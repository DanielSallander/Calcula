//! FILENAME: app/src/core/state/gridActions.ts
// PURPOSE: Action type definitions and action creators for grid state management.
// CONTEXT: This module defines all possible actions that can modify the grid state.
// Actions are dispatched to the gridReducer to update selection, viewport, editing state, etc.
// UPDATED: Removed Find actions - Find state now lives in the FindReplaceDialog extension.
// UPDATED: Added SET_FREEZE_CONFIG action for freeze panes support.

import type {
  Viewport,
  EditingCell,
  GridConfig,
  ViewportDimensions,
  VirtualBounds,
  FormulaReference,
  SelectionType,
  Selection,
  ClipboardMode,
  FreezeConfig,
} from "../types";

// Action type constants
export const GRID_ACTIONS = {
  SET_SELECTION: "SET_SELECTION",
  CLEAR_SELECTION: "CLEAR_SELECTION",
  EXTEND_SELECTION: "EXTEND_SELECTION",
  MOVE_SELECTION: "MOVE_SELECTION",
  SET_VIEWPORT: "SET_VIEWPORT",
  UPDATE_SCROLL: "UPDATE_SCROLL",
  SCROLL_BY: "SCROLL_BY",
  SCROLL_TO_CELL: "SCROLL_TO_CELL",
  SCROLL_TO_POSITION: "SCROLL_TO_POSITION",
  START_EDITING: "START_EDITING",
  UPDATE_EDITING: "UPDATE_EDITING",
  STOP_EDITING: "STOP_EDITING",
  UPDATE_CONFIG: "UPDATE_CONFIG",
  SET_VIEWPORT_SIZE: "SET_VIEWPORT_SIZE",
  SET_VIEWPORT_DIMENSIONS: "SET_VIEWPORT_DIMENSIONS",
  EXPAND_VIRTUAL_BOUNDS: "EXPAND_VIRTUAL_BOUNDS",
  SET_VIRTUAL_BOUNDS: "SET_VIRTUAL_BOUNDS",
  RESET_VIRTUAL_BOUNDS: "RESET_VIRTUAL_BOUNDS",
  SET_FORMULA_REFERENCES: "SET_FORMULA_REFERENCES",
  CLEAR_FORMULA_REFERENCES: "CLEAR_FORMULA_REFERENCES",
  SET_COLUMN_WIDTH: "SET_COLUMN_WIDTH",
  SET_ROW_HEIGHT: "SET_ROW_HEIGHT",
  SET_ALL_DIMENSIONS: "SET_ALL_DIMENSIONS",
  SET_CLIPBOARD: "SET_CLIPBOARD",
  CLEAR_CLIPBOARD: "CLEAR_CLIPBOARD",
  SET_SHEET_CONTEXT: "SET_SHEET_CONTEXT",
  SET_ACTIVE_SHEET: "SET_ACTIVE_SHEET",
  SET_FREEZE_CONFIG: "SET_FREEZE_CONFIG",
  SET_HIDDEN_ROWS: "SET_HIDDEN_ROWS",
  SET_HIDDEN_COLS: "SET_HIDDEN_COLS",
  SET_MANUALLY_HIDDEN_ROWS: "SET_MANUALLY_HIDDEN_ROWS",
  SET_MANUALLY_HIDDEN_COLS: "SET_MANUALLY_HIDDEN_COLS",
  SET_GROUP_HIDDEN_ROWS: "SET_GROUP_HIDDEN_ROWS",
  SET_GROUP_HIDDEN_COLS: "SET_GROUP_HIDDEN_COLS",
} as const;

// Action interfaces

export interface SetSelectionPayload {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  type?: SelectionType;
}

export interface SetSelectionAction {
  type: typeof GRID_ACTIONS.SET_SELECTION;
  payload: SetSelectionPayload;
}

export interface ClearSelectionAction {
  type: typeof GRID_ACTIONS.CLEAR_SELECTION;
}

export interface ExtendSelectionAction {
  type: typeof GRID_ACTIONS.EXTEND_SELECTION;
  payload: { row: number; col: number };
}

