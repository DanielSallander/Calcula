//! FILENAME: app/extensions/Charts/lib/chartStore.ts
// PURPOSE: Chart store with Tauri backend persistence.
// CONTEXT: Charts are persisted via Rust backend as opaque JSON blobs.
//          The in-memory array provides synchronous access for rendering;
//          every mutation is mirrored to the backend for persistence.

import {
  removeGridRegionsByType,
  addGridRegions,
  type GridRegion,
} from "@api/gridOverlays";
import type { ChartDefinition, ChartSpec } from "../types";
import { validateChartSpec } from "./chartSpecValidate";
import {
  chartSpecNeedsRepair,
  normalizeChartDefinition,
  normalizeChartSpec,
} from "./chartSpecNormalize";
import { chartsBackend } from "./chartsBackend";
import { emitAppEvent, AppEvents } from "@api/events";
import { alertAsync } from "@api/dialogs";
// The sheet list's id <-> index map lives in its own small module, NOT in the
// resolver: the store is imported almost everywhere, and the resolver pulls the
// whole `@api` facade and the grid state with it.
import { loadSheetIdMap, peekSheetIdForIndex } from "./sheetIdMap";
import {
  specHasUnstampedRangeRef,
  stampSpecSheetIds,
  stampStoredChartJson,
  type SheetIdForIndex,
} from "./chartSheetRefs";

// ============================================================================
// Backend Types
// ============================================================================

/** Matches Rust ChartEntry (api_types.rs). */
export interface ChartEntry {
  id: string;
  sheetIndex: number;
  specJson: string;
}

/**
 * Matches Rust ChartSheetIdStamp (api_types.rs): which step of this store an
 * `update_chart` sheet-id stamp finishes. `afterLoad` is recorded clean (the
 * stamp restates what the loaded index says); `afterCreate` dirties like the
 * create it completes. Neither adds an undo step.
 */
export type ChartSheetIdStamp = "afterLoad" | "afterCreate";

// ============================================================================
// Store State
// ============================================================================

/** Counter used only for default display names ("Chart 1", "Chart 2", ...). */
let nextChartNumber = 1;
let charts: ChartDefinition[] = [];

/** Active sheet index used for filtering which charts to render. */
let activeSheetIndex = 0;

/** Deleted charts stack for undo (max 10 items). */
const deletedChartsTrash: ChartDefinition[] = [];

/**
 * The last value the BACKEND confirmed for each chart id — the only thing in
 * this module that is known to survive a reload.
 *
 * Populated on load and after every successful persist; removed after a
 * successful delete. It exists so a refused write can put the in-memory store
 * back to what is actually stored, instead of leaving the canvas painting an
 * edit that was never written (see reportChartPersistFailures below).
 */
const persistedSnapshots = new Map<string, ChartDefinition>();

// ============================================================================
// Backend Sync Helpers
// ============================================================================

/** Serialize a ChartDefinition to a ChartEntry for backend persistence. */
function toEntry(chart: ChartDefinition): ChartEntry {
  return {
    id: chart.chartId,
    sheetIndex: chart.sheetIndex,
    specJson: JSON.stringify(chart),
  };
}

/**
 * Deserialize a ChartEntry from the backend into a ChartDefinition.
 *
 * THE ONLY PLACE a foreign JSON blob becomes a typed chart, and therefore the
 * only place the type's promises can be made true. `specJson` is whatever was
 * handed to the `save_chart` command — by this build, by an older one, by an
 * `.xlsx` or `.calp` import, by a sandboxed script, or by a test harness — and
 * the painters read `spec.xAxis.title` / `spec.legend.visible` with no guard.
 * An unchecked `as ChartDefinition` here is what let an incomplete record reach
 * the paint path and make the chart render its own exception (see
 * chartSpecNormalize.ts). Completing the record costs one shallow copy per
 * chart at load and removes the whole failure mode.
 */
export function fromEntry(entry: ChartEntry): ChartDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.specJson);
  } catch {
    parsed = null;
  }
  const definition = normalizeChartDefinition(parsed, {
    chartId: entry.id,
    sheetIndex: entry.sheetIndex,
  });
  // THE ENTRY'S PLACEMENT WINS over the copy inside the JSON. `toEntry` writes
  // the placement sheet twice -- once as the entry's `sheet_index`, once inside
  // `specJson` -- and only the first is maintained by the backend: a sheet
  // delete / move / copy remaps `entry.sheet_index` (object_deps
  // `cascade_sheet_removed`, and the two .calp materializers) and never
  // rewrites the opaque JSON. Preferring the JSON copy undid every remap at the
  // next load, and the next `update_chart` then wrote the stale index back.
  if (typeof entry.sheetIndex === "number" && Number.isInteger(entry.sheetIndex)) {
    definition.sheetIndex = entry.sheetIndex;
  }
  return definition;
}

/** True for non-null, non-array objects (the values we recurse into when merging). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `patch` into `base`, returning a new object.
 * - Nested plain objects merge recursively, so a partial patch like
 *   `{ xAxis: { title: "X" } }` updates only `title` and preserves the rest of
 *   `xAxis` (the previous shallow spread dropped every sibling field).
 * - Arrays, primitives, `null`, and `undefined` REPLACE the target. In
 *   particular `{ filters: undefined }` clears `filters` — several callers rely
 *   on undefined-to-clear semantics.
 */
