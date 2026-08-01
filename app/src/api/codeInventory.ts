//! FILENAME: app/src/api/codeInventory.ts
// PURPOSE: The single, unified inventory of every piece of executable code that
//          resides in the open workbook — the data behind the "Code in This
//          File" transparency inspector (T1). It makes the vision's core
//          question answerable from one call: "where does code reside and what
//          can it touch?"
// CONTEXT: Joins the three persisted code populations — object scripts
//          (worker-realm), module scripts and notebooks (isolated Rust QuickJS,
//          grid-only) — and classifies each into its ScriptSurface from the
//          governance taxonomy (scriptSurfaces.ts), so that taxonomy finally
//          has a concrete, per-file UI consumer. Live tier/grant state is
//          joined from the broker's mounted handles where available.
//
//          Design notes:
//          - The Rust-QuickJS surfaces declare NO capability ceiling, but only
//            the one-off/module surface is grid-only by construction (no model
//            provider is installed for it). A NOTEBOOK can be granted bi.query /
//            bi.sql just-in-time, and that grant is recorded only in the Rust
//            CapabilityStore — so notebook reach is read live from there rather
//            than assumed to be []. Object scripts carry the R19 declared
//            ceiling, the only surface where reach is known before it runs.
//          - We deliberately do NOT enumerate getAllCustomFunctions(): that
//            registry is dominated by built-in extension functions (PMT, NPV,
//            STDEV, ...) which are app code, not "code in THIS file"; listing
//            them would mislead. UDFs registered by an object script are already
//            represented by that owning object script.
//          - It also answers the question the code list alone cannot: "what
//            runs WITHOUT me asking?". Scheduled jobs (the `schedule`
//            capability — Calcula's Application.OnTime replacement) are joined
//            in here and rendered by the same transparency panel, because a
//            persistent, self-starting job the user can neither see nor stop is
//            precisely the VBA failure mode this product exists to fix. Jobs are
//            owned by a code unit, so this module — which already knows every
//            unit — is where the owner join belongs.
//          - We DO enumerate the user-authored Custom Functions library (the
//            formula-udf surface): each function body runs in the worker realm
//            under the library's declared ceiling (e.g. bi.query for cube.*), so
//            its code and reach must be visible here, never hidden. The raw JSON
//            store record is filtered out of the module list (it is data, not
//            code) — we surface the parsed functions instead.
//          - The Rust-QuickJS surfaces' reach is DERIVED, not asserted. It used
//            to be a hand-written "grid-only" comment on this file, which is the
//            one link in the transparency chain nothing verified: an op module
//            could grow a new privileged reach and the panel would keep saying
//            "grid-only". QUICKJS_SURFACE_REACH below mirrors the interpreter's
//            own op/reach manifest (core/script-engine/src/manifest.rs), which a
//            Rust test diffs against the LIVE registered surface and a TS test
//            (__tests__/interpreterReachDrift.test.ts) diffs against this file.

import type { ScriptSurfaceId } from "./scriptSurfaces";
import type { CapabilityId } from "./scriptHost/capabilityIds";
import { loadAllObjectScripts } from "./objectScriptBackend";
import {
  listModuleScripts,
  getModuleScript,
  describeModuleScriptScope,
} from "./moduleScriptBackend";
import { listNotebooks, loadNotebook } from "./notebookBackend";
import { listMountedHandles } from "./scriptHost/broker";
import { listBackendCapabilityGrants } from "./scriptHost/capabilities";
import { loadPersistedLibrary, CUSTOM_FUNCTIONS_SCRIPT_ID } from "./customFunctions";
import { loadPersistedTransformLibraryWithProvenance, CHART_TRANSFORMS_SCRIPT_ID } from "./chartTransformScripts";
import { loadPersistedMarkLibraryWithProvenance, markScriptId } from "./chartMarkScripts";
import { mountedWritebackValidators } from "./writebackValidators";
import { listAllScheduledJobs, type ScheduledJob } from "./scriptHost/scheduler";
import { listScriptKeybindings } from "./keybindings";
import { listInstalledLibraries, listLibraryRealms, readLockedSource } from "./scriptLibraries";
import { invokeBackend } from "./backend";

// The trusted-UI half of the scheduler is re-exported through the inventory so
// that a transparency surface has ONE door for both halves of the promise:
// seeing what runs (getWorkbookScheduledJobs) and stopping it (these two).
// Visibility without control would still leave the user unable to say no.
export { cancelScheduledJob, setScheduledJobEnabled } from "./scriptHost/scheduler";
export type { ScheduledJob } from "./scriptHost/scheduler";

// Same reasoning, same door: a shortcut a script holds must be revocable from
// the surface that shows it. `revokeScriptKeybinding` is the trusted-UI half of
// the `ui.shortcut` capability (keybindings.ts rule 4).
export { revokeScriptKeybinding } from "./keybindings";
export type { ScriptKeybinding } from "./keybindings";

// ===========================================================================
// Interpreter-derived reach for the Rust-QuickJS surfaces
// ---------------------------------------------------------------------------
// GROUND TRUTH: core/script-engine/src/manifest.rs. Every constant in this
// block mirrors it, and app/src/api/__tests__/interpreterReachDrift.test.ts
// reads that Rust file and fails if they diverge — naming this block as the fix
// site. Do not "correct" a value here to make a test pass: the interpreter is
// authoritative, so either the manifest row is right and this mirror is stale,
// or a new op genuinely widened a sandbox and the FIX IS IN RUST.
// ===========================================================================

/** What sandboxed code on the Rust-QuickJS interpreter can touch. Mirrors
 *  `ReachClass::as_str()` in core/script-engine/src/manifest.rs. */
export type InterpreterReachClass =
  /** Cells, formulas, ranges, fills and style application in the CLONED grid. */
  | "grid"
  /** Sheets, visibility, document properties, named styles, calc settings. */
  | "workbook"
  /** View/UX state applied by the host after the run (zoom, status bar, ...). */
  | "view"
  /** Cell and view bookmarks. */
  | "bookmarks"
  /** Console lines and structured tables returned to the caller. */
  | "output"
  /** Read-only application/locale metadata. */
  | "appMetadata"
  /** Read-only BI/semantic-model data — the ONLY class that leaves the clone. */
  | "model";

/** The surfaces that run on the Rust-QuickJS interpreter. `Extract` (rather
 *  than a fresh union) so renaming a ScriptSurfaceId breaks the build here
 *  instead of silently dropping a surface out of the reach mirror. */
export type QuickJsSurfaceId = Extract<
  ScriptSurfaceId,
  "notebook-cell" | "one-off-script" | "mcp-tool" | "writeback-validator"
>;

