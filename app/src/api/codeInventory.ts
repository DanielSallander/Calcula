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
//          - We DO enumerate the user-authored Custom Functions library (the
//            formula-udf surface): each function body runs in the worker realm
//            under the library's declared ceiling (e.g. bi.query for cube.*), so
//            its code and reach must be visible here, never hidden. The raw JSON
//            store record is filtered out of the module list (it is data, not
//            code) — we surface the parsed functions instead.

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
  const [objectScripts, moduleSummaries, notebookSummaries, mounted] =
    await Promise.all([
      safely("object scripts", loadAllObjectScripts),
      safely("module scripts", listModuleScripts),
      safely("notebooks", listNotebooks),
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
      source: s.source,
      lineCount: lineCount(s.source),
    });
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
      // The one-off surface installs no model provider at all
      // (script-engine model_provider.rs), so it is grid-only by construction.
      declaredCapabilities: [],
      liveGrants: null,
      tier: null,
      mounted: false,
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
      source: v.source,
      lineCount: lineCount(v.source),
    });
  }

  return units;
}

/** Canonical surface ordering for the inspector (object scripts first — they
 *  carry the only real reach — then the grid-only surfaces).
 *
 *  `extension-worker` is deliberately absent: a sandboxed distributed extension
 *  is a script SURFACE (it has a taxonomy row) but its code lives in
 *  %APPDATA%/extensions, not in the open workbook, so it is not "code in this
 *  file". Listing it here would promise per-file provenance this inventory
 *  cannot honor. */
const SURFACE_ORDER: ScriptSurfaceId[] = [
  "object-script",
  "formula-udf",
  "chart-transform-sandbox",
  "chart-mark",
  "writeback-validator",
  "one-off-script",
  "notebook-cell",
  "chart-transform",
  "mcp-tool",
];

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
    mounted: units.filter((u) => u.mounted).length,
    bySurface,
  };
}
