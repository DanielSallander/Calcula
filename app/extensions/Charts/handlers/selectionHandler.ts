//! FILENAME: app/extensions/Charts/handlers/selectionHandler.ts
// PURPOSE: Track selection context for the Chart extension with hierarchical selection.
// CONTEXT: Supports Excel-like selection progression:
//          Level 0: No chart selected
//          Level 1: Chart selected (whole chart - blue border + handles)
//          Level 2: Series selected (all bars in a series highlighted, others dimmed)
//          Level 3: Data point selected (single bar highlighted, everything else dimmed)
//
//          Uses a deferred-click mechanism to distinguish clicks from drags:
//          On mousedown (floatingObject:selected) -> set pending click
//          On moveComplete -> clear pending (was a drag)
//          On mouseup -> if pending still set, it was a click -> advance selection

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
} from "../../../src/api";
import type { ChartHitResult, ChartSubSelection, ChartSelectionLevel } from "../types";

// ============================================================================
// State
// ============================================================================

let currentChartId: number | null = null;

let subSelection: ChartSubSelection = { level: "none" };

/** Pending click state for deferred click detection. */
let pendingClick: {
  chartId: number;
  canvasX: number;
  canvasY: number;
} | null = null;

// ============================================================================
// Selection Management
// ============================================================================

/**
 * Select a chart by ID. Called when a floating chart is clicked.
 * For the first click (chart not yet selected), sets to Level 1.
 * For subsequent clicks, sets pendingClick for deferred processing.
 */
export function selectChart(chartId: number): void {
  if (currentChartId !== chartId) {
    // First click on this chart: select it (Level 1)
    currentChartId = chartId;
    subSelection = { level: "chart" };
    addTaskPaneContextKey("chart");
  }
  // If already selected, the pending click mechanism in index.ts
  // will handle advancing the sub-selection after mouseup.
}

/**
 * Deselect any selected chart. Called when user clicks on the grid (not on a chart).
 */
export function deselectChart(): void {
  if (currentChartId !== null) {
    currentChartId = null;
    subSelection = { level: "none" };
    pendingClick = null;
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
  deselectChart();
}

/**
 * Check if a specific chart is currently selected (any level).
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
 * Get the current sub-selection state.
 */
export function getSubSelection(): ChartSubSelection {
  return subSelection;
}

// ============================================================================
// Hierarchical Selection State Machine
// ============================================================================

/**
 * Advance the selection based on a hit-test result.
 * Called after a confirmed click (not a drag) on a chart that is already selected.
 *
 * State transitions:
 * - Level 1 (chart) + bar hit -> Level 2 (series)
 * - Level 2 (series) + same series bar hit -> Level 3 (dataPoint)
 * - Level 2 (series) + different series bar hit -> Level 2 (new series)
 * - Level 3 (dataPoint) + same bar hit -> Level 3 (same, no-op)
 * - Level 3 (dataPoint) + same series different bar -> Level 3 (new point)
 * - Level 3 (dataPoint) + different series bar hit -> Level 2 (new series)
 * - Level 2/3 + non-bar hit -> Level 1 (chart)
 */
export function advanceSelection(chartId: number, hitResult: ChartHitResult): void {
  if (currentChartId !== chartId) return;

  if (hitResult.type !== "bar") {
    // Clicked on non-bar area (plot background, title, etc.) -> back to chart level
    subSelection = { level: "chart" };
    return;
  }

  const { seriesIndex, categoryIndex } = hitResult;

  switch (subSelection.level) {
    case "chart":
      // Chart selected -> click on bar -> select series
      subSelection = { level: "series", seriesIndex };
      break;

    case "series":
      if (subSelection.seriesIndex === seriesIndex) {
        // Same series -> advance to data point
        subSelection = { level: "dataPoint", seriesIndex, categoryIndex };
      } else {
        // Different series -> switch to that series
        subSelection = { level: "series", seriesIndex };
      }
      break;

    case "dataPoint":
      if (subSelection.seriesIndex === seriesIndex) {
        // Same series -> select the clicked data point
        subSelection = { level: "dataPoint", seriesIndex, categoryIndex };
      } else {
        // Different series -> switch to that series
        subSelection = { level: "series", seriesIndex };
      }
      break;
  }
}

/**
 * Reset sub-selection to chart level (e.g., when data changes).
 * Only resets if a chart is currently selected.
 */
export function resetSubSelection(): void {
  if (currentChartId !== null) {
    subSelection = { level: "chart" };
  }
}

// ============================================================================
// Deferred Click (distinguishes clicks from drags)
// ============================================================================

/**
 * Set a pending click. Called on floatingObject:selected for already-selected charts.
 */
export function setPendingClick(chartId: number, canvasX: number, canvasY: number): void {
  pendingClick = { chartId, canvasX, canvasY };
}

/**
 * Clear the pending click (was a drag, not a click).
 * Called on floatingObject:moveComplete.
 */
export function clearPendingClick(): void {
  pendingClick = null;
}

/**
 * Consume and return the pending click (if any).
 * Called on mouseup to determine if a click occurred.
 */
export function consumePendingClick(): { chartId: number; canvasX: number; canvasY: number } | null {
  const click = pendingClick;
  pendingClick = null;
  return click;
}

// ============================================================================
// Reset
// ============================================================================

/**
 * Reset all selection handler state (used during extension deactivation).
 */
export function resetSelectionHandlerState(): void {
  currentChartId = null;
  subSelection = { level: "none" };
  pendingClick = null;
}
