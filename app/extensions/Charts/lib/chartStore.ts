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
import { invokeBackend } from "@api/backend";

import type { ChartDefinition, ChartSpec } from "../types";
import { validateChartSpec } from "./chartSpecValidate";

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

/** Deserialize a ChartEntry from the backend into a ChartDefinition. */
function fromEntry(entry: ChartEntry): ChartDefinition {
  return JSON.parse(entry.specJson) as ChartDefinition;
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
  for (const id of ids) {
    const chart = getChartById(id);
    if (chart) {
      await invokeBackend("update_chart", { entry: toEntry(chart) }).catch(() => {});
    }
  }
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
  try {
    const entries = await invokeBackend<ChartEntry[]>("get_charts");
    charts = entries.map(fromEntry);
    // Set the display-name counter past the number of existing charts
    nextChartNumber = charts.length + 1;
    // Advisory schema check: a persisted chart authored by an older app build (or
    // by a script/AI before the broker write-path gate landed) may carry keys the
    // schema no longer accepts. We WARN rather than drop — dropping a chart that
    // still renders fine would be a worse regression than a stale key. The broker
    // write path (validateChartSpec) gates new writes; this is a load-time canary.
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
  },
): ChartDefinition {
  const id = crypto.randomUUID();
  const chart: ChartDefinition = {
    chartId: id,
    name: `Chart ${nextChartNumber++}`,
    sheetIndex: placement.sheetIndex,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    spec,
  };
  charts.push(chart);
  // Persist to backend (fire-and-forget)
  invokeBackend("save_chart", { entry: toEntry(chart) }).catch(() => {});
  return chart;
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
    chart.spec = spec;
    scheduleSave(chartId);
  }
}

/**
 * Delete a chart from the store.
 */
export function deleteChart(chartId: string): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (chart) {
    // Push to trash for undo (keep max 10)
    deletedChartsTrash.push({ ...chart, spec: { ...chart.spec } });
    if (deletedChartsTrash.length > 10) deletedChartsTrash.shift();
  }
  charts = charts.filter((c) => c.chartId !== chartId);
  // Persist to backend
  invokeBackend("delete_chart", { id: chartId }).catch(() => {});
}

/**
 * Undo the last chart deletion. Returns the restored chart, or null if nothing to undo.
 */
export function undoDeleteChart(): ChartDefinition | null {
  const chart = deletedChartsTrash.pop();
  if (!chart) return null;

  charts.push(chart);
  // Persist restoration to backend
  scheduleSave(chart.chartId);
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
  charts = [];
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
