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

import { invoke } from "@tauri-apps/api/core";
import { registerFunction, UDF_ERROR_KEY } from "./formulaFunctions";
import { hostMountScript, hostUnmountScript } from "./scriptHost/host";
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
/** The broker scriptId the custom-function library mounts under — exported so the
 *  code inventory (transparency panel) can join live tier/grant state for the
 *  formula-udf surface. */
export const CUSTOM_FUNCTIONS_SCRIPT_ID = LIB_SCRIPT_ID;
// Reuse the workbook object-type with a reserved instance so the library never
// collides with a user's own workbook script (keyed by type + instanceId).
const LIB_OBJECT_TYPE = "workbook";
/**
 * The instance the library exposes its UDFs under — RANDOM per install, not the
 * old fixed "__custom_functions__".
 *
 * SECURITY (pre-existing hole, closed here): the UDFs are exposed
 * `{ public: false }`, which the broker's `callExposed` enforces only for
 * CROSS-tier/CROSS-origin callers. This library mounts as a LOCAL, RESTRICTED
 * script, and so does every user object script — same tier, same origin — so
 * the `sameTrust` branch let any local object script invoke any custom function
 * with `context.callMethod("workbook", "__custom_functions__", "MYFN", …)` while
 * the fixed instance id was guessable. A UDF body may hold `bi.query` (or any
 * capability the user granted this library), so that was a confused deputy: a
 * script that declared nothing could drive the library's reach.
 * Randomizing the instance means the address is an unguessable reference held
 * only by trusted host code (`callExposedMethod` below and the UDF pre-fetch),
 * never handed to any script. The proper fix — an identity check on the CALLER
 * rather than on knowledge of the address — belongs in the broker; see
 * docs/design/script-package-manager.md §5.3.
 */
let libInstanceId = randomInstanceId();

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

let registeredCleanups: Array<() => void> = [];
let mounted = false;
/** Drops this install's library-import tokens (and unmounts realms that lose
 *  their last consumer). Null when nothing is linked. */
let releaseLink: (() => void) | null = null;
// Serialize install/uninstall so a startup install + AFTER_OPEN reload can't
// interleave and corrupt the module-level mount/cleanup state.
let installQueue: Promise<unknown> = Promise.resolve();
// The last library that mounted+registered cleanly, for rollback on a failed edit.
let lastGood: { lib: CustomFunctionLibrary; source: string } | null = null;

/** Currently-installed status (for the manager UI). */
export function customFunctionsInstalled(): boolean {
  return mounted;
}

/** Mount `source` and register `defs` as UDFs (no rollback/queue). */
async function rawInstall(lib: CustomFunctionLibrary, source: string): Promise<void> {
  uninstallCustomFunctions();
  const defs = lib.functions.filter((d) => d.name.trim() && d.body.trim());
  if (defs.length === 0 || !source) return;

  // Link declared library imports BEFORE mounting. Each imported library gets a
  // realm at `declared(library) INTERSECT (lib.capabilities ?? [])` — so a
  // library this UDF set imports can never reach further than the UDF set
  // itself was consented for. An unresolved alias throws here and the install
  // fails (the caller restores the previous good library), which is the point:
  // a UDF must not start with a dangling import.
  const link = await linkScript({
    scriptId: LIB_SCRIPT_ID,
    scriptName: "Custom Functions",
    source,
    declaredCapabilities: lib.capabilities ?? [],
    accessLevel: "restricted",
  });
  releaseLink = link.release;

  // A fresh unguessable instance per install (see libInstanceId's SECURITY note).
  libInstanceId = randomInstanceId();
  const instanceId = libInstanceId;
  try {
    await hostMountScript({
      id: LIB_SCRIPT_ID,
      name: "Custom Functions",
      objectType: LIB_OBJECT_TYPE,
      instanceId,
      source: link.prelude + source,
      accessLevel: "restricted",
      declaredCapabilities: lib.capabilities ?? [],
      apiVersion: "1.0.0",
    });
  } catch (e) {
    link.release();
    releaseLink = null;
    throw e;
  }
  mounted = true;
  for (const d of defs) {
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
      // Bound to THIS install's instance so a later re-install cannot leave a
      // registered UDF pointing at a torn-down realm's address.
      implementation: (...args: unknown[]) =>
        callExposedMethod(LIB_OBJECT_TYPE, instanceId, upper, ...args),
    });
    registeredCleanups.push(cleanup);
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
// Worse than "unprompted": the merged record shares the SUBSCRIBER'S script id
// and therefore the subscriber's live capability grants. A subscriber who had
// granted their own functions bi.query was, without being asked, running a
// stranger's code with it. That is the confused deputy this project exists to
// refuse.
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
  const byPackage = new Map<string, CustomFunctionUdf[]>();
  for (const f of all) {
    const pkg = typeof f.sourcePackage === "string" ? f.sourcePackage.trim() : "";
    if (!pkg) continue;
    const list = byPackage.get(pkg) ?? [];
    list.push(f);
    byPackage.set(pkg, list);
  }
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

async function doInstall(lib: CustomFunctionLibrary): Promise<void> {
  // THE GATE. Everything below this line operates on the consented subset only.
  const { library: gated, pending } = await gateCustomFunctionLibrary(lib);
  if (pending.length > 0) {
    // Announce, do not block: the withheld functions simply are not mounted, so
    // their cells resolve to #NAME? until the user says yes. A listener (the
    // CustomFunctions extension) turns this into the prompt.
    emitAppEvent(CUSTOM_FUNCTIONS_CONSENT_NEEDED, { pending });
  }
  const defs = gated.functions.filter((d) => d.name.trim() && d.body.trim());
  // Generate (and VALIDATE) first — a bad name/param throws here, BEFORE any
  // teardown, so an invalid edit never tears down a working library.
  const source = defs.length ? generateLibrarySource(defs, gated.uses ?? []) : "";
  const prev = lastGood;
  try {
    await rawInstall(gated, source);
    lastGood = { lib: gated, source };
  } catch (e) {
    // Mount/compile failed — restore the previous good library rather than
    // leaving the user with NO functions.
    if (prev) {
      try {
        await rawInstall(prev.lib, prev.source);
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
export function installCustomFunctions(lib: CustomFunctionLibrary): Promise<void> {
  const run = () => doInstall(lib);
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
export async function loadAndInstallCustomFunctions(): Promise<void> {
  try {
    const lib = await loadPersistedLibrary();
    if (lib && lib.functions.length > 0) {
      await installCustomFunctions(lib);
    } else {
      uninstallCustomFunctions();
    }
  } catch (e) {
    console.error("[customFunctions] failed to install persisted functions", e);
  }
}

/** Unregister all custom-function UDFs and tear down the sandbox. */
export function uninstallCustomFunctions(): void {
  for (const fn of registeredCleanups) {
    try {
      fn();
    } catch {
      /* best-effort */
    }
  }
  registeredCleanups = [];
  if (releaseLink) {
    try {
      releaseLink();
    } catch {
      /* best-effort */
    }
    releaseLink = null;
  }
  if (mounted) {
    try {
      hostUnmountScript(LIB_SCRIPT_ID);
    } catch {
      /* best-effort */
    }
    mounted = false;
  }
}
