//! FILENAME: app/src/api/grid.ts
// PURPOSE: Grid-related API exports for extensions.
// CONTEXT: Re-exports grid state hooks and actions from core.
// UPDATED: Removed Find actions - Find state now lives in the FindReplaceDialog extension.

// Re-export the context hook and non-React state getter
export { useGridContext, useGridState, useGridDispatch, getGridStateSnapshot } from "../core/state/GridContext";

// Re-export hit-testing for extensions
export { getCellFromPixel } from "../core/lib/gridRenderer";

// Re-export grid actions (Find actions removed - they live in FindReplaceDialog extension)
export {
  setSelection,
  clearSelection,
  extendSelection,
  moveSelection,
  setViewport,
  updateScroll,
  scrollBy,
  scrollToCell,
  scrollToPosition,
  startEditing,
  updateEditing,
  stopEditing,
  updateConfig,
  setViewportSize,
  setViewportDimensions,
  expandVirtualBounds,
  setVirtualBounds,
  resetVirtualBounds,
  setFormulaReferences,
  clearFormulaReferences,
  setColumnWidth,
  setRowHeight,
  setAllDimensions,
  setClipboard,
  clearClipboard,
  setSheetContext,
  setActiveSheet,
  setFreezeConfig,
  setHiddenRows,
  setHiddenCols,
  setManuallyHiddenRows,
  setManuallyHiddenCols,
  setGroupHiddenRows,
  setGroupHiddenCols,
  setZoom,
  setSplitConfig,
  setViewMode,
  setShowFormulas,
  setDisplayZeros,
  setDisplayGridlines,
  setDisplayHeadings,
  setDisplayFormulaBar,
  setReferenceStyle,
} from "../core/state/gridActions";

// Re-export action types
export type { GridAction, SetSelectionPayload } from "../core/state/gridActions";

// ============================================================================
// Freeze Panes Orchestration
// ============================================================================

import type { FormattingResult, ViewMode } from "../core/types/types";
import {
  setFreezePanes as backendSetFreezePanes,
  getFreezePanes as backendGetFreezePanes,
  setSplitWindow as backendSetSplitWindow,
  getSplitWindow as backendGetSplitWindow,
  goToSpecial as backendGoToSpecial,
  applyBorderPreset,
  fillRange as backendFillRange,
} from "../core/lib/tauri-api";
import { emitAppEvent, AppEvents } from "./events";
import { getGridStateSnapshot } from "../core/state/GridContext";
import { dispatchGridAction } from "./gridDispatch";
import { invokeBackend } from "./backend";
import { setZoom as setZoomAction } from "../core/state/gridActions";

/**
 * Set freeze panes via backend and emit events for Shell/Core sync.
 */
