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
//          - The two Rust-QuickJS surfaces are grid-only BY CONSTRUCTION (their
//            ScriptSurface declares no capabilities), so their "what can it
//            touch" answer is a hard [] — they cannot reach network/BI/storage.
//            Only object scripts carry a real R19 declared-capability ceiling.
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
import { loadPersistedLibrary, CUSTOM_FUNCTIONS_SCRIPT_ID } from "./customFunctions";

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
   *  Empty for the grid-only Rust-QuickJS surfaces (they cannot be granted any
   *  privileged capability). */
  declaredCapabilities: CapabilityId[];
  /** Capabilities GRANTED right now, when the script is live/mounted via the
   *  broker; null when not applicable (grid-only surfaces) or not mounted. */
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

/** True iff a unit's declared ceiling lets it reach outside grid state
 *  (network, BI, storage, host HTML). Grid-only surfaces are always false. */
export function codeUnitReachesBeyondGrid(unit: CodeUnit): boolean {
  return unit.declaredCapabilities.length > 0;
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
      declaredCapabilities: [], // grid-only surface
      liveGrants: null,
      tier: null,
      mounted: false,
      source,
      lineCount: lineCount(source),
    });
  }

  // ---- Notebooks (Rust QuickJS; grid-only) ---------------------------------
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
      declaredCapabilities: [], // grid-only surface
      liveGrants: null,
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

  return units;
}

/** Canonical surface ordering for the inspector (object scripts first — they
 *  carry the only real reach — then the grid-only surfaces). */
const SURFACE_ORDER: ScriptSurfaceId[] = [
  "object-script",
  "formula-udf",
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