function deepMergeSpec<T>(base: T, patch: Partial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const existing = result[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      result[key] = deepMergeSpec(existing, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

// ============================================================================
// Transient preview (CI-14) — the live-preview half of the transient-write rule
// ============================================================================
//
// WHY THIS IS NOT `updateChartSpec`. That function ends in `scheduleSave`,
// unconditionally. Routing a hover preview through it would persist the colour
// the pointer happened to pass over: a 300 ms debounce means the LAST swatch
// crossed on the way to the OK button is what lands in the workbook, the
// document is dirtied, and the close-without-saving prompt now guards an edit
// the reader never made.
//
// So a preview goes through `previewChartSpec`, which mutates the render-time
// spec and nothing else: no `scheduleSave`, no undo entry, no dirty flag.
// CLAUDE.md rule 6 (the transient-write pattern) in its smallest form —
// snapshot, write without entering the undo/dirty path, restore on stop.
//
// THE RESTORE IS THE WHOLE CONTRACT. A preview left standing is not a cosmetic
// bug: the next REAL edit would deep-merge onto the previewed spec and persist
// it as authored state, so the preview would have written itself into the
// document through a command that is innocent of it. That is why the restore is
// enforced in three independent places rather than only at the caller's exits:
//
//   1. `updateChartSpec` / `replaceChartSpec` restore BEFORE merging, so a real
//      edit always starts from the true spec.
//   2. `flushDirtyCharts` persists the ORIGINAL spec while a preview is up, so
//      an unrelated pending save (a drag scheduled one 200 ms ago) cannot carry
//      the preview to disk.
//   3. `deleteChart`, `resetChartStore` and `loadChartsFromBackend` drop it,
//      because the chart or the whole document has gone.
//
// Only ONE preview exists at a time. Previewing a second chart restores the
// first, and every preview merges onto the ORIGINAL spec rather than onto the
// previous preview, so crossing ten swatches leaves exactly one thing to undo.

/** The single live preview: which chart, and the spec to put back. */
interface ChartSpecPreview {
  chartId: string;
  /**
   * The stored spec as it was before the first preview merge. Held by
   * REFERENCE, not cloned: nothing in this module mutates a spec in place —
   * every write reassigns `chart.spec` to a fresh object — so the reference is
   * a faithful restore point, and a JSON clone would quietly drop the
   * explicit-`undefined` keys that `deepMergeSpec` treats as "cleared".
   */
  original: ChartSpec;
}

let activePreview: ChartSpecPreview | null = null;

/**
 * Show `specUpdates` on the chart WITHOUT persisting anything.
 *
 * The merge is always computed from the preview's ORIGINAL spec, so successive
 * previews replace one another instead of compounding. The caller is
 * responsible for repainting (invalidate the render cache + re-sync regions);
 * this module deliberately does not import the renderer.
 */
export function previewChartSpec(chartId: string, specUpdates: Partial<ChartSpec>): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (!chart) return;
  if (activePreview !== null && activePreview.chartId !== chartId) {
    restoreChartSpecPreview();
  }
  if (activePreview === null) {
    activePreview = { chartId, original: chart.spec };
  }
  chart.spec = deepMergeSpec(activePreview.original, specUpdates);
}

/**
 * Put the previewed chart back to its stored spec.
 *
 * Returns the chart id that was being previewed so the caller can repaint it,
 * or null when nothing was previewing. Safe to call on any exit path, however
 * many times: the second call is a no-op.
 */
export function restoreChartSpecPreview(): string | null {
  if (activePreview === null) return null;
  const { chartId, original } = activePreview;
  activePreview = null;
  const chart = charts.find((c) => c.chartId === chartId);
  // A missing chart is not an error — it was deleted while the preview was up.
  // The id still comes back so the caller can drop its own preview state.
  if (chart) chart.spec = original;
  return chartId;
}

/**
 * The spec a COMMIT must be built from: the stored one, never the previewed
 * one. A control that spreads `spec.dataPointOverrides` while its own hover
 * preview is on screen would otherwise bake the preview into the committed
 * array.
 */
export function getPreviewBaseSpec(chartId: string): ChartSpec | null {
  if (activePreview !== null && activePreview.chartId === chartId) {
    return activePreview.original;
  }
  return charts.find((c) => c.chartId === chartId)?.spec ?? null;
}

/** True while a transient preview is on screen (for `chartId`, when given). */
export function isChartSpecPreviewActive(chartId?: string): boolean {
  if (activePreview === null) return false;
  return chartId === undefined || activePreview.chartId === chartId;
}

/**
 * The definition as it should be PERSISTED — the previewed chart with its
 * original spec restored.
 *
 * This is the guard for the case the exit paths cannot cover: a drag or a
 * rename scheduled a save 200 ms ago, the reader is now hovering a swatch, and
 * the debounce fires. `toEntry` serialises the WHOLE chart, spec included, so
 * without this the preview would be written to the workbook by a save that has
 * nothing to do with it.
 */
function chartAsPersisted(chart: ChartDefinition): ChartDefinition {
  if (activePreview === null || activePreview.chartId !== chart.chartId) return chart;
  return { ...chart, spec: activePreview.original };
}

// ============================================================================
// Persist-failure handling — the store must never keep an edit the backend refused
// ============================================================================
//
// WHY THIS EXISTS. Every write out of this module used to end in `.catch(() => {})`.
// The in-memory chart kept the edit, the canvas painted it, no undo entry was
// recorded and nothing was shown — and on reload the work was simply gone. That is
// not theoretical: `save_chart` / `update_chart` / `delete_chart` all begin with
// `check_sheet_action(..., "editObjects", ...)` (app/src-tauri/src/chart_commands.rs),
// so a chart created on a PROTECTED sheet painted itself onto the grid, was never
// persisted, and vanished at the next open.
//
// The contract now is: a refused write is rolled back to the last value the backend
// confirmed, the user is told ONCE per batch, the message NAMES the chart and says
// what was discarded, and the whole thing is also written to console.error with the
// raw reason for debugging.

/** One refused backend write, collected so a batch can be reported in one message. */
export interface ChartPersistFailure {
  chartId: string;
  chartName: string;
  /** Which backend write was refused. */
  operation: "create" | "update" | "delete" | "restore";
  /** The backend's own reason, as close to verbatim as it can be rendered. */
  reason: string;
  /** What the in-memory store now shows, after the rollback. */
  outcome: "removed" | "reverted" | "restored" | "unchanged";
  /** Human-readable list of the edits that were discarded (update path only). */
  lost: string;
}

/**
 * True while a failure message is on screen. A drag can schedule a flush every
 * 300 ms, so without this latch a protected sheet would stack a modal per flush
 * and the app would be unusable. Failures that arrive while a box is up are still
 * rolled back and still logged — only the second modal is suppressed.
 */
let failureDialogOpen = false;

/** A structural copy, identical to what `toEntry` would persist. */
function cloneChart(chart: ChartDefinition): ChartDefinition {
  return JSON.parse(JSON.stringify(chart)) as ChartDefinition;
}

/** Record a chart as confirmed-persisted (the rollback target for later writes). */
function recordPersisted(chart: ChartDefinition): void {
  persistedSnapshots.set(chart.chartId, cloneChart(chart));
}

/** Render whatever the backend rejected with as a sentence. */
function describeBackendError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * Name the edits that are about to be thrown away, so the message can SHOW the
 * loss instead of reverting in silence. Must be called BEFORE the rollback.
 */
function describeLostEdits(current: ChartDefinition, persisted: ChartDefinition): string {
  const parts: string[] = [];
  if (current.name !== persisted.name) {
    parts.push(`name (back to "${persisted.name}")`);
  }
  if (current.sheetIndex !== persisted.sheetIndex) parts.push("sheet");
  if (current.x !== persisted.x || current.y !== persisted.y) parts.push("position");
  if (current.width !== persisted.width || current.height !== persisted.height) parts.push("size");
  if (JSON.stringify(current.spec) !== JSON.stringify(persisted.spec)) parts.push("chart settings");
  return parts.length > 0 ? parts.join(", ") : "no visible difference";
}

/**
 * Overwrite `target` in place with `source`. In place, because components and the
 * overlay host hold references to the live ChartDefinition object — swapping the
 * array element would leave them pointing at the rejected edit.
 */
function restoreInPlace(target: ChartDefinition, source: ChartDefinition): void {
  const t = target as unknown as Record<string, unknown>;
  const s = cloneChart(source) as unknown as Record<string, unknown>;
  for (const key of Object.keys(t)) {
    if (!(key in s)) delete t[key];
  }
  for (const [key, value] of Object.entries(s)) t[key] = value;
}

/**
 * Put the in-memory chart back to the last value the backend confirmed.
 *
 * - A chart with a snapshot is REVERTED to it (an update/placement write was refused).
 * - A chart with no snapshot was never persisted at all, so it is REMOVED — keeping
 *   it would be the original lie in a new costume.
 */
function rollbackToPersisted(chartId: string): "reverted" | "removed" {
  // THE PREVIEW'S RESTORE TOKEN IS NOW A LIE, so it is dropped BEFORE the
  // rollback rather than restored by it.
  //
  // `activePreview.original` is the spec the preview merged onto — the edit the
  // backend has just REFUSED. Leaving it standing meant the next mouse-out put
  // the refused edit straight back on the canvas, seconds after a modal said
  // "Nothing was written to the workbook, so what you see now matches what is
  // stored", and the next real edit deep-merged onto it and persisted it. The
  // token cannot be spent (`restoreChartSpecPreview` would write the refused
  // spec back) and it cannot be kept, so it is discarded; the chart is about to
  // be overwritten with the last CONFIRMED version, which is the only state a
  // restore could honestly produce.
  if (activePreview !== null && activePreview.chartId === chartId) {
    activePreview = null;
  }
  const snapshot = persistedSnapshots.get(chartId);
  const index = charts.findIndex((c) => c.chartId === chartId);
  if (!snapshot) {
    if (index >= 0) charts.splice(index, 1);
    return "removed";
  }
  if (index < 0) {
    charts.push(cloneChart(snapshot));
  } else {
    restoreInPlace(charts[index], snapshot);
  }
  return "reverted";
}

/** The per-chart line in the user-visible message. */
function failureLine(failure: ChartPersistFailure): string {
  const name = `"${failure.chartName}"`;
  switch (failure.outcome) {
    case "removed":
      return `${name} was never saved, so it has been removed from the sheet.`;
    case "reverted":
      return `${name} has gone back to the last saved version. Discarded: ${failure.lost}.`;
    case "restored":
      return `${name} could not be deleted, so it has been put back.`;
    default:
      return `${name} is unchanged.`;
  }
}

/** The whole message: one headline, one line per chart, one closing sentence. */
function buildFailureMessage(failures: ChartPersistFailure[]): string {
  const reasons = Array.from(new Set(failures.map((f) => f.reason))).filter((r) => r.length > 0);
  const headline =
    failures.length === 1
      ? "Calcula could not save a chart change."
      : `Calcula could not save ${failures.length} chart changes.`;
  const lines = failures.map((f) => `  - ${failureLine(f)}`);
  const because =
    reasons.length === 1
      ? `Reason: ${reasons[0]}`
      : `Reasons:\n${reasons.map((r) => `  - ${r}`).join("\n")}`;
  return [
    headline,
    "",
    because,
    "",
    ...lines,
    "",
    "Nothing was written to the workbook, so what you see now matches what is stored.",
  ].join("\n");
}

/**
 * Report a batch of refused writes: console.error for every one of them (with the
 * raw reason and the chart id), then AT MOST ONE awaited dialog for the batch.
 *
 * `alertAsync` and not `window.alert`: under Tauri the global is fire-and-forget
 * and does not block even when awaited, so the user could miss the message
 * entirely (see app/src/core/lib/dialogs.ts).
 */
async function reportChartPersistFailures(failures: ChartPersistFailure[]): Promise<void> {
  if (failures.length === 0) return;
  for (const failure of failures) {
    console.error(
      `[Charts] Backend refused ${failure.operation} for chart "${failure.chartName}" ` +
        `(${failure.chartId}): ${failure.reason} -- in-memory state ${failure.outcome}` +
        (failure.outcome === "reverted" ? ` (discarded: ${failure.lost})` : ""),
      failure,
    );
  }
  // The canvas is repainted from the regions, so it has to be re-synced from the
  // rolled-back store BEFORE the modal goes up — otherwise the user reads "it has
  // gone back to the last saved version" while looking at the edit that was lost.
  syncChartRegions();
  if (failureDialogOpen) return;
  failureDialogOpen = true;
  try {
    await alertAsync(buildFailureMessage(failures), { title: "Charts", kind: "error" });
  } finally {
    failureDialogOpen = false;
  }
}

// ============================================================================
// Debounced Persistence (for high-frequency operations like drag/resize)
// ============================================================================

/** Chart IDs that have been mutated but not yet persisted. */
const dirtyChartIds = new Set<string>();

/**
 * Dirty chart ids whose ONLY pending change is a sheet-id stamp (the load-time
 * migration, or a create whose sheet list was not to hand). Such a write
 * carries nothing the user authored -- the stamp names the same sheet the index
 * already names -- so a refusal (a protected sheet refuses every chart write)
 * is logged and NOT put in front of the user as lost work. Any real edit to the
 * chart before the flush removes it from this map. The value is the step the
 * stamp finishes, which the backend needs to decide the dirty flag.
 */
const stampOnlyCharts = new Map<string, ChartSheetIdStamp>();

/**
 * For a load-time stamp: the entry AS THE BACKEND STORES IT, with the stamps
 * applied (`stampStoredChartJson`), computed from the same sheet list as the
 * in-memory stamp. A stamp-only flush sends this, flagged `sheetIdStamp`, and
 * the backend records it without an undo step -- and, after a load, without
 * dirtying the document -- once it has verified the write adds sheet ids and
 * nothing else. The normalized definition
 * would not pass that check (a bare spec comes back wrapped, missing axes come
 * back filled in), and through the ordinary update the stamp made every
 * workbook holding such a chart open DIRTY. Any real edit removes the entry.
 */
const pendingStampEntries = new Map<string, ChartEntry>();

/** Timer handle for the debounced save. */
let saveTimer: number | null = null;

/**
 * Mark a chart as dirty and schedule a debounced persist.
 * Multiple calls within 300ms are batched into a single flush.
 */
function scheduleSave(chartId: string, reason: "edit" | ChartSheetIdStamp = "edit"): void {
  if (reason !== "edit") {
    if (!dirtyChartIds.has(chartId)) stampOnlyCharts.set(chartId, reason);
  } else {
    stampOnlyCharts.delete(chartId);
    pendingStampEntries.delete(chartId);
  }
  dirtyChartIds.add(chartId);
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void runFlush(true);
  }, 300);
}