/**
 * Every reach class each Rust-QuickJS surface actually has, derived from the
 * interpreter's manifest AND from how the host builds that surface's realm:
 *
 *  - notebook-cell       : a ModelDataProvider IS injected
 *                          (scripting/notebook_executor.rs), so `model` is in.
 *  - one-off-script      : `ScriptEngine::run_with_options` installs NO provider,
 *  - mcp-tool            : likewise — the model ops are registered on every
 *                          surface and THROW without a provider, so these two
 *                          are grid-only by construction, not by assertion.
 *  - writeback-validator : the submit harness deletes the host globals before
 *                          the publisher's code is evaluated, so it reaches
 *                          nothing at all.
 *
 * Classes are listed in manifest order (grid outwards).
 */
export const QUICKJS_SURFACE_REACH: Record<QuickJsSurfaceId, readonly InterpreterReachClass[]> = {
  "notebook-cell": ["grid", "workbook", "view", "bookmarks", "output", "appMetadata", "model"],
  "one-off-script": ["grid", "workbook", "view", "bookmarks", "output", "appMetadata"],
  "mcp-tool": ["grid", "workbook", "view", "bookmarks", "output", "appMetadata"],
  "writeback-validator": [],
};

/**
 * The capability ids each Rust-QuickJS surface's reach can demand — i.e. what a
 * just-in-time consent prompt on that surface may ever ask for. Empty is the
 * honest, DERIVED form of the "grid-only" claim: not "we believe it is
 * grid-only", but "no op reachable from this realm is capability-gated".
 *
 * These are CEILINGS, not grants: a notebook holds nothing until the user
 * approves a prompt, and the grant then lives in the Rust CapabilityStore (read
 * live into `liveGrants`).
 */
export const QUICKJS_SURFACE_CAPABILITIES: Record<QuickJsSurfaceId, readonly CapabilityId[]> = {
  "notebook-cell": ["bi.query", "bi.sql"],
  "one-off-script": [],
  "mcp-tool": [],
  "writeback-validator": [],
};

/** Human phrasing for one reach class — the panel must never render the raw
 *  wire name at the user. */
const REACH_LABELS: Record<InterpreterReachClass, string> = {
  grid: "cell values and formulas (a private copy of the grid)",
  workbook: "workbook structure and calculation settings",
  view: "view state (zoom, gridlines, status bar, navigation)",
  bookmarks: "cell and view bookmarks",
  output: "console and table output back to you",
  appMetadata: "read-only app and locale metadata",
  model: "read-only BI model data — only after you approve it",
};

/**
 * One sentence describing what code on a Rust-QuickJS surface can touch, built
 * from the interpreter manifest rather than from prose. Used by the
 * transparency panel so the sentence cannot drift from the sandbox.
 */
export function describeInterpreterReach(
  reach: readonly InterpreterReachClass[],
): string {
  if (reach.length === 0) {
    return "Nothing: this code runs in a bare JavaScript realm with every Calcula global removed.";
  }
  const parts = reach.map((r) => REACH_LABELS[r]);
  const last = parts.pop() as string;
  return parts.length === 0 ? `Can touch ${last}.` : `Can touch ${parts.join(", ")} and ${last}.`;
}

/** One normalized code unit residing in the open workbook. */
export interface CodeUnit {
  /** Which governance surface this code runs on (scriptSurfaces.ts). */
  surfaceId: ScriptSurfaceId;
  /** Stable id of the underlying script/notebook. */
  id: string;
  /** Display name. */
  name: string;
  /** Human one-liner for WHERE this code resides (the "never hidden" answer). */
  residence: string;
  /** Authored here (local) vs arrived in a distributed .calp package. */
  provenance: "local" | "distributed";
  /** The .calp package this came from, when distributed; else null. */
  sourcePackage: string | null;
  /** The R19 declared-capability CEILING — the MOST this code may ever touch.
   *  Empty on surfaces that declare nothing up front: the Rust-QuickJS
   *  surfaces grant capabilities JUST IN TIME instead, so their reach shows up
   *  in `liveGrants`, not here. */
  declaredCapabilities: CapabilityId[];
  /** Capabilities GRANTED right now: from the broker for worker-realm scripts,
   *  from the Rust CapabilityStore for notebooks (their only grant record).
   *  null when the surface has no grant concept or nothing is mounted. */
  liveGrants: CapabilityId[] | null;
  /** restricted = own-object reach only; unlocked = cross-object. null when the
   *  surface has no tier concept. */
  tier: "restricted" | "unlocked" | null;
  /** Whether this code is currently mounted/active in the broker. */
  mounted: boolean;
  /**
   * For code running on the Rust-QuickJS interpreter: the reach classes that
   * surface actually has, DERIVED from the interpreter's op manifest and from
   * whether the host injects a model provider / deletes the host globals.
   * `null` on worker-realm surfaces, whose reach is the broker's business
   * (declaredCapabilities + liveGrants describe those completely).
   */
  interpreterReach: readonly InterpreterReachClass[] | null;
  /**
   * For Rust-QuickJS code: the capability ids this surface's reach can ever
   * demand (the JIT-consent CEILING). `null` on worker-realm surfaces.
   * Empty array = the derived, verified form of "grid-only".
   */
  interpreterCapabilities: readonly CapabilityId[] | null;
  /** The full source text — shown inline so code is never hidden in the file. */
  source: string;
  /** Lines of source (a size-at-a-glance signal). */
  lineCount: number;
}

/** A roll-up of an inventory for the panel header. */
export interface CodeInventorySummary {
  total: number;
  local: number;
  distributed: number;
  /** Units whose declared ceiling lets them reach beyond grid state. */
  beyondGrid: number;
  /** Units that COULD reach beyond grid state — including a Rust-QuickJS unit
   *  that holds no grant yet but whose surface can be granted one just in time.
   *  Always >= beyondGrid; the gap is "what a prompt could still turn on". */
  beyondGridCapable: number;
  /** Units currently mounted/active. */
  mounted: number;
  /** Units grouped by surface, in the taxonomy's canonical order. */
  bySurface: { surfaceId: ScriptSurfaceId; units: CodeUnit[] }[];
}

/** True iff a unit can reach outside grid state (network, BI, storage, host
 *  HTML, a modal that interrupts you) — either through its declared ceiling or
 *  through a capability granted
 *  to it right now. Both matter: a notebook declares NOTHING and is granted
 *  bi.query/bi.sql at run time, so a declared-only test called it "grid-only"
 *  while it was querying the BI model. */
export function codeUnitReachesBeyondGrid(unit: CodeUnit): boolean {
  return unit.declaredCapabilities.length > 0 || (unit.liveGrants?.length ?? 0) > 0;
}

/**
 * True iff the unit could reach beyond grid state — right now, OR after a
 * just-in-time consent prompt its surface is allowed to raise.
 *
 * This is the CEILING question, and it is deliberately separate from
 * `codeUnitReachesBeyondGrid` (the "right now" question). A notebook holding no
 * grant answers false there and true here: nothing has been approved yet, but
 * the surface can ask, and a transparency panel that only ever showed the
 * "right now" answer would let a user conclude a notebook is incapable of
 * touching the BI model when in fact one click stands between it and the data.
 */
