//! FILENAME: app/extensions/AutoFilter/lib/filterStore.ts
// PURPOSE: Module-level state management for the AutoFilter extension.
// CONTEXT: Stores current filter state and provides functions to modify it.

import type { AutoFilterInfo, AutoFilterResult } from "@api";
import type {
  AutoFilterController,
  AutoFilterSnapshot,
  AutoFilterColumnCriteria,
  AutoFilterUniqueValues,
} from "@api/autoFilterService";
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
} from "@api";
import {
  sortRangeByColumn,
  sortRange,
  getViewportCells,
  getStyle,
  setColumnCustomFilter,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
} from "@api/lib";
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

// ============================================================================
// Sort Operations (from filter dropdown)
// ============================================================================

/**
 * Sort the AutoFilter data range by the given column.
 * Uses the header row as headers.
 */
export async function sortByColumn(absoluteCol: number, ascending: boolean): Promise<void> {
  if (!state.autoFilterInfo) return;
  const info = state.autoFilterInfo;
  try {
    await beginUndoTransaction("Sort by column");
    const result = await sortRangeByColumn<{ success: boolean; error?: string }>(
      info.startRow,
      info.startCol,
      info.endRow,
      info.endCol,
      absoluteCol,
      ascending,
      true, // hasHeaders
    );
    await commitUndoTransaction();
    if (result.success) {
      // Use "grid:refresh" (not "app:grid-refresh") to re-fetch cell data from backend
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      // Reapply filter since row order changed
      await reapplyFilter();
    } else if (result.error) {
      alert(result.error);
    }
  } catch (err) {
    // sort_range now rejects when the range is protected, so this is a routine
    // outcome rather than an internal error. Cancel the transaction (the commit
    // above is skipped on throw, leaving it open for later edits to join) and
    // tell the user why the click did nothing.
    await cancelUndoTransaction().catch(() => {});
    console.error("[AutoFilter] Sort failed:", err);
    const msg = typeof err === "string" ? err : (err as Error)?.message;
    if (msg) alert(msg);
  }
}

/**
 * Sort the AutoFilter data range by cell color or font color.
 * Puts the specified color on top.
 */
export async function sortByColor(
  absoluteCol: number,
  color: string,
  sortOn: "cellColor" | "fontColor",
): Promise<void> {
  if (!state.autoFilterInfo) return;
  const info = state.autoFilterInfo;
  try {
    await beginUndoTransaction("Sort by color");
    const result = await sortRange<{ success: boolean; error?: string }>(
      info.startRow,
      info.startCol,
      info.endRow,
      info.endCol,
      [{
        key: absoluteCol - info.startCol,
        ascending: true,
        sortOn,
        color,
      }],
      { hasHeaders: true },
    );
    await commitUndoTransaction();
    if (result.success) {
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      await reapplyFilter();
    } else if (result.error) {
      alert(result.error);
    }
  } catch (err) {
    // Same as sortByColumn: a protected range now rejects here.
    await cancelUndoTransaction().catch(() => {});
    console.error("[AutoFilter] Sort by color failed:", err);
    const msg = typeof err === "string" ? err : (err as Error)?.message;
    if (msg) alert(msg);
  }
}

/**
 * Scan a column for unique background or font colors.
 * Returns distinct CSS color strings found in the data rows (skipping header).
 */
export async function getUniqueColorsInColumn(
  absoluteCol: number,
  type: "cellColor" | "fontColor",
): Promise<string[]> {
  if (!state.autoFilterInfo) return [];
  const info = state.autoFilterInfo;
  const dataStartRow = info.startRow + 1; // skip header
  const cells = await getViewportCells(dataStartRow, absoluteCol, info.endRow, absoluteCol);
  const colorSet = new Set<string>();

  for (const cell of cells) {
    if (cell.styleIndex === 0 && type === "cellColor") continue;
    try {
      const style = await getStyle(cell.styleIndex);
      const color = type === "cellColor" ? style.backgroundColor : style.textColor;
      if (
        color &&
        color !== "transparent" &&
        color !== "rgba(0, 0, 0, 0)" &&
        color !== "#000000"
      ) {
        colorSet.add(color.toLowerCase());
      }
    } catch {
      // Skip cells with invalid style indices
    }
  }

  return Array.from(colorSet);
}

