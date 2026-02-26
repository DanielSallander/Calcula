//! FILENAME: app/extensions/AutoFilter/lib/filterStore.ts
// PURPOSE: Module-level state management for the AutoFilter extension.
// CONTEXT: Stores current filter state and provides functions to modify it.

import type { AutoFilterInfo, AutoFilterResult } from "../../../src/api";
import type { FilterState } from "../types";

/** Minimal selection type for filter operations. */
interface Selection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  type?: "cells" | "columns" | "rows";
}
import {
  applyAutoFilter,
  removeAutoFilter,
  clearAutoFilterCriteria,
  reapplyAutoFilter,
  clearColumnCriteria,
  getAutoFilter,
  getHiddenRows,
  setColumnFilterValues,
  getFilterUniqueValues,
  detectDataRegion,
  setHiddenRows,
  dispatchGridAction,
  emitAppEvent,
  AppEvents,
  addGridRegions,
  removeGridRegionsByType,
} from "../../../src/api";
import { FilterEvents } from "./filterEvents";

// ============================================================================
// Module State
// ============================================================================

let state: FilterState = {
  autoFilterInfo: null,
  isActive: false,
  openDropdownCol: null,
};

let currentSelection: Selection | null = null;

// ============================================================================
// State Accessors
// ============================================================================

export function getFilterState(): FilterState {
  return state;
}

export function isFilterActive(): boolean {
  return state.isActive;
}

export function getAutoFilterInfo(): AutoFilterInfo | null {
  return state.autoFilterInfo;
}

export function getOpenDropdownCol(): number | null {
  return state.openDropdownCol;
}

export function setCurrentSelection(sel: Selection | null): void {
  currentSelection = sel;
}

export function getCurrentSelection(): Selection | null {
  return currentSelection;
}

// ============================================================================
// Grid Region Sync
// ============================================================================

const REGION_TYPE = "autofilter";

/**
 * Update the grid overlay region for the AutoFilter header row.
 * This triggers the chevron/funnel renderer to paint on the header cells.
 */
function syncOverlayRegion(): void {
  removeGridRegionsByType(REGION_TYPE);
  if (state.autoFilterInfo && state.isActive) {
    const info = state.autoFilterInfo;
    addGridRegions([{
      id: "autofilter-header",
      type: REGION_TYPE,
      startRow: info.startRow,
      startCol: info.startCol,
      endRow: info.startRow, // Only the header row
      endCol: info.endCol,
    }]);
  }
}

// ============================================================================
// Hidden Rows Sync
// ============================================================================

/**
 * Sync hidden rows from an AutoFilter result to the Core grid state.
 */
