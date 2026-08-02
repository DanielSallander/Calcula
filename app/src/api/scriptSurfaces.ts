//! FILENAME: app/src/api/scriptSurfaces.ts
// PURPOSE: The single, queryable source of truth for every surface that runs
//          user- or extension-authored code in Calcula (Wave 3 / C3). The
//          governance is unified — ONE capability vocabulary (capabilityIds.ts),
//          one consent/provenance model, one transparency story — while
//          execution is deliberately heterogeneous (each surface has different
//          needs and constraints; see docs/design/script-sandbox-architecture.md
//          §0). This registry lets the transparency UI answer the vision's core
//          question — "where does code reside and what can it touch?" — from one
//          place, and a test keeps it in lockstep with the capability vocabulary.
//
// THE COMPLETENESS CONTRACT (why this file is more than a table of strings):
//   A membership guard ("every id I mention exists") can only catch a typo — it
//   can NEVER catch an UNDERSTATEMENT, which is the failure that actually hurts
//   the user: a row that promises less reach than the broker will really grant.
//   So the worker-realm rows are DERIVED-CHECKED against the enforcing code:
//   `brokerGatedCapabilities()` reads the ALLOWLIST policy table itself, and
//   `enforceableCapabilities()` folds in the mount-site ceiling + the broker's
//   automatic local grant. `auditScriptSurfaceCapabilities()` reports the delta
//   in both directions, and the tests fail on any `understated` entry — so a new
//   `cap.*` row in the allowlist breaks the build until this taxonomy is updated.

import { ALL_CAPABILITY_IDS, type CapabilityId } from "./scriptHost/capabilityIds";
import { ALLOWLIST } from "./scriptHost/allowlist";
import { extensionReachableCapabilities } from "./scriptHost/extensionProtocol";

export type ScriptRuntime =
  | "worker-realm" // per-script hardened Web Worker, broker-mediated
  | "rust-quickjs" // isolated Rust QuickJS interpreter over cloned state
  | "main-thread" // runs in the page (pure / data only)
  | "rust-native"; // first-party Rust (not a user-scripting surface)

export type ScriptSurfaceId =
  | "object-script"
  | "script-library"
  | "extension-worker"
  | "formula-udf"
  | "notebook-cell"
  | "one-off-script"
  | "chart-transform"
  | "chart-transform-sandbox"
  | "chart-mark"
  | "writeback-validator"
  | "mcp-tool";

export interface ScriptSurface {
  id: ScriptSurfaceId;
  /** Human label for the transparency UI. */
  label: string;
  runtime: ScriptRuntime;
  /** One-line containment summary. */
  containment: string;
  /**
   * Capabilities this surface can be granted (subset of the one vocabulary).
   * MUST be a superset of `enforceableCapabilities(surface)` — understating a
   * worker-realm row is a transparency defect, and the completeness guard below
   * fails the build for it. Overstating is merely stale (and reported too).
   */
  capabilities: CapabilityId[];
  /**
   * For worker-realm surfaces whose MOUNT SITE hard-codes the R19 declared
   * ceiling (rather than taking it from the author): the exact list it passes.
   * `undefined` means the ceiling is AUTHOR-declared (source pragmas / package
   * manifest / library definition), so everything the broker can gate is
   * reachable. Only chart marks fix it today (chartMarkScripts.ts rawInstall
   * passes `declaredCapabilities: []`).
   */
  mountCeiling?: readonly CapabilityId[];
  /** How execution is authorized. */
  gate: string;
  /** True when user/extension-authored IMPERATIVE code actually executes here
   *  (false for pure-declarative surfaces like chart transforms). */
  executesUserCode: boolean;
}

/**
 * What the broker automatically declares AND grants to every LOCAL (non-
 * distributed) worker-realm script, on top of whatever its mount declared —
 * see `buildHandleFromDefinition` in scriptHost/broker.ts. It is the reason a
 * "declares nothing" mount is still not a zero-capability mount. Pinned against
 * the broker by the taxonomy tests.
 */
export const BROKER_AUTO_LOCAL_CAPABILITIES: readonly CapabilityId[] = ["ui.html"];