/** Index -> sheet id from the resolver's CACHED sheet list (synchronous; may miss). */
const cachedSheetIdForIndex: SheetIdForIndex = (sheetIndex) => peekSheetIdForIndex(sheetIndex);

/**
 * Stamp the sheet id onto every DataRangeRef in `chart`'s spec that lacks one,
 * from the CACHED sheet list only -- synchronous, so no persist path waits on a
 * backend read for it. A cold cache simply leaves the ref for the load-time
 * migration. Skipped for a chart under a transient preview: its `spec` is the
 * preview, not the stored spec.
 */
function stampChartFromCache(chart: ChartDefinition): void {
  if (activePreview !== null && activePreview.chartId === chart.chartId) return;
  if (!specHasUnstampedRangeRef(chart.spec)) return;
  const stamped = stampSpecSheetIds(chart.spec, cachedSheetIdForIndex);
  if (stamped !== chart.spec) chart.spec = stamped;
}

/**
 * The flush that is running (or resolved). Flushes are SERIALISED through it:
 * a manual flush that finds nothing dirty still waits for a timer-driven one
 * whose writes are in flight, so "flushed" always means "landed" -- the canvas's
 * one-undo-step arrange and group drag commit their transaction only after it.
 */
let flushInFlight: Promise<unknown> = Promise.resolve();

/** Run a flush after any flush already in flight. */
function runFlush(report: boolean): Promise<ChartPersistFailure[]> {
  const run = flushInFlight.then(() => flushDirtyCharts(report));
  flushInFlight = run.catch(() => undefined);
  return run;
}

/**
 * Flush all dirty charts to the backend.
 * Called automatically after the debounce delay, or can be called
 * manually (e.g., before file save) via `flushPendingChartSaves()`.
 *
 * `report` false: refusals are still rolled back (and the regions re-synced),
 * but NOT put in front of the user -- the caller reports them (the object-
 * geometry seam shows one toast for a whole arrange). The failures are
 * returned either way.
 */
