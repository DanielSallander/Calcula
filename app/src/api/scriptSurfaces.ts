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

export type ScriptRuntime =
  | "worker-realm" // per-script hardened Web Worker, broker-mediated
  | "rust-quickjs" // isolated Rust QuickJS interpreter over cloned state
  | "main-thread" // runs in the page (pure / data only)
  | "rust-native"; // first-party Rust (not a user-scripting surface)

export type ScriptSurfaceId =
  | "object-script"
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
      "Per-script hardened worker; no DOM/Tauri; every privileged call broker-mediated. The R19 ceiling is AUTHOR-declared (source pragmas / package manifest), so any capability in the vocabulary is reachable once declared, consented and granted",
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
    ],
    gate: "Tier broker + R19 declared ceiling + per-package consent (JIT prompt for local scripts); net.fetch / bi.query / bi.sql / bi.model / bi.connector / distribution.writeback / schedule are re-checked authoritatively in Rust (schedule on every firing, so a revoke stops a job persisted in the workbook)",
    executesUserCode: true,
  },
  {
    id: "extension-worker",
    label: "Sandboxed extensions",
    runtime: "worker-realm",
    containment:
      "A distributed extension that declares workerSupport runs its WHOLE activation in a per-extension hardened worker (scriptHost/worker/extensionWorkerContext.ts): no DOM, no Tauri, no direct grid — UI and data reach are message-passed to the host and every privileged call is broker-mediated. Its code lives in %APPDATA%/extensions, NOT in the workbook, so it is a script SURFACE without being an entry in the per-file code inventory",
    // The ceiling is the SIGNED MANIFEST's `capabilities` (extensionWorkerHost.ts
    // mountWorkerExtension -> buildHandleFromDefinition), i.e. author-declared:
    // nothing narrows it, so the whole broker-gated vocabulary is reachable once
    // declared and consented. Distributed provenance means NO auto ui.html.
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
    ],
    gate: "Ed25519-signed sidecar manifest verified at scan (the manifest, not the bundle's self-report, is authoritative for id + ceiling) + per-package consent; net.fetch / bi.query / bi.sql / bi.model / bi.connector / distribution.writeback / schedule re-checked authoritatively in Rust (schedule on every firing)",
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