export const SCRIPT_SURFACES: readonly ScriptSurface[] = [
  {
    id: "object-script",
    label: "Object scripts",
    runtime: "worker-realm",
    containment:
      "Per-script hardened worker; no DOM/Tauri; every privileged call broker-mediated. The R19 ceiling is AUTHOR-declared (source pragmas / package manifest), so any capability in the vocabulary is reachable once declared, consented and granted. Reading the workbook is governed by the TIER, not by a capability: a restricted script reads and writes its own sheet, an unlocked one any sheet — which is why `grid.read` is absent from this row and present on the sandboxed-extension row. Do not read that absence as 'an object script cannot see your cells'; read it as 'the question is answered by the tier and by who wrote the script'",
    // Author-declared ceiling => everything the ALLOWLIST can gate. bi.sql is
    // part of that (cap.biSql, tier "restricted"): raw read-only SQL against a
    // connection's database is a HIGHER-trust superset of bi.query, so it must
    // never be omitted here. So is distribution.writeback, whose publisher half
    // reads every respondent's submitted answers (Rust additionally requires
    // the package signing key, but the CEILING is what this row describes).
    capabilities: [
      "net.fetch",
      "bi.query",
      "bi.sql",
      "storage",
      "ui.html",
      "formula.udf",
      "bi.model",
      "bi.connector",
      "ui.dialog",
      "distribution.writeback",
      "schedule",
      "file.picker",
      "ui.shortcut",
      // The .calp package loop, split OUTBOUND / INBOUND. Both are broker-gated
      // (cap.pkg*) and therefore part of any author-declared ceiling, so
      // omitting either would understate this surface. The tier is what really
      // bounds them: every cap.pkg* row is "unlocked", and a DISTRIBUTED script
      // is forced restricted at pull — so a package's own scripts can never
      // publish or pull, which is what stops a package from propagating itself.
      "distribution.publish",
      "distribution.subscribe",
    ],
    gate: "Tier broker + R19 declared ceiling + per-package consent (JIT prompt for local scripts); net.fetch / bi.query / bi.sql / bi.model / bi.connector / distribution.writeback / schedule are re-checked authoritatively in Rust (schedule on every firing, so a revoke stops a job persisted in the workbook); file.picker is host-mediated — the broker gates the call and a native picker the USER drives chooses the file, so no path ever crosses; ui.shortcut is host-mediated too — the broker gates the binding and the ONE keydown listener in the app (api/keybindings.ts) owns dispatch, so a script is told only that its own Ctrl+Shift+<letter> fired",
    executesUserCode: true,
  },
  {
    id: "script-library",
    label: "Script libraries",
    runtime: "worker-realm",
    containment:
      "A third-party library imported with `// @uses` runs in its OWN hardened worker realm, never inside its consumer's — so its module state, its exceptions and its capability grants are all separate. Its R19 ceiling is `declared(library) INTERSECT declared(consumer)` (and, for a library's own dependency, INTERSECT its parent's), so importing a library can never hand a script reach the script did not itself declare. Only names the module marked `// @export` are routable, through one token-gated entry point. The exact bytes live in the workbook (.calcula/script-libs/<sha256>.js) and are re-hashed on every read",
    // The ceiling is AUTHOR-declared (source pragmas) exactly like an object
    // script's, so every broker-gated capability is reachable in principle —
    // what a GIVEN realm holds is the intersection, which is per-mount data and
    // therefore reported by the code inventory, not by this row. Understating
    // here would promise the user less than the broker would allow.
    capabilities: [
      "net.fetch",
      "bi.query",
      "bi.sql",
      "storage",
      "ui.html",
      "formula.udf",
      "bi.model",
      "bi.connector",
      "ui.dialog",
      "distribution.writeback",
      "schedule",
      "file.picker",
      "ui.shortcut",
      // The .calp package loop, split OUTBOUND / INBOUND. Both are broker-gated
      // (cap.pkg*) and therefore part of any author-declared ceiling, so
      // omitting either would understate this surface. The tier is what really
      // bounds them: every cap.pkg* row is "unlocked", and a DISTRIBUTED script
      // is forced restricted at pull — so a package's own scripts can never
      // publish or pull, which is what stops a package from propagating itself.
      "distribution.publish",
      "distribution.subscribe",
    ],
    gate: "Ed25519 signature + TOFU publisher pin at resolve (the SAME .calp trust root as report packages, no second signer), per-workbook consent keyed `lib:<package>` over the exact module sources, a version pin in .calcula/script-deps.json that mount never re-resolves against the registry, and then the tier broker + the INTERSECTED R19 ceiling. Calls in are authorized by an unguessable host-issued token, which is delegation-transparent but not caller-identifying — see docs/design/script-package-manager.md §10.4",
    executesUserCode: true,
  },
  {
    id: "extension-worker",
    label: "Sandboxed extensions",
    runtime: "worker-realm",
    containment:
      "A distributed extension that declares workerSupport runs its WHOLE activation in a per-extension hardened worker (scriptHost/worker/extensionWorkerContext.ts): no DOM, no Tauri, no direct grid — UI and data reach are message-passed to the host and every privileged call is broker-mediated. Its code lives in %APPDATA%/extensions, NOT in the workbook, so it is a script SURFACE without being an entry in the per-file code inventory",
    // The ceiling is the SIGNED MANIFEST's `capabilities` (extensionWorkerHost.ts
    // mountWorkerExtension -> buildHandleFromDefinition), NARROWED by
    // computeExtensionCeiling to what this surface can actually exercise.
    //
    // THIS ROW IS SHORTER THAN THE OBJECT-SCRIPT ROW ABOVE, ON PURPOSE. A
    // sandboxed extension reaches the broker only through EXTENSION_BROKER_METHODS,
    // a strict subset of the shared ALLOWLIST, so `ui.html`, `bi.connector` and
    // `ui.shortcut` have NO door here at all: ui.html addresses a shape instance
    // an extension does not own, bi.connector's two rows are object-script only,
    // and an extension's keyboard path is the DECLARATIVE keybinding contribution
    // (disclosed in the signed sidecar before the bundle runs), not the
    // imperative capability. Listing them cost nothing in reach and everything in
    // honesty: they appeared in the consent prompt's "Capabilities it can use"
    // line. Distributed provenance also means NO auto ui.html.
    //
    //
    // `grid.read` is on this row and on NO other, because this is the one
    // surface where the HOST PUSHES workbook data into code the user did not
    // write: a cellStyle contributor is handed the displayed value of every
    // visible cell, and a subscriber to the cell-change events is handed each
    // change's old value, new value and formula. Both are now gated on it
    // (CONTRIBUTION_REQUIRED_CAPABILITY + EXTENSION_PUSHED_DATA_CAPABILITIES),
    // and both are derived into `enforceableCapabilities`, so this row cannot
    // go quietly stale if either gate is removed.
    //
    // `enforceableCapabilities` derives this exact set for this surface id, so
    // the audit below compares the row against the code rather than against a
    // second copy of this comment.
    capabilities: [
      "net.fetch",
      "bi.query",
      "bi.sql",
      "storage",
      "formula.udf",
      "bi.model",
      "ui.dialog",
      "distribution.writeback",
      "schedule",
      "file.picker",
      "grid.read",
    ],
    gate: "Ed25519-signed sidecar manifest verified at scan (the manifest, not the bundle's self-report, is authoritative for id + ceiling; the signature must also cover the BUNDLE via codeHash, re-checked on every scan) + per-package consent; net.fetch / bi.query / bi.sql / bi.model / distribution.writeback / schedule re-checked authoritatively in Rust (schedule on every firing); file.picker is host-mediated (native picker, user chooses the file, no path crosses). grid.read is host-mediated too and gates the two paths by which the host hands this surface the user's cell contents: a cellStyle contribution is REFUSED outright without it (loudly — console, toast, manager row, audit), and a subscription to the cell-change events is delivered redacted to coordinates. Because an unsigned or tampered sidecar arrives with its capability list zeroed, an add-in nobody signed is never shown a single cell value. ui.shortcut is NOT reachable here: an extension's keyboard path is the declarative keybinding contribution, held to the same Ctrl+Shift+<letter> rule",
    executesUserCode: true,
  },
  {
    id: "formula-udf",
    label: "Formula user-defined functions",
    runtime: "worker-realm",
    containment:
      "Runs in the owning script's worker realm; invoked via formula.udf.invoke, pre-fetched before the synchronous recalc. The Custom Functions library is ONE mount whose ceiling is the library's declared capabilities, so a UDF body reaches whatever that library declared (cube.*/bi.query, raw bi.sql, net.fetch, ...) — not only formula.udf",
    // formula.udf gates the INVOCATION; the body's own reach is the library
    // mount's author-declared ceiling (customFunctions.ts rawInstall passes
    // `declaredCapabilities: lib.capabilities`, unfiltered), which can be any
    // capability in the vocabulary.
    capabilities: [
      "net.fetch",
      "bi.query",
      "bi.sql",
      "storage",
      "ui.html",
      "formula.udf",
      "bi.model",
      "bi.connector",
      "ui.dialog",
      "distribution.writeback",
      "schedule",
      "file.picker",
      "ui.shortcut",
      // The .calp package loop, split OUTBOUND / INBOUND. Both are broker-gated
      // (cap.pkg*) and therefore part of any author-declared ceiling, so
      // omitting either would understate this surface. The tier is what really
      // bounds them: every cap.pkg* row is "unlocked", and a DISTRIBUTED script
      // is forced restricted at pull — so a package's own scripts can never
      // publish or pull, which is what stops a package from propagating itself.
      "distribution.publish",
      "distribution.subscribe",
    ],
    gate: "Broker (declared + granted): formula.udf gates the invocation, the library mount's own R19 ceiling + grants gate what the body may touch",
    executesUserCode: true,
  },
  {
    id: "notebook-cell",
    label: "Notebook cells",
    runtime: "rust-quickjs",
    containment:
      "Isolated QuickJS over a clone of grid state; grid ops + read-only model.* (Rust-gated, RLS-enforced); no network / filesystem / Tauri",
    capabilities: ["bi.query", "bi.sql"],
    gate: "Coarse session approval (check_script_security) + JIT per-notebook capability consent (Rust CapabilityStore-enforced, audited)",
    executesUserCode: true,
  },
  {
    id: "one-off-script",
    label: "One-off scripts",
    runtime: "rust-quickjs",
    containment: "Ephemeral QuickJS over cloned state; grid-only, no ambient access (no model provider is installed for this surface)",
    capabilities: [],
    gate: "Coarse session approval (check_script_security)",
    executesUserCode: true,
  },
  {
    id: "chart-transform",
    label: "Chart transforms (built-in pipeline)",
    runtime: "main-thread",
    containment:
      "Pure data pipeline; calculate/filter expressions evaluate via the real Rust engine (@api evaluateScoped -> evaluate_scoped), not an in-extension evaluator. chartFormula is only a thin syntax adapter (variable-ref rewriting + coercion); no eval/new Function.",
    capabilities: [],
    gate: "n/a (pure declarative, not an execution surface)",
    executesUserCode: false,
  },
  {
    id: "chart-transform-sandbox",
    label: "Sandboxed chart transforms",
    runtime: "worker-realm",
    containment:
      "Per-library hardened worker; user-authored data->data transforms, broker-mediated capabilities. The whole library shares ONE mount whose R19 ceiling is the library's own declaration, so any capability in the vocabulary is reachable once declared and granted (e.g. bi.query for cube.*)",
    // chartTransformScripts.ts rawInstall passes `declaredCapabilities:
    // lib.capabilities` unfiltered => author-declared ceiling, same as object
    // scripts. Listing only net/bi/storage understated ui.html, formula.udf,
    // bi.model and bi.connector.
    capabilities: [
      "net.fetch",
      "bi.query",
      "bi.sql",
      "storage",
      "ui.html",
      "formula.udf",
      "bi.model",
      "bi.connector",
      "ui.dialog",
      "distribution.writeback",
      "schedule",
      "file.picker",
      "ui.shortcut",
      // The .calp package loop, split OUTBOUND / INBOUND. Both are broker-gated
      // (cap.pkg*) and therefore part of any author-declared ceiling, so
      // omitting either would understate this surface. The tier is what really
      // bounds them: every cap.pkg* row is "unlocked", and a DISTRIBUTED script
      // is forced restricted at pull — so a package's own scripts can never
      // publish or pull, which is what stops a package from propagating itself.
      "distribution.publish",
      "distribution.subscribe",
    ],
    gate: "Broker + R19 ceiling (the library's declaration) + per-package consent (distributed)",
    executesUserCode: true,
  },
  {
    id: "chart-mark",
    label: "Sandboxed chart marks",
    runtime: "worker-realm",
    containment:
      "Per-mark hardened worker; paint-only into the chart's clipped plot rect — returns only an ImageBitmap + hit geometry. The mount hard-codes an EMPTY declared ceiling, so no network / BI / storage is reachable; a LOCAL mark still inherits the broker's automatic ui.html (render.setHtml addresses a shape instance, so it is inert for a mark), and a distributed mark holds nothing at all",
    // The mount declares []; the broker adds ui.html to the ceiling AND the
    // grants of every non-distributed script, so a local mark really does hold
    // it. Stating "no capability" here would understate the broker's behavior.
    mountCeiling: [],
    capabilities: ["ui.html"],
    gate: "Broker with a hard-coded EMPTY declared ceiling (paint-only) + per-package consent (distributed)",
    executesUserCode: true,
  },
  {
    id: "writeback-validator",
    label: "Writeback validators",
    runtime: "rust-quickjs",
    containment:
      "A PUBLISHER-authored predicate that decides whether your writeback answers may be sent. The authoritative run is server-side, in the embedded Rust QuickJS interpreter, over an empty cloned grid with Calcula/model/display/console deleted before the publisher's code is evaluated — it sees one value at a time and returns accept or a message, nothing else. The same body ALSO mounts (advisory, for as-you-type feedback) in a hardened worker realm with an EMPTY declared ceiling and distributed provenance, so the broker denies every privileged call. The body is read from the Ed25519-verified version manifest, so what the consent prompt shows is byte-identical to what runs",
    // Both realms give it nothing: the QuickJS realm deletes every host global
    // before evaluation, and the worker mount declares [] with distributed
    // provenance (so it does not even receive the broker's automatic local
    // ui.html). Declaring [] here is therefore the honest row, and — because
    // this surface is not `worker-realm` — it is also what the completeness
    // guard checks it against.
    capabilities: [],
    gate: "Per-package consent keyed by SHA-256 of the exact body (.calcula/script-consent.json, '<package>::writeback-validators'); the Rust submit path FAILS CLOSED — no body, no consent, a throw, a timeout or a junk return all refuse the submission before any registry write",
    executesUserCode: true,
  },
  {
    id: "mcp-tool",
    label: "MCP tools",
    runtime: "rust-quickjs",
    containment:
      "First-party Rust tool bodies; the execute_script tool runs AGENT-authored JS in the same isolated QuickJS interpreter as one-off scripts (cloned grid state, grid-only — no model provider, no network / filesystem / Tauri), writes replay through the normal undo + recalc pipeline, and sensitive commands stay main-window-guarded",
    capabilities: [],
    gate: "Window-label guard + AI access ceiling (check_mcp_access: read / mutate / script) + session approval (check_script_security) for the script tier; mutating tools audited",
    // execute_script hands arbitrary agent-authored JS to
    // script_engine::ScriptEngine::run — imperative user (agent) code really
    // does execute on this surface, so claiming otherwise understated it.
    executesUserCode: true,
  },
];