export function codeUnitMayReachBeyondGrid(unit: CodeUnit): boolean {
  return (
    codeUnitReachesBeyondGrid(unit) || (unit.interpreterCapabilities?.length ?? 0) > 0
  );
}

const lineCount = (source: string): number =>
  source.length === 0 ? 0 : source.split("\n").length;

const titleCase = (s: string): string =>
  s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);

/** Tolerantly run a population fetch; an empty/missing population (or a backend
 *  that is not wired in a given window) yields [] rather than failing the whole
 *  inventory. */
async function safely<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (e) {
    console.warn(`[codeInventory] ${label} unavailable:`, e);
    return [];
  }
}

/**
 * Gather every piece of executable code residing in the open workbook, joined
 * with live broker state, normalized into one CodeUnit[]. Ordered by surface
 * (object scripts, then the grid-only Rust-QuickJS surfaces) then by name.
 */
export async function getWorkbookCodeUnits(): Promise<CodeUnit[]> {
  const [objectScripts, moduleSummaries, notebookSummaries, lockedLibraries, mounted] =
    await Promise.all([
      safely("object scripts", loadAllObjectScripts),
      safely("module scripts", listModuleScripts),
      safely("notebooks", listNotebooks),
      safely("script libraries", listInstalledLibraries),
      Promise.resolve(listMountedHandles()),
    ]);

  // scriptId -> live broker handle, for the tier/grant join.
  const handleById = new Map(mounted.map((h) => [h.scriptId, h]));

  const units: CodeUnit[] = [];

  // ---- Object scripts (worker-realm; the only surface with a real ceiling) --
  for (const s of objectScripts) {
    const handle = handleById.get(s.id);
    const declared = (s.declaredCapabilities ?? []) as CapabilityId[];
    const provenance: "local" | "distributed" =
      s.provenance === "distributed" || s.packageName ? "distributed" : "local";
    units.push({
      surfaceId: "object-script",
      id: s.id,
      name: s.name,
      residence: s.instanceId
        ? `${titleCase(s.objectType)} instance ${s.instanceId}`
        : `${titleCase(s.objectType)}-level script`,
      provenance,
      sourcePackage: s.packageName ?? null,
      declaredCapabilities: declared,
      liveGrants: handle ? ([...handle.grants] as CapabilityId[]) : null,
      tier: handle ? handle.tier : s.accessLevel === "unlocked" ? "unlocked" : "restricted",
      mounted: !!handle,
      // Worker realm, not the Rust interpreter: the broker is the whole story.
      interpreterReach: null,
      interpreterCapabilities: null,
      source: s.source,
      lineCount: lineCount(s.source),
    });
  }

  // ---- Script libraries (worker realms; third-party code living IN the file) --
  //
  // A library is imported with `// @uses`, so no object script's source contains
  // it — yet its exact bytes are in this workbook (.calcula/script-libs/) and it
  // executes here. Leaving it out would be the single biggest hole in "the user
  // can always discover what code exists": the most likely place for hostile
  // third-party code to sit is precisely a dependency nobody typed.
  //
  // The CEILING shown is the LOCKED module's own declaration; the GRANTS shown
  // are the live realm's, which is the intersection with whichever consumer
  // pulled it in. They differ on purpose — that gap is the narrowing, and the
  // panel should show it rather than pick one.
  const realmsByPackage = new Map<string, ReturnType<typeof listLibraryRealms>[number]>();
  for (const realm of listLibraryRealms()) {
    // A package can hold several realms (different consumers, different
    // ceilings). Show the WIDEST — understating what is running is the failure
    // mode that matters.
    const prior = realmsByPackage.get(realm.package);
    if (!prior || realm.capabilities.length > prior.capabilities.length) {
      realmsByPackage.set(realm.package, realm);
    }
  }
  for (const lib of lockedLibraries) {
    const realm = realmsByPackage.get(lib.package) ?? null;
    for (const mod of lib.modules) {
      let source = "";
      try {
        source = await readLockedSource(mod.sourceHash);
      } catch (e) {
        // An unreadable/tampered blob must be VISIBLE, not omitted: an entry the
        // panel silently drops is exactly the thing an attacker wants.
        source = `// [the cached source for this module could not be verified: ${
          e instanceof Error ? e.message : String(e)
        }]`;
      }
      units.push({
        surfaceId: "script-library",
        id: `${lib.package}@${lib.resolved}/${mod.id}`,
        name: `${mod.name} (${lib.package}@${lib.resolved})`,
        residence: `Library module — imported with // @uses, cached in .calcula/script-libs/${mod.sourceHash.slice(0, 12)}…`,
        provenance: "distributed",
        sourcePackage: lib.package,
        declaredCapabilities: [...mod.capabilities],
        liveGrants: realm ? [...realm.capabilities] : null,
        tier: realm ? realm.tier : null,
        mounted: realm !== null,
        interpreterReach: null,
        interpreterCapabilities: null,
        source,
        lineCount: lineCount(source),
      });
    }
  }

  // ---- Module scripts (Rust QuickJS; grid-only, no privileged capabilities) -
  const modules = await Promise.all(
    moduleSummaries.map(async (m) => {
      try {
        return await getModuleScript(m.id);
      } catch (e) {
        console.warn(`[codeInventory] module "${m.name}" source unavailable:`, e);
        return null;
      }
    }),
  );
  for (let i = 0; i < moduleSummaries.length; i++) {
    const summary = moduleSummaries[i];
    const full = modules[i];
    const source = full?.source ?? "";
    const pkg = full?.sourcePackage ?? null;
    units.push({
      surfaceId: "one-off-script",
      id: summary.id,
      name: summary.name,
      residence: `Module — ${describeModuleScriptScope(summary.scope)}`,
      provenance: pkg ? "distributed" : "local",
      sourcePackage: pkg,
      // The one-off surface declares no R19 ceiling; what it can touch is a
      // property of the interpreter + the host's construction of the realm,
      // read below from the manifest mirror instead of asserted here.
      declaredCapabilities: [],
      liveGrants: null,
      tier: null,
      mounted: false,
      interpreterReach: QUICKJS_SURFACE_REACH["one-off-script"],
      interpreterCapabilities: QUICKJS_SURFACE_CAPABILITIES["one-off-script"],
      source,
      lineCount: lineCount(source),
    });
  }

  // ---- Notebooks (Rust QuickJS; grid + JIT-granted BI reach) ---------------
  const notebooks = await Promise.all(
    notebookSummaries.map(async (n) => {
      try {
        return await loadNotebook(n.id);
      } catch (e) {
        console.warn(`[codeInventory] notebook "${n.name}" source unavailable:`, e);
        return null;
      }
    }),
  );
  // A notebook's consent grants live ONLY in the Rust CapabilityStore, keyed by
  // the surface id the provider checks ("notebook:<id>"). Best-effort: a window
  // without the backend wired reports "nothing granted" rather than failing.
  const notebookGrants = await Promise.all(
    notebookSummaries.map(async (n) => {
      try {
        return await listBackendCapabilityGrants(`notebook:${n.id}`);
      } catch {
        return [] as CapabilityId[];
      }
    }),
  );
  for (let i = 0; i < notebookSummaries.length; i++) {
    const summary = notebookSummaries[i];
    const full = notebooks[i];
    // Concatenate cell sources with a separator so the inline view shows the
    // whole notebook's code in execution order.
    const source = full
      ? full.cells
          .map((c, idx) => `// --- cell ${idx + 1} ---\n${c.source}`)
          .join("\n\n")
      : "";
    const pkg = full?.sourcePackage ?? null;
    units.push({
      surfaceId: "notebook-cell",
      id: summary.id,
      name: summary.name,
      residence: `Notebook — ${summary.cellCount} cell${
        summary.cellCount === 1 ? "" : "s"
      }`,
      provenance: pkg ? "distributed" : "local",
      sourcePackage: pkg,
      // A notebook declares no ceiling: bi.query / bi.sql are granted JIT and
      // recorded ONLY in the Rust CapabilityStore, so the live grants (read
      // above) are the whole truth about its reach.
      declaredCapabilities: [],
      liveGrants: notebookGrants[i],
      tier: null,
      mounted: false,
      // A notebook IS handed a ModelDataProvider, so unlike the one-off surface
      // its realm really can reach the BI model once a prompt is approved.
      interpreterReach: QUICKJS_SURFACE_REACH["notebook-cell"],
      interpreterCapabilities: QUICKJS_SURFACE_CAPABILITIES["notebook-cell"],
      source,
      lineCount: lineCount(source),
    });
  }

  // ---- Custom functions (formula-udf surface; worker-realm, declared ceiling) -
  // Each user-authored UDF body runs in the same hardened worker realm under the
  // library's declared capabilities (e.g. bi.query for cube.*). The whole library
  // shares ONE mount, so the live tier/grant join uses that single handle.
  const customLib = await safely("custom functions", async () => {
    const lib = await loadPersistedLibrary();
    return lib ? [lib] : [];
  });
  const libHandle = handleById.get(CUSTOM_FUNCTIONS_SCRIPT_ID);
  for (const lib of customLib) {
    const declared = (lib.capabilities ?? []) as CapabilityId[];
    for (const fn of lib.functions) {
      const name = fn.name.trim();
      if (!name) continue;
      const params = fn.params.map((p) => p.trim()).filter(Boolean);
      // Show the code as a readable function rather than the raw stored body.
      const source = `function ${name.toUpperCase()}(${params.join(", ")}) {\n${fn.body}\n}`;
      units.push({
        surfaceId: "formula-udf",
        id: `${CUSTOM_FUNCTIONS_SCRIPT_ID}::${name.toUpperCase()}`,
        name: `${name.toUpperCase()}(${params.join(", ")})`,
        residence: "Custom Function — worker-realm sandbox",
        provenance: "local",
        sourcePackage: null,
        declaredCapabilities: declared,
        liveGrants: libHandle ? ([...libHandle.grants] as CapabilityId[]) : null,
        tier: libHandle ? libHandle.tier : "restricted",
        mounted: !!libHandle,
        interpreterReach: null,
        interpreterCapabilities: null,
        source,
        lineCount: lineCount(source),
      });
    }
  }

  // ---- Sandboxed chart transforms (worker-realm; may declare a real ceiling) --
  // The whole library shares ONE mount under CHART_TRANSFORMS_SCRIPT_ID; each
  // user-authored transform body runs in that worker under the library's declared
  // capabilities (e.g. bi.query for cube.*). Provenance is the .calp it came from.
  const transformLib = await safely("chart transforms", async () => {
    const res = await loadPersistedTransformLibraryWithProvenance();
    return res ? [res] : [];
  });
  const transformHandle = handleById.get(CHART_TRANSFORMS_SCRIPT_ID);
  for (const { lib, sourcePackage } of transformLib) {
    const declared = (lib.capabilities ?? []) as CapabilityId[];
    for (const t of lib.transforms) {
      const type = t.type.trim();
      if (!type) continue;
      const source = t.body;
      units.push({
        surfaceId: "chart-transform-sandbox",
        id: `${CHART_TRANSFORMS_SCRIPT_ID}::${type}`,
        name: t.label?.trim() || type,
        residence: "Chart transform — worker-realm sandbox",
        provenance: sourcePackage ? "distributed" : "local",
        sourcePackage,
        declaredCapabilities: declared,
        liveGrants: transformHandle ? ([...transformHandle.grants] as CapabilityId[]) : null,
        tier: transformHandle ? transformHandle.tier : "restricted",
        mounted: !!transformHandle,
        interpreterReach: null,
        interpreterCapabilities: null,
        source,
        lineCount: lineCount(source),
      });
    }
  }

  // ---- Sandboxed chart marks (worker-realm; paint-only, no capabilities) ------
  // Each mark mounts as its OWN worker (instanceId = markScriptId), so the live
  // mount/grant join is per-mark. Marks declare nothing (clipped paint surface).
  const markLib = await safely("chart marks", async () => {
    const res = await loadPersistedMarkLibraryWithProvenance();
    return res ? [res] : [];
  });
  for (const { lib, sourcePackage } of markLib) {
    for (const m of lib.marks) {
      const markId = m.markId.trim();
      if (!markId) continue;
      const handle = handleById.get(markScriptId(markId));
      const source = m.body;
      units.push({
        surfaceId: "chart-mark",
        id: markScriptId(markId),
        name: m.label?.trim() || markId,
        residence: "Chart mark — worker-realm sandbox (paint-only)",
        provenance: sourcePackage ? "distributed" : "local",
        sourcePackage,
        // The mount declares [] (paint-only). The broker still auto-grants
        // ui.html to every non-distributed worker script, which is why a local
        // mark's liveGrants below is not empty — see
        // BROKER_AUTO_LOCAL_CAPABILITIES in scriptSurfaces.ts. It is inert on
        // this surface: render.setHtml addresses a shape instance.
        declaredCapabilities: [],
        liveGrants: handle ? ([...handle.grants] as CapabilityId[]) : null,
        tier: handle ? handle.tier : "restricted",
        mounted: !!handle,
        interpreterReach: null,
        interpreterCapabilities: null,
        source,
        lineCount: lineCount(source),
      });
    }
  }

  // ---- Writeback validators (publisher-authored; Rust QuickJS is the gate) ---
  // The user APPROVED this code, so it will run: the Rust submit path evaluates
  // it out of the Ed25519-verified manifest before any registry write. Hiding it
  // would leave publisher code executing on the user's machine with no entry in
  // the answer to "where does code reside?". Listed once per (package,
  // validator) — several regions commonly share one predicate.
  const seenValidators = new Set<string>();
  for (const v of mountedWritebackValidators()) {
    const key = `${v.packageName}::${v.name}`;
    if (seenValidators.has(key)) continue;
    seenValidators.add(key);
    units.push({
      surfaceId: "writeback-validator",
      id: key,
      name: `${v.name} (writeback check)`,
      residence:
        "Writeback validator — runs in the embedded Rust QuickJS realm at submit (advisory copy in a worker realm)",
      provenance: "distributed",
      sourcePackage: v.packageName,
      // A pure predicate: empty ceiling in the worker realm, and every host
      // global deleted in the QuickJS realm.
      declaredCapabilities: [],
      liveGrants: [],
      tier: "restricted",
      mounted: true,
      // The authoritative run is the Rust QuickJS one, whose harness deletes
      // every host global first — so the manifest derives an EMPTY reach for
      // this surface rather than this file claiming "a pure predicate".
      interpreterReach: QUICKJS_SURFACE_REACH["writeback-validator"],
      interpreterCapabilities: QUICKJS_SURFACE_CAPABILITIES["writeback-validator"],
      source: v.source,
      lineCount: lineCount(v.source),
    });
  }

  return units;
}