function syncHiddenRows(result: AutoFilterResult): void {
  dispatchGridAction(setHiddenRows(result.hiddenRows));
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Clear all hidden rows in the Core grid state.
 */
function clearHiddenRows(): void {
  dispatchGridAction(setHiddenRows([]));
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Filter Operations
// ============================================================================

/**
 * Toggle the AutoFilter on/off.
 * If no filter exists, creates one based on the current selection or detected data region.
 * If a filter exists, removes it.
 */
export async function toggleFilter(): Promise<void> {
  if (state.isActive && state.autoFilterInfo) {
    // Remove the filter
    await removeAutoFilter();
    state.autoFilterInfo = null;
    state.isActive = false;
    state.openDropdownCol = null;
    syncOverlayRegion();
    clearHiddenRows();
    emitAppEvent(FilterEvents.FILTER_TOGGLED, { active: false });
    return;
  }

  // Create a new filter - detect data region
  let startRow: number;
  let startCol: number;
  let endRow: number;
  let endCol: number;

  if (currentSelection) {
    const sel = currentSelection;
    const minRow = Math.min(sel.startRow, sel.endRow);
    const maxRow = Math.max(sel.startRow, sel.endRow);
    const minCol = Math.min(sel.startCol, sel.endCol);
    const maxCol = Math.max(sel.startCol, sel.endCol);

    // If single cell, detect the data region
    if (minRow === maxRow && minCol === maxCol) {
      const region = await detectDataRegion(minRow, minCol);
      if (region) {
        [startRow, startCol, endRow, endCol] = region;
      } else {
        // No data region found, use current cell
        startRow = minRow;
        startCol = minCol;
        endRow = minRow;
        endCol = minCol;
      }
    } else if (sel.type === "rows") {
      // Entire row selection: detect the data region starting from the first
      // selected row to avoid applying filters across empty columns.
      const region = await detectDataRegion(minRow, 0);
      if (region) {
        [startRow, startCol, endRow, endCol] = region;
      } else {
        return; // No data in the selected rows
      }
    } else {
      startRow = minRow;
      startCol = minCol;
      endRow = maxRow;
      endCol = maxCol;
    }
  } else {
    // No selection, try cell 0,0
    const region = await detectDataRegion(0, 0);
    if (region) {
      [startRow, startCol, endRow, endCol] = region;
    } else {
      return; // Nothing to filter
    }
  }

  const result = await applyAutoFilter(startRow, startCol, endRow, endCol);
  if (result.success && result.autoFilter) {
    state.autoFilterInfo = result.autoFilter;
    state.isActive = true;
    syncOverlayRegion();
    syncHiddenRows(result);
    emitAppEvent(FilterEvents.FILTER_TOGGLED, { active: true });
  }
}

/**
 * Apply a value-based filter to a column.
 */
export async function applyColumnFilter(
  relativeColIndex: number,
  values: string[],
  includeBlanks: boolean
): Promise<void> {
  const result = await setColumnFilterValues(relativeColIndex, values, includeBlanks);
  if (result.success && result.autoFilter) {
    state.autoFilterInfo = result.autoFilter;
    syncOverlayRegion();
    syncHiddenRows(result);
    emitAppEvent(FilterEvents.FILTER_APPLIED, { column: relativeColIndex });
  }
}

/**
 * Clear filter criteria for a specific column.
 */
export async function clearColumnFilter(relativeColIndex: number): Promise<void> {
  const result = await clearColumnCriteria(relativeColIndex);
  if (result.success && result.autoFilter) {
    state.autoFilterInfo = result.autoFilter;
    syncOverlayRegion();
    syncHiddenRows(result);
    emitAppEvent(FilterEvents.FILTER_CLEARED, { column: relativeColIndex });
  }
}

/**
 * Clear all filter criteria but keep the AutoFilter range.
 */
export async function clearAllFilters(): Promise<void> {
  const result = await clearAutoFilterCriteria();
  if (result.success && result.autoFilter) {
    state.autoFilterInfo = result.autoFilter;
    syncOverlayRegion();
    syncHiddenRows(result);
    emitAppEvent(FilterEvents.FILTER_CLEARED, { column: "all" });
  }
}

/**
 * Reapply the AutoFilter (refresh filtering with current data).
 */
export async function reapplyFilter(): Promise<void> {
  const result = await reapplyAutoFilter();
  if (result.success && result.autoFilter) {
    state.autoFilterInfo = result.autoFilter;
    syncOverlayRegion();
    syncHiddenRows(result);
  }
}

/**
 * Get unique values for a column in the AutoFilter range.
 */
export async function getColumnUniqueValues(relativeColIndex: number) {
  return getFilterUniqueValues(relativeColIndex);
}

/**
 * Refresh the filter state from the backend (e.g., after sheet switch).
 */
export async function refreshFilterState(): Promise<void> {
  const info = await getAutoFilter();
  if (info) {
    state.autoFilterInfo = info;
    state.isActive = info.enabled;
    syncOverlayRegion();
    // Sync hidden rows
    const hiddenRowsList = await getHiddenRows();
    dispatchGridAction(setHiddenRows(hiddenRowsList));
    emitAppEvent(AppEvents.GRID_REFRESH);
  } else {
    state.autoFilterInfo = null;
    state.isActive = false;
    state.openDropdownCol = null;
    syncOverlayRegion();
    clearHiddenRows();
  }
  emitAppEvent(FilterEvents.FILTER_STATE_REFRESHED);
}

/**
 * Set which dropdown column is open.
 */
export function setOpenDropdownCol(col: number | null): void {
  state.openDropdownCol = col;
}

/**
 * Reset all extension state.
 */
export function resetState(): void {
  removeGridRegionsByType(REGION_TYPE);
  state = {
    autoFilterInfo: null,
    isActive: false,
    openDropdownCol: null,
  };
  currentSelection = null;
}
