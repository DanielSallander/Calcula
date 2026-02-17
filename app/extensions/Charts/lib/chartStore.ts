//! FILENAME: app/extensions/Charts/lib/chartStore.ts
// PURPOSE: In-memory chart store for tracking chart definitions.
// CONTEXT: Temporary frontend-only store. Same pattern as tableStore.ts.
//          Will be replaced with backend API calls when Rust chart persistence is added.

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
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  },
): ChartDefinition {
  const id = nextChartId++;
  const chart: ChartDefinition = {
    chartId: id,
    name: `Chart ${id}`,
    sheetIndex: placement.sheetIndex,
    startRow: placement.startRow,
    startCol: placement.startCol,
    endRow: placement.endRow,
    endCol: placement.endCol,
    spec,
  };
  charts.push(chart);
  return chart;
}

/**
 * Find the chart at a given cell position.
 * Returns null if no chart contains the cell.
 */
export function getChartAtCell(
  row: number,
  col: number,
  sheetIndex?: number,
): ChartDefinition | null {
  for (const chart of charts) {
    if (
      (sheetIndex === undefined || chart.sheetIndex === sheetIndex) &&
      row >= chart.startRow &&
      row <= chart.endRow &&
      col >= chart.startCol &&
      col <= chart.endCol
    ) {
      return chart;
    }
  }
  return null;
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
 * Move a chart to a new grid position.
 */
export function moveChart(
  chartId: number,
  startRow: number,
  startCol: number,
): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (chart) {
    const rowSpan = chart.endRow - chart.startRow;
    const colSpan = chart.endCol - chart.startCol;
    chart.startRow = startRow;
    chart.startCol = startCol;
    chart.endRow = startRow + rowSpan;
    chart.endCol = startCol + colSpan;
  }
}

/**
 * Resize a chart's region.
 */
export function resizeChart(
  chartId: number,
  endRow: number,
  endCol: number,
): void {
  const chart = charts.find((c) => c.chartId === chartId);
  if (chart) {
    chart.endRow = endRow;
    chart.endCol = endCol;
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
// Structural Change Handlers
// ============================================================================

/**
 * Shift chart boundaries when rows are inserted.
 * Charts entirely below the insertion point are shifted down.
 * Charts spanning the insertion point expand.
 */
export function shiftChartsForRowInsert(fromRow: number, count: number): void {
  for (const chart of charts) {
    if (chart.startRow > fromRow) {
      chart.startRow += count;
      chart.endRow += count;
    } else if (chart.endRow >= fromRow) {
      chart.endRow += count;
    }
  }
}

/**
 * Shift chart boundaries when columns are inserted.
 */
export function shiftChartsForColInsert(fromCol: number, count: number): void {
  for (const chart of charts) {
    if (chart.startCol > fromCol) {
      chart.startCol += count;
      chart.endCol += count;
    } else if (chart.endCol >= fromCol) {
      chart.endCol += count;
    }
  }
}

/**
 * Shift chart boundaries when rows are deleted.
 * Charts fully within the deleted range are removed.
 */
export function shiftChartsForRowDelete(fromRow: number, count: number): void {
  const deleteEnd = fromRow + count;

  charts = charts.filter(
    (c) => !(c.startRow >= fromRow && c.endRow < deleteEnd),
  );

  for (const chart of charts) {
    if (chart.startRow >= deleteEnd) {
      chart.startRow -= count;
      chart.endRow -= count;
    } else if (chart.startRow >= fromRow) {
      chart.startRow = fromRow;
      chart.endRow -= count;
    } else if (chart.endRow >= deleteEnd) {
      chart.endRow -= count;
    } else if (chart.endRow >= fromRow) {
      chart.endRow = Math.max(fromRow - 1, chart.startRow);
    }
  }
}

/**
 * Shift chart boundaries when columns are deleted.
 * Charts fully within the deleted range are removed.
 */
export function shiftChartsForColDelete(fromCol: number, count: number): void {
  const deleteEnd = fromCol + count;

  charts = charts.filter(
    (c) => !(c.startCol >= fromCol && c.endCol < deleteEnd),
  );

  for (const chart of charts) {
    if (chart.startCol >= deleteEnd) {
      chart.startCol -= count;
      chart.endCol -= count;
    } else if (chart.startCol >= fromCol) {
      chart.startCol = fromCol;
      chart.endCol -= count;
    } else if (chart.endCol >= deleteEnd) {
      chart.endCol -= count;
    } else if (chart.endCol >= fromCol) {
      chart.endCol = Math.max(fromCol - 1, chart.startCol);
    }
  }
}

// ============================================================================
// Grid Overlay Sync
// ============================================================================

/**
 * Sync all chart definitions to the grid overlay system.
 * Call this after any mutation (create, resize, delete, spec change)
 * so the canvas renders charts correctly.
 */
export function syncChartRegions(): void {
  removeGridRegionsByType("chart");

  const regions: GridRegion[] = charts.map((chart) => ({
    id: `chart-${chart.chartId}`,
    type: "chart",
    startRow: chart.startRow,
    startCol: chart.startCol,
    endRow: chart.endRow,
    endCol: chart.endCol,
    data: {
      chartId: chart.chartId,
      name: chart.name,
    },
  }));

  if (regions.length > 0) {
    addGridRegions(regions);
  }
}