async function flushDirtyCharts(report = true): Promise<ChartPersistFailure[]> {
  const ids = Array.from(dirtyChartIds);
  const stampOnly = new Map<string, ChartSheetIdStamp>();
  for (const id of ids) {
    const origin = stampOnlyCharts.get(id);
    if (origin !== undefined) stampOnly.set(id, origin);
    stampOnlyCharts.delete(id);
  }
  dirtyChartIds.clear();
  // The timer is the CALLER's to clear (a serialised flush can start after a
  // newer save was scheduled, and must not forget that newer timer).
  const failures: ChartPersistFailure[] = [];
  for (const id of ids) {
    const storedStamp = pendingStampEntries.get(id);
    pendingStampEntries.delete(id);
    const chart = getChartById(id);
    if (!chart) continue;
    // Every write carries the source sheet's id where the cache can supply it,
    // so a ref a script wrote by index is pinned to that sheet from now on.
    stampChartFromCache(chart);
    // NEVER the previewed spec: a save scheduled by an unrelated edit must not
    // carry a hover preview to disk (see `chartAsPersisted`).
    const persistable = chartAsPersisted(chart);
    const stampOrigin = stampOnly.get(id);
    if (stampOrigin !== undefined) {
      // A STAMP, sent as one: the stored record plus its sheet ids (or, for a
      // create whose sheet list was cold, the entry the create wrote plus the
      // stamp), with the step it finishes. The backend verifies that it is a
      // stamp and records it with no undo step -- clean after a load, dirty
      // after a create (chart_commands.rs, `record_chart_sheet_id_stamp`).
      try {
        await chartsBackend.invoke("update_chart", {
          entry: storedStamp ?? toEntry(persistable),
          sheetIdStamp: stampOrigin,
        });
        recordPersisted(persistable);
      } catch (error) {
        // Nothing the user did was refused: the stored chart still resolves
        // its data by index, and the next load tries the stamp again.
        console.warn(
          `[Charts] Could not record the source sheet id for chart "${chart.name}" (${id}); ` +
            `it keeps resolving its data by sheet index: ${describeBackendError(error)}`,
        );
      }
      continue;
    }
    try {
      await chartsBackend.invoke("update_chart", { entry: toEntry(persistable) });
      recordPersisted(persistable);
    } catch (error) {
      // Describe the loss BEFORE the rollback, while both versions still exist.
      const snapshot = persistedSnapshots.get(id);
      // Also the persistable shape: a preview is not a lost EDIT, and naming it
      // as one would tell the reader they had lost work they never authored.
      const lost = snapshot ? describeLostEdits(persistable, snapshot) : "the whole chart";
      const chartName = chart.name;
      const outcome = rollbackToPersisted(id);
      failures.push({
        chartId: id,
        chartName,
        operation: "update",
        reason: describeBackendError(error),
        outcome,
        lost,
      });
    }
  }
  // One flush, one message, however many charts were refused.
  if (report) {
    await reportChartPersistFailures(failures);
  } else if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `[Charts] Backend refused ${failure.operation} for chart "${failure.chartName}" ` +
          `(${failure.chartId}): ${failure.reason} -- in-memory state ${failure.outcome}`,
      );
    }
    // The rolled-back store is what the canvas must paint.
    syncChartRegions();
  }
  return failures;
}

/**
 * Public API: flush any pending debounced chart saves immediately.
 * Call this before file save or app close to avoid losing changes.
 * Also waits for a flush already in flight.
 */
export async function flushPendingChartSaves(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirtyChartIds.size === 0) {
    await flushInFlight;
    return;
  }
  await runFlush(true);
}

/**
 * Tell the user about refused chart writes the store's usual way (one dialog
 * for the batch, every one logged). For a caller that flushed quietly and
 * found failures that are not its own to report.
 */
export function reportChartFailures(failures: ChartPersistFailure[]): Promise<void> {
  return reportChartPersistFailures(failures);
}

/**
 * Flush pending chart saves WITHOUT telling the user about refusals: they are
 * rolled back to the last persisted version (and the regions re-synced), and
 * RETURNED so the caller can report them its own way. The object-geometry
 * provider's commit uses this, so an arrange that a protected sheet refuses
 * produces one toast for every family rather than a chart dialog beside it.
 */
export async function flushPendingChartSavesQuietly(): Promise<ChartPersistFailure[]> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirtyChartIds.size === 0) {
    await flushInFlight;
    return [];
  }
  return runFlush(false);
}

// ============================================================================
// Backend Load (call on init / file open)
// ============================================================================

/**
 * Load all charts from the Rust backend into the in-memory store.
 * Call this on extension activation and after file open.
 *
 * `stampSheetIds: false` skips the late sheet-id stamp (see `migrateSheetIds`).
 * A chart loaded from a FILE arrives stamped already -- the backend pins every
 * index-only range to the file's own sheet inside `open_file` (BUG-0204) -- so
 * the late stamp only ever meets a chart some other path wrote by index. After
 * a sheet-list CHANGE it must not meet one at all: the backend renumbered the
 * sheets but not the index inside such a range, so stamping it now would pin
 * the chart to whichever sheet took the old index.
 */
export async function loadChartsFromBackend(options?: { stampSheetIds?: boolean }): Promise<void> {
  // File > New and File > Open both land here. The whole `charts` array is
  // replaced below, so a preview held against the OUTGOING document would
  // otherwise survive as a restore token aimed at a chart id from another
  // workbook (the document-scoped-state lesson).
  activePreview = null;
  let loadedEntries: ChartEntry[] = [];
  try {
    const entries = await chartsBackend.invoke<ChartEntry[]>("get_charts");
    loadedEntries = entries;
    charts = entries.map(fromEntry);
    // Everything that just came OFF the backend is, by definition, persisted —
    // this is the rollback target for the first refused write of the session.
    persistedSnapshots.clear();
    for (const chart of charts) recordPersisted(chart);
    // Set the display-name counter past the number of existing charts
    nextChartNumber = charts.length + 1;
    // Advisory schema check: a persisted chart authored by an older app build (or
    // by a script/AI before the broker write-path gate landed) may carry keys the
    // schema no longer accepts. We WARN rather than drop — dropping a chart that
    // still renders fine would be a worse regression than a stale key. The broker
    // write path (validateChartSpec) gates new writes; this is a load-time canary.
    //
    // Note the division of labour with fromEntry: MISSING structure is repaired
    // (a chart with no yAxis renders with a default one instead of painting an
    // exception), while WRONG structure is reported here and left alone. The
    // repair is announced separately so "we changed what was loaded" never hides
    // inside a schema warning.
    for (const entry of entries) {
      let raw: unknown;
      try {
        raw = JSON.parse(entry.specJson);
      } catch {
        raw = null;
      }
      const rawSpec =
        raw && typeof raw === "object" && "spec" in (raw as Record<string, unknown>)
          ? (raw as Record<string, unknown>).spec
          : raw;
      if (chartSpecNeedsRepair(rawSpec)) {
        console.warn(
          `[Charts] Chart ${entry.id} was persisted without a complete spec ` +
            `(missing axes/legend/palette); default values were supplied so it renders.`,
        );
      }
    }
    for (const chart of charts) {
      const violations = validateChartSpec(chart.spec);
      if (violations.length > 0) {
        console.warn(
          `[Charts] Chart "${chart.name}" (${chart.chartId}) has ${violations.length} schema violation(s); ` +
            `rendering anyway. First: ${violations[0]}`,
        );
      }
    }
  } catch {
    // If backend call fails (e.g., fresh app), start with empty store
    charts = [];
    persistedSnapshots.clear();
    nextChartNumber = 1;
    return;
  }
  // AFTER the snapshots are recorded: they are what the backend holds. The
  // stamp is persisted AS a stamp (see `pendingStampEntries`).
  if (options?.stampSheetIds === false) return;
  await migrateSheetIds(charts, loadedEntries, "afterLoad");
}

/**
 * Load-time migration: stamp the source sheet's id on every DataRangeRef a
 * chart carries without one (spec.data, layers[].data, lookup `from`, concat
 * children -- see chartSheetRefs.ts), from ONE sheet-list read, and persist the
 * stamps through the debounced update path AS STAMPS: the stored record plus
 * its sheet ids, flagged `sheetIdStamp` with `origin`, which the backend
 * records without an undo step. After a load (`afterLoad`) that is also
 * without dirtying the document -- loading a workbook is not editing it;
 * after a create with a cold sheet list (`afterCreate`) it dirties like the
 * create it finishes.
 *
 * The id comes from the ref's own `sheetIndex` at load -- the only thing a
 * ref written before ids existed says about its sheet. A ref whose index no
 * sheet answers to is left alone (it cannot be pinned to anything), and a
 * failed sheet-list read leaves every chart as it was: an unstamped ref still
 * resolves by index, exactly as before.
 */
