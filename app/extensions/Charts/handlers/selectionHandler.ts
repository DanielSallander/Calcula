//! FILENAME: app/extensions/Charts/handlers/selectionHandler.ts
// PURPOSE: Track selection context for the Chart extension.
// CONTEXT: Detects when the active cell is within a chart region and manages
//          the "chart" task pane context key for contextual UI.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
} from "../../../src/api";
import { getChartAtCell } from "../lib/chartStore";

// ============================================================================
// State
// ============================================================================

let currentChartId: number | null = null;
let lastCheckedSelection: { row: number; col: number } | null = null;

// ============================================================================
// Selection Handler
// ============================================================================

/**
 * Handle selection changes from the extension registry.
 * Checks if the active cell is within a chart and updates context.
 */
export function handleSelectionChange(
  selection: { endRow: number; endCol: number } | null,
): void {
  if (!selection) return;

  const row = selection.endRow;
  const col = selection.endCol;

  // Skip if already checked this cell
  if (
    lastCheckedSelection?.row === row &&
    lastCheckedSelection?.col === col
  ) {
    return;
  }
  lastCheckedSelection = { row, col };

  const chart = getChartAtCell(row, col);

  if (chart) {
    currentChartId = chart.chartId;
    addTaskPaneContextKey("chart");
  } else {
    if (currentChartId !== null) {
      currentChartId = null;
      removeTaskPaneContextKey("chart");
    }
  }
}

/**
 * Check if a specific chart is currently selected.
 */
export function isChartSelected(chartId: number): boolean {
  return currentChartId === chartId;
}

/**
 * Get the ID of the chart the selection is currently within.
 */
export function getCurrentChartId(): number | null {
  return currentChartId;
}

/**
 * Reset all selection handler state (used during extension deactivation).
 */
export function resetSelectionHandlerState(): void {
  currentChartId = null;
  lastCheckedSelection = null;
}