/** Look up a surface by id. */
export function getScriptSurface(id: ScriptSurfaceId): ScriptSurface | undefined {
  return SCRIPT_SURFACES.find((s) => s.id === id);
}

/** Surfaces that actually execute user/extension imperative code. */
export function executableScriptSurfaces(): ScriptSurface[] {
  return SCRIPT_SURFACES.filter((s) => s.executesUserCode);
}

// ============================================================================
// Derivation: what the ENFORCING code can actually grant
// ============================================================================

/** Vocabulary position, for a stable canonical ordering of capability lists. */
const VOCABULARY_ORDER = new Map<string, number>(ALL_CAPABILITY_IDS.map((id, i) => [id, i]));

/**
 * De-duplicate + order a capability list canonically (vocabulary order; ids the
 * vocabulary does not know come last, alphabetically). Ordering is total — an
 * id that leaked into the allowlist WITHOUT being in the vocabulary is still
 * reported rather than silently dropped, so the two guards can't hide for each
 * other.
 */
function orderCapabilities(ids: Iterable<CapabilityId>): CapabilityId[] {
  return [...new Set(ids)].sort((a, b) => {
    const ia = VOCABULARY_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = VOCABULARY_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ia === ib ? a.localeCompare(b) : ia - ib;
  });
}

/**
 * Every capability the BROKER can gate, derived from the ALLOWLIST policy table
 * itself (the `capability` field of each MethodPolicy). This is the ceiling of
 * ceilings for a worker-realm script: declare it, get it consented, and the
 * broker will let the call through.
 *
 * Derived, never hand-maintained — adding a `cap.*` row that names a NEW
 * capability grows this set immediately, which makes the taxonomy's worker-realm
 * rows fail their completeness test until they are updated.
 */