async function migrateSheetIds(
  loaded: readonly ChartDefinition[],
  entries: readonly ChartEntry[],
  origin: ChartSheetIdStamp,
): Promise<void> {
  const needing = loaded.filter((c) => specHasUnstampedRangeRef(c.spec));
  if (needing.length === 0) return;
  let idForIndex: SheetIdForIndex;
  try {
    const map = await loadSheetIdMap();
    idForIndex = (sheetIndex) => map.idByIndex.get(sheetIndex);
  } catch (error) {
    console.warn("[Charts] Could not read the sheet list to stamp chart source sheet ids:", error);
    return;
  }
  for (const chart of needing) {
    // A newer load (or a delete) may have replaced the chart while we waited.
    if (getChartById(chart.chartId) !== chart) continue;
    if (activePreview !== null && activePreview.chartId === chart.chartId) continue;
    const stamped = stampSpecSheetIds(chart.spec, idForIndex);
    if (stamped === chart.spec) continue;
    chart.spec = stamped;
    const stored = entries.find((e) => e.id === chart.chartId);
    const storedJson = stored ? stampStoredChartJson(stored.specJson, idForIndex) : null;
    if (stored && storedJson !== null) {
      pendingStampEntries.set(chart.chartId, { id: stored.id, sheetIndex: stored.sheetIndex, specJson: storedJson });
    }
    scheduleSave(chart.chartId, origin);
  }
}

// ============================================================================
// Adopting the backend's rewrites of a record a pending save still holds
// ============================================================================

/** Bound on the merge's recursion (a spec nests `concat` charts, each shallow). */
const MAX_REWRITE_MERGE_DEPTH = 64;

/** Keys of a JSON object whose value is present (an `undefined` value is absence, as in JSON). */
function presentKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/** Structural JSON equality: key order ignored, an `undefined` member equal to an absent one. */
function sameJson(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > MAX_REWRITE_MERGE_DEPTH) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJson(item, b[i], depth + 1));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = presentKeys(a);
    const keysB = presentKeys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => b[key] !== undefined && sameJson(a[key], b[key], depth + 1));
  }
  return false;
}

/**
 * THREE-WAY MERGE of a pending edit with what the backend holds now.
 *
 * `current` is the in-memory value (the last persisted value plus the pending
 * edit), `before` the last value the backend confirmed (the snapshot), and
 * `stored` what the backend holds after an operation of its own rewrote the
 * record. Wherever the backend changed the value and the pending edit did not,
 * the backend's value is adopted; wherever the edit changed it, the edit wins;
 * where both changed an object the merge goes down into it, so a range whose
 * ROWS the user edited still takes the sheet index the backend remapped; and
 * where both changed a LIST it goes down element by element, each against the
 * element it came from (`matchListElements`), so a pending edit that appended,
 * removed or reordered a layer or a transform still takes the backend's
 * rewrite of every element it left alone. Returns `current` itself when there
 * is nothing to adopt.
 *
 * Generic on purpose: which members of a chart record a backend operation
 * rewrites (today the index-only ranges `remap_chart_index_ranges` walks, in
 * object_deps.rs) is the backend's business, and a copy of that walk here
 * would drift from it -- the same reason `count_sheet_id_stamps` is generic.
 */
function adoptBackendRewrites(current: unknown, before: unknown, stored: unknown, depth = 0): unknown {
  if (sameJson(before, stored)) return current;
  if (sameJson(current, before)) return stored === undefined ? undefined : JSON.parse(JSON.stringify(stored));
  if (depth >= MAX_REWRITE_MERGE_DEPTH) return current;
  if (isPlainObject(current) && isPlainObject(before) && isPlainObject(stored)) {
    const out: Record<string, unknown> = { ...current };
    const keys = new Set([...Object.keys(current), ...Object.keys(before), ...Object.keys(stored)]);
    for (const key of keys) {
      const merged = adoptBackendRewrites(current[key], before[key], stored[key], depth + 1);
      if (merged === undefined) delete out[key];
      else out[key] = merged;
    }
    return out;
  }
  // A list the backend rewrote IN PLACE (it never adds or removes elements:
  // its remap rewrites a range where it stands). One whose length it changed
  // cannot be lined up with the edit.
  if (Array.isArray(current) && Array.isArray(before) && Array.isArray(stored) && before.length === stored.length) {
    const origin = matchListElements(current, before, depth);
    return current.map((item, i) => {
      const j = origin[i];
      return j < 0 ? item : adoptBackendRewrites(item, before[j], stored[j], depth + 1);
    });
  }
  // Both changed it, and not in a shape that can be merged: the edit wins.
  return current;
}

/** Bound on the element pairs `matchListElements` compares; a longer list is matched by position only. */
const MAX_REWRITE_MATCH_PAIRS = 4096;

/** Leaf values in a JSON value (an empty object or list counts as one). */
function leafCount(value: unknown, depth = 0): number {
  if (depth >= MAX_REWRITE_MERGE_DEPTH) return 1;
  let n = 0;
  if (isPlainObject(value)) for (const key of presentKeys(value)) n += leafCount(value[key], depth + 1);
  else if (Array.isArray(value)) for (const item of value) n += leafCount(item, depth + 1);
  else return 1;
  return Math.max(n, 1);
}

/** How many of `a`'s leaf values `b` holds unchanged at the same path (0: nothing in common). */
function sharedLeaves(a: unknown, b: unknown, depth = 0): number {
  if (sameJson(a, b, depth)) return leafCount(a, depth);
  if (depth >= MAX_REWRITE_MERGE_DEPTH) return 0;
  let n = 0;
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of presentKeys(a)) n += sharedLeaves(a[key], b[key], depth + 1);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) n += sharedLeaves(a[i], b[i], depth + 1);
  }
  return n;
}

/**
 * For each element of the edited list `current`, the index of the element of
 * `before` it CAME FROM, or -1 for one the edit added. Matching by position
 * alone (what the merge did until review D) goes wrong the moment the edit
 * changes the list's shape: after an append the untouched elements were not
 * merged at all, and after a removal or a reorder a layer would be read
 * against its NEIGHBOUR and take the neighbour's rewrite -- a live range
 * pinned as gone because the layer beside it was on the deleted sheet.
 *
 *   1. An element the edit left UNCHANGED is found by value (its own position
 *      first). Wherever an append, removal or reorder moved it, it is the
 *      same value, and equal values are rewritten alike. This goes BEFORE
 *      step 2: an element holding all of this one's values and more (the same
 *      range stamped with its sheet id, which the backend leaves alone)
 *      shares as much with it as its true origin does.
 *   2. An element the edit CHANGED is paired with the remaining one it shares
 *      the most leaf values with (ties to the nearer position): a layer whose
 *      rows were edited still carries its sheet, its columns and its mark.
 *      One that shares nothing is new, and stays exactly as the edit wrote it
 *      -- pairing it anyway could only hand it keys the backend ADDED to
 *      another element.
 *
 * Past `MAX_REWRITE_MATCH_PAIRS` only step 1 at the same position runs.
 */
