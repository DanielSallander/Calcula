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

// ============================================================================
// Backend Types
// ============================================================================

/** Matches Rust ChartEntry (api_types.rs). */
interface ChartEntry {
  id: string;
  sheetIndex: number;
  specJson: string;
}

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
function fromEntry(entry: ChartEntry): ChartDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.specJson);
  } catch {
    parsed = null;
  }
  return normalizeChartDefinition(parsed, {
    chartId: entry.id,
    sheetIndex: entry.sheetIndex,
  });
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
interface ChartPersistFailure {
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

/** Timer handle for the debounced save. */
let saveTimer: number | null = null;

/**
 * Mark a chart as dirty and schedule a debounced persist.
 * Multiple calls within 300ms are batched into a single flush.
 */
function scheduleSave(chartId: string): void {
  dirtyChartIds.add(chartId);
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushDirtyCharts, 300);
}

/**
 * Flush all dirty charts to the backend.
 * Called automatically after the debounce delay, or can be called
 * manually (e.g., before file save) via `flushPendingChartSaves()`.
 */
async function flushDirtyCharts(): Promise<void> {
  const ids = Array.from(dirtyChartIds);
  dirtyChartIds.clear();
  saveTimer = null;
  const failures: ChartPersistFailure[] = [];
  for (const id of ids) {
    const chart = getChartById(id);
    if (!chart) continue;
    // NEVER the previewed spec: a save scheduled by an unrelated edit must not
    // carry a hover preview to disk (see `chartAsPersisted`).
    const persistable = chartAsPersisted(chart);
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
  await reportChartPersistFailures(failures);
}

/**
 * Public API: flush any pending debounced chart saves immediately.
 * Call this before file save or app close to avoid losing changes.
 */
export function flushPendingChartSaves(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirtyChartIds.size === 0) return Promise.resolve();
  return flushDirtyCharts();
}

// ============================================================================
// Backend Load (call on init / file open)
// ============================================================================

/**
 * Load all charts from the Rust backend into the in-memory store.
 * Call this on extension activation and after file open.
 */
export async function loadChartsFromBackend(): Promise<void> {
  // File > New and File > Open both land here. The whole `charts` array is
  // replaced below, so a preview held against the OUTGOING document would
  // otherwise survive as a restore token aimed at a chart id from another
  // workbook (the document-scoped-state lesson).
  activePreview = null;
  try {
    const entries = await chartsBackend.invoke<ChartEntry[]>("get_charts");
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
  }
}

// ============================================================================
// Store Operations
// ============================================================================

/**
 * Create a new chart and add it to the store.
 * Returns the created chart definition.
 */
export function createChart(
  spec: ChartSpec,
  placement: {
    sheetIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Display name; omitted (or blank) auto-numbers as "Chart N". */
    name?: string;
  },
): ChartDefinition {
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
    spec: normalizeChartSpec(spec),
  };
  charts.push(chart);
  // Persist to backend. Still not awaited (createChart is synchronous by
  // contract and a dozen callers rely on that), but no longer SWALLOWED: a
  // refusal removes the chart again and tells the user.
  void persistNewChart(chart, "create");
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
): Promise<void> {
  try {
    await chartsBackend.invoke("save_chart", { entry: toEntry(chart) });
    recordPersisted(chart);
  } catch (error) {
    const chartName = chart.name;
    const outcome = rollbackToPersisted(chart.chartId);
    await reportChartPersistFailures([
      {
        chartId: chart.chartId,
        chartName,
        operation,
        reason: describeBackendError(error),
        outcome,
        lost: "the whole chart",
      },
    ]);
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

/**
 * Delete a chart from the store.
 */
export function deleteChart(chartId: string): void {
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
  chartsBackend
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
    })
    .catch((error) => {
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
      void reportChartPersistFailures([
        {
          chartId,
          chartName: chart?.name ?? chartId,
          operation: "delete",
          reason: describeBackendError(error),
          outcome: restored ? "restored" : "unchanged",
          lost: "the deletion",
        },
      ]);
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
  // The store is going away; there is nothing left to restore a preview onto.
  activePreview = null;
  charts = [];
  persistedSnapshots.clear();
  nextChartNumber = 1;
  activeSheetIndex = 0;
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