export interface MoveSelectionAction {
  type: typeof GRID_ACTIONS.MOVE_SELECTION;
  payload: {
    deltaRow: number;
    deltaCol: number;
    extend: boolean;
  };
}

export interface SetViewportAction {
  type: typeof GRID_ACTIONS.SET_VIEWPORT;
  payload: Viewport;
}

export interface UpdateScrollAction {
  type: typeof GRID_ACTIONS.UPDATE_SCROLL;
  payload: { scrollX: number; scrollY: number };
}

export interface ScrollByAction {
  type: typeof GRID_ACTIONS.SCROLL_BY;
  payload: { deltaX: number; deltaY: number };
}

export interface ScrollToCellAction {
  type: typeof GRID_ACTIONS.SCROLL_TO_CELL;
  payload: { row: number; col: number; center?: boolean };
}

export interface ScrollToPositionAction {
  type: typeof GRID_ACTIONS.SCROLL_TO_POSITION;
  payload: { scrollX: number; scrollY: number };
}

export interface StartEditingAction {
  type: typeof GRID_ACTIONS.START_EDITING;
  payload: EditingCell;
}

export interface UpdateEditingAction {
  type: typeof GRID_ACTIONS.UPDATE_EDITING;
  payload: { value: string };
}

export interface StopEditingAction {
  type: typeof GRID_ACTIONS.STOP_EDITING;
}

export interface UpdateConfigAction {
  type: typeof GRID_ACTIONS.UPDATE_CONFIG;
  payload: Partial<GridConfig>;
}

export interface SetViewportSizeAction {
  type: typeof GRID_ACTIONS.SET_VIEWPORT_SIZE;
  payload: { rowCount: number; colCount: number };
}

export interface SetViewportDimensionsAction {
  type: typeof GRID_ACTIONS.SET_VIEWPORT_DIMENSIONS;
  payload: ViewportDimensions;
}

export interface ExpandVirtualBoundsAction {
  type: typeof GRID_ACTIONS.EXPAND_VIRTUAL_BOUNDS;
  payload: { targetRow: number; targetCol: number };
}

export interface SetVirtualBoundsAction {
  type: typeof GRID_ACTIONS.SET_VIRTUAL_BOUNDS;
  payload: VirtualBounds;
}

export interface ResetVirtualBoundsAction {
  type: typeof GRID_ACTIONS.RESET_VIRTUAL_BOUNDS;
}

export interface SetFormulaReferencesAction {
  type: typeof GRID_ACTIONS.SET_FORMULA_REFERENCES;
  payload: FormulaReference[];
}

export interface ClearFormulaReferencesAction {
  type: typeof GRID_ACTIONS.CLEAR_FORMULA_REFERENCES;
}

export interface SetColumnWidthAction {
  type: typeof GRID_ACTIONS.SET_COLUMN_WIDTH;
  payload: { col: number; width: number };
}

export interface SetRowHeightAction {
  type: typeof GRID_ACTIONS.SET_ROW_HEIGHT;
  payload: { row: number; height: number };
}

export interface SetAllDimensionsAction {
  type: typeof GRID_ACTIONS.SET_ALL_DIMENSIONS;
  payload: {
    columnWidths: Map<number, number>;
    rowHeights: Map<number, number>;
  };
}

export interface SetClipboardAction {
  type: typeof GRID_ACTIONS.SET_CLIPBOARD;
  payload: { mode: ClipboardMode; selection: Selection | null };
}

export interface ClearClipboardAction {
  type: typeof GRID_ACTIONS.CLEAR_CLIPBOARD;
}

export interface SetSheetContextAction {
  type: typeof GRID_ACTIONS.SET_SHEET_CONTEXT;
  payload: { activeSheetIndex: number; activeSheetName: string };
}

export interface SetActiveSheetAction {
  type: typeof GRID_ACTIONS.SET_ACTIVE_SHEET;
  payload: { index: number; name: string };
}

// Freeze panes action interface
export interface SetFreezeConfigAction {
  type: typeof GRID_ACTIONS.SET_FREEZE_CONFIG;
  payload: FreezeConfig;
}

// Hidden rows/cols action interfaces
export interface SetHiddenRowsAction {
  type: typeof GRID_ACTIONS.SET_HIDDEN_ROWS;
  payload: { rows: number[] };
}