// ============================================================================
// Expression Filter
// ============================================================================

/**
 * Apply a custom filter expression to a column.
 * Supports criteria like ">=100", "<>done", "=*text*", etc.
 */
export async function applyExpressionFilter(
  relativeColIndex: number,
  expression: string,
): Promise<void> {
  if (!expression.trim()) return;

  const result = await setColumnCustomFilter(relativeColIndex, expression.trim());
  if (result.success && result.autoFilter) {
    state.autoFilterInfo = result.autoFilter;
    syncOverlayRegion();
    syncHiddenRows(result);
    window.dispatchEvent(new CustomEvent("grid:refresh"));
    emitAppEvent(FilterEvents.FILTER_APPLIED, { column: relativeColIndex });
  }
}

// ============================================================================
// Script-callable surface (the AutoFilterController seam)
// ============================================================================
//
// The functions above are driven by the dropdown overlay and the Data menu, so
// they read the current SELECTION and the open-dropdown column. A caller that
// is not a person — the script broker, through @api/autoFilterService — has
// neither, so this block is the same operations with every input passed in
// explicitly and nothing read from UI state.
//
// WHAT IT DELIBERATELY REUSES: syncOverlayRegion + syncHiddenRows + the cached
// `state.autoFilterInfo`, i.e. exactly what a click updates. That is the whole
// reason the broker is routed through the extension instead of calling the
// backend commands itself — a filter applied behind this cache's back leaves
// chevron clicks resolving column indexes against a stale start_col.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH: table ownership. `Table.autoFilterId` is
// derived state recomputed inside the Rust commands (relink_autofilter_owner);
// nothing here may set or infer it.

function toSnapshot(info: AutoFilterInfo, hiddenRows: number[]): AutoFilterSnapshot {
  return {
    id: info.id,
    startRow: info.startRow,
    startCol: info.startCol,
    endRow: info.endRow,
    endCol: info.endCol,
    enabled: info.enabled,
    isDataFiltered: info.isDataFiltered,
    columns: info.criteria.map((c, columnIndex) =>
      c
        ? {
            columnIndex,
            filterOn: c.filterOn,
            values: c.values ?? [],
            criterion1: c.criterion1 ?? null,
            criterion2: c.criterion2 ?? null,
            operator: c.operator ?? null,
            filterOutBlanks: c.filterOutBlanks === true,
          }
        : null,
    ),
    hiddenRows: [...hiddenRows].sort((a, b) => a - b),
  };
}

/** Adopt an AutoFilterResult into the cache + the view, then project it. */
function adoptResult(result: AutoFilterResult, action: string): AutoFilterSnapshot {
  if (!result.success || !result.autoFilter) {
    throw new Error(result.error || `${action} was refused by the workbook`);
  }
  state.autoFilterInfo = result.autoFilter;
  state.isActive = result.autoFilter.enabled;
  syncOverlayRegion();
  syncHiddenRows(result);
  return toSnapshot(result.autoFilter, result.hiddenRows ?? []);
}

/** Read the active sheet's filter WITHOUT forcing a full view resync (a caller
 *  may read often). The cache is still repaired, because a stale cached range
 *  is the failure mode that misdirects a later chevron click. */
export async function readAutoFilter(): Promise<AutoFilterSnapshot | null> {
  const info = await getAutoFilter();
  if (!info) {
    if (state.autoFilterInfo) {
      state.autoFilterInfo = null;
      state.isActive = false;
      state.openDropdownCol = null;
      syncOverlayRegion();
    }
    return null;
  }
  state.autoFilterInfo = info;
  state.isActive = info.enabled;
  syncOverlayRegion();
  const hiddenRows = await getHiddenRows();
  return toSnapshot(info, hiddenRows);
}

