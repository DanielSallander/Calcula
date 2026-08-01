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

// The trusted-UI half of the scheduler is re-exported through the inventory so
// that a transparency surface has ONE door for both halves of the promise:
// seeing what runs (getWorkbookScheduledJobs) and stopping it (these two).
// Visibility without control would still leave the user unable to say no.
export { cancelScheduledJob, setScheduledJobEnabled } from "./scriptHost/scheduler";
export type { ScheduledJob } from "./scriptHost/scheduler";

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