export interface SetHiddenColsAction {
  type: typeof GRID_ACTIONS.SET_HIDDEN_COLS;
  payload: { cols: number[] };
}

export interface SetManuallyHiddenRowsAction {
  type: typeof GRID_ACTIONS.SET_MANUALLY_HIDDEN_ROWS;
  payload: { rows: number[] };
}

export interface SetManuallyHiddenColsAction {
  type: typeof GRID_ACTIONS.SET_MANUALLY_HIDDEN_COLS;
  payload: { cols: number[] };
}

export interface SetGroupHiddenRowsAction {
  type: typeof GRID_ACTIONS.SET_GROUP_HIDDEN_ROWS;
  payload: { rows: number[] };
}

export interface SetGroupHiddenColsAction {
  type: typeof GRID_ACTIONS.SET_GROUP_HIDDEN_COLS;
  payload: { cols: number[] };
}

// Union type of all actions
export type GridAction =
  | SetSelectionAction
  | ClearSelectionAction
  | ExtendSelectionAction
  | MoveSelectionAction
  | SetViewportAction
  | UpdateScrollAction
  | ScrollByAction
  | ScrollToCellAction
  | ScrollToPositionAction
  | StartEditingAction
  | UpdateEditingAction
  | StopEditingAction
  | UpdateConfigAction
  | SetViewportSizeAction
  | SetViewportDimensionsAction
  | ExpandVirtualBoundsAction
  | SetVirtualBoundsAction
  | ResetVirtualBoundsAction
  | SetFormulaReferencesAction
  | ClearFormulaReferencesAction
  | SetColumnWidthAction
  | SetRowHeightAction
  | SetAllDimensionsAction
  | SetClipboardAction
  | ClearClipboardAction
  | SetSheetContextAction
  | SetActiveSheetAction
  | SetFreezeConfigAction
  | SetHiddenRowsAction
  | SetHiddenColsAction
  | SetManuallyHiddenRowsAction
  | SetManuallyHiddenColsAction
  | SetGroupHiddenRowsAction
  | SetGroupHiddenColsAction;

// Action creators

/**
 * Set the sheet context (active sheet index and name).
 */
export function setSheetContext(
  activeSheetIndex: number,
  activeSheetName: string
): SetSheetContextAction {
  return {
    type: GRID_ACTIONS.SET_SHEET_CONTEXT,
    payload: { activeSheetIndex, activeSheetName },
  };
}

/**
 * Set the active sheet (for switching sheets during formula editing).
 */
export function setActiveSheet(index: number, name: string): SetActiveSheetAction {
  return {
    type: GRID_ACTIONS.SET_ACTIVE_SHEET,
    payload: { index, name },
  };
}

/**
 * Set selection to a specific range.
 * Accepts either positional arguments or a payload object.
 */
export function setSelection(payload: SetSelectionPayload): SetSelectionAction;
export function setSelection(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  type?: SelectionType
): SetSelectionAction;
export function setSelection(
  startRowOrPayload: number | SetSelectionPayload,
  startCol?: number,
  endRow?: number,
  endCol?: number,
  type: SelectionType = "cells"
): SetSelectionAction {
  // Check if first argument is a payload object
  if (typeof startRowOrPayload === "object") {
    return {
      type: GRID_ACTIONS.SET_SELECTION,
      payload: {
        startRow: startRowOrPayload.startRow,
        startCol: startRowOrPayload.startCol,
        endRow: startRowOrPayload.endRow,
        endCol: startRowOrPayload.endCol,
        type: startRowOrPayload.type || "cells",
      },
    };
  }

  // Positional arguments
  return {
    type: GRID_ACTIONS.SET_SELECTION,
    payload: {
      startRow: startRowOrPayload,
      startCol: startCol!,
      endRow: endRow!,
      endCol: endCol!,
      type,
    },
  };
}

export function clearSelection(): ClearSelectionAction {
  return {
    type: GRID_ACTIONS.CLEAR_SELECTION,
  };
}

export function extendSelection(row: number, col: number): ExtendSelectionAction {
  return {
    type: GRID_ACTIONS.EXTEND_SELECTION,
    payload: { row, col },
  };
}