/**
 * Surfaces the taxonomy defines but this per-file inventory deliberately omits.
 *
 * `extension-worker`: a sandboxed distributed extension is a script SURFACE (it
 * has a taxonomy row) but its code lives in %APPDATA%/extensions, not in the
 * open workbook, so it is not "code in this file". Listing it here would
 * promise per-file provenance this inventory cannot honor.
 *
 * Every omission must be listed HERE with its reason, because the compile-time
 * guard below treats this list as the only sanctioned way for a surface to be
 * missing from the inspector.
 */
const SURFACES_NOT_IN_THIS_FILE = ["extension-worker"] as const;
type OmittedSurfaceId = (typeof SURFACES_NOT_IN_THIS_FILE)[number];

/** Canonical surface ordering for the inspector (object scripts first — they
 *  carry the only real reach — then the grid-only surfaces). */
const SURFACE_ORDER = [
  "object-script",
  // Immediately after the scripts that import them: a library is third-party
  // code nobody typed into this file, so it belongs high in the reading order.
  "script-library",
  "formula-udf",
  "chart-transform-sandbox",
  "chart-mark",
  "writeback-validator",
  "one-off-script",
  "notebook-cell",
  "chart-transform",
  "mcp-tool",
] as const satisfies readonly Exclude<ScriptSurfaceId, OmittedSurfaceId>[];