function matchListElements(current: readonly unknown[], before: readonly unknown[], depth: number): number[] {
  const origin = new Array<number>(current.length).fill(-1);
  const taken = new Array<boolean>(before.length).fill(false);
  const pair = (i: number, j: number): void => {
    origin[i] = j;
    taken[j] = true;
  };
  for (let i = 0; i < Math.min(current.length, before.length); i++) {
    if (sameJson(current[i], before[i], depth + 1)) pair(i, i);
  }
  if (current.length * before.length > MAX_REWRITE_MATCH_PAIRS) return origin;
  for (let i = 0; i < current.length; i++) {
    if (origin[i] >= 0) continue;
    const j = before.findIndex((item, k) => !taken[k] && sameJson(current[i], item, depth + 1));
    if (j >= 0) pair(i, j);
  }
  const candidates: Array<{ i: number; j: number; shared: number }> = [];
  for (let i = 0; i < current.length; i++) {
    if (origin[i] >= 0) continue;
    for (let j = 0; j < before.length; j++) {
      if (taken[j]) continue;
      const shared = sharedLeaves(current[i], before[j], depth + 1);
      if (shared > 0) candidates.push({ i, j, shared });
    }
  }
  candidates.sort((a, b) => b.shared - a.shared || Math.abs(a.i - a.j) - Math.abs(b.i - b.j) || a.i - b.i || a.j - b.j);
  for (const { i, j } of candidates) {
    if (origin[i] < 0 && !taken[j]) pair(i, j);
  }
  return origin;
}

/**
 * Reload the store after the sheet COLLECTION changed (a sheet added, deleted,
 * moved, copied, or such an operation undone), WITHOUT losing a pending
 * debounced save.
 *
 * WHY NOT JUST RELOAD. A drag schedules its write 300 ms out. Replacing the
 * array under it lost the drag (the timer then wrote the reloaded, un-dragged
 * chart). WHY NOT JUST FLUSH FIRST. The backend has already REMAPPED each
 * chart for the operation that just happened -- its placement sheet, and every
 * data range that names its sheet by INDEX only (`spec.data`,
 * `layers[].data`, a lookup's `from`, `concat` children; a range whose sheet
 * is gone is pinned to an unresolvable sheet id) -- and a flush writes the
 * whole record, so writing the in-memory, pre-operation indices would undo
 * that remap, the very staleness this reload exists to cure. (X14: the ranges
 * were not adopted, so a drag still waiting its turn wrote them back and the
 * chart charted whichever sheet took the old index.)
 *
 * So: read the entries the backend holds now; for every pending chart adopt
 * ITS placement index unless the user moved the chart to another sheet since
 * the last persist, and ITS rewrites of the spec wherever the pending edit did
 * not change the same value (`adoptBackendRewrites`); make the rollback
 * snapshot what the backend now holds; drop a pending chart the backend no
 * longer has (it went with its sheet -- `update_chart` would refuse it and
 * show a spurious error); flush; THEN reload.
 */
export async function reloadChartsAfterSheetListChange(): Promise<void> {
  if (saveTimer !== null || dirtyChartIds.size > 0) {
    let entries: ChartEntry[] | null = null;
    try {
      entries = await chartsBackend.invoke<ChartEntry[]>("get_charts");
    } catch {
      entries = null;
    }
    if (entries !== null) {
      const storedEntries = new Map<string, ChartEntry>();
      for (const e of entries) storedEntries.set(e.id, e);
      for (const id of Array.from(dirtyChartIds)) {
        const chart = getChartById(id);
        const storedEntry = storedEntries.get(id);
        if (!chart || storedEntry === undefined) {
          dirtyChartIds.delete(id);
          stampOnlyCharts.delete(id);
          pendingStampEntries.delete(id);
          continue;
        }
        const stored = storedEntry.sheetIndex;
        const snapshot = persistedSnapshots.get(id);
        // A pending placement MOVE (the user put the chart on another sheet and
        // it has not been written yet) is the user's; anything else follows the
        // backend's remap.
        if (!snapshot || chart.sheetIndex === snapshot.sheetIndex) {
          chart.sheetIndex = stored;
        }
        // The spec: three-way against the last confirmed version. Without a
        // snapshot there is no telling the user's edit from the backend's
        // rewrite, and the spec is written as it is.
        if (snapshot) {
          const storedSpec = fromEntry(storedEntry).spec;
          chart.spec = adoptBackendRewrites(chart.spec, snapshot.spec, storedSpec) as ChartSpec;
          // A hover preview holds the spec to persist; it takes the rewrites too.
          if (activePreview !== null && activePreview.chartId === id) {
            activePreview = {
              chartId: id,
              original: adoptBackendRewrites(activePreview.original, snapshot.spec, storedSpec) as ChartSpec,
            };
          }
          // The rollback target is what the backend holds NOW: a refused flush
          // must put back the remapped record, and name only the user's edit
          // as lost.
          snapshot.sheetIndex = stored;
          snapshot.spec = JSON.parse(JSON.stringify(storedSpec)) as ChartSpec;
        }
      }
      await flushPendingChartSaves();
    }
  }
  // NO late sheet-id stamp here (BUG-0204): the sheet list just changed under
  // every index-only range, so stamping would pin it to the wrong sheet.
  await loadChartsFromBackend({ stampSheetIds: false });
}

// ============================================================================
// Store Operations
// ============================================================================

/**
 * Create a new chart and add it to the store.
 * Returns the created chart definition.
 */
export function createChart(spec: ChartSpec, placement: ChartPlacement): ChartDefinition {
  const chart = addNewChart(spec, placement);
  // Persist to backend. Still not awaited (createChart is synchronous by
  // contract and a dozen callers rely on that), but no longer SWALLOWED: a
  // refusal removes the chart again and tells the user.
  void persistNewChart(chart, "create");
  return chart;
}

/** Where a new chart goes (createChart / createChartLanded). */
export interface ChartPlacement {
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Display name; omitted (or blank) auto-numbers as "Chart N". */
  name?: string;
}

/** What `createChartLanded` settled to. */
export interface LandedChartCreate {
  /** The chart, now stored by the backend -- or null when it was refused. */
  chart: ChartDefinition | null;
  /** The backend's reason when refused (the chart is gone from the store again). */
  refusal: string | null;
}

/**
 * Create a chart and WAIT until the backend has it -- for a caller that must
 * know it LANDED: a paste or duplicate of several objects runs inside ONE
 * undo transaction (@api/objectClipboard), and a save still in flight when
 * that transaction commits would record its "Insert chart" as a step of its
 * own. Never rejects. A refusal removes the chart again (as `createChart`
 * does) and settles to its reason; with `reportRefusal: false` the caller
 * names it (one toast for the whole paste) instead of this store's dialog.
 *
 * `opts` is optional without a default literal, like `deleteChart`'s (the
 * cascade-announcement census reads bodies from the first brace).
 */
export async function createChartLanded(
  spec: ChartSpec,
  placement: ChartPlacement,
  opts?: { reportRefusal?: boolean },
): Promise<LandedChartCreate> {
  const chart = addNewChart(spec, placement);
  const refusal = await persistNewChart(chart, "create", opts?.reportRefusal !== false);
  if (refusal !== null) return { chart: null, refusal };
  return { chart, refusal: null };
}

/** Build a new chart from `spec` + `placement` and put it in the store (no persist). */
function addNewChart(spec: ChartSpec, placement: ChartPlacement): ChartDefinition {
  const id = crypto.randomUUID();
  // The auto-number is consumed either way, so a later rename of an explicitly
  // named chart can never collide with the next auto-named one.
  const autoName = `Chart ${nextChartNumber++}`;
  const chart: ChartDefinition = {
    chartId: id,
    name: placement.name?.trim() || autoName,
    sheetIndex: placement.sheetIndex,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    // Same reasoning as fromEntry: `spec` is typed but not all callers are
    // type-checked against it — the script broker and the MCP tools hand over a
    // parsed JSON object. Completing here means no path into the store can
    // produce a chart the painters cannot draw.
    //
    // And the source sheet's id goes on every DataRangeRef the caller wrote by
    // index (a script / MCP client can only write `sheetIndex`), from the
    // cached sheet list so create stays synchronous. A cold cache is covered
    // after the save (see persistNewChart).
    spec: stampSpecSheetIds(normalizeChartSpec(spec), cachedSheetIdForIndex),
  };
  charts.push(chart);
  return chart;
}