export function moveSelection(
  deltaRow: number,
  deltaCol: number,
  extend: boolean = false
): MoveSelectionAction {
  return {
    type: GRID_ACTIONS.MOVE_SELECTION,
    payload: { deltaRow, deltaCol, extend },
  };
}

export function setViewport(viewport: Viewport): SetViewportAction {
  return {
    type: GRID_ACTIONS.SET_VIEWPORT,
    payload: viewport,
  };
}

export function updateScroll(scrollX: number, scrollY: number): UpdateScrollAction {
  return {
    type: GRID_ACTIONS.UPDATE_SCROLL,
    payload: { scrollX, scrollY },
  };
}

/**
 * Scroll by a relative delta (in pixels).
 */
export function scrollBy(deltaX: number, deltaY: number): ScrollByAction {
  return {
    type: GRID_ACTIONS.SCROLL_BY,
    payload: { deltaX, deltaY },
  };
}

/**
 * Scroll to make a specific cell visible.
 * @param row - Target row index
 * @param col - Target column index
 * @param center - If true, center the cell in the viewport
 */
export function scrollToCell(
  row: number,
  col: number,
  center: boolean = false
): ScrollToCellAction {
  return {
    type: GRID_ACTIONS.SCROLL_TO_CELL,
    payload: { row, col, center },
  };
}

/**
 * Scroll to an absolute position (in pixels).
 */
export function scrollToPosition(scrollX: number, scrollY: number): ScrollToPositionAction {
  return {
    type: GRID_ACTIONS.SCROLL_TO_POSITION,
    payload: { scrollX, scrollY },
  };
}

export function startEditing(cell: EditingCell): StartEditingAction {
  return {
    type: GRID_ACTIONS.START_EDITING,
    payload: cell,
  };
}

export function updateEditing(value: string): UpdateEditingAction {
  return {
    type: GRID_ACTIONS.UPDATE_EDITING,
    payload: { value },
  };
}

export function stopEditing(): StopEditingAction {
  return {
    type: GRID_ACTIONS.STOP_EDITING,
  };
}

export function updateConfig(config: Partial<GridConfig>): UpdateConfigAction {
  return {
    type: GRID_ACTIONS.UPDATE_CONFIG,
    payload: config,
  };
}

export function setViewportSize(rowCount: number, colCount: number): SetViewportSizeAction {
  return {
    type: GRID_ACTIONS.SET_VIEWPORT_SIZE,
    payload: { rowCount, colCount },
  };
}

/**
 * Set the viewport dimensions in pixels.
 * Used for scroll calculations that need pixel-level precision.
 */
export function setViewportDimensions(
  width: number,
  height: number
): SetViewportDimensionsAction {
  return {
    type: GRID_ACTIONS.SET_VIEWPORT_DIMENSIONS,
    payload: { width, height },
  };
}

/**
 * Expand virtual bounds to include the target cell.
 * Used when user navigates or scrolls toward the edge of current bounds.
 */
export function expandVirtualBounds(
  targetRow: number,
  targetCol: number
): ExpandVirtualBoundsAction {
  return {
    type: GRID_ACTIONS.EXPAND_VIRTUAL_BOUNDS,
    payload: { targetRow, targetCol },
  };
}

/**
 * Set virtual bounds to specific values.
 * Used when loading a document with known data extent.
 */
export function setVirtualBounds(bounds: VirtualBounds): SetVirtualBoundsAction {
  return {
    type: GRID_ACTIONS.SET_VIRTUAL_BOUNDS,
    payload: bounds,
  };
}

/**
 * Reset virtual bounds to default values.
 * Used when creating a new document.
 */
export function resetVirtualBounds(): ResetVirtualBoundsAction {
  return {
    type: GRID_ACTIONS.RESET_VIRTUAL_BOUNDS,
  };
}

/**
 * Set formula references for visual highlighting during formula entry.
 * Used when the user clicks cells while editing a formula.
 */
export function setFormulaReferences(
  references: FormulaReference[]
): SetFormulaReferencesAction {
  return {
    type: GRID_ACTIONS.SET_FORMULA_REFERENCES,
    payload: references,
  };
}

