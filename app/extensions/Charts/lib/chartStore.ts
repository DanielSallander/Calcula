//! FILENAME: app/extensions/Charts/lib/chartStore.ts
// PURPOSE: In-memory chart store for tracking chart definitions.
// CONTEXT: Temporary frontend-only store. Same pattern as tableStore.ts.
//          Will be replaced with backend API calls when Rust chart persistence is added.
//          Charts are free-floating objects positioned by pixel coordinates.

import {
  removeGridRegionsByType,
  addGridRegions,
  type GridRegion,
} from "../../../src/api/gridOverlays";

import type { ChartDefinition, ChartSpec } from "../types";

// ============================================================================
// Store State
// ============================================================================

let nextChartId = 1;
let charts: ChartDefinition[] = [];

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
  }
}

/**
 * Delete a chart from the store.
 */
export function deleteChart(chartId: number): void {
  charts = charts.filter((c) => c.chartId !== chartId);
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
  }
}

/**
 * Reset the entire chart store (used during extension deactivation).
 */
export function resetChartStore(): void {
  charts = [];
  nextChartId = 1;
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

  const regions: GridRegion[] = charts.map((chart) => ({
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