/**
 * COMPILE-TIME exhaustiveness guard. Adding a `ScriptSurfaceId` to the taxonomy
 * without adding it to SURFACE_ORDER (or to SURFACES_NOT_IN_THIS_FILE, with a
 * reason) makes this assignment fail to type-check, and the error text names the
 * missing id. A surface silently absent from the ordering would have its units
 * DROPPED from `summarizeCodeInventory().bySurface` — code that exists in the
 * workbook but never appears in the "Code in This File" panel is precisely the
 * hidden-code failure this product exists to prevent, so it must not be
 * possible to introduce it by forgetting a line.
 */
type MissingFromSurfaceOrder = Exclude<
  ScriptSurfaceId,
  OmittedSurfaceId | (typeof SURFACE_ORDER)[number]
>;
const _surfaceOrderIsExhaustive: [MissingFromSurfaceOrder] extends [never]
  ? true
  : {
      error: "A ScriptSurfaceId is missing from SURFACE_ORDER in codeInventory.ts — add it there, or to SURFACES_NOT_IN_THIS_FILE with a reason";
      missing: MissingFromSurfaceOrder;
    } = true;
void _surfaceOrderIsExhaustive;

/** Roll an inventory up for the panel header + group it by surface. */
export function summarizeCodeInventory(units: CodeUnit[]): CodeInventorySummary {
  const groups = new Map<ScriptSurfaceId, CodeUnit[]>();
  for (const u of units) {
    const arr = groups.get(u.surfaceId);
    if (arr) arr.push(u);
    else groups.set(u.surfaceId, [u]);
  }

  const bySurface = SURFACE_ORDER.filter((id) => groups.has(id)).map((id) => ({
    surfaceId: id,
    units: groups.get(id)!.slice().sort((a, b) => a.name.localeCompare(b.name)),
  }));

  return {
    total: units.length,
    local: units.filter((u) => u.provenance === "local").length,
    distributed: units.filter((u) => u.provenance === "distributed").length,
    beyondGrid: units.filter(codeUnitReachesBeyondGrid).length,
    beyondGridCapable: units.filter(codeUnitMayReachBeyondGrid).length,
    mounted: units.filter((u) => u.mounted).length,
    bySurface,
  };
}

// ===========================================================================
// Scheduled jobs — "what runs without me asking?"
// ===========================================================================

/** The scheduler surface marking a job that drives a script-fed BI connector's
 *  refresh cycle: its `handler` is the connector's sourceId, not an exposed
 *  method (mirrors CONNECTOR_SURFACE in scriptHost/scheduler.ts). */
const CONNECTOR_JOB_SURFACE = "connector";

/** One scheduled job joined with the code unit that owns it — everything the
 *  user needs to judge it: whose code it is, what it calls, how often, when it
 *  last ran and when it runs next. */
export interface ScheduledJobEntry {
  /** Scheduler job id — the handle for cancel / enable / disable. */
  id: string;
  /** Id of the owning script (a CodeUnit id for object scripts). */
  scriptId: string;
  /** Display name of the owning code unit; the raw scriptId when it is gone. */
  ownerName: string;
  /** True when NOTHING owns the job any more — no code unit in this workbook
   *  AND no live mount. Such a job never fires (Rust requires the owner mounted
   *  and granted), but it is still persisted, so hiding it would hide a
   *  schedule that revives the moment the script comes back.
   *
   *  A job owned by a MOUNTED script that is not "code in this file" — a
   *  sandboxed distributed extension worker, whose code lives in
   *  %APPDATA%/extensions — is NOT an orphan: it is mounted, so it can and will
   *  fire. Flagging it as one would understate what runs, which is the one
   *  direction a transparency surface must never be wrong in. */
  ownerMissing: boolean;
  /** Where the owner came from; "unknown" when the owner is missing. */
  ownerProvenance: "local" | "distributed" | "unknown";
  /** The .calp package the owner arrived in, when distributed; else null. */
  ownerPackage: string | null;
  /** Scheduler surface ("object" for exposed methods, "connector" for feeds). */
  surface: string;
  objectType: string;
  instanceId: string | null;
  /** The raw method name (or connector sourceId) the job invokes. */
  handler: string;
  /** Human "what it calls" — the answer to "what can it touch, and when". */
  target: string;
  /** Human cadence, e.g. "Every 5 minutes" / "Daily at 07:30". */
  cadence: string;
  /** The label the script supplied, if any. */
  label: string | null;
  enabled: boolean;
  running: boolean;
  nextRunMs: number;
  lastRunMs: number;
  lastOk: boolean;
  lastError: string | null;
  runCount: number;
}