export async function freezePanes(
  freezeRow: number | null,
  freezeCol: number | null
): Promise<void> {
  await backendSetFreezePanes(freezeRow, freezeCol);
  emitAppEvent(AppEvents.FREEZE_CHANGED, { freezeRow, freezeCol });
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Load freeze panes config from backend and emit FREEZE_CHANGED event.
 */
export async function loadFreezePanesConfig(): Promise<{
  freezeRow: number | null;
  freezeCol: number | null;
}> {
  const config = await backendGetFreezePanes();
  emitAppEvent(AppEvents.FREEZE_CHANGED, config);
  return config;
}

// ============================================================================
// Split Window Orchestration
// ============================================================================

/**
 * Set split window via backend and emit events for Shell/Core sync.
 */
export async function splitWindow(
  splitRow: number | null,
  splitCol: number | null
): Promise<void> {
  await backendSetSplitWindow(splitRow, splitCol);
  emitAppEvent(AppEvents.SPLIT_CHANGED, { splitRow, splitCol });
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Load split window config from backend and emit SPLIT_CHANGED event.
 */
export async function loadSplitWindowConfig(): Promise<{
  splitRow: number | null;
  splitCol: number | null;
}> {
  const config = await backendGetSplitWindow();
  emitAppEvent(AppEvents.SPLIT_CHANGED, config);
  return config;
}

/**
 * Remove split window.
 */
export async function removeSplitWindow(): Promise<void> {
  await splitWindow(null, null);
}

// ============================================================================
// Go To Special
// ============================================================================

export interface GoToSpecialResult {
  cells: Array<{ row: number; col: number }>;
}

export type GoToSpecialCriteria =
  | "blanks"
  | "formulas"
  | "constants"
  | "errors"
  | "comments"
  | "notes"
  | "conditionalFormats"
  | "dataValidation";

// ============================================================================
// Scroll / Navigation API
// ============================================================================

/**
 * Scroll the grid to make the specified cell visible.
 * @param row 0-based row index
 * @param col 0-based column index
 * @param select If true, also select the cell (default: true)
 */
export function navigateToCell(row: number, col: number, select?: boolean): void {
  emitAppEvent(AppEvents.NAVIGATE_TO_CELL, { row, col, select: select !== false });
}

/**
 * Scroll the grid to make the specified range visible.
 * Scrolls to the top-left corner of the range and selects the full range.
 */
export function navigateToRange(startRow: number, startCol: number, endRow: number, endCol: number): void {
  emitAppEvent(AppEvents.NAVIGATE_TO_CELL, { row: startRow, col: startCol, select: true, endRow, endCol });
}

// ============================================================================
// Border Around
// ============================================================================

/**
 * Apply outside borders to a range.
 * Convenience wrapper around applyBorderPreset with preset "outside".
 * Matches Excel's Range.BorderAround method.
 *
 * @param startRow - First row of range (inclusive)
 * @param startCol - First column of range (inclusive)
 * @param endRow - Last row of range (inclusive)
 * @param endCol - Last column of range (inclusive)
 * @param style - Border line style (default "solid")
 * @param color - CSS hex color (default "#000000")
 * @param width - Border width (default 1)
 */
export async function borderAround(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  style?: string,
  color?: string,
  width?: number,
): Promise<FormattingResult> {
  return applyBorderPreset(
    startRow,
    startCol,
    endRow,
    endCol,
    "outside",
    style ?? "solid",
    color ?? "#000000",
    width ?? 1,
  );
}

/**
 * Find cells matching specific criteria.
 */
export async function goToSpecial(
  criteria: GoToSpecialCriteria,
  searchRange?: { startRow: number; startCol: number; endRow: number; endCol: number }
): Promise<GoToSpecialResult> {
  const range = searchRange
    ? [searchRange.startRow, searchRange.startCol, searchRange.endRow, searchRange.endCol] as [number, number, number, number]
    : null;
  return await backendGoToSpecial(criteria, range);
}

// ============================================================================
// Fill Operations (Ctrl+D, Ctrl+R, etc.)
// ============================================================================

/**
 * Fill down: copies the top row of the selection to all rows below it.
 * Equivalent to Excel's Ctrl+D.
 * @param startRow - First row of the selection (inclusive)
 * @param startCol - First column of the selection (inclusive)
 * @param endRow - Last row of the selection (inclusive)
 * @param endCol - Last column of the selection (inclusive)
 */
export async function fillDown(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<void> {
  if (endRow <= startRow) return; // nothing to fill
  const updatedCells = await backendFillRange(
    startRow, startCol, startRow, endCol,       // source: first row
    startRow + 1, startCol, endRow, endCol,     // target: rows below
  );
  emitAppEvent(AppEvents.CELL_VALUES_CHANGED, { cells: updatedCells });
}

/**
 * Fill right: copies the leftmost column of the selection to all columns to the right.
 * Equivalent to Excel's Ctrl+R.
 * @param startRow - First row of the selection (inclusive)
 * @param startCol - First column of the selection (inclusive)
 * @param endRow - Last row of the selection (inclusive)
 * @param endCol - Last column of the selection (inclusive)
 */
export async function fillRight(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<void> {
  if (endCol <= startCol) return; // nothing to fill
  const updatedCells = await backendFillRange(
    startRow, startCol, endRow, startCol,       // source: first column
    startRow, startCol + 1, endRow, endCol,     // target: columns to the right
  );
  emitAppEvent(AppEvents.CELL_VALUES_CHANGED, { cells: updatedCells });
}

/**
 * Fill up: copies the bottom row of the selection to all rows above it.
 * @param startRow - First row of the selection (inclusive)
 * @param startCol - First column of the selection (inclusive)
 * @param endRow - Last row of the selection (inclusive)
 * @param endCol - Last column of the selection (inclusive)
 */
export async function fillUp(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<void> {
  if (endRow <= startRow) return; // nothing to fill
  const updatedCells = await backendFillRange(
    endRow, startCol, endRow, endCol,           // source: last row
    startRow, startCol, endRow - 1, endCol,     // target: rows above
  );
  emitAppEvent(AppEvents.CELL_VALUES_CHANGED, { cells: updatedCells });
}

/**
 * Fill left: copies the rightmost column of the selection to all columns to the left.
 * @param startRow - First row of the selection (inclusive)
 * @param startCol - First column of the selection (inclusive)
 * @param endRow - Last row of the selection (inclusive)
 * @param endCol - Last column of the selection (inclusive)
 */
export async function fillLeft(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<void> {
  if (endCol <= startCol) return; // nothing to fill
  const updatedCells = await backendFillRange(
    startRow, endCol, endRow, endCol,           // source: last column
    startRow, startCol, endRow, endCol - 1,     // target: columns to the left
  );
  emitAppEvent(AppEvents.CELL_VALUES_CHANGED, { cells: updatedCells });
}

// ============================================================================
// Zoom Control API (programmatic, non-React)
// ============================================================================

/**
 * Get the current zoom level as a percentage (e.g., 100 for 100%).
 * Returns the zoom percentage or 100 if grid state is not initialized.
 */
export function getZoom(): number {
  const state = getGridStateSnapshot();
  if (!state) return 100;
  return Math.round(state.zoom * 100);
}

/**
 * Set the zoom level programmatically.
 * @param zoomPercent - Zoom as a percentage (e.g., 150 for 150%).
 *   Clamped to the allowed range (ZOOM_MIN..ZOOM_MAX internally).
 */
export function setZoomLevel(zoomPercent: number): void {
  const zoomFactor = zoomPercent / 100;
  dispatchGridAction(setZoomAction(zoomFactor));
}

// ============================================================================
// View Mode API (programmatic, non-React)
// ============================================================================

/**
 * Get the current view mode.
 * Returns "normal", "pageLayout", or "pageBreakPreview".
 */
export function getViewMode(): ViewMode {
  const state = getGridStateSnapshot();
  if (!state) return "normal";
  return state.viewMode;
}

/**
 * Change the view mode programmatically.
 * Emits the VIEW_MODE_CHANGED event so the Shell bridge, Print extension,
 * and any other listeners all stay in sync.
 * @param viewMode - "normal", "pageLayout", or "pageBreakPreview"
 */
export function changeViewMode(viewMode: ViewMode): void {
  emitAppEvent(AppEvents.VIEW_MODE_CHANGED, { viewMode });
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Status Bar Text API
// ============================================================================

/**
 * Set custom text in the status bar (replaces the default "Ready" text).
 * @param text - The text to display in the status bar.
 */
export function setStatusBarText(text: string): void {
  emitAppEvent(AppEvents.STATUS_BAR_TEXT_CHANGED, { text });
}

/**
 * Clear the custom status bar text, reverting to the default "Ready".
 */
export function clearStatusBarText(): void {
  emitAppEvent(AppEvents.STATUS_BAR_TEXT_CHANGED, { text: null });
}

// ============================================================================
// R1C1 Reference Style
// ============================================================================

/**
 * Get the current reference style from the backend.
 */
export async function getReferenceStyle(): Promise<"A1" | "R1C1"> {
  return invokeBackend<string>("get_reference_style") as Promise<"A1" | "R1C1">;
}

/**
 * Set the reference style in the backend and update frontend state.
 * Emits REFERENCE_STYLE_CHANGED event to sync the grid state.
 */
export async function changeReferenceStyle(style: "A1" | "R1C1"): Promise<void> {
  await invokeBackend<string>("set_reference_style", { style });
  emitAppEvent(AppEvents.REFERENCE_STYLE_CHANGED, { referenceStyle: style });
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Convert a formula between A1 and R1C1 notation.
 * @param formula - The formula string (with or without leading `=`)
 * @param fromStyle - Source notation ("A1" or "R1C1")
 * @param toStyle - Target notation ("A1" or "R1C1")
 * @param baseRow - 0-based row of the cell containing the formula
 * @param baseCol - 0-based column of the cell containing the formula
 */
export async function convertFormulaStyle(
  formula: string,
  fromStyle: "A1" | "R1C1",
  toStyle: "A1" | "R1C1",
  baseRow: number,
  baseCol: number,
): Promise<string> {
  return invokeBackend<string>("convert_formula_style", {
    formula,
    fromStyle,
    toStyle,
    baseRow,
    baseCol,
  });
}