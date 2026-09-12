//! FILENAME: app/src/api/customFunctions.ts
// PURPOSE: User-authored formula functions (JS UDFs) executed in a SANDBOXED
//          worker. A user writes function bodies (which may call cube.* / fetch);
//          we generate one "function library" script, mount it in the script
//          sandbox (broker-mediated capabilities + audit), and register each
//          function as a formula UDF whose implementation runs the body in the
//          worker via callExposedMethod. The synchronous evaluator serves the
//          pre-fetched result (same path as any UDF).
//
// Sandboxing: the body runs in the hardened Worker realm (no DOM/Tauri/network
// except declared capabilities), NOT on the main thread. Privileged reach is
// limited to the library's declaredCapabilities (e.g. "bi.query" for cube.*).
//
// DISTRIBUTED CODE: a .calp package may ship its own functions, which the
// backend MERGES per function into this one subscriber-owned library record
// (calp_commands.rs merge_custom_function_library) and stamps `sourcePackage` +
// `sourceDigest` on. Those functions are somebody else's CODE, so they are
// consent-gated here before anything mounts — see the "distributed-package
// consent gate" section below.
//
// ...AND THEY DO NOT MOUNT AS YOURS. The record is one merged blob, but a REALM
// is not: each trust origin present in the library gets its own worker realm,
// mounted with the provenance its functions' `sourcePackage` stamp derives
// (`planCustomFunctionRealms` / `mountRealm`). Until that split existed, an
// approved publisher function was mounted at LOCAL provenance under the
// subscriber's own broker script id, which meant it was same-trust-origin with
// the user's own scripts, it took the LOCAL just-in-time capability prompt
// instead of application consent, and it borrowed whatever the user had already
// granted their own functions — the confused deputy the consent gate below
// exists to refuse, re-entered one layer down. The sibling libraries that ship
// distributed code already had this right (chartTransformScripts.rawInstall and
// chartMarkScripts.rawInstall both mount `provenance: "distributed"` with the
// package name); this one is per-FUNCTION because its record is merged per
// function.

import { invoke } from "@tauri-apps/api/core";
// The parser that decides whether a body stays inside its wrapper. Same acorn
// the object-script validator uses (scriptHost/scriptValidation/analyze.ts), and
// a parser rather than `new Function` because the shipped CSP has no
// `unsafe-eval` — see `validateFunctionBody`.
import { parse as acornParse, type Program as AcornProgram } from "acorn";
import { registerFunction, UDF_ERROR_KEY } from "./formulaFunctions";
import { hostMountScript, hostUnmountScript } from "./scriptHost/host";
import { applyConsentedCapabilities, revokeScriptGrants } from "./scriptHost/capabilities";
import {
  mountProvenanceForOrigin,
  scriptOriginForStoredRecord,
  type MountOrigin,
} from "./scriptHost/scriptOrigin";
import { callExposedMethod } from "./scriptableObjects";
import type { CapabilityId } from "./scriptHost/capabilityIds";
import { linkScript, type LibraryUseDeclaration } from "./scriptLibraries";
import { loadConsents, isConsentCurrent, recordConsent } from "./distributedConsent";
import { emitAppEvent } from "./events";

/** A user-authored custom formula function. */
export interface CustomFunctionUdf {
  /** Function name (uppercased for formula matching). */
  name: string;
  /** Parameter names (positional). */
  params: string[];
  /** JS body. Has `cube` (caps.cube), `cellError`, the params, and may
   *  `return` a value (a scalar, an array to spill, or `cellError("#N/A")`). */
  body: string;
  /** Help text shown in autocomplete. */
  description?: string;
  /** Recalculate on every edit (Excel's Application.Volatile). Default false:
   *  the cell recalculates only when one of its arguments changes. */
  volatile?: boolean;
  /**
   * The .calp package this function ARRIVED IN, stamped by the backend merge.
   * Absent/empty means the subscriber wrote it themselves. Present means it is
   * distributed code and must clear {@link gateCustomFunctionLibrary} before it
   * is allowed to mount.
   */
  sourcePackage?: string;
  /**
   * Content hash the backend merge stamps alongside `sourcePackage`, so a later
   * refresh can tell "the subscriber edited this" from "the publisher changed
   * it". Not part of the consent hash — consent is over the CODE, and this key
   * is derived from it.
   */
  sourceDigest?: string;
}

/** A library of custom functions sharing one sandbox + capability set. */
export interface CustomFunctionLibrary {
  functions: CustomFunctionUdf[];
  /** Capabilities the library may use (e.g. "bi.query" for cube.*, "net.fetch"). */
  capabilities?: CapabilityId[];
  /**
   * Shared script libraries this UDF library imports. Emitted as `// @uses`
   * pragmas into the generated source, so the ONE linker (@api/scriptLibraries)
   * resolves them exactly as it does for an object script — including the
   * ceiling intersection: an imported library runs at
   * `declared(library) INTERSECT capabilities` above, never wider.
   */
  uses?: LibraryUseDeclaration[];
}

const LIB_SCRIPT_ID = "__calcula_custom_functions__";
/** The broker scriptId the SUBSCRIBER'S OWN custom functions mount under —
 *  exported so the code inventory (transparency panel) can join live tier/grant
 *  state for the formula-udf surface. Functions that arrived in an application
 *  mount under `customFunctionScriptId(theirPackage)` instead, which is the
 *  whole point: their grants are not this id's grants. */
export const CUSTOM_FUNCTIONS_SCRIPT_ID = LIB_SCRIPT_ID;

/**
 * The broker script id the functions from `sourcePackage` mount under — the
 * library's own id for the subscriber's code, a per-application id for anybody
 * else's.
 *
 * A distinct id is not cosmetic. `getGrantSet` (capabilities.ts) is keyed by it,
 * so it is what decides whose capability grants a body runs with; the persisted
 * grant store and the audit ring are keyed by it too. Sharing one id is exactly
 * how a publisher's function came to run on the subscriber's grants.
 */
export function customFunctionScriptId(sourcePackage?: string | null): string {
  const name = typeof sourcePackage === "string" ? sourcePackage.trim() : "";
  return name === "" ? LIB_SCRIPT_ID : `${LIB_SCRIPT_ID}pkg:${name}`;
}

// Reuse the workbook object-type with a reserved instance so the library never
// collides with a user's own workbook script (keyed by type + instanceId).
const LIB_OBJECT_TYPE = "workbook";
/**
 * The instance a realm exposes its UDFs under — RANDOM per install, not the
 * old fixed "__custom_functions__".
 *
 * SECURITY (pre-existing hole, closed here): the UDFs are exposed
 * `{ public: false }`, which the broker's `callExposed` enforces only for
 * CROSS-tier/CROSS-origin callers. The subscriber's own realm mounts as a LOCAL,
 * RESTRICTED script, and so does every user object script — same tier, same
 * origin — so the `sameTrust` branch let any local object script invoke any
 * custom function with
 * `context.callMethod("workbook", "__custom_functions__", "MYFN", …)` while
 * the fixed instance id was guessable. A UDF body may hold `bi.query` (or any
 * capability the user granted this library), so that was a confused deputy: a
 * script that declared nothing could drive the library's reach.
 * Randomizing the instance means the address is an unguessable reference held
 * only by trusted host code (`callExposedMethod` below and the UDF pre-fetch),
 * never handed to any script. The proper fix — an identity check on the CALLER
 * rather than on knowledge of the address — belongs in the broker; see
 * docs/design/script-package-manager.md §5.3.
 */
function randomInstanceId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return (
    "__custom_functions_" +
    Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

const normalizeName = (n: string): string => n.trim().toUpperCase();

/** A valid JS identifier (function name / parameter). */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Names bound in the generated set() scope that a parameter must not shadow. */
const RESERVED_PARAMS = new Set([
  "cube",
  "caps",
  "context",
  "setup",
  "cellError",
  // Sibling-call table (below) and the library-import binding the linker's
  // generated prelude introduces.
  "fns",
  "imports",
]);

export function validateFunctionName(name: string): string | null {
  const up = normalizeName(name);
  if (!IDENT_RE.test(up)) {
    return `Invalid function name "${name}". Use letters, digits, and underscores (no dots/spaces).`;
  }
  return null;
}

export function validateParam(param: string, fnName: string): string | null {
  if (!IDENT_RE.test(param)) {
    return `Invalid parameter "${param}" in ${fnName}. Use a JS identifier.`;
  }
  if (RESERVED_PARAMS.has(param)) {
    return `Parameter "${param}" in ${fnName} is reserved (it would shadow the sandbox helpers).`;
  }
  return null;
}

/**
 * Does this body stay INSIDE the arrow function it is spliced into?
 *
 * `generateLibrarySource` splices the body as raw TEXT between the `{` and `}`
 * of `fns[NAME] = async (...) => { … }`. A body whose own `}` closes that arrow
 * early does not fail — it PARSES, and everything after the brace becomes a
 * sibling statement in `setup(context)`, which the realm runs once per MOUNT.
 * So the author's code executes on every workbook open, before and without any
 * cell ever calling the function, and the UDF still works, so nothing looks
 * wrong. Same realm, same tier, same grant set, so it is not an escalation —
 * it is a TIMING and TRANSPARENCY gap, and a consent prompt that says "runs
 * whenever a cell uses it" is then not true.
 *
 * WHY A REAL PARSE. Brace counting is defeated by `}` inside a string, a
 * template literal, a regex literal or a comment — all of which are ordinary in
 * a function body, so a counter would REJECT legitimate code, which is the
 * worse failure here. `new Function` cannot be the parser either: the shipped
 * CSP carries no `unsafe-eval`, so constructing one throws in a built app while
 * working perfectly in `tauri dev`, which enforces no CSP. Acorn is already a
 * runtime dependency and already parses object scripts one directory over
 * (`scriptHost/scriptValidation/analyze.ts`), so it is the parser that is
 * demonstrably allowed to run here.
 *
 * The probe wraps the body the same way the generator does and requires the
 * result to be EXACTLY one arrow-function expression: an escaped body either
 * fails to parse or yields more than one statement.
 */
export function validateFunctionBody(
  body: string,
  params: string[],
  fnName: string,
): string | null {
  const probe = `(async (${params.join(", ")}) => {\n${body}\n})`;
  // Said on BOTH refusal paths. An escaping body is a syntax error in the probe
  // rather than a well-formed program — the parentheses admit exactly one
  // expression — so the parser's own message is what an author actually sees,
  // and "Unexpected token (2:11)" teaches nothing about why it is refused. The
  // phrasing is conditional because this path also catches an ordinary typo,
  // and claiming an escape that is not there would be its own dishonesty.
  const consequence =
    `If the body closes its own "}", everything after it runs when the workbook ` +
    `opens instead of when a cell calls ${fnName}.`;
  let program: AcornProgram;
  try {
    program = acornParse(probe, { ecmaVersion: "latest" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${fnName} is not a valid function body: ${msg}. ${consequence}`;
  }
  // Belt and braces, and honestly labelled as such: a parenthesised expression
  // admits exactly one arrow, so reaching here would mean acorn parsed
  // something this function's premise says it cannot. Kept because the premise
  // is the guard — if it ever stops holding, refusing is the safe answer.
  const only = program.body.length === 1 ? program.body[0] : null;
  if (
    !only ||
    only.type !== "ExpressionStatement" ||
    only.expression.type !== "ArrowFunctionExpression"
  ) {
    return `${fnName} does not parse as a single function body. ${consequence}`;
  }
  return null;
}

/** Indent each line of a body by two spaces for readable generated source. */
function indent(body: string): string {
  return body
    .split("\n")
    .map((line) => "    " + line)
    .join("\n");
}

/**
 * Emit the `// @uses` pragma block for a library's declared imports. Emitted as
 * real pragmas (rather than passed to the linker out-of-band) so the SAME
 * parser reads the same text for a UDF library as for a hand-written object
 * script — one dialect, no second code path that could disagree about what a
 * script declares.
 */
function usesPragmaBlock(uses: LibraryUseDeclaration[]): string {
  return uses
    .map(
      (u) =>
        `// @uses${u.isolated ? "-isolated" : ""} ${u.alias} ${u.package}@${u.pin}`,
    )
    .join("\n");
}

/**
 * Generate the sandboxed "function library" script source from the definitions.
 * Each function is exposed NON-public so only TRUSTED host code (the UDF
 * pre-fetch via callExposedMethod) can invoke it — a peer sandboxed script
 * cannot reach it via context.callMethod and borrow the library's capabilities.
 * `cube` is bound from the capability shim so a body can `return await
 * cube.value(...)`; `cellError` is bound so a body can return a SPECIFIC
 * spreadsheet error (the sentinel object survives structured clone across the
 * worker boundary, which a thrown object would not).
 *
 * SIBLING CALLS. Every function is also bound into a `fns` table, so a body can
 * call another custom function directly: `return await fns.OTHER(x)`. Before
 * this, each `context.expose` closure was anonymous inside `setup` and nothing
 * bound a sibling to a name, so the only way to reach one was the undocumented
 * `context.callMethod("workbook", <instance>, "OTHER", …)` peer path — untyped,
 * invisible to IntelliSense, and (with a fixed instance id) reachable by any
 * local script. Sanctioning `fns` and randomizing the instance id closes that
 * ambiguity in both directions.
 *
 * `uses` becomes a `// @uses` pragma block; the linker resolves it against the
 * workbook lockfile at mount and prepends the `imports` prelude.
 *
 * Pure + exported for tests; THROWS on an invalid name/param (so a crafted
 * token cannot break out of the generated structure).
 */
export function generateLibrarySource(
  defs: CustomFunctionUdf[],
  uses: LibraryUseDeclaration[] = [],
): string {
  const bodies = defs
    .filter((d) => d.name.trim())
    .map((d) => {
      const nameErr = validateFunctionName(d.name);
      if (nameErr) throw new Error(nameErr);
      const params = d.params.map((p) => p.trim()).filter(Boolean);
      for (const p of params) {
        const perr = validateParam(p, d.name);
        if (perr) throw new Error(perr);
      }
      // Last, because it is the only check that needs the final parameter list:
      // the body must stay inside the arrow this splices it into, or code that
      // was meant to run per call runs once per MOUNT instead.
      const berr = validateFunctionBody(d.body, params, d.name);
      if (berr) throw new Error(berr);
      const name = JSON.stringify(normalizeName(d.name));
      return (
        `  fns[${name}] = async (${params.join(", ")}) => {\n` +
        `${indent(d.body)}\n` +
        `  };\n` +
        `  context.expose(${name}, fns[${name}], { public: false });`
      );
    })
    .join("\n");
  const pragmas = usesPragmaBlock(uses);
  return (
    (pragmas ? pragmas + "\n" : "") +
    `function setup(context) {\n` +
    `  const caps = context.caps || {};\n` +
    `  const cube = caps.cube;\n` +
    `  // return cellError("#N/A") to put a specific error in the cell.\n` +
    `  const cellError = (code) => ({ ${UDF_ERROR_KEY}: String(code) });\n` +
    `  // Sibling calls: a body may call another custom function as await fns.NAME(...).\n` +
    `  const fns = {};\n` +
    `${bodies}\n` +
    `}\n`
  );
}

/**
 * One realm the library mounts: the functions that share ONE trust origin, and
 * the source generated for exactly those.
 *
 * The library record is merged (subscriber + every application that shipped
 * functions), but a realm is the unit of TRUST — script id, provenance, grant
 * set and same-origin peers all follow it — so the merge has to be undone before
 * anything mounts.
 */
export interface CustomFunctionRealm {
  /** The application these functions arrived in; "" for the subscriber's own. */
  packageName: string;
  /** DERIVED from that stamp (scriptOriginForStoredRecord), never asserted. */
  origin: MountOrigin;
  /** The broker script id this realm mounts under. */
  scriptId: string;
  /** Display name — the Script Security prompt, the audit ring, the panel. */
  name: string;
  /** Its functions, in the library's own order. */
  functions: CustomFunctionUdf[];
  /** The generated library source for exactly those functions. */
  source: string;
  /**
   * The string this realm's consent is recorded against — `customFunctionConsentSource`
   * over EVERY function stamped with this package (the gate's grouping, empty
   * bodies included) and the library's capability set. Computed by the same
   * former the gate checks and the grant recorder writes, so the artifact the
   * mount names is byte-for-byte the one in the record. Meaningless for the
   * subscriber's own realm, which is never asked.
   */
  consentSource: string;
}

/**
 * Every function grouped by the application it arrived in (`""` for the
 * subscriber's own), in the library's own order — the ONE grouping both the
 * consent gate and the realm plan use. Empty names/bodies are NOT filtered here:
 * the consent source is over what the record was written against, and the plan
 * drops what cannot mount afterwards.
 */
function functionsByPackage(lib: CustomFunctionLibrary): Map<string, CustomFunctionUdf[]> {
  const byPackage = new Map<string, CustomFunctionUdf[]>();
  for (const d of lib.functions ?? []) {
    const pkg = typeof d.sourcePackage === "string" ? d.sourcePackage.trim() : "";
    const list = byPackage.get(pkg);
    if (list) list.push(d);
    else byPackage.set(pkg, [d]);
  }
  return byPackage;
}

/** A realm that is (or was about to be) mounted, for teardown. */
interface MountedRealm {
  scriptId: string;
  isPackage: boolean;
  /** Drops this realm's library-import tokens (and unmounts imported realms
   *  that lose their last consumer). */
  release: () => void;
  /** False when the mount itself threw — there is nothing to unmount. */
  mounted: boolean;
}

let registeredCleanups: Array<() => void> = [];
/** Every realm this install mounted — one per trust origin in the library. */
let realms: MountedRealm[] = [];
// Serialize install/uninstall so a startup install + AFTER_OPEN reload can't
// interleave and corrupt the module-level mount/cleanup state.
let installQueue: Promise<unknown> = Promise.resolve();
// The last library that mounted+registered cleanly, for rollback on a failed edit.
let lastGood: { lib: CustomFunctionLibrary; plan: CustomFunctionRealm[] } | null = null;

/** Currently-installed status (for the manager UI). */
export function customFunctionsInstalled(): boolean {
  return realms.length > 0;
}

/**
 * Split a library into one realm per trust origin, generating each realm's
 * source. Pure (and exported for tests); THROWS on an invalid name, param, or
 * BODY (one that does not stay inside the arrow it is spliced into — see
 * `validateFunctionBody`), which is why `doInstall` calls it BEFORE any
 * teardown. A refusal therefore leaves the previously-installed library
 * standing rather than half-torn-down.
 *
 * One bad definition refuses the WHOLE plan, including realms it is not in.
 * That is pre-existing — an invalid name has always done it — and it is the
 * safe direction, but it does mean a publisher's malformed function disables
 * the subscriber's own until the package is fixed or removed.
 *
 * The subscriber's realm comes first and applications follow in name order, so
 * the mount order — and therefore the audit ring — is deterministic.
 *
 * SIBLING CALLS DO NOT CROSS A REALM. `fns.OTHER(...)` reaches the functions of
 * the SAME origin only. That is the honest consequence of the split: a
 * publisher's body calling the subscriber's function (or the reverse) is a
 * cross-trust call, and those go through the broker's own rules or not at all.
 */
export function planCustomFunctionRealms(lib: CustomFunctionLibrary): CustomFunctionRealm[] {
  const uses = lib.uses ?? [];
  const caps = lib.capabilities ?? [];
  const byPackage = functionsByPackage(lib);
  // Plain lexicographic order: "" is smaller than every package name, so the
  // subscriber's realm sorts first without a special case.
  const plan: CustomFunctionRealm[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const all = byPackage.get(pkg) as CustomFunctionUdf[];
    const functions = all.filter((d) => d.name.trim() && d.body.trim());
    // A package whose every function is a blank has nothing to mount.
    if (functions.length === 0) continue;
    plan.push({
      packageName: pkg,
      // `""` is THIS MODULE's spelling of "the subscriber's own group" (the
      // trim in functionsByPackage folds an absent stamp and a blank one
      // together), and the origin derivation reads a present stamp — blank or
      // not — as a package, the way Rust reads `Option<String>`. Hand it the
      // ABSENCE it means, or the subscriber's own realm mounts as an unnamed
      // publisher's.
      origin: scriptOriginForStoredRecord({ sourcePackage: pkg === "" ? null : pkg }),
      scriptId: customFunctionScriptId(pkg),
      name: pkg === "" ? "Custom Functions" : `Custom Functions (${pkg})`,
      functions,
      source: generateLibrarySource(functions, uses),
      // Over ALL of the package's functions (the gate's grouping), never the
      // mountable subset — the record was written against the former.
      consentSource: customFunctionConsentSource(all, caps),
    });
  }
  return plan;
}

/** Mount one realm and register its functions as UDFs. */
async function mountRealm(
  plan: CustomFunctionRealm,
  capabilities: CapabilityId[],
  opts: { cause?: "open" } = {},
): Promise<void> {
  // Link declared library imports BEFORE mounting. Each imported library gets a
  // realm at `declared(library) INTERSECT capabilities` — so a library this UDF
  // set imports can never reach further than the UDF set itself was consented
  // for. An unresolved alias throws here and the install fails (the caller
  // restores the previous good library), which is the point: a UDF must not
  // start with a dangling import.
  const link = await linkScript({
    scriptId: plan.scriptId,
    scriptName: plan.name,
    source: plan.source,
    declaredCapabilities: capabilities,
    accessLevel: "restricted",
  });
  const realm: MountedRealm = {
    scriptId: plan.scriptId,
    isPackage: plan.origin.kind === "package",
    release: link.release,
    mounted: false,
  };
  // Recorded BEFORE the mount, so a mount that throws still has its import
  // tokens dropped by the teardown the caller runs.
  realms.push(realm);

  if (realm.isPackage) {
    // A distributed realm gets NO just-in-time prompt (mayJitPromptForCapability
    // refuses a package origin), so if its capabilities did not come from the
    // application's consent record they would not come at all. This is that
    // record: `gateCustomFunctionLibrary` above admitted these functions only
    // while a persisted consent covered this exact code AND this exact
    // capability set, and a widening of the set re-prompts. Same chokepoint the
    // script-library linker uses for a package realm.
    await applyConsentedCapabilities(plan.scriptId, [...capabilities], []);
  }

  // A fresh unguessable instance per realm (see randomInstanceId's SECURITY note).
  const instanceId = randomInstanceId();
  await hostMountScript({
    id: plan.scriptId,
    name: plan.name,
    objectType: LIB_OBJECT_TYPE,
    // "open" when the install was triggered by this workbook opening. Without it
    // `openReplayPending` is never set for this realm, so a consented library's
    // `workbook.onOpen` never fired — while the consent prompt promised it would.
    mountCause: opts.cause,
    instanceId,
    source: link.prelude + plan.source,
    accessLevel: "restricted",
    // ONE spelling of "distributed", derived from the stamp the backend merge
    // wrote on these functions. Omitting this field is not neutral: the handle
    // builder reads a missing `provenance` as LOCAL, which is how a publisher's
    // body came to sit inside the subscriber's own trust origin.
    ...mountProvenanceForOrigin(plan.origin),
    declaredCapabilities: capabilities,
    // THE ARTIFACT THE CONSENT RECORD NAMES. `grantCustomFunctionConsent` records
    // `{ id: CUSTOM_FUNCTIONS_SCRIPT_ID, source: consentSource }` under
    // `custom-functions:<package>`, and `plan.consentSource` is the same string
    // from the same former over the same grouping — so the Rust gate holds this
    // realm to the exact functions AND capability set the user approved. The id
    // is the record's (the library's reserved id), not this realm's per-package
    // broker id. Passed for the subscriber's own realm too, where it is simply
    // never consulted.
    consentSurface: "custom-functions",
    consentArtifacts: [{ id: CUSTOM_FUNCTIONS_SCRIPT_ID, source: plan.consentSource }],
    apiVersion: "1.0.0",
  });
  realm.mounted = true;

  for (const d of plan.functions) {
    const upper = normalizeName(d.name);
    const arity = d.params.map((p) => p.trim()).filter(Boolean).length;
    const cleanup = registerFunction({
      name: upper,
      description: d.description?.trim() || "User-defined function",
      syntax: `${upper}(${d.params.map((p) => p.trim()).filter(Boolean).join(", ")})`,
      category: "Custom",
      minArgs: arity,
      maxArgs: arity,
      volatile: d.volatile === true,
      // Bound to THIS realm's instance so a later re-install cannot leave a
      // registered UDF pointing at a torn-down realm's address — and so a
      // formula never reaches a body through another origin's realm.
      implementation: (...args: unknown[]) =>
        callExposedMethod(LIB_OBJECT_TYPE, instanceId, upper, ...args),
    });
    registeredCleanups.push(cleanup);
  }
}

/** Mount every realm in `plan` and register its UDFs (no rollback/queue). */
async function rawInstall(
  lib: CustomFunctionLibrary,
  plan: CustomFunctionRealm[],
  opts: { cause?: "open" } = {},
): Promise<void> {
  uninstallCustomFunctions();
  if (plan.length === 0) return;
  const capabilities = lib.capabilities ?? [];
  try {
    for (const realm of plan) {
      await mountRealm(realm, capabilities, opts);
    }
  } catch (e) {
    // All or nothing: a half-mounted library would register some functions and
    // silently drop the rest.
    uninstallCustomFunctions();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The distributed-package consent gate
// ---------------------------------------------------------------------------
//
// THE HOLE THIS CLOSES. A .calp package can ship a custom-function library. The
// backend merges it, per function, into the ONE reserved library record this
// module installs (calp_commands.rs merge_custom_function_library) and then
// emits "custom-functions:refresh" so it goes live without a reopen. Until this
// gate existed, that meant a package's JavaScript mounted and ran — on pull, on
// refresh and on every subsequent workbook open — with no prompt at all, while
// three consent strings the user had just read promised the opposite ("any code
// that arrives stays switched off until you approve it").
//
// Worse than "unprompted": the merged record shared the SUBSCRIBER'S script id
// and therefore the subscriber's live capability grants. A subscriber who had
// granted their own functions bi.query was, without being asked, running a
// stranger's code with it. That is the confused deputy this project exists to
// refuse. The GRANT half of that is now closed one layer down as well — a
// package's functions mount in their own realm under their own script id
// (`planCustomFunctionRealms`), so they hold what THEIR consent record granted
// and nothing the subscriber granted their own code. The gate below is still
// what decides whether that realm is allowed to exist at all.
//
// SHAPE. Identical to the chart-transform / chart-mark gate
// (Charts/lib/distributedLibraryGate.ts) and stored in the SAME shared consent
// store (@api/distributedConsent), namespaced so it can never collide with the
// object-script record for the same .calp:
//
//   * consent is per PACKAGE, over that package's functions only — a second
//     package cannot ride in on the first one's approval;
//   * the consent source carries a `// @capability` pragma per capability the
//     SHARED realm holds, so the store's own expansion check re-prompts when the
//     subscriber later widens the library. Without this, a package function
//     approved when the library was inert would silently acquire net.fetch the
//     day the subscriber granted it for their own function;
//   * the hash is over the code, so an upstream edit re-prompts too.
//
// FAIL CLOSED BY CONSTRUCTION. The filter lives inside `doInstall`, the single
// choke point every install path funnels through (startup, AFTER_OPEN, the
// backend refresh event, and the authoring dialog's Save). Putting it in the
// extension instead would leave whichever caller is added next ungated.

/** Consent-store key for one package's contribution to the shared library. */
export function customFunctionConsentKey(packageName: string): string {
  return `custom-functions:${packageName}`;
}

/** Provenance-stripped canonical form of one function — what consent is over. */
function canonicalFunction(f: CustomFunctionUdf): string {
  return JSON.stringify({
    name: normalizeName(f.name),
    params: f.params.map((p) => p.trim()).filter(Boolean),
    body: f.body,
    description: f.description ?? "",
    volatile: f.volatile === true,
  });
}

/**
 * The canonical "consent source" for one package's functions: one
 * `// @capability <id>` pragma per capability the SHARED library realm holds,
 * then the package's functions in a stable order. Hashing over this (rather
 * than the raw JSON) is what makes the shared distributed-consent store work
 * verbatim — a code edit changes the hash, and a capability expansion changes
 * both the hash and the store's declared-capability comparison.
 */
export function customFunctionConsentSource(
  functions: CustomFunctionUdf[],
  capabilities: CapabilityId[],
): string {
  const pragmas = [...capabilities].sort().map((c) => `// @capability ${c}`).join("\n");
  const canon = functions.map(canonicalFunction).sort().join("\n");
  return (pragmas ? pragmas + "\n" : "") + canon;
}

/** One package's functions awaiting the user's answer. */
export interface PendingCustomFunctionPackage {
  /** The .calp package the functions arrived in. */
  packageName: string;
  /** Upper-cased function names, for the prompt. */
  functionNames: string[];
  /** What the shared realm holds — i.e. what approving really grants this code. */
  capabilities: CapabilityId[];
  /** The exact string consent is recorded against (opaque to the caller). */
  consentSource: string;
}

/** App event carrying the packages whose functions were withheld. */
export const CUSTOM_FUNCTIONS_CONSENT_NEEDED = "customfunctions:consent-needed";

/**
 * Split a library into what may mount now and what is waiting on the user.
 * Locally-authored functions (no `sourcePackage`) always pass; every package's
 * functions pass only while a persisted consent covers that exact code AND that
 * exact capability set. Pure apart from the consent read — exported so the
 * extension can render the prompt and the tests can drive it.
 */
export async function gateCustomFunctionLibrary(
  lib: CustomFunctionLibrary,
): Promise<{ library: CustomFunctionLibrary; pending: PendingCustomFunctionPackage[] }> {
  const caps = [...(lib.capabilities ?? [])].sort();
  const all = lib.functions ?? [];
  // The same grouping the realm plan uses, minus the subscriber's own bucket:
  // the consent source a realm later names is over THIS list, so the two must
  // not be built by two loops that could drift.
  const byPackage = functionsByPackage(lib);
  byPackage.delete("");
  if (byPackage.size === 0) return { library: lib, pending: [] };

  const consents = await loadConsents();
  const withheld = new Set<CustomFunctionUdf>();
  const pending: PendingCustomFunctionPackage[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const fns = byPackage.get(pkg) as CustomFunctionUdf[];
    const consentSource = customFunctionConsentSource(fns, caps);
    const current = await isConsentCurrent(consents, customFunctionConsentKey(pkg), [
      { id: CUSTOM_FUNCTIONS_SCRIPT_ID, source: consentSource },
    ]);
    if (current) continue;
    for (const f of fns) withheld.add(f);
    pending.push({
      packageName: pkg,
      functionNames: fns.map((f) => normalizeName(f.name)),
      capabilities: caps,
      consentSource,
    });
  }
  if (withheld.size === 0) return { library: lib, pending: [] };
  // Original order preserved: the generated source, and therefore the mounted
  // realm, must not reshuffle just because a package was withheld.
  return { library: { ...lib, functions: all.filter((f) => !withheld.has(f)) }, pending };
}

/**
 * Record the user's approval of one package's functions and re-run the install
 * so they go live immediately. Persisted in the workbook, keyed by code hash +
 * capability set, so a later open does not re-prompt but an upstream change (or
 * a capability expansion) does.
 */
export async function grantCustomFunctionConsent(
  p: PendingCustomFunctionPackage,
): Promise<void> {
  await recordConsent(
    customFunctionConsentKey(p.packageName),
    [{ id: CUSTOM_FUNCTIONS_SCRIPT_ID, source: p.consentSource }],
    p.capabilities.map((capability) => ({ capability })),
  );
  await loadAndInstallCustomFunctions();
}

async function doInstall(
  lib: CustomFunctionLibrary,
  opts: { cause?: "open" } = {},
): Promise<void> {
  // THE GATE. Everything below this line operates on the consented subset only.
  const { library: gated, pending } = await gateCustomFunctionLibrary(lib);
  if (pending.length > 0) {
    // Announce, do not block: the withheld functions simply are not mounted, so
    // their cells resolve to #NAME? until the user says yes. A listener (the
    // CustomFunctions extension) turns this into the prompt.
    emitAppEvent(CUSTOM_FUNCTIONS_CONSENT_NEEDED, { pending });
  }
  // Plan + generate (and VALIDATE) first — a bad name/param throws here, BEFORE
  // any teardown, so an invalid edit never tears down a working library.
  const plan = planCustomFunctionRealms(gated);
  const prev = lastGood;
  try {
    await rawInstall(gated, plan, opts);
    lastGood = { lib: gated, plan };
  } catch (e) {
    // Mount/compile failed — restore the previous good library rather than
    // leaving the user with NO functions.
    if (prev) {
      try {
        await rawInstall(prev.lib, prev.plan);
      } catch {
        uninstallCustomFunctions();
      }
    } else {
      uninstallCustomFunctions();
    }
    throw e;
  }
}

/**
 * Mount the library in the sandbox and register each function as a formula UDF.
 * Replaces any previously-installed library. A formula `=NAME(args)` resolves by
 * running the body in the worker (off the synchronous recalc, via the UDF
 * pre-fetch path) — the result is served to the evaluator. Serialized: concurrent
 * calls run in order; on failure the previous working library is restored.
 */
export function installCustomFunctions(
  lib: CustomFunctionLibrary,
  opts: { cause?: "open" } = {},
): Promise<void> {
  const run = () => doInstall(lib, opts);
  const next = installQueue.then(run, run);
  // Keep the queue alive even if this install rejects (don't poison the chain).
  installQueue = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Persistence (reuses the workbook module-script store; no new backend section).
// The library lives in a RESERVED workbook script whose `source` is the JSON
// definition (it is never executed as code — we parse + install it ourselves).
// ---------------------------------------------------------------------------

const PERSIST_SCRIPT_ID = "__calcula_custom_functions__";

/** Load the persisted custom-function library from the workbook, or null. */
export async function loadPersistedLibrary(): Promise<CustomFunctionLibrary | null> {
  try {
    const data = await invoke<{ source: string }>("get_script", { id: PERSIST_SCRIPT_ID });
    if (!data?.source) return null;
    const parsed = JSON.parse(data.source) as CustomFunctionLibrary;
    if (!parsed || !Array.isArray(parsed.functions)) return null;
    return parsed;
  } catch {
    return null; // not found / not present
  }
}

/** Persist the library into the workbook (saved with the .cala). */
export async function savePersistedLibrary(lib: CustomFunctionLibrary): Promise<void> {
  await invoke("save_script", {
    script: {
      id: PERSIST_SCRIPT_ID,
      name: "Custom Functions (data)",
      description: "Definitions for user-authored formula functions.",
      source: JSON.stringify(lib),
      scope: { type: "workbook" },
      sourcePackage: null,
    },
  });
}

/** Load the persisted library (if any) and install it. Call on startup + open.
 *  Best-effort: a corrupt/failing library must not throw into the open path. */
export async function loadAndInstallCustomFunctions(
  opts: { cause?: "open" } = {},
): Promise<void> {
  try {
    const lib = await loadPersistedLibrary();
    if (lib && lib.functions.length > 0) {
      await installCustomFunctions(lib, opts);
    } else {
      uninstallCustomFunctions();
    }
  } catch (e) {
    console.error("[customFunctions] failed to install persisted functions", e);
  }
}

/** Unregister all custom-function UDFs and tear down every mounted realm. */
export function uninstallCustomFunctions(): void {
  for (const fn of registeredCleanups) {
    try {
      fn();
    } catch {
      /* best-effort */
    }
  }
  registeredCleanups = [];
  for (const realm of realms) {
    try {
      realm.release();
    } catch {
      /* best-effort */
    }
    if (realm.mounted) {
      try {
        hostUnmountScript(realm.scriptId);
      } catch {
        /* best-effort */
      }
    }
    // A distributed realm's grants were derived from the application's consent
    // record and are re-derived from it on every install, so dropping them here
    // loses nothing — and a package whose consent the user later withdraws must
    // not leave its capabilities sitting in the live set for the next mount to
    // find. The SUBSCRIBER's realm keeps its grants, which are the user's own
    // "Always" answers and must survive an ordinary edit-and-reinstall.
    if (realm.isPackage) revokeScriptGrants(realm.scriptId);
  }
  realms = [];
}