/** Turn filtering on for an explicit rectangle (first row = header row). */
export async function applyFilterToRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<AutoFilterSnapshot> {
  const result = await applyAutoFilter(startRow, startCol, endRow, endCol);
  const snapshot = adoptResult(result, "Applying a filter");
  emitAppEvent(FilterEvents.FILTER_TOGGLED, { active: true });
  return snapshot;
}

/** Filter one column by picking values. */
export async function setColumnValueFilter(
  relativeColIndex: number,
  values: string[],
  includeBlanks: boolean,
): Promise<AutoFilterSnapshot> {
  const result = await setColumnFilterValues(relativeColIndex, values, includeBlanks);
  const snapshot = adoptResult(result, "Filtering a column");
  emitAppEvent(FilterEvents.FILTER_APPLIED, { column: relativeColIndex });
  return snapshot;
}

/** Filter one column by an Excel-style rule (">=100", "<>done", "=*text*"). */
export async function setColumnRuleFilter(
  relativeColIndex: number,
  criterion1: string,
  criterion2: string | undefined,
  operator: "and" | "or" | undefined,
): Promise<AutoFilterSnapshot> {
  const result = await setColumnCustomFilter(
    relativeColIndex,
    criterion1,
    criterion2,
    operator,
  );
  const snapshot = adoptResult(result, "Filtering a column");
  emitAppEvent(FilterEvents.FILTER_APPLIED, { column: relativeColIndex });
  return snapshot;
}

/** Stop filtering one column, or every column when `relativeColIndex` is null. */
export async function clearFilterCriteria(
  relativeColIndex: number | null,
): Promise<AutoFilterSnapshot> {
  const result =
    relativeColIndex === null
      ? await clearAutoFilterCriteria()
      : await clearColumnCriteria(relativeColIndex);
  const snapshot = adoptResult(result, "Clearing a filter");
  emitAppEvent(FilterEvents.FILTER_CLEARED, {
    column: relativeColIndex === null ? "all" : relativeColIndex,
  });
  return snapshot;
}

/** Turn filtering off entirely and show every row again. */
export async function removeFilter(): Promise<void> {
  const result = await removeAutoFilter();
  if (!result.success) {
    throw new Error(result.error || "Turning the filter off was refused by the workbook");
  }
  state.autoFilterInfo = null;
  state.isActive = false;
  state.openDropdownCol = null;
  syncOverlayRegion();
  clearHiddenRows();
  emitAppEvent(FilterEvents.FILTER_TOGGLED, { active: false });
}

/** Distinct values in one column, for building a values filter. */
export async function listColumnValues(
  relativeColIndex: number,
): Promise<AutoFilterUniqueValues> {
  const result = await getFilterUniqueValues(relativeColIndex);
  if (!result.success) {
    throw new Error(result.error || "Reading the values in that column was refused");
  }
  return {
    values: result.values.map((v) => ({ value: v.value, count: v.count })),
    hasBlanks: result.hasBlanks === true,
  };
}

/**
 * The AutoFilterController handed to @api at activation. Built here (rather
 * than in index.ts) so the operations and the cache they repair stay in one
 * file — a controller assembled elsewhere out of the pieces above would be a
 * second place that has to remember the sync order.
 */
export function createAutoFilterController(): AutoFilterController {
  return {
    get: () => readAutoFilter(),
    listValues: (columnIndex: number) => listColumnValues(columnIndex),
    apply: (startRow: number, startCol: number, endRow: number, endCol: number) =>
      applyFilterToRange(startRow, startCol, endRow, endCol),
    setColumn: (columnIndex: number, criteria: AutoFilterColumnCriteria) =>
      criteria.kind === "values"
        ? setColumnValueFilter(
            columnIndex,
            criteria.values,
            criteria.includeBlanks === true,
          )
        : setColumnRuleFilter(
            columnIndex,
            criteria.criterion1,
            criteria.criterion2,
            criteria.operator,
          ),
    clear: (columnIndex: number | null) => clearFilterCriteria(columnIndex),
    remove: () => removeFilter(),
  };
}

// ============================================================================
// Dropdown State
// ============================================================================

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