export function brokerGatedCapabilities(): CapabilityId[] {
  const gated: CapabilityId[] = [];
  for (const policy of Object.values(ALLOWLIST)) {
    if (policy.capability) gated.push(policy.capability);
  }
  return orderCapabilities(gated);
}

/**
 * The MOST a script on `surface` can ever hold, derived from the code that
 * actually enforces it:
 *  - worker-realm  : the broker-gated set, narrowed by the mount site's
 *                    hard-coded ceiling (when it has one) and widened by the
 *                    broker's automatic local grant.
 *  - everything else: the broker is NOT their gate (the Rust CapabilityStore is,
 *                    for notebooks; the other rows execute no capability-bearing
 *                    code at all), and Rust policy cannot be derived from TS — so
 *                    the row's own declaration stands and is pinned by its own
 *                    dedicated test instead.
 */
export function enforceableCapabilities(surface: ScriptSurface): CapabilityId[] {
  if (surface.runtime !== "worker-realm") {
    return orderCapabilities(surface.capabilities);
  }
  // A sandboxed extension does not reach the whole ALLOWLIST: handleBrokerCall
  // rejects anything outside EXTENSION_BROKER_METHODS before the broker sees it,
  // so several capabilities have no door on this surface at all. Deriving from
  // the broker-gated set alone overstated this row by three ids (ui.html,
  // bi.connector, ui.shortcut) — reach the consent prompt named and the broker
  // refused. The narrower set is derived too, so it cannot go stale.
  if (surface.id === "extension-worker") {
    return orderCapabilities([...extensionReachableCapabilities()]);
  }
  const gated = new Set(brokerGatedCapabilities());
  if (!surface.mountCeiling) {
    return orderCapabilities(gated);
  }
  const ceiling = new Set<CapabilityId>([
    ...surface.mountCeiling,
    ...BROKER_AUTO_LOCAL_CAPABILITIES,
  ]);
  return orderCapabilities([...ceiling].filter((c) => gated.has(c)));
}