/**
 * Upsert a chart the backend does not have yet — a brand-new chart, or one being
 * put back by undo.
 *
 * `save_chart` and not `update_chart`: `save_chart` is the UPSERT
 * (chart_commands.rs), while `update_chart` returns `Err("Chart with id ... not
 * found")` for an id the backend has never seen. Routing undo through the
 * debounced update path therefore could not work — the restore was rejected every
 * time and, until this module started reporting refusals, rejected in silence.
 */
async function persistNewChart(
  chart: ChartDefinition,
  operation: "create" | "restore",
  report = true,
): Promise<string | null> {
  // The record exactly as written: a later stamp is verified against it.
  const written = toEntry(chart);
  try {
    await chartsBackend.invoke("save_chart", { entry: written });
    recordPersisted(chart);
    // The create could not stamp every ref from the cache (the sheet list was
    // not to hand). The save above is NOT delayed for it -- a create followed
    // at once by a delete must reach the backend in that order -- so the stamp
    // follows as a debounced STAMP of the record just written, marked as
    // finishing this create: it dirties like the create (nothing is being
    // loaded) and adds no step behind "Insert chart".
    if (operation === "create" && specHasUnstampedRangeRef(chart.spec)) {
      void migrateSheetIds([chart], [written], "afterCreate");
    }
    return null;
  } catch (error) {
    const chartName = chart.name;
    const reason = describeBackendError(error);
    const outcome = rollbackToPersisted(chart.chartId);
    if (!report) {
      // The caller names the refusal (createChartLanded, reportRefusal:false);
      // the chart it removed must stop painting all the same.
      console.error(`[Charts] Backend refused ${operation} for chart "${chartName}" (${chart.chartId}): ${reason}`);
      syncChartRegions();
      return reason;
    }
    await reportChartPersistFailures([
      {
        chartId: chart.chartId,
        chartName,
        operation,
        reason,
        outcome,
        lost: "the whole chart",
      },
    ]);
    return reason;
  }
}

/**
 * Find a chart by its ID.
 */
export function getChartById(chartId: string): ChartDefinition | null {
  return charts.find((c) => c.chartId === chartId) ?? null;
}

/**
 * Get all chart definitions.
 */
export function getAllCharts(): ChartDefinition[] {
  return [...charts];
}

/**
 * Update the spec for an existing chart via a deep-merge patch.
 *
 * Nested objects (axes, scale, theme, ...) merge field-by-field, so a partial
 * patch never clobbers sibling properties. Arrays replace wholesale and an
 * explicit `undefined` clears a field. For a full overwrite (where omitted
 * fields must be deleted), use {@link replaceChartSpec} instead.
 */
export function updateChartSpec(
  chartId: string,
  specUpdates: Partial<ChartSpec>,
): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (chart) {
    // A REAL edit always starts from the STORED spec. Merging onto a live
    // preview would persist the hovered colour as authored state through a
    // command that never asked for it — the exact corruption the
    // transient-write rule exists to prevent.
    if (activePreview !== null && activePreview.chartId === chartId) {
      restoreChartSpecPreview();
    }
    chart.spec = deepMergeSpec(chart.spec, specUpdates);
    // Debounced persist — spec changes during interactive editing
    scheduleSave(chartId);
  }
}

/**
 * Compute (WITHOUT mutating the store) the spec that {@link updateChartSpec} would
 * produce for a deep-merge patch — used by the broker chart-write path to validate
 * the merged result BEFORE committing it. Returns null for an unknown chart. Pure.
 */
export function mergeSpecPreview(chartId: string, specUpdates: Partial<ChartSpec>): ChartSpec | null {
  const chart = charts.find((c) => c.chartId === chartId);
  if (!chart) return null;
  return deepMergeSpec(chart.spec, specUpdates);
}

/**
 * Replace the entire spec for an existing chart (full overwrite, not a merge).
 *
 * Used by the chart editor dialog, which holds the complete spec: deletions made
 * in the Spec tab must take effect, which a merge cannot express. For partial,
 * additive updates use {@link updateChartSpec}.
 */
export function replaceChartSpec(chartId: string, spec: ChartSpec): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (chart) {
    // Same reason as updateChartSpec: the preview is dropped, not overwritten,
    // so its restore token can never be applied on top of the new spec.
    if (activePreview !== null && activePreview.chartId === chartId) {
      restoreChartSpecPreview();
    }
    // A full overwrite is the one write that can DELETE a required field —
    // hand-editing the Spec tab and removing `yAxis` is a two-keystroke way to
    // make a chart paint an exception. Optional fields (filters, trendlines,
    // layers) still delete normally; only the structure the painters
    // dereference unguarded is restored.
    chart.spec = normalizeChartSpec(spec);
    scheduleSave(chartId);
  }
}

/** How {@link deleteChart} tells of a refusal. */
export interface DeleteChartOptions {
  /**
   * false: the store does NOT raise its own failure dialog for a refusal --
   * the CALLER names it (the canvas-wide Delete's one toast,
   * @api/objectSelection `deleteSelectedObjects`). The chart is put back and
   * its region re-published either way. Default true.
   */
  reportRefusal?: boolean;
}

/**
 * Delete a chart from the store. The store changes at once; the returned
 * promise settles when the backend delete has landed -- resolving to null --
 * or has been refused and the chart put back -- resolving to the refusal's
 * reason. It never rejects. A canvas-wide Delete awaits it so the whole
 * selection's deletes land inside ONE undo transaction, and reads the reason
 * so a refused chart STAYS selected and is named (wave A review: a refusal
 * used to count as deleted and deselect the chart that came back).
 *
 * `opts` is optional WITHOUT a default object literal on purpose: the
 * cascade-announcement census (src/api/__tests__/cascadeAnnouncementCensus.test.ts)
 * reads this function's body from the first brace after its name, and a
 * default literal in the parameter list is a brace.
 */