/** Roll-up for a header chip / a Settings pointer. */
export interface ScheduledJobSummary {
  total: number;
  enabled: number;
  disabled: number;
  running: number;
  orphaned: number;
  /** Soonest next run among ENABLED jobs; null when nothing is armed. */
  nextRunMs: number | null;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** Cadence form: the count is dropped at 1 ("Every minute", not "Every 1
 *  minute"). */
const plural = (n: number, unit: string): string =>
  n === 1 ? unit : `${n} ${unit}s`;

/** Duration form: the count always shows ("1 minute ago"). */
const counted = (n: number, unit: string): string =>
  `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "30 seconds" / "minute" / "2 hours" / "day" — the largest whole unit. */
function describeInterval(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400 && s % 86400 === 0) return plural(s / 86400, "day");
  if (s >= 3600 && s % 3600 === 0) return plural(s / 3600, "hour");
  if (s >= 60 && s % 60 === 0) return plural(s / 60, "minute");
  return plural(s, "second");
}

/** Human cadence for a job. Exported so every surface phrases it identically. */
export function describeJobCadence(
  job: Pick<ScheduledJob, "cadence" | "intervalSecs" | "minuteOfDay">,
): string {
  if (job.cadence === "dailyAt") {
    const minute = Math.max(0, Math.floor(job.minuteOfDay));
    return `Daily at ${pad2(Math.floor(minute / 60) % 24)}:${pad2(minute % 60)}`;
  }
  return `Every ${describeInterval(job.intervalSecs)}`;
}

/** Human "what this job actually does" for a job row. */
export function describeJobTarget(job: Pick<ScheduledJob, "surface" | "handler">): string {
  return job.surface === CONNECTOR_JOB_SURFACE
    ? `Refreshes the "${job.handler}" data connector`
    : `Calls ${job.handler}()`;
}

/**
 * Human, relative wall-clock for a job timestamp ("in 4 minutes", "2 hours
 * ago", "never"). `now` is injectable so the phrasing is testable.
 */
export function describeJobTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "never";
  const delta = ms - now;
  const abs = Math.abs(delta);
  let text: string;
  if (abs < 45_000) text = "less than a minute";
  else if (abs < 3_600_000) text = counted(Math.round(abs / 60_000), "minute");
  else if (abs < 86_400_000) text = counted(Math.round(abs / 3_600_000), "hour");
  else text = counted(Math.round(abs / 86_400_000), "day");
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

/**
 * Every scheduled job in this workbook, joined with the code unit that owns it.
 *
 * Pass `units` when the caller already has the inventory (the transparency
 * panel does) so the owner join costs nothing extra; omit it and the inventory
 * is fetched — but only when at least one job exists, so a workbook that
 * schedules nothing pays for exactly one backend call.
 */
export async function getWorkbookScheduledJobs(
  units?: CodeUnit[],
): Promise<ScheduledJobEntry[]> {
  const jobs = await safely("scheduled jobs", listAllScheduledJobs);
  // Array.isArray, not just length: a window whose backend is stubbed hands
  // back undefined, and a transparency surface must degrade to "nothing known"
  // rather than throw and render as "nothing scheduled".
  if (!Array.isArray(jobs) || jobs.length === 0) return [];

  const owners = units ?? (await getWorkbookCodeUnits());
  const ownerById = new Map(owners.map((u) => [u.id, u]));
  // Second-chance owner lookup for a job whose owner is deliberately NOT a code
  // unit: a sandboxed distributed EXTENSION worker is a script surface, but its
  // code lives in %APPDATA%/extensions rather than in this workbook, so the
  // inventory omits it (see SURFACE_ORDER). It is nonetheless mounted, so its
  // job really does fire — calling it an orphan would tell the user the
  // opposite of the truth.
  const handleById = new Map(listMountedHandles().map((h) => [h.scriptId, h]));

  const entries: ScheduledJobEntry[] = jobs.map((job) => {
    const owner = ownerById.get(job.scriptId) ?? null;
    const handle = owner ? null : (handleById.get(job.scriptId) ?? null);
    return {
      id: job.id,
      scriptId: job.scriptId,
      ownerName: owner?.name ?? handle?.scriptName ?? job.scriptId,
      ownerMissing: owner === null && handle === null,
      ownerProvenance: owner
        ? owner.provenance
        : handle
          ? handle.origin === "local"
            ? "local"
            : "distributed"
          : "unknown",
      ownerPackage:
        owner?.sourcePackage ?? (handle && handle.origin !== "local" ? handle.origin : null),
      surface: job.surface,
      objectType: job.objectType,
      instanceId: job.instanceId,
      handler: job.handler,
      target: describeJobTarget(job),
      cadence: describeJobCadence(job),
      label: job.label,
      enabled: job.enabled,
      running: job.running,
      nextRunMs: job.nextRunMs,
      lastRunMs: job.lastRunMs,
      lastOk: job.lastOk,
      lastError: job.lastError,
      runCount: job.runCount,
    };
  });

  // Soonest first: the thing about to happen is the thing the user is deciding
  // about. Disabled jobs sink to the bottom — they are not going to happen.
  entries.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.nextRunMs !== b.nextRunMs) return a.nextRunMs - b.nextRunMs;
    return `${a.ownerName}:${a.handler}`.localeCompare(`${b.ownerName}:${b.handler}`);
  });
  return entries;
}

/** Roll a job list up for a header chip or a cross-reference count. */
export function summarizeScheduledJobs(jobs: ScheduledJobEntry[]): ScheduledJobSummary {
  const armed = jobs.filter((j) => j.enabled && j.nextRunMs > 0);
  return {
    total: jobs.length,
    enabled: jobs.filter((j) => j.enabled).length,
    disabled: jobs.filter((j) => !j.enabled).length,
    running: jobs.filter((j) => j.running).length,
    orphaned: jobs.filter((j) => j.ownerMissing).length,
    nextRunMs: armed.length === 0 ? null : Math.min(...armed.map((j) => j.nextRunMs)),
  };
}

// ===========================================================================
// What scripts are HOLDING right now — "state I did not put there"
// ===========================================================================
//
// The code list answers "what code exists"; the schedule answers "what runs
// without me asking". Neither answers the third question, and it is the one VBA
// answered worst: WHAT IS A SCRIPT HOLDING ON MY BEHALF RIGHT NOW?
//
// Three things sit in that gap. Each is already exposed as an API, each is
// already refused/bounded/consented correctly, and each was invisible to the
// person it belongs to:
//
//   1. KEYBOARD SHORTCUTS (`ui.shortcut`). `Application.OnKey "^+r", "Macro"`
//      is the canonical VBA hijack: a key silently stops doing what the user
//      expects and nothing anywhere records that a script took it. Calcula
//      already refuses the dangerous shapes, reserves the app's own keys and
//      revokes at unmount — but a shortcut nobody can SEE is still a shortcut
//      nobody can take back, and "invisible key binding" is exactly the failure
//      this product exists to avoid.
//   2. PRIVATE CLIPBOARDS. Copying a range into a script's own buffer never
//      touches the OS clipboard (host.ts refuses that outright), but the buffer
//      still holds real cell VALUES out of the user's workbook, held by code,
//      for as long as the script is mounted. Cells sitting in a script's hand
//      is a fact about the user's data.
//   3. BACKGROUND WATCHERS. A script subscribing to writeback submissions makes
//      Calcula poll a registry on a timer. It is demand-driven, bounded and
//      authorization-checked in Rust — and it is still network traffic and
//      background work the user caused without doing anything.
//
// The rule this section applies is the one the scheduler already established:
// VISIBILITY PLUS CONTROL. Showing the user a shortcut they cannot revoke, or a
// buffer they cannot clear, is half a promise. So the panel gets `revoke` and
// `clear` alongside the list.

/** One keyboard shortcut a live script is holding, joined with its owner. */
export interface ScriptShortcutEntry {
  /** Registry id — the handle for revoking it. */
  id: string;
  /** Canonical combination ("Ctrl+Shift+R"). */
  combo: string;
  scriptId: string;
  /** Owning code unit's display name; falls back to the name the host recorded
   *  at bind time, which is host-supplied and never the script's own claim. */
  ownerName: string;
  /** True when no code unit in this workbook owns it (a distributed extension
   *  worker, whose code lives in %APPDATA%/extensions, or a stale row). */
  ownerMissing: boolean;
  ownerProvenance: "local" | "distributed" | "unknown";
  ownerPackage: string | null;
  /** The exposed method the keys call. */
  handler: string;
  /** Human label for the shortcut list ("refreshAll()"). */
  label: string;
}

/** One script's private clipboard, as a size — never its contents. */
export interface ScriptClipboardEntry {
  scriptId: string;
  ownerName: string;
  ownerMissing: boolean;
  ownerProvenance: "local" | "distributed" | "unknown";
  ownerPackage: string | null;
  rows: number;
  cols: number;
  /** rows x cols — the number of cells the script currently holds. */
  cells: number;
}

/** The background registry poll, phrased for a person. */
export interface BackgroundWatchEntry {
  /** Stable id for the row. */
  id: string;
  /** What is being watched, in one line. */
  what: string;
  running: boolean;
  /** How many holders want it (scripts + open panes). */
  refCount: number;
  intervalMs: number;
  /** Human cadence, e.g. "Every minute". */
  cadence: string;
  /** Registry regions polled on the last pass. */
  watchedRegionIds: string[];
  /** Regions skipped for the session (not published by this machine). */
  skippedRegionIds: string[];
  /** ISO timestamp of the last completed pass, or null. */
  lastPollAt: string | null;
  /** Backend calls the last pass made. */
  lastPollCalls: number;
  lastError: string | null;
}

/** Everything scripts are holding on the user's behalf right now. */
export interface ScriptHeldState {
  shortcuts: ScriptShortcutEntry[];
  clipboards: ScriptClipboardEntry[];
  /** Background work scripts caused. Empty when nothing is polling. */
  watches: BackgroundWatchEntry[];
}

/** Header roll-up for the held-state section. */
export interface ScriptHeldStateSummary {
  shortcuts: number;
  clipboards: number;
  /** Total cells sitting in script clipboards. */
  clipboardCells: number;
  /** Background watchers actually running. */
  runningWatches: number;
  /** True when a script is holding ANYTHING. */
  any: boolean;
}

/** The submission watch's row id — stable so the UI can key on it. */
const SUBMISSION_WATCH_ID = "distribution.submissionWatch";

/** Human cadence for a millisecond interval, reusing the job phrasing so the two
 *  sections cannot describe "every minute" differently. */
function describeIntervalMs(ms: number): string {
  return `Every ${describeInterval(Math.round(ms / 1000))}`;
}

/** Owner join shared by the shortcut and clipboard lists: a code unit if this
 *  workbook carries one, else a live broker mount (a distributed extension
 *  worker is mounted but is deliberately not "code in this file"), else nobody.
 */
function joinOwner(
  scriptId: string,
  fallbackName: string,
  ownerById: Map<string, CodeUnit>,
  handleById: Map<string, { scriptName: string; origin: string }>,
): {
  ownerName: string;
  ownerMissing: boolean;
  ownerProvenance: "local" | "distributed" | "unknown";
  ownerPackage: string | null;
} {
  const owner = ownerById.get(scriptId) ?? null;
  const handle = owner ? null : (handleById.get(scriptId) ?? null);
  return {
    ownerName: owner?.name ?? handle?.scriptName ?? fallbackName ?? scriptId,
    ownerMissing: owner === null && handle === null,
    ownerProvenance: owner
      ? owner.provenance
      : handle
        ? handle.origin === "local"
          ? "local"
          : "distributed"
        : "unknown",
    ownerPackage:
      owner?.sourcePackage ?? (handle && handle.origin !== "local" ? handle.origin : null),
  };
}

/**
 * Everything scripts are holding right now, joined with the code that holds it.
 *
 * Pass `units` when the caller already has the inventory (the transparency panel
 * does) so the owner join costs nothing extra.
 *
 * Every read is best-effort in the same way the rest of this module is: a window
 * without a given subsystem wired reports "nothing held" for that subsystem
 * rather than failing the whole panel. The one thing it must never do is report
 * LESS than is really held, which is why the clipboard read enumerates every
 * mounted handle rather than only the workbook's own code units — a distributed
 * extension worker holds a buffer of the user's cells exactly like a local
 * object script does.
 */
export async function getScriptHeldState(units?: CodeUnit[]): Promise<ScriptHeldState> {
  const mounted = listMountedHandles();
  const handleById = new Map(mounted.map((h) => [h.scriptId, h]));

  // The shortcut list is pure, synchronous host state, so it is read first: if
  // the inventory join below fails, a held shortcut is still reported (with its
  // host-recorded owner name) rather than disappearing.
  let held: ReturnType<typeof listScriptKeybindings> = [];
  try {
    held = listScriptKeybindings();
  } catch (e) {
    console.warn("[codeInventory] script shortcuts unavailable:", e);
  }

  // Clipboards: ask the host for the SIZE of each mounted script's buffer. The
  // contents are deliberately never read here — the user needs to know cells are
  // held and be able to drop them, not to have a second copy rendered into the
  // DOM.
  let clipboardSizes: { scriptId: string; rows: number; cols: number }[] = [];
  try {
    const host = await import("./scriptHost/host");
    for (const handle of mounted) {
      const size = host.scriptClipboardSize(handle.scriptId);
      if (size && size.rows > 0 && size.cols > 0) {
        clipboardSizes.push({ scriptId: handle.scriptId, rows: size.rows, cols: size.cols });
      }
    }
  } catch (e) {
    console.warn("[codeInventory] script clipboards unavailable:", e);
    clipboardSizes = [];
  }

  // Only fetch the inventory when something is actually held, so a workbook
  // where no script holds anything pays nothing for this section.
  const needsOwners = held.length > 0 || clipboardSizes.length > 0;
  const owners = needsOwners ? (units ?? (await getWorkbookCodeUnits())) : [];
  const ownerById = new Map(owners.map((u) => [u.id, u]));

  const shortcuts: ScriptShortcutEntry[] = held.map((b) => ({
    id: b.id,
    combo: b.combo,
    scriptId: b.scriptId,
    handler: b.handler,
    label: b.label,
    ...joinOwner(b.scriptId, b.scriptName, ownerById, handleById),
  }));

  const clipboards: ScriptClipboardEntry[] = clipboardSizes.map((c) => ({
    scriptId: c.scriptId,
    rows: c.rows,
    cols: c.cols,
    cells: c.rows * c.cols,
    ...joinOwner(c.scriptId, c.scriptId, ownerById, handleById),
  }));

  // The submission watch. Reported whenever anything holds it — including the
  // Responses pane, because "why is Calcula talking to the registry" is the
  // user's question regardless of who asked for it.
  const watches: BackgroundWatchEntry[] = [];
  try {
    const { getSubmissionWatchStatus } = await import("./distribution");
    const s = getSubmissionWatchStatus();
    if (s.refCount > 0 || s.running) {
      watches.push({
        id: SUBMISSION_WATCH_ID,
        what: "Checks the distribution registry for new writeback submissions",
        running: s.running,
        refCount: s.refCount,
        intervalMs: s.intervalMs,
        cadence: describeIntervalMs(s.intervalMs),
        watchedRegionIds: [...s.watchedRegionIds],
        skippedRegionIds: [...s.skippedRegionIds],
        lastPollAt: s.lastPollAt,
        lastPollCalls: s.lastPollCalls,
        lastError: s.lastError,
      });
    }
  } catch (e) {
    console.warn("[codeInventory] submission watch status unavailable:", e);
  }

  shortcuts.sort((a, b) => a.combo.localeCompare(b.combo) || a.ownerName.localeCompare(b.ownerName));
  clipboards.sort((a, b) => b.cells - a.cells || a.ownerName.localeCompare(b.ownerName));
  return { shortcuts, clipboards, watches };
}

/** Roll the held state up for a header chip. */
export function summarizeScriptHeldState(state: ScriptHeldState): ScriptHeldStateSummary {
  const clipboardCells = state.clipboards.reduce((n, c) => n + c.cells, 0);
  const runningWatches = state.watches.filter((w) => w.running).length;
  return {
    shortcuts: state.shortcuts.length,
    clipboards: state.clipboards.length,
    clipboardCells,
    runningWatches,
    any:
      state.shortcuts.length > 0 || state.clipboards.length > 0 || state.watches.length > 0,
  };
}

/**
 * Drop one script's private clipboard. The control half of the promise: a buffer
 * the user can see but not empty is a buffer they cannot say no to.
 *
 * Safe by construction — `clearScriptClipboard` only forgets host-side state; it
 * cannot touch the grid, and the script simply finds its buffer empty (the same
 * state it starts in) the next time it pastes.
 */
export async function clearScriptClipboard(scriptId: string): Promise<void> {
  const host = await import("./scriptHost/host");
  host.clearScriptClipboard(scriptId);
}

// ===========================================================================
// Machine-scoped: add-ins installed on THIS COMPUTER
// ===========================================================================
//
// THIS SECTION IS NOT ABOUT THE OPEN WORKBOOK, and every surface that renders it
// must say so. It is here anyway because this module is the transparency spine
// and because the question it answers is one a user asks in the same breath as
// "what code is in this file": "...and what else did I let onto this machine?".
//
// An add-in is the widest-blast-radius decision in Calcula — the code lands in
// %APPDATA%/com.calcula.app/extensions and loads into EVERY workbook afterwards
// — so recording it in a .cala would have made the broadest consent the
// shortest-lived record. The trail lives in the profile directory beside the
// publisher pin store it explains (Rust: app/src-tauri/src/extension_audit.rs),
// append-only, and is read through a main-window-only command.
//
// It is a RECORD, not an authority: nothing in Calcula consults it to decide
// whether an add-in may load. Trust is re-derived from the signature, the code
// hash and the pin store on every scan.

/** One machine-scoped add-in decision. Mirrors `ExtensionAuditEntry` in
 *  app/src-tauri/src/extension_audit.rs field for field (camelCase over the
 *  wire, snake_case in Rust — the Golden Rule). */
export interface ExtensionAuditEntry {
  /** RFC 3339 UTC timestamp. */
  at: string;
  /** "installed" | "removed" | "publisherPinned" | "publisherChangeAccepted". */
  action: string;
  id: string;
  name: string;
  version: string;
  bundleFileName: string;
  publisherKey: string;
  previousPublisherKey: string;
  /** The trust status at the moment of the decision, NOT re-derived now. */
  trustStatus: string;
  capabilitiesHonored: boolean;
  declaredCapabilities: string[];
  /** Flattened "kind:id" contribution declarations. */
  contributions: string[];
  sourcePath: string;
  detail: string;
}

/** A read of the machine trail. `missing` and a read error are distinguished on
 *  purpose: both render as an empty list and they mean opposite things. */
export interface ExtensionAuditTrail {
  entries: ExtensionAuditEntry[];
  total: number;
  unreadableLines: number;
  /** Absolute path, so the user can read the file themselves. */
  path: string;
  missing: boolean;
  lastWriteError: string;
}

/** Human phrasing for one recorded action. A UI must never render the raw wire
 *  word at a user for a security event. */
export const EXTENSION_AUDIT_ACTION_LABELS: Record<string, string> = {
  installed: "Installed",
  removed: "Removed",
  publisherPinned: "Publisher trusted",
  publisherChangeAccepted: "Publisher CHANGED — accepted",
};

/** Read this machine's add-in trust trail. Never throws: a window without the
 *  backend wired reports an unreadable trail rather than failing the panel. */
export async function getExtensionAuditTrail(): Promise<ExtensionAuditTrail> {
  try {
    return await invokeBackend<ExtensionAuditTrail>("list_extension_audit");
  } catch (e) {
    return {
      entries: [],
      total: 0,
      unreadableLines: 0,
      path: "",
      missing: false,
      lastWriteError: e instanceof Error ? e.message : String(e),
    };
  }
}