/**
 * Clear all formula references.
 * Used when editing is cancelled or committed.
 */
export function clearFormulaReferences(): ClearFormulaReferencesAction {
  return {
    type: GRID_ACTIONS.CLEAR_FORMULA_REFERENCES,
  };
}

/**
 * Set a custom column width.
 */
export function setColumnWidth(col: number, width: number): SetColumnWidthAction {
  return {
    type: GRID_ACTIONS.SET_COLUMN_WIDTH,
    payload: { col, width },
  };
}

/**
 * Set a custom row height.
 */
export function setRowHeight(row: number, height: number): SetRowHeightAction {
  return {
    type: GRID_ACTIONS.SET_ROW_HEIGHT,
    payload: { row, height },
  };
}

/**
 * Set all dimensions at once (used for loading from backend).
 */
export function setAllDimensions(
  columnWidths: Map<number, number>,
  rowHeights: Map<number, number>
): SetAllDimensionsAction {
  return {
    type: GRID_ACTIONS.SET_ALL_DIMENSIONS,
    payload: { columnWidths, rowHeights },
  };
}

/**
 * Set clipboard state for visual feedback (dotted border around copied/cut cells).
 */
export function setClipboard(
  mode: ClipboardMode,
  selection: Selection | null
): SetClipboardAction {
  return {
    type: GRID_ACTIONS.SET_CLIPBOARD,
    payload: { mode, selection },
  };
}

/**
 * Clear clipboard state (removes visual feedback).
 */
export function clearClipboard(): ClearClipboardAction {
  return {
    type: GRID_ACTIONS.CLEAR_CLIPBOARD,
  };
}

/**
 * Set freeze panes configuration.
 * @param freezeRow - First scrollable row (null to unfreeze rows)
 * @param freezeCol - First scrollable column (null to unfreeze columns)
 */
export function setFreezeConfig(
  freezeRow: number | null,
  freezeCol: number | null
): SetFreezeConfigAction {
  return {
    type: GRID_ACTIONS.SET_FREEZE_CONFIG,
    payload: { freezeRow, freezeCol },
  };
}

/**
 * Set which rows are hidden (e.g., by AutoFilter).
 * @param rows - Array of row indices to hide (empty array to show all)
 */
export function setHiddenRows(rows: number[]): SetHiddenRowsAction {
  return {
    type: GRID_ACTIONS.SET_HIDDEN_ROWS,
    payload: { rows },
  };
}

/**
 * Set which columns are hidden (combined set).
 * @param cols - Array of column indices to hide (empty array to show all)
 */
export function setHiddenCols(cols: number[]): SetHiddenColsAction {
  return {
    type: GRID_ACTIONS.SET_HIDDEN_COLS,
    payload: { cols },
  };
}

/**
 * Set which rows are manually hidden by the user (distinct from filter-hidden).
 * @param rows - Array of row indices manually hidden
 */
export function setManuallyHiddenRows(rows: number[]): SetManuallyHiddenRowsAction {
  return {
    type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_ROWS,
    payload: { rows },
  };
}

/**
 * Set which columns are manually hidden by the user.
 * @param cols - Array of column indices manually hidden
 */
export function setManuallyHiddenCols(cols: number[]): SetManuallyHiddenColsAction {
  return {
    type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_COLS,
    payload: { cols },
  };
}

/**
 * Set which rows are hidden due to outline group collapse.
 * The combined hiddenRows set is recomputed in the reducer.
 * @param rows - Array of all row indices currently hidden by groups
 */
export function setGroupHiddenRows(rows: number[]): SetGroupHiddenRowsAction {
  return {
    type: GRID_ACTIONS.SET_GROUP_HIDDEN_ROWS,
    payload: { rows },
  };
}

/**
 * Set which columns are hidden due to outline group collapse.
 * The combined hiddenCols set is recomputed in the reducer.
 * @param cols - Array of all column indices currently hidden by groups
 */
export function setGroupHiddenCols(cols: number[]): SetGroupHiddenColsAction {
  return {
    type: GRID_ACTIONS.SET_GROUP_HIDDEN_COLS,
    payload: { cols },
  };
}