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
  registerPanel,
  unregisterPanel,
} from "@api";
import type { ChartHitResult, ChartSubSelection, ChartSelectionLevel } from "../types";
import { CHART_DESIGN_TAB_ID, buildChartDesignPanelDefinition } from "../manifest";
import { ChartEvents } from "../lib/chartEvents";

// ============================================================================
// State
// ============================================================================

let currentChartId: string | null = null;

let subSelection: ChartSubSelection = { level: "none" };

/** Whether the contextual Design panel is currently registered. */
let designTabRegistered = false;

/** Section-id fingerprint of the last-registered Design panel. */
let designSectionIds = "";

/** Pending click state for deferred click detection. */
let pendingClick: {
  chartId: string;
  canvasX: number;
  canvasY: number;
} | null = null;

// ============================================================================
// Contextual Design Panel (sections vary with the selected chart's type)
// ============================================================================

/** Register (or upsert) the Design panel for the currently selected chart. */
function registerDesignPanel(): void {
  const definition = buildChartDesignPanelDefinition();
  designSectionIds = definition.sections.map((s) => s.id).join("|");
  registerPanel(definition);
}

/**
 * Re-register the Design panel when the applicable section set changes (e.g.
 * the chart type switches bar -> pie and the Stacking/Trendline groups no
 * longer apply) — mirroring the former monolithic tab's conditional
 * RibbonGroup rendering. No-op when the section list is unchanged, so
 * in-section editing (title typing, etc.) never remounts the panel.
 */
function refreshDesignPanelSections(): void {
  if (!designTabRegistered) return;
  const definition = buildChartDesignPanelDefinition();
  const ids = definition.sections.map((s) => s.id).join("|");
  if (ids !== designSectionIds) {
    designSectionIds = ids;
    registerPanel(definition);
  }
}

/** Window listener: chart specs changed — the section set may have too. */
function handleChartUpdatedForDesignPanel(): void {
  refreshDesignPanelSections();
}

// ============================================================================
// Selection Management
// ============================================================================

/**
 * Select a chart by ID. Called when a floating chart is clicked.
 * For the first click (chart not yet selected), sets to Level 1.
 * For subsequent clicks, sets pendingClick for deferred processing.
 */
export function selectChart(chartId: string): void {
  if (currentChartId !== chartId) {
    // First click on this chart: select it (Level 1)
    currentChartId = chartId;
    subSelection = { level: "chart" };
    addTaskPaneContextKey("chart");

    // Show the contextual Design panel (ribbon-placed by default)
    if (!designTabRegistered) {
      registerDesignPanel();
      designTabRegistered = true;
      // Keep the section set in sync with chart-type changes while selected.
      window.addEventListener(ChartEvents.CHART_UPDATED, handleChartUpdatedForDesignPanel);
    } else {
      // Switching directly to a different chart: its type may need a
      // different section set (e.g. bar -> pie drops Stacking/Trendline).
      refreshDesignPanelSections();
    }
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

    // Hide the contextual Design panel
    if (designTabRegistered) {
      window.removeEventListener(ChartEvents.CHART_UPDATED, handleChartUpdatedForDesignPanel);
      unregisterPanel(CHART_DESIGN_TAB_ID);
      designTabRegistered = false;
      designSectionIds = "";
    }
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
export function isChartSelected(chartId: string): boolean {
  return currentChartId === chartId;
}

/**
 * Get the ID of the currently selected chart.
 */
export function getCurrentChartId(): string | null {
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
export function advanceSelection(chartId: string, hitResult: ChartHitResult): void {
  if (currentChartId !== chartId) return;

  // Axis click -> select the axis
  if (hitResult.type === "axis" && hitResult.axisType) {
    subSelection = { level: "axis", axisType: hitResult.axisType };
    return;
  }

  if (hitResult.type !== "bar" && hitResult.type !== "point" && hitResult.type !== "slice") {
    // Clicked on non-data area (plot background, title, etc.) -> back to chart level
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
export function setPendingClick(chartId: string, canvasX: number, canvasY: number): void {
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
export function consumePendingClick(): { chartId: string; canvasX: number; canvasY: number } | null {
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
  if (designTabRegistered) {
    window.removeEventListener(ChartEvents.CHART_UPDATED, handleChartUpdatedForDesignPanel);
    unregisterPanel(CHART_DESIGN_TAB_ID);
    designTabRegistered = false;
    designSectionIds = "";
  }
}
