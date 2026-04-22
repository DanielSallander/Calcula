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

// ============================================================================
// Backend Types
// ============================================================================

/** Matches Rust ChartEntry (api_types.rs). */
interface ChartEntry {
  id: number;
  sheetIndex: number;
  specJson: string;
}

// ============================================================================
// Store State
// ============================================================================

let nextChartId = 1;
let charts: ChartDefinition[] = [];

/** Active sheet index used for filtering which charts to render. */
let activeSheetIndex = 0;

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
    // Set nextChartId to one past the highest existing ID
    let maxId = 0;
    for (const chart of charts) {
      if (chart.chartId > maxId) {
        maxId = chart.chartId;
      }
    }
    nextChartId = maxId + 1;
  } catch {
    // If backend call fails (e.g., fresh app), start with empty store
    charts = [];
    nextChartId = 1;
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
  const id = nextChartId++;
  const chart: ChartDefinition = {
    chartId: id,
    name: `Chart ${id}`,
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
export function getChartById(chartId: number): ChartDefinition | null {
  return charts.find((c) => c.chartId === chartId) ?? null;
}

/**
 * Get all chart definitions.
 */
export function getAllCharts(): ChartDefinition[] {
  return [...charts];
}

/**
 * Update the spec for an existing chart.
 */
export function updateChartSpec(
  chartId: number,
  specUpdates: Partial<ChartSpec>,
): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (chart) {
    chart.spec = { ...chart.spec, ...specUpdates };
    // Persist to backend
    invokeBackend("update_chart", { entry: toEntry(chart) }).catch(() => {});
  }
}

/**
 * Delete a chart from the store.
 */
export function deleteChart(chartId: number): void {
  charts = charts.filter((c) => c.chartId !== chartId);
  // Persist to backend
  invokeBackend("delete_chart", { id: chartId }).catch(() => {});
}

/**
 * Move a chart to a new pixel position.
 */
export function moveChart(
  chartId: number,
  x: number,
  y: number,
): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (chart) {
    chart.x = x;
    chart.y = y;
    // Persist to backend
    invokeBackend("update_chart", { entry: toEntry(chart) }).catch(() => {});
  }
}

/**
 * Resize a chart (full bounds update to support all corner resize).
 */
export function resizeChart(
  chartId: number,
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
    // Persist to backend
    invokeBackend("update_chart", { entry: toEntry(chart) }).catch(() => {});
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
  charts = [];
  nextChartId = 1;
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
