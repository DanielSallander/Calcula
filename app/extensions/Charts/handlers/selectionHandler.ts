//! FILENAME: app/extensions/Charts/handlers/selectionHandler.ts
// PURPOSE: Track selection context for the Chart extension.
// CONTEXT: Detects when a floating chart is selected (via move/resize handlers)
//          and manages the "chart" task pane context key for contextual UI.
//          With floating charts, selection is driven by floatingObject events from Core,
//          not by cell-based position checking.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
} from "../../../src/api";

// ============================================================================
// State
// ============================================================================

let currentChartId: number | null = null;

// ============================================================================
// Selection Management
// ============================================================================

/**
 * Select a chart by ID. Called when a floating chart is clicked.
 */
export function selectChart(chartId: number): void {
  if (currentChartId === chartId) return;
  currentChartId = chartId;
  addTaskPaneContextKey("chart");
}

/**
 * Deselect any selected chart. Called when user clicks on the grid (not on a chart).
 */
export function deselectChart(): void {
  if (currentChartId !== null) {
    currentChartId = null;
    removeTaskPaneContextKey("chart");
  }
}

/**
 * Handle selection changes from the extension registry.
 * When the user clicks on a cell (not on a chart), deselect any selected chart.
 */
export function handleSelectionChange(
  _selection: { endRow: number; endCol: number } | null,
): void {
  // If user selected a cell, deselect any chart
  deselectChart();
}

/**
 * Check if a specific chart is currently selected.
 */
export function isChartSelected(chartId: number): boolean {
  return currentChartId === chartId;
}

/**
 * Get the ID of the currently selected chart.
 */
export function getCurrentChartId(): number | null {
  return currentChartId;
}

/**
 * Reset all selection handler state (used during extension deactivation).
 */
export function resetSelectionHandlerState(): void {
  currentChartId = null;
}