/** Per-surface comparison of the DECLARED taxonomy against the enforcing code. */
export interface ScriptSurfaceCapabilityAudit {
  surfaceId: ScriptSurfaceId;
  /** What the taxonomy row promises the surface can be granted. */
  declared: CapabilityId[];
  /** What the enforcing code can actually grant it. */
  enforceable: CapabilityId[];
  /** enforceable minus declared — the surface UNDERSTATES its reach (a
   *  transparency defect: the panel would promise less than the broker allows). */
  understated: CapabilityId[];
  /** declared minus enforceable — an overstatement: safe for the user, but a
   *  stale row (the capability can no longer be granted here). */
  overstated: CapabilityId[];
}

/** Compare every row against the enforcing code. Shared by the transparency UI
 *  and the taxonomy tests, so both see the same derivation. */
export function auditScriptSurfaceCapabilities(): ScriptSurfaceCapabilityAudit[] {
  return SCRIPT_SURFACES.map((surface) => {
    const declared = orderCapabilities(surface.capabilities);
    const enforceable = enforceableCapabilities(surface);
    const declaredSet = new Set(declared);
    const enforceableSet = new Set(enforceable);
    return {
      surfaceId: surface.id,
      declared,
      enforceable,
      understated: enforceable.filter((c) => !declaredSet.has(c)),
      overstated: declared.filter((c) => !enforceableSet.has(c)),
    };
  });
}

/** True iff every capability referenced by a surface is in the one vocabulary —
 *  guards the taxonomy against drifting from capabilityIds.ts. (Membership only:
 *  it cannot see an understatement — use the completeness guard for that.) */
export function scriptSurfacesReferenceOnlyKnownCapabilities(): boolean {
  const known = new Set<string>(ALL_CAPABILITY_IDS);
  return SCRIPT_SURFACES.every((s) => s.capabilities.every((c) => known.has(c)));
}

/** True iff NO surface understates its reach — i.e. every row lists at least
 *  everything the enforcing code can grant it. This is the transparency-critical
 *  direction: a row that promises too little is a lie to the user, and it lies in
 *  the safe-LOOKING direction where nothing else would notice. */
export function scriptSurfaceCapabilitiesAreComplete(): boolean {
  return auditScriptSurfaceCapabilities().every((a) => a.understated.length === 0);
}