export function deleteChart(chartId: string, opts?: DeleteChartOptions): Promise<string | null> {
  // Restore BEFORE the trash copy is taken. Undo must put back the chart the
  // reader had, not the colour their pointer was resting on when they pressed
  // Delete.
  if (activePreview !== null && activePreview.chartId === chartId) {
    restoreChartSpecPreview();
  }
  const index = charts.findIndex((c) => c.chartId === chartId);
  const chart = index >= 0 ? charts[index] : null;
  if (chart) {
    // Push to trash for undo (keep max 10)
    deletedChartsTrash.push({ ...chart, spec: { ...chart.spec } });
    if (deletedChartsTrash.length > 10) deletedChartsTrash.shift();
  }
  const trashDepth = deletedChartsTrash.length;
  charts = charts.filter((c) => c.chartId !== chartId);
  // Persist to backend
  return chartsBackend
    .invoke("delete_chart", { id: chartId })
    .then(() => {
      persistedSnapshots.delete(chartId);
      // §3bn: the backend cleared the chart-parameter binding of every pane
      // control that drove this chart. The control SURVIVES -- only the dead
      // binding goes -- but the Controls pane caches its config, so a stale
      // card would still offer to drive a chart that no longer exists.
      emitAppEvent(AppEvents.MUTATION_REFRESH, {
        domains: ["paneControl"],
        source: "commit",
      });
      return null;
    })
    .catch((error): string => {
      // The backend still HAS this chart, so the store must have it too. Put it
      // back where it was (z-order is array order) and un-trash it, otherwise
      // Undo would offer to restore a chart that was never removed.
      const restored = chart ? cloneChart(chart) : persistedSnapshots.get(chartId);
      if (restored && !charts.some((c) => c.chartId === chartId)) {
        charts.splice(index >= 0 ? Math.min(index, charts.length) : charts.length, 0, restored);
      }
      if (deletedChartsTrash.length === trashDepth) {
        const top = deletedChartsTrash[deletedChartsTrash.length - 1];
        if (top && top.chartId === chartId) deletedChartsTrash.pop();
      }
      const reason = describeBackendError(error);
      if (opts?.reportRefusal === false) {
        console.error(`[Charts] Backend refused delete for chart "${chart?.name ?? chartId}" (${chartId}): ${reason}`);
        // The caller names the refusal; the chart it put back must still paint.
        syncChartRegions();
      } else {
        void reportChartPersistFailures([
          {
            chartId,
            chartName: chart?.name ?? chartId,
            operation: "delete",
            reason,
            outcome: restored ? "restored" : "unchanged",
            lost: "the deletion",
          },
        ]);
      }
      return reason;
    });
}

/**
 * Undo the last chart deletion. Returns the restored chart, or null if nothing to undo.
 */
export function undoDeleteChart(): ChartDefinition | null {
  const chart = deletedChartsTrash.pop();
  if (!chart) return null;

  charts.push(chart);
  // Persist restoration to backend. NOT scheduleSave: that routes to
  // `update_chart`, which errors for an id the backend no longer has (the delete
  // removed it), so the restore never actually landed. `save_chart` upserts.
  void persistNewChart(chart, "restore");
  return chart;
}

/**
 * Check if there's a deleted chart that can be restored.
 */
export function canUndoDeleteChart(): boolean {
  return deletedChartsTrash.length > 0;
}

/**
 * Move a chart to a new pixel position.
 */
export function moveChart(
  chartId: string,
  x: number,
  y: number,
): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (chart) {
    chart.x = x;
    chart.y = y;
    // Debounced persist — drag operations fire many times per second
    scheduleSave(chartId);
  }
}

/**
 * Resize a chart (full bounds update to support all corner resize).
 */
export function resizeChart(
  chartId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (chart) {
    chart.x = x;
    chart.y = y;
    chart.width = width;
    chart.height = height;
    // Debounced persist — resize operations fire many times per second
    scheduleSave(chartId);
  }
}

/**
 * Patch a chart's placement — position, size, display name and/or sheet
 * (Wave 4 script geometry). Only the keys PRESENT in the patch change; the
 * same fields the drag handles mutate, persisted through the same debounced
 * save. Returns the updated definition, or null when no chart has that id.
 */
export function updateChartPlacement(
  chartId: string,
  placement: {
    name?: string;
    sheetIndex?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  },
): ChartDefinition | null {
  const chart = charts.find((c) => c.chartId === chartId);
  if (!chart) return null;
  if (placement.name !== undefined) chart.name = placement.name;
  if (placement.sheetIndex !== undefined) chart.sheetIndex = placement.sheetIndex;
  if (placement.x !== undefined) chart.x = placement.x;
  if (placement.y !== undefined) chart.y = placement.y;
  if (placement.width !== undefined) chart.width = placement.width;
  if (placement.height !== undefined) chart.height = placement.height;
  scheduleSave(chartId);
  return chart;
}

/**
 * Show a chart at a new position/size WITHOUT persisting it: the in-memory
 * definition changes and nothing is scheduled -- no write, no undo entry, no
 * dirty flag. The canvas's nudge previews every keystroke of a burst this way
 * and commits once through `updateChartPlacement` + a flush; a preview that
 * scheduled saves would land a debounced write mid-burst, outside the burst's
 * one undo step. Returns false when no chart has that id.
 */
export function previewChartPlacement(
  chartId: string,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  const chart = charts.find((c) => c.chartId === chartId);
  if (!chart) return false;
  chart.x = rect.x;
  chart.y = rect.y;
  chart.width = rect.width;
  chart.height = rect.height;
  return true;
}

/**
 * Set the active sheet index. Charts on other sheets will be hidden.
 */
export function setActiveSheetIndex(sheetIndex: number): void {
  activeSheetIndex = sheetIndex;
}

/**
 * Get the active sheet index.
 */
export function getActiveSheetIndex(): number {
  return activeSheetIndex;
}

// ============================================================================
// Reload window -- a render that raced a store reload is not the store's answer
// ============================================================================

/**
 * How many requested reloads of this store have not finished yet (each one a
 * coalesced burst -- see `requestChartsReload` in the extension's index).
 *
 * WHY THE RENDERER ASKS. Between the backend changing the chart collection (a
 * sheet deleted together with its charts, a document replaced) and this store
 * re-reading it, the store still holds the OLD charts at their OLD sheets, and
 * anything that invalidates and repaints inside that window renders one of
 * them -- the one announcement that deletes a sheet also fans out to table
 * definitions, pivots and slicers, and each of those repaints. That render's
 * data read then answers for a workbook that no longer has the chart. Since a
 * range is pinned to its sheet by id (canvas sheets, M4), a chart whose OWN
 * sheet was just deleted fails with "the chart's source sheet no longer
 * exists", and it was reported as a broken chart -- console error, error card --
 * for the few frames until the reload dropped it. The reload repaints every
 * chart when it lands, so a render that FAILS inside the window is dropped
 * quietly and the fresh one reports (chartRenderer.ts, renderChartAsync).
 */
let pendingReloads = 0;

/**
 * Record that a reload of this store has been requested. Returns the callback
 * that marks it finished; calling that more than once is harmless.
 */
export function beginChartStoreReload(): () => void {
  pendingReloads++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pendingReloads = Math.max(0, pendingReloads - 1);
  };
}

/** True while a requested reload of this store has not finished. */
export function isChartStoreReloadPending(): boolean {
  return pendingReloads > 0;
}

/**
 * Reset the entire chart store (used during extension deactivation).
 */
export function resetChartStore(): void {
  // Cancel any pending debounced saves — the store is being torn down
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirtyChartIds.clear();
  stampOnlyCharts.clear();
  pendingStampEntries.clear();
  flushInFlight = Promise.resolve();
  // The store is going away; there is nothing left to restore a preview onto.
  activePreview = null;
  charts = [];
  persistedSnapshots.clear();
  nextChartNumber = 1;
  activeSheetIndex = 0;
  pendingReloads = 0;
  removeGridRegionsByType("chart");
}

// ============================================================================
// Grid Overlay Sync
// ============================================================================

/**
 * Sync all chart definitions to the grid overlay system.
 * Call this after any mutation (create, move, resize, delete, spec change)
 * so the canvas renders charts correctly.
 *
 * Charts use the `floating` field on GridRegion for pixel-based positioning.
 * The cell-based fields (startRow etc.) are set to 0 since they're unused.
 */
export function syncChartRegions(): void {
  removeGridRegionsByType("chart");

  // Only show charts on the active sheet
  const visibleCharts = charts.filter((c) => c.sheetIndex === activeSheetIndex);

  const regions: GridRegion[] = visibleCharts.map((chart) => ({
    id: `chart-${chart.chartId}`,
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: {
      x: chart.x,
      y: chart.y,
      width: chart.width,
      height: chart.height,
    },
    data: {
      chartId: chart.chartId,
      name: chart.name,
    },
  }));

  if (regions.length > 0) {
    addGridRegions(regions);
  }
}
