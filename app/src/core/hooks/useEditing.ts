//! FILENAME: app/src/core/hooks/useEditing.ts
// PURPOSE: Custom hook for managing cell editing state.
// CONTEXT: This hook provides cell editing functionality including:
// - Starting edit mode on a cell (with optional initial value)
// - Updating the editing value
// - Committing or canceling edits
// - Integration with the backend via Tauri IPC
// - Formula reference tracking for visual highlighting
// - Column and row reference insertion for formula mode
// - Cross-sheet reference support for formulas
// FIX: Commit now switches back to source sheet before saving
// FIX: isEditingRef is now a MODULE-LEVEL singleton to prevent race conditions
//      across multiple useEditing() hook instances
// FIX: Column/row references now use limited bounds for visual highlighting
//      to prevent performance issues with large ranges
// FIX: startEdit now resolves to master cell when editing merged cells
// FIX: Added globalEditingValue for synchronous formula mode checking
// FIX: Dispatch formula:referenceInserted event to restore focus after inserting references

import { autoCompleteFormula } from "../lib/formulaCompletion";
import { setExtendMode } from "./useGridKeyboard";
import { useCallback, useState, useEffect, useRef } from "react";
import { useGridContext } from "../state/GridContext";
import { 
  startEditing as startEditingAction, 
  updateEditing, 
  stopEditing,
  setFormulaReferences,
  clearFormulaReferences,
  setActiveSheet,
  setSelection,
} from "../../core/state/gridActions";
import { updateCell, getCell, setActiveSheet as setActiveSheetApi, getMergeInfo } from "../lib/tauri-api";
import { cellEvents } from "../lib/cellEvents";
import {
  rangeToReference,
  columnToReference,
  columnRangeToReference,
  rowToReference,
  rowRangeToReference,
  cellToReference,
} from "../lib/gridRenderer";
import type { EditingCell, CellUpdateResult, FormulaReference } from "../types";
import { isFormulaExpectingReference, FORMULA_REFERENCE_COLORS } from "../types";
import { checkEditGuards } from "../lib/editGuards";
import { checkCommitGuards } from "../lib/commitGuards";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  findReferenceAtCell,
  updateFormulaReference,
  type FormulaReferenceWithPosition,
} from "../lib/formulaRefParser";

/**
 * MODULE-LEVEL singleton ref for synchronous editing state.
 * This is shared across ALL useEditing() hook instances to prevent race conditions
 * where one instance starts editing but another instance's keydown handler
 * doesn't see the updated state.
 * 
 * FIX: Previously each useEditing() call created its own ref, causing:
 * - useSpreadsheetSelection.ts sets isEditingRef.current = true
 * - useSpreadsheetEditing.ts checks ITS OWN ref which is still false
 * - Keystroke slips through and starts a new edit session in replace mode
 */
let globalIsEditing = false;

/**
 * MODULE-LEVEL variable for synchronous formula value checking.
 * FIX: This allows checking if we're in formula mode without waiting for React to re-render.
 * When the user types "+" in a formula, this is updated immediately, so a subsequent
 * mouse click can correctly detect formula mode and insert a cell reference.
 */
let globalEditingValue = "";

/**
 * MODULE-LEVEL state for arrow key reference navigation.
 * When navigating cell references with arrow keys in formula mode, we track:
 * - The current cursor position (where arrow keys navigate from)
 * - The insert index (where the reference starts in the formula string)
 * - The color assigned to the current arrow-navigated reference
 * This allows replacing the current reference when pressing additional arrow keys,
 * rather than appending new references.
 */
let arrowRefCursor: { row: number; col: number } | null = null;
let arrowRefAnchor: { row: number; col: number } | null = null;
let arrowRefInsertIndex: number = 0;
let arrowRefColor: string | null = null;

/**
 * Set the global editing flag. Used internally by the hook.
 */
export function setGlobalIsEditing(value: boolean): void {
  globalIsEditing = value;
  if (!value) {
    globalEditingValue = "";
  }
}

/**
 * Get the global editing flag. Can be used for synchronous checks.
 */
export function getGlobalIsEditing(): boolean {
  return globalIsEditing;
}

/**
 * Set the global editing value. Updated synchronously when the user types.
 */
export function setGlobalEditingValue(value: string): void {
  globalEditingValue = value;
}

/**
 * Get the global editing value.
 */
export function getGlobalEditingValue(): string {
  return globalEditingValue;
}

/**
 * Check if currently in formula mode synchronously.
 * FIX: This checks the global editing value immediately, without waiting for React state.
 * Use this in event handlers where the React state might be stale.
 */
export function isGlobalFormulaMode(): boolean {
  return globalIsEditing && isFormulaExpectingReference(globalEditingValue);
}

/**
 * Check if currently editing a formula (regardless of whether expecting a reference).
 * This is used for reference dragging - you should be able to drag existing references
 * even when the formula doesn't end with an operator.
 */
export function isEditingFormula(): boolean {
  return globalIsEditing && globalEditingValue.startsWith("=");
}

/**
 * Get the arrow reference cursor position.
 */
export function getArrowRefCursor(): { row: number; col: number } | null {
  return arrowRefCursor;
}

/**
 * Set the arrow reference cursor position.
 */
export function setArrowRefCursor(cursor: { row: number; col: number } | null): void {
  arrowRefCursor = cursor;
}

/**
 * Get the arrow reference insert index.
 */
export function getArrowRefInsertIndex(): number {
  return arrowRefInsertIndex;
}

/**
 * Set the arrow reference insert index.
 */
export function setArrowRefInsertIndex(index: number): void {
  arrowRefInsertIndex = index;
}

/**
 * Reset arrow reference navigation state.
 * Called when user types something (not arrow navigation) to reset the cursor.
 */
export function resetArrowRefState(): void {
  arrowRefCursor = null;
  arrowRefAnchor = null;
  arrowRefInsertIndex = 0;
  arrowRefColor = null;
}

/**
 * Get the arrow reference color.
 */
export function getArrowRefColor(): string | null {
  return arrowRefColor;
}

/**
 * Set the arrow reference color.
 */
export function setArrowRefColor(color: string | null): void {
  arrowRefColor = color;
}

/**
 * Maximum rows/cols to include in formula reference highlighting.
 * This prevents performance issues when highlighting entire column/row references.
 * The visual highlight will show this many rows/cols, which is sufficient for
 * indicating a full column/row reference without iterating over millions of cells.
 */
const MAX_FORMULA_REFERENCE_ROWS = 1000;
const MAX_FORMULA_REFERENCE_COLS = 100;

// =============================================================================
// REFERENCE DRAGGING STATE
// =============================================================================

/**
 * MODULE-LEVEL state for reference dragging.
 * When dragging an existing reference to move it, we track:
 * - The reference being dragged (with position info)
 * - The original cell the drag started from
 * - The current offset from the original position
 */
let draggedReference: FormulaReferenceWithPosition | null = null;
let draggedRefIndex: number = -1;
let dragStartCell: { row: number; col: number } | null = null;

/**
 * Get the currently dragged reference.
 */
export function getDraggedReference(): FormulaReferenceWithPosition | null {
  return draggedReference;
}

/**
 * Get the index of the currently dragged reference.
 */
export function getDraggedRefIndex(): number {
  return draggedRefIndex;
}

/**
 * Get the cell where the reference drag started.
 */
export function getDragStartCell(): { row: number; col: number } | null {
  return dragStartCell;
}

/**
 * Start dragging a reference.
 * @param ref - The reference being dragged
 * @param refIndex - Index of the reference in the parsed array
 * @param startRow - Row where the drag started
 * @param startCol - Column where the drag started
 */
export function startReferenceDrag(
  ref: FormulaReferenceWithPosition,
  refIndex: number,
  startRow: number,
  startCol: number
): void {
  draggedReference = ref;
  draggedRefIndex = refIndex;
  dragStartCell = { row: startRow, col: startCol };
}

/**
 * Clear the reference dragging state.
 */
export function clearReferenceDrag(): void {
  draggedReference = null;
  draggedRefIndex = -1;
  dragStartCell = null;
}

/**
 * Check if a reference drag is in progress.
 */
export function isReferenceDragging(): boolean {
  return draggedReference !== null;
}

// =============================================================================
// REFERENCE RESIZE STATE
// =============================================================================

/**
 * MODULE-LEVEL state for reference resize.
 * When resizing an existing reference by dragging a corner handle, we track:
 * - The reference being resized (with position info)
 * - Which corner is being dragged
 * - The anchor point (the corner opposite to the dragged one)
 */
let resizedReference: FormulaReferenceWithPosition | null = null;
let resizedRefIndex: number = -1;
let resizeCorner: "topLeft" | "topRight" | "bottomLeft" | "bottomRight" | null = null;
let resizeAnchor: { row: number; col: number } | null = null;

/**
 * Get the reference being resized.
 */
export function getResizedReference(): FormulaReferenceWithPosition | null {
  return resizedReference;
}

/**
 * Get the resize anchor point (the fixed corner).
 */
export function getResizeAnchor(): { row: number; col: number } | null {
  return resizeAnchor;
}

/**
 * Start resizing a reference by a corner.
 * The anchor is the corner OPPOSITE to the one being dragged.
 */
export function startReferenceResize(
  ref: FormulaReferenceWithPosition,
  refIndex: number,
  corner: "topLeft" | "topRight" | "bottomLeft" | "bottomRight"
): void {
  resizedReference = ref;
  resizedRefIndex = refIndex;
  resizeCorner = corner;

  switch (corner) {
    case "topLeft":
      resizeAnchor = { row: ref.endRow, col: ref.endCol };
      break;
    case "topRight":
      resizeAnchor = { row: ref.endRow, col: ref.startCol };
      break;
    case "bottomLeft":
      resizeAnchor = { row: ref.startRow, col: ref.endCol };
      break;
    case "bottomRight":
      resizeAnchor = { row: ref.startRow, col: ref.startCol };
      break;
  }
}

/**
 * Clear the reference resize state.
 */
export function clearReferenceResize(): void {
  resizedReference = null;
  resizedRefIndex = -1;
  resizeCorner = null;
  resizeAnchor = null;
}

/**
 * Check if a reference resize is in progress.
 */
export function isReferenceResizing(): boolean {
  return resizedReference !== null;
}

/**
 * Resize a reference to include the given cell position.
 * The anchor point stays fixed; the dragged corner moves to the mouse position.
 * Returns the new formula value if successful.
 */
export function resizeReferenceToPosition(
  newRow: number,
  newCol: number
): string | null {
  if (!resizedReference || !resizeAnchor || !globalEditingValue) {
    return null;
  }

  const newStartRow = Math.min(resizeAnchor.row, newRow);
  const newStartCol = Math.min(resizeAnchor.col, newCol);
  const newEndRow = Math.max(resizeAnchor.row, newRow);
  const newEndCol = Math.max(resizeAnchor.col, newCol);

  return updateFormulaReference(
    globalEditingValue,
    resizedReference,
    newStartRow,
    newStartCol,
    newEndRow,
    newEndCol
  );
}

/**
 * MODULE-LEVEL flag to track when cursor is hovering over a reference border.
 * This is used to prevent blur commit when clicking on a reference to drag it.
 * The mousedown event triggers blur BEFORE the drag handler can set preventBlurCommit,
 * so we need to track the hover state to know if the click was on a reference border.
 */
let hoveringOverReferenceBorder = false;

/**
 * Set whether the cursor is hovering over a reference border.
 * Called by useMouseSelection when cursor moves over/off a reference border.
 */
export function setHoveringOverReferenceBorder(value: boolean): void {
  hoveringOverReferenceBorder = value;
}

/**
 * Check if the cursor is currently hovering over a reference border.
 * Used by InlineEditor's blur handler to prevent commit when clicking to drag.
 */
export function isHoveringOverReferenceBorder(): boolean {
  return hoveringOverReferenceBorder;
}

/**
 * Check if a cell is part of an existing formula reference.
 * Returns the reference index if found, or -1 if not.
 * This is used to detect when the user clicks on a reference to drag it.
 *
 * @param row - Cell row (0-based)
 * @param col - Cell column (0-based)
 * @param currentSheetName - The current sheet being viewed
 * @param formulaSourceSheet - The sheet where the formula is being edited
 * @returns Index of the reference containing the cell, or -1 if not found
 */
export function findReferenceContainingCell(
  row: number,
  col: number,
  currentSheetName?: string,
  formulaSourceSheet?: string
): number {
  if (!globalIsEditing || !globalEditingValue.startsWith("=")) {
    return -1;
  }

  const refs = parseFormulaReferencesWithPositions(globalEditingValue);
  return findReferenceAtCell(refs, row, col, currentSheetName, formulaSourceSheet);
}

/**
 * Get the parsed references with positions for the current formula.
 */
export function getReferencesWithPositions(): FormulaReferenceWithPosition[] {
  if (!globalIsEditing || !globalEditingValue.startsWith("=")) {
    return [];
  }
  return parseFormulaReferencesWithPositions(globalEditingValue);
}

/**
 * Move a reference by the given offset and update the formula.
 * Returns the new formula value if successful, or null if the drag is not active.
 *
 * @param newRow - The new top-left row of the reference
 * @param newCol - The new top-left column of the reference
 * @returns New formula string, or null if no drag is active
 */
export function moveReferenceToPosition(
  newRow: number,
  newCol: number
): string | null {
  if (!draggedReference || !globalEditingValue) {
    return null;
  }

  // Calculate the new end position based on the reference size
  const refHeight = draggedReference.endRow - draggedReference.startRow;
  const refWidth = draggedReference.endCol - draggedReference.startCol;
  const newEndRow = newRow + refHeight;
  const newEndCol = newCol + refWidth;

  // Update the formula with the new reference position
  const newFormula = updateFormulaReference(
    globalEditingValue,
    draggedReference,
    newRow,
    newCol,
    newEndRow,
    newEndCol
  );

  return newFormula;
}

/**
 * FIX: Dispatch event to trigger refocus of the InlineEditor after inserting a reference.
 * This ensures the user can continue typing after clicking a cell to add a reference.
 */
function dispatchReferenceInsertedEvent(): void {
  window.dispatchEvent(new CustomEvent("formula:referenceInserted"));
}

/**
 * FIX: Set the preventBlurCommit flag to prevent the InlineEditor from committing
 * when focus is lost during a reference drag operation.
 */
function setPreventBlurCommit(value: boolean): void {
  window.dispatchEvent(new CustomEvent("editor:preventBlurCommit", { detail: value }));
}

/**
 * Return type for the useEditing hook.
 */
export interface UseEditingReturn {
  /** Current editing state or null */
  editing: EditingCell | null;
  /** Check if currently editing */
  isEditing: boolean;
  /** Ref for synchronous editing check (avoids stale closure issues) */
  isEditingRef: { current: boolean };
  /** Check if in formula reference mode (editing a formula that expects a reference) */
  isFormulaMode: boolean;
  /** Last error message from a failed commit */
  lastError: string | null;
  /** Whether a commit is in progress */
  isCommitting: boolean;
  /** Current formula references for highlighting */
  formulaReferences: FormulaReference[];
  /** Start editing a specific cell by row/col */
  startEdit: (row: number, col: number, initialValue?: string) => Promise<void>;
  /** Start editing the currently selected cell (convenience method) */
  startEditing: (initialValue?: string) => Promise<void>;
  /** Update the current editing value */
  updateValue: (value: string) => void;
  /** Commit the current edit to the backend */
  commitEdit: () => Promise<CellUpdateResult | null>;
  /** Cancel the current edit without saving */
  cancelEdit: () => void;
  /** Start editing with the current cell content */
  editCurrentCell: () => Promise<void>;
  /** Start editing with a fresh value (replace mode) */
  replaceCurrentCell: (initialChar?: string) => void;
  /** Clear the last error */
  clearError: () => void;
  /** Insert a cell reference into the current formula */
  insertReference: (row: number, col: number) => void;
  /** Insert a range reference into the current formula */
  insertRangeReference: (startRow: number, startCol: number, endRow: number, endCol: number) => void;
  /** Insert a column reference into the current formula (e.g., "A:A") */
  insertColumnReference: (col: number) => void;
  /** Insert a column range reference into the current formula (e.g., "A:C") */
  insertColumnRangeReference: (startCol: number, endCol: number) => void;
  /** Insert a row reference into the current formula (e.g., "1:1") */
  insertRowReference: (row: number) => void;
  /** Insert a row range reference into the current formula (e.g., "1:3") */
  insertRowRangeReference: (startRow: number, endRow: number) => void;
  /** Update the pending formula reference (for live preview while selecting) */
  updatePendingReference: (startRow: number, startCol: number, endRow: number, endCol: number) => void;
  /** Update pending column reference for live preview */
  updatePendingColumnReference: (startCol: number, endCol: number) => void;
  /** Update pending row reference for live preview */
  updatePendingRowReference: (startRow: number, endRow: number) => void;
  /** Clear the pending reference */
  clearPendingReference: () => void;
  /** Get the source sheet name for cross-sheet references */
  getSourceSheetName: () => string | null;
  /** Check if currently on a different sheet than the formula source */
  isOnDifferentSheet: () => boolean;
  /** Navigate cell reference with arrow keys in formula mode (extend=true for Shift+Arrow range expansion) */
  navigateReferenceWithArrow: (direction: "up" | "down" | "left" | "right", extend?: boolean) => void;
  /** Start dragging an existing reference to move it */
  startRefDrag: (row: number, col: number) => boolean;
  /** Update the reference position during drag (live preview) */
  updateRefDrag: (row: number, col: number) => void;
  /** Complete the reference drag and update the formula */
  completeRefDrag: (row: number, col: number) => void;
  /** Cancel the reference drag */
  cancelRefDrag: () => void;
  /** Check if currently dragging a reference */
  isRefDragging: boolean;
  /** Start resizing an existing reference by a corner handle */
  startRefResize: (row: number, col: number, corner: "topLeft" | "topRight" | "bottomLeft" | "bottomRight") => boolean;
  /** Update the reference bounds during resize (live preview) */
  updateRefResize: (row: number, col: number) => void;
  /** Complete the reference resize and update the formula */
  completeRefResize: (row: number, col: number) => void;
  /** Cancel the reference resize */
  cancelRefResize: () => void;
  /** Check if currently resizing a reference */
  isRefResizing: boolean;
}

/**
 * Hook for managing cell editing state.
 * Enhanced with cross-sheet reference support for formula editing.
 *
 * @returns Object containing editing state and management functions
 */
export function useEditing(): UseEditingReturn {
  const { state, dispatch } = useGridContext();
  const { editing, formulaReferences, config, sheetContext } = state;
  
  const [lastError, setLastError] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [pendingReference, setPendingReference] = useState<FormulaReference | null>(null);
  // Track previous pending reference for proper cleanup during drag updates
  const prevPendingRefForSync = useRef<FormulaReference | null>(null);

  // FIX: Ref to prevent double commits from race conditions
  // This catches cases where multiple sources (InlineEditor blur, formula bar, etc.)
  // trigger commitEdit before React state updates
  const commitInProgressRef = useRef(false);
  
  // FIX: Create a ref-like object that accesses the module-level singleton
  // This ensures all hook instances see the same value
  const isEditingRef = useRef<{ current: boolean }>({
    get current() { return globalIsEditing; },
    set current(value: boolean) { globalIsEditing = value; }
  }).current;

  /**
   * Check if currently in formula mode (expecting a reference).
   */
  const isFormulaMode = editing !== null && isFormulaExpectingReference(editing.value);

  /**
   * Get the source sheet name (where the formula is being edited).
   */
  const getSourceSheetName = useCallback((): string | null => {
    return editing?.sourceSheetName ?? null;
  }, [editing]);

  /**
   * Check if we're on a different sheet than the formula source.
   */
  const isOnDifferentSheet = useCallback((): boolean => {
    if (!editing?.sourceSheetName) return false;
    return editing.sourceSheetName !== sheetContext.activeSheetName;
  }, [editing, sheetContext.activeSheetName]);

  /**
   * Get the target sheet name for references (current active sheet if different from source).
   */
  const getTargetSheetName = useCallback((): string | null => {
    if (!editing?.sourceSheetName) return null;
    if (editing.sourceSheetName === sheetContext.activeSheetName) return null;
    return sheetContext.activeSheetName;
  }, [editing, sheetContext.activeSheetName]);

  /**
   * Get the next color for a formula reference.
   */
  const getNextReferenceColor = useCallback((): string => {
    const usedColors = formulaReferences.map(ref => ref.color);
    for (const color of FORMULA_REFERENCE_COLORS) {
      if (!usedColors.includes(color)) {
        return color;
      }
    }
    // Cycle back if all colors used
    return FORMULA_REFERENCE_COLORS[formulaReferences.length % FORMULA_REFERENCE_COLORS.length];
  }, [formulaReferences]);

  /**
   * Update pending reference for live preview.
   * FIX: Include sheetName for cross-sheet reference highlighting.
   */
  const updatePendingReference = useCallback(
    (startRow: number, startCol: number, endRow: number, endCol: number) => {
      const targetSheet = getTargetSheetName();
      const newPending: FormulaReference = {
        startRow,
        startCol,
        endRow,
        endCol,
        color: pendingReference?.color || getNextReferenceColor(),
        sheetName: targetSheet ?? undefined,
      };
      setPendingReference(newPending);
    },
    [pendingReference, getNextReferenceColor, getTargetSheetName]
  );

  /**
   * Update pending column reference for live preview.
   * FIX: Limit the row range to prevent performance issues.
   * FIX: Include sheetName for cross-sheet reference highlighting.
   */
  const updatePendingColumnReference = useCallback(
    (startCol: number, endCol: number) => {
      const targetSheet = getTargetSheetName();
      // FIX: Use limited bounds instead of totalRows to prevent performance issues
      const maxRow = Math.min(MAX_FORMULA_REFERENCE_ROWS - 1, (config?.totalRows || MAX_FORMULA_REFERENCE_ROWS) - 1);
      const newPending: FormulaReference = {
        startRow: 0,
        startCol: Math.min(startCol, endCol),
        endRow: maxRow,
        endCol: Math.max(startCol, endCol),
        color: pendingReference?.color || getNextReferenceColor(),
        sheetName: targetSheet ?? undefined,
        isFullColumn: true, // Flag to indicate this is a full column reference
      };
      setPendingReference(newPending);
    },
    [pendingReference, getNextReferenceColor, config, getTargetSheetName]
  );

  /**
   * Update pending row reference for live preview.
   * FIX: Limit the column range to prevent performance issues.
   * FIX: Include sheetName for cross-sheet reference highlighting.
   */
  const updatePendingRowReference = useCallback(
    (startRow: number, endRow: number) => {
      const targetSheet = getTargetSheetName();
      // FIX: Use limited bounds instead of totalCols to prevent performance issues
      const maxCol = Math.min(MAX_FORMULA_REFERENCE_COLS - 1, (config?.totalCols || MAX_FORMULA_REFERENCE_COLS) - 1);
      const newPending: FormulaReference = {
        startRow: Math.min(startRow, endRow),
        startCol: 0,
        endRow: Math.max(startRow, endRow),
        endCol: maxCol,
        color: pendingReference?.color || getNextReferenceColor(),
        sheetName: targetSheet ?? undefined,
        isFullRow: true, // Flag to indicate this is a full row reference
      };
      setPendingReference(newPending);
    },
    [pendingReference, getNextReferenceColor, config, getTargetSheetName]
  );

  /**
   * Clear pending reference.
   */
  const clearPendingReference = useCallback(() => {
    setPendingReference(null);
  }, []);

  /**
   * Update formula references in state, including pending reference.
   * FIX: Use prevPendingRefForSync to filter out the PREVIOUS pending reference
   * rather than the new one. Without this, each drag move creates a new pending
   * reference object, and the old ones accumulate in the array (causing corner
   * handles to appear on every cell during drag).
   */
  useEffect(() => {
    if (pendingReference) {
      const filtered = formulaReferences.filter(r => r !== prevPendingRefForSync.current);
      dispatch(setFormulaReferences([...filtered, pendingReference]));
    }
    prevPendingRefForSync.current = pendingReference;
  }, [pendingReference, dispatch]);

  /**
   * Start editing a cell by row/col.
   * FIX: Now fetches cell content BEFORE dispatching to prevent race conditions.
   * FIX: Resolves to master cell when the target cell is part of a merged region.
   * FIX: Checks if cell is in a pivot region and shows error message if so.
   * This ensures the InlineEditor receives the correct initial value immediately.
   */
  const startEdit = useCallback(
    async (row: number, col: number, initialValue?: string) => {
      setLastError(null);
      setPendingReference(null);
      
      // Check if any extension blocks editing this cell (e.g., pivot regions)
      const guardResult = await checkEditGuards(row, col);
      if (guardResult?.blocked) {
        console.log("[useEditing] Edit blocked by guard");
        return;
      }

      // FIX: Set global flag BEFORE any async operation to prevent race conditions
      setGlobalIsEditing(true);
      setExtendMode(false);

      // FIX: Check if this cell is part of a merged region and resolve to master cell
      let editRow = row;
      let editCol = col;
      let rowSpan = 1;
      let colSpan = 1;
      
      try {
        const mergeInfo = await getMergeInfo(row, col);
        if (mergeInfo) {
          editRow = mergeInfo.startRow;
          editCol = mergeInfo.startCol;
          rowSpan = mergeInfo.endRow - mergeInfo.startRow + 1;
          colSpan = mergeInfo.endCol - mergeInfo.startCol + 1;
          
          console.log(`[useEditing] Resolved to master cell: (${editRow}, ${editCol}) with span (${rowSpan}x${colSpan})`);
          
          dispatch(setSelection({
            startRow: mergeInfo.startRow,
            startCol: mergeInfo.startCol,
            endRow: mergeInfo.endRow,
            endCol: mergeInfo.endCol,
            type: "cells",
          }));
        }
      } catch (error) {
        console.error("[useEditing] Failed to get merge info:", error);
      }
      
      // Determine the initial value to use
      let value = initialValue ?? "";
      
      if (initialValue === undefined) {
        try {
          const cellData = await getCell(editRow, editCol);
          value = cellData?.formula || cellData?.display || "";
        } catch (error) {
          console.error("Failed to get cell data:", error);
        }
      }
      
      // FIX: Update global editing value synchronously for formula mode detection
      setGlobalEditingValue(value);
      
      // FIX: Clear old references, then re-parse from the formula being edited.
      // This replaces the passive (faint) selection highlights with active (full) edit highlights.
      dispatch(clearFormulaReferences());
      if (value.startsWith("=")) {
        const refs = parseFormulaReferences(value, false);
        if (refs.length > 0) {
          dispatch(setFormulaReferences(refs));
        }
      }
      
      dispatch(
        startEditingAction({
          row: editRow,
          col: editCol,
          value,
          sourceSheetIndex: sheetContext.activeSheetIndex,
          sourceSheetName: sheetContext.activeSheetName,
          rowSpan,
          colSpan,
        })
      );
    },
    [dispatch, sheetContext]
  );

  /**
   * Start editing the currently selected cell.
   */
  /**
   * Start editing the currently selected cell.
   */
  const startEditing = useCallback(
    async (initialValue?: string) => {
      const { selection } = state;
      if (!selection) {
        return;
      }

      const row = selection.endRow;
      const col = selection.endCol;

      // Check if any extension blocks editing this cell (e.g., pivot regions)
      const guardResult = await checkEditGuards(row, col);
      if (guardResult?.blocked) {
        console.log("[useEditing] Edit blocked by guard");
        return;
      }

      if (initialValue !== undefined) {
        // REPLACE mode - start with provided character
        // Still need to check for merge to get correct position
        setLastError(null);
        dispatch(clearFormulaReferences());
        setPendingReference(null);
        
        // FIX: Set global flag BEFORE dispatch
        setGlobalIsEditing(true);
        setExtendMode(false);

        // Check for merge info for replace mode too
        let editRow = row;
        let editCol = col;
        let rowSpan = 1;
        let colSpan = 1;
        
        try {
          const mergeInfo = await getMergeInfo(row, col);
          if (mergeInfo) {
            editRow = mergeInfo.startRow;
            editCol = mergeInfo.startCol;
            rowSpan = mergeInfo.endRow - mergeInfo.startRow + 1;
            colSpan = mergeInfo.endCol - mergeInfo.startCol + 1;
            
            // Update selection to cover merged region
            dispatch(setSelection({
              startRow: mergeInfo.startRow,
              startCol: mergeInfo.startCol,
              endRow: mergeInfo.endRow,
              endCol: mergeInfo.endCol,
              type: "cells",
            }));
          }
        } catch (error) {
          console.error("[useEditing] Failed to get merge info:", error);
        }
        
        // FIX: Update global editing value synchronously for formula mode detection
        setGlobalEditingValue(initialValue);
        
        dispatch(
          startEditingAction({
            row: editRow,
            col: editCol,
            value: initialValue,
            sourceSheetIndex: sheetContext.activeSheetIndex,
            sourceSheetName: sheetContext.activeSheetName,
            rowSpan,
            colSpan,
          })
        );
      } else {
        // EDIT mode - fetch existing content (handled by startEdit)
        await startEdit(row, col);
      }
    },
    [state, startEdit, dispatch, sheetContext]
  );

  /**
   * Update the current editing value.
   * FIX: Also updates global editing value synchronously for formula mode detection.
   * FIX: Resets arrow reference cursor when user types (not from arrow navigation).
   */
  const updateValue = useCallback(
    (value: string) => {
      // FIX: Update global value synchronously BEFORE dispatching to React state
      // This ensures formula mode is detected immediately when the user types "+"
      setGlobalEditingValue(value);

      // Reset arrow reference cursor when user types
      // This ensures the next arrow key press starts fresh from the editing cell
      resetArrowRefState();

      dispatch(updateEditing(value));
    },
    [dispatch]
  );

  /**
   * Insert a cell reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Dispatches event to restore focus to InlineEditor.
   * FIX: Sets up arrow cursor state so arrow keys can continue from this cell.
   */
  const insertReference = useCallback(
    (row: number, col: number) => {
      if (!editing || !isFormulaExpectingReference(editing.value)) {
        return;
      }

      const targetSheet = getTargetSheetName();
      const sourceSheet = getSourceSheetName();
      const reference = rangeToReference(row, col, row, col, targetSheet, sourceSheet);
      const newValue = editing.value + reference;

      // FIX: Update global value synchronously
      setGlobalEditingValue(newValue);
      dispatch(updateEditing(newValue));

      // FIX: Include sheetName for cross-sheet reference highlighting
      // FIX: Reuse pendingReference color and filter it out (avoids duplicate)
      const color = pendingReference?.color || getNextReferenceColor();
      const newRef: FormulaReference = {
        startRow: row,
        startCol: col,
        endRow: row,
        endCol: col,
        color: color,
        sheetName: targetSheet ?? undefined,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);

      // FIX: Set up arrow cursor state so arrow keys can continue from this cell
      arrowRefCursor = { row, col };
      arrowRefAnchor = { row, col };
      arrowRefInsertIndex = editing.value.length; // Where the reference starts
      arrowRefColor = color;

      // FIX: Dispatch event to restore focus to the InlineEditor
      dispatchReferenceInsertedEvent();
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a range reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Dispatches event to restore focus to InlineEditor.
   */
  const insertRangeReference = useCallback(
    (startRow: number, startCol: number, endRow: number, endCol: number) => {
      if (!editing || !isFormulaExpectingReference(editing.value)) {
        return;
      }

      const targetSheet = getTargetSheetName();
      const sourceSheet = getSourceSheetName();
      const reference = rangeToReference(startRow, startCol, endRow, endCol, targetSheet, sourceSheet);
      const newValue = editing.value + reference;

      // FIX: Update global value synchronously
      setGlobalEditingValue(newValue);
      dispatch(updateEditing(newValue));

      // FIX: Include sheetName for cross-sheet reference highlighting
      const newRef: FormulaReference = {
        startRow,
        startCol,
        endRow,
        endCol,
        color: pendingReference?.color || getNextReferenceColor(),
        sheetName: targetSheet ?? undefined,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);
      
      // FIX: Dispatch event to restore focus to the InlineEditor
      dispatchReferenceInsertedEvent();
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a column reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Use limited bounds for visual highlighting.
   * FIX: Dispatches event to restore focus to InlineEditor.
   */
  const insertColumnReference = useCallback(
    (col: number) => {
      if (!editing || !isFormulaExpectingReference(editing.value)) {
        return;
      }

      const targetSheet = getTargetSheetName();
      const sourceSheet = getSourceSheetName();
      const reference = columnToReference(col, targetSheet, sourceSheet);
      const newValue = editing.value + reference;
      
      // FIX: Update global value synchronously
      setGlobalEditingValue(newValue);
      dispatch(updateEditing(newValue));

      // FIX: Use limited bounds instead of totalRows to prevent performance issues
      // The actual formula will still reference the entire column, but the visual
      // highlight will only show a reasonable number of rows
      const maxRow = Math.min(MAX_FORMULA_REFERENCE_ROWS - 1, (config?.totalRows || MAX_FORMULA_REFERENCE_ROWS) - 1);
      // FIX: Include sheetName for cross-sheet reference highlighting
      const newRef: FormulaReference = {
        startRow: 0,
        startCol: col,
        endRow: maxRow,
        endCol: col,
        color: pendingReference?.color || getNextReferenceColor(),
        sheetName: targetSheet ?? undefined,
        isFullColumn: true,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);

      // FIX: Dispatch event to restore focus to the InlineEditor
      dispatchReferenceInsertedEvent();
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, config, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a column range reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Use limited bounds for visual highlighting.
   * FIX: Dispatches event to restore focus to InlineEditor.
   */
  const insertColumnRangeReference = useCallback(
    (startCol: number, endCol: number) => {
      if (!editing || !isFormulaExpectingReference(editing.value)) {
        return;
      }

      const targetSheet = getTargetSheetName();
      const sourceSheet = getSourceSheetName();
      const reference = columnRangeToReference(startCol, endCol, targetSheet, sourceSheet);
      const newValue = editing.value + reference;

      // FIX: Update global value synchronously
      setGlobalEditingValue(newValue);
      dispatch(updateEditing(newValue));

      // FIX: Use limited bounds instead of totalRows to prevent performance issues
      const maxRow = Math.min(MAX_FORMULA_REFERENCE_ROWS - 1, (config?.totalRows || MAX_FORMULA_REFERENCE_ROWS) - 1);
      const minCol = Math.min(startCol, endCol);
      const maxCol = Math.max(startCol, endCol);
      // FIX: Include sheetName for cross-sheet reference highlighting
      const newRef: FormulaReference = {
        startRow: 0,
        startCol: minCol,
        endRow: maxRow,
        endCol: maxCol,
        color: pendingReference?.color || getNextReferenceColor(),
        sheetName: targetSheet ?? undefined,
        isFullColumn: true,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);
      
      // FIX: Dispatch event to restore focus to the InlineEditor
      dispatchReferenceInsertedEvent();
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, config, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a row reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Use limited bounds for visual highlighting.
   * FIX: Dispatches event to restore focus to InlineEditor.
   */
  const insertRowReference = useCallback(
    (row: number) => {
      if (!editing || !isFormulaExpectingReference(editing.value)) {
        return;
      }

      const targetSheet = getTargetSheetName();
      const sourceSheet = getSourceSheetName();
      const reference = rowToReference(row, targetSheet, sourceSheet);
      const newValue = editing.value + reference;
      
      // FIX: Update global value synchronously
      setGlobalEditingValue(newValue);
      dispatch(updateEditing(newValue));

      // FIX: Use limited bounds instead of totalCols to prevent performance issues
      const maxCol = Math.min(MAX_FORMULA_REFERENCE_COLS - 1, (config?.totalCols || MAX_FORMULA_REFERENCE_COLS) - 1);
      // FIX: Include sheetName for cross-sheet reference highlighting
      const newRef: FormulaReference = {
        startRow: row,
        startCol: 0,
        endRow: row,
        endCol: maxCol,
        color: pendingReference?.color || getNextReferenceColor(),
        sheetName: targetSheet ?? undefined,
        isFullRow: true,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);

      // FIX: Dispatch event to restore focus to the InlineEditor
      dispatchReferenceInsertedEvent();
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, config, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a row range reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Use limited bounds for visual highlighting.
   * FIX: Dispatches event to restore focus to InlineEditor.
   */
  const insertRowRangeReference = useCallback(
    (startRow: number, endRow: number) => {
      if (!editing || !isFormulaExpectingReference(editing.value)) {
        return;
      }

      const targetSheet = getTargetSheetName();
      const sourceSheet = getSourceSheetName();
      const reference = rowRangeToReference(startRow, endRow, targetSheet, sourceSheet);
      const newValue = editing.value + reference;

      // FIX: Update global value synchronously
      setGlobalEditingValue(newValue);
      dispatch(updateEditing(newValue));

      // FIX: Use limited bounds instead of totalCols to prevent performance issues
      const maxCol = Math.min(MAX_FORMULA_REFERENCE_COLS - 1, (config?.totalCols || MAX_FORMULA_REFERENCE_COLS) - 1);
      const minRow = Math.min(startRow, endRow);
      const maxRow = Math.max(startRow, endRow);
      // FIX: Include sheetName for cross-sheet reference highlighting
      const newRef: FormulaReference = {
        startRow: minRow,
        startCol: 0,
        endRow: maxRow,
        endCol: maxCol,
        color: pendingReference?.color || getNextReferenceColor(),
        sheetName: targetSheet ?? undefined,
        isFullRow: true,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);

      // FIX: Dispatch event to restore focus to the InlineEditor
      dispatchReferenceInsertedEvent();
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, config, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Commit the current edit to the backend.
   * FIX: If editing started on a different sheet, switch back to that sheet before committing.
  */
    const commitEdit = useCallback(async (): Promise<CellUpdateResult | null> => {
      // FIX: Prevent double commits from race conditions
      // This can happen when InlineEditor blur and formula bar both trigger commit
      if (commitInProgressRef.current) {
        console.log("[useEditing] commitEdit skipped - already in progress");
        // FIX: Clear global state to prevent stuck editing mode.
        // If a commit is already in progress, the new edit session that set
        // globalIsEditing=true should be abandoned. The in-progress commit
        // will handle clearing state when it completes.
        setGlobalIsEditing(false);
        setGlobalEditingValue("");
        resetArrowRefState();
        return null;
      }

      if (!editing) {
        // FIX: Clear global flag and arrow reference state even on early return to prevent stuck state
        setGlobalIsEditing(false);
        setGlobalEditingValue("");
        resetArrowRefState();
        return null;
      }

      // FIX: Set the ref guard BEFORE any async work
      commitInProgressRef.current = true;

      console.log("[useEditing] commitEdit called", {
      editingRow: editing.row,
      editingCol: editing.col,
      sourceSheetIndex: editing.sourceSheetIndex,
      sourceSheetName: editing.sourceSheetName,
      currentSheetIndex: sheetContext.activeSheetIndex,
      currentSheetName: sheetContext.activeSheetName,
    });
    
    setIsCommitting(true);
    setLastError(null);

    try {
      const perfT0 = performance.now();

      // FIX: Check if we need to switch back to the source sheet before committing
      const needsSheetSwitch =
        editing.sourceSheetIndex !== undefined &&
        editing.sourceSheetIndex !== sheetContext.activeSheetIndex;

      if (needsSheetSwitch) {
        console.log("[useEditing] Switching back to source sheet before commit:", editing.sourceSheetName);

        // Switch the backend to the source sheet
        await setActiveSheetApi(editing.sourceSheetIndex!);

        // Update the frontend state to match
        dispatch(setActiveSheet(editing.sourceSheetIndex!, editing.sourceSheetName!));

        // Dispatch event to refresh grid cells for the source sheet
        window.dispatchEvent(new CustomEvent("sheet:formulaModeSwitch", {
          detail: {
            newSheetIndex: editing.sourceSheetIndex,
            newSheetName: editing.sourceSheetName,
          }
        }));
      }
      const perfT1SheetSwitch = performance.now();

      // AFTER:
      let oldValue: string | undefined;
      try {
        const oldCell = await getCell(editing.row, editing.col);
        oldValue = oldCell?.display;
      } catch {
        // Ignore - cell might not exist yet
      }
      const perfT2GetOldCell = performance.now();

      // Smart formula completion - auto-close parentheses, etc.
      const valueToCommit = autoCompleteFormula(editing.value);

      // === COMMIT GUARD CHECK ===
      // Extensions (e.g., Data Validation) can register guards that validate
      // the pending value before it is written to the grid.
      const guardResult = await checkCommitGuards(editing.row, editing.col, valueToCommit);
      if (guardResult) {
        if (guardResult.action === "block") {
          // Cancel: stop editing, revert to previous value
          setGlobalIsEditing(false);
          setGlobalEditingValue("");
          resetArrowRefState();
          dispatch(stopEditing());
          dispatch(clearFormulaReferences());
          setIsCommitting(false);
          commitInProgressRef.current = false;
          return null;
        }
        if (guardResult.action === "retry") {
          // Retry: keep in edit mode, let user correct the value
          setIsCommitting(false);
          commitInProgressRef.current = false;
          return null;
        }
        // action === "allow" -- fall through to normal commit
      }

      const updatedCells = await updateCell(editing.row, editing.col, valueToCommit);
      const perfT3UpdateCell = performance.now();
      const primaryCell = updatedCells[0];

      // FIX: Clear global flag and arrow reference state when editing stops
      console.log("[commitEdit] SUCCESS - clearing globalIsEditing, was:", globalIsEditing);
      setGlobalIsEditing(false);
      setGlobalEditingValue("");
      resetArrowRefState();
      console.log("[commitEdit] globalIsEditing is now:", globalIsEditing);

      if (primaryCell) {
        cellEvents.emit({
          row: primaryCell.row,
          col: primaryCell.col,
          oldValue,
          newValue: primaryCell.display,
          formula: primaryCell.formula ?? null,
        });

        // Emit events for same-sheet dependent cells only
        // Cross-sheet cells (sheetIndex defined) are already updated in the backend
        // and will be fetched fresh when switching sheets
        for (let i = 1; i < updatedCells.length; i++) {
          const depCell = updatedCells[i];
          // Skip cross-sheet cells - sheetIndex is undefined for same-sheet cells
          if (depCell.sheetIndex !== undefined) {
            continue;
          }
          cellEvents.emit({
            row: depCell.row,
            col: depCell.col,
            oldValue: undefined,
            newValue: depCell.display,
            formula: depCell.formula ?? null,
          });
        }
        const perfT4Events = performance.now();

        dispatch(stopEditing());
        dispatch(clearFormulaReferences());
        const perfT5Dispatch = performance.now();

        console.log(
          `[PERF] commitEdit(${editing.row},${editing.col}) deps=${updatedCells.length} | ` +
          `sheetSwitch=${(perfT1SheetSwitch - perfT0).toFixed(1)}ms ` +
          `getOldCell=${(perfT2GetOldCell - perfT1SheetSwitch).toFixed(1)}ms ` +
          `updateCell=${(perfT3UpdateCell - perfT2GetOldCell).toFixed(1)}ms ` +
          `events=${(perfT4Events - perfT3UpdateCell).toFixed(1)}ms ` +
          `dispatch=${(perfT5Dispatch - perfT4Events).toFixed(1)}ms ` +
          `TOTAL=${(perfT5Dispatch - perfT0).toFixed(1)}ms`
        );
        
        const result: CellUpdateResult = {
          success: true,
          row: primaryCell.row,
          col: primaryCell.col,
          display: primaryCell.display,
          formula: primaryCell.formula ?? null,
          updatedCells,
        };
        
        return result;
      } else {
        dispatch(stopEditing());
        dispatch(clearFormulaReferences());
        
        const result: CellUpdateResult = {
          success: true,
          row: editing.row,
          col: editing.col,
          display: '',
          formula: null,
          updatedCells,
        };
        
        return result;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to update cell:", error);
      setLastError(errorMessage);
      
      // FIX: Clear global flag and arrow reference state on error too
      setGlobalIsEditing(false);
      setGlobalEditingValue("");
      resetArrowRefState();

      dispatch(stopEditing());
      dispatch(clearFormulaReferences());
      return {
        success: false,
        row: editing.row,
        col: editing.col,
        display: "#ERROR",
        formula: editing.value.startsWith("=") ? editing.value : null,
        error: errorMessage,
      };
    } finally {
      setIsCommitting(false);
      // FIX: Clear the ref guard
      commitInProgressRef.current = false;
    }
  }, [editing, dispatch, sheetContext]);

  /**
   * Cancel the current edit without saving.
   * FIX: If editing started on a different sheet, switch back to that sheet.
   */
  const cancelEdit = useCallback(async () => {
    // FIX: Clear global flag and arrow reference state immediately
    setGlobalIsEditing(false);
    setGlobalEditingValue("");
    resetArrowRefState();
    
    if (!editing) {
      setLastError(null);
      setPendingReference(null);
      dispatch(stopEditing());
      return;
    }

    // Check if we need to switch back to the source sheet
    const needsSheetSwitch = 
      editing.sourceSheetIndex !== undefined && 
      editing.sourceSheetIndex !== sheetContext.activeSheetIndex;

    if (needsSheetSwitch) {
      console.log("[useEditing] Canceling - switching back to source sheet:", editing.sourceSheetName);
      
      // Switch the backend to the source sheet
      await setActiveSheetApi(editing.sourceSheetIndex!);
      
      // Update the frontend state to match
      dispatch(setActiveSheet(editing.sourceSheetIndex!, editing.sourceSheetName!));
      
      // Dispatch event to refresh grid cells for the source sheet
      window.dispatchEvent(new CustomEvent("sheet:formulaModeSwitch", {
        detail: {
          newSheetIndex: editing.sourceSheetIndex,
          newSheetName: editing.sourceSheetName,
        }
      }));
    }

    setLastError(null);
    setPendingReference(null);
    dispatch(stopEditing());
  }, [dispatch, editing, sheetContext]);

  /**
   * Start editing the currently selected cell with its current content.
   */
  const editCurrentCell = useCallback(async () => {
    const { selection } = state;
    if (!selection) {
      return;
    }

    await startEdit(selection.endRow, selection.endCol);
  }, [state, startEdit]);

  /**
   * Start editing the currently selected cell in replace mode.
   */
  const replaceCurrentCell = useCallback(
    async (initialChar?: string) => {
      const { selection } = state;
      if (!selection) {
        return;
      }

      // Check if any extension blocks editing this cell (e.g., pivot regions)
      const guardResult = await checkEditGuards(selection.endRow, selection.endCol);
      if (guardResult?.blocked) {
        console.log("[useEditing] Edit blocked by guard");
        window.alert(guardResult.message || "This cell cannot be edited.");
        return;
      }

      setLastError(null);
      dispatch(clearFormulaReferences());
      setPendingReference(null);
      
      // FIX: Set global flag BEFORE dispatch
      setGlobalIsEditing(true);
      setExtendMode(false);

      // Check for merge info
      let editRow = selection.endRow;
      let editCol = selection.endCol;
      let rowSpan = 1;
      let colSpan = 1;
      
      try {
        const mergeInfo = await getMergeInfo(selection.endRow, selection.endCol);
        if (mergeInfo) {
          editRow = mergeInfo.startRow;
          editCol = mergeInfo.startCol;
          rowSpan = mergeInfo.endRow - mergeInfo.startRow + 1;
          colSpan = mergeInfo.endCol - mergeInfo.startCol + 1;
          
          // Update selection to cover merged region
          dispatch(setSelection({
            startRow: mergeInfo.startRow,
            startCol: mergeInfo.startCol,
            endRow: mergeInfo.endRow,
            endCol: mergeInfo.endCol,
            type: "cells",
          }));
        }
      } catch (error) {
        console.error("[useEditing] Failed to get merge info:", error);
      }
      
      // FIX: Update global editing value synchronously
      setGlobalEditingValue(initialChar || "");
      
      dispatch(
        startEditingAction({
          row: editRow,
          col: editCol,
          value: initialChar || "",
          sourceSheetIndex: sheetContext.activeSheetIndex,
          sourceSheetName: sheetContext.activeSheetName,
          rowSpan,
          colSpan,
        })
      );
    },
    [state, dispatch, sheetContext]
  );

  /**
   * Clear the last error message.
   */
  const clearError = useCallback(() => {
    setLastError(null);
  }, []);

  /**
   * Navigate cell reference with arrow keys in formula mode.
   * When in formula mode and arrow keys are pressed, this function:
   * - Creates a new reference if no arrow navigation is active
   * - Replaces the current reference if arrow navigation is active
   * - When extend=true (Shift+Arrow), expands into a range reference (e.g., B1:B3)
   * This mimics Excel's behavior of navigating cell references with arrow keys.
   */
  const navigateReferenceWithArrow = useCallback(
    (direction: "up" | "down" | "left" | "right", extend: boolean = false) => {
      if (!editing) {
        return;
      }

      // Allow navigation if:
      // 1. Formula is expecting a reference (e.g., "=" or "=A1+")
      // 2. OR we're already in arrow navigation mode (e.g., just pressed arrow to get "=B1")
      const isInArrowNavMode = arrowRefCursor !== null;
      const isExpectingRef = isFormulaExpectingReference(editing.value);

      if (!isExpectingRef && !isInArrowNavMode) {
        return;
      }

      const currentCursor = arrowRefCursor;
      let newRow: number;
      let newCol: number;
      let color: string;

      if (currentCursor === null) {
        // Starting a new arrow navigation from the editing cell
        newRow = editing.row;
        newCol = editing.col;
        arrowRefInsertIndex = editing.value.length;
        // Get a new color for this arrow navigation session
        color = getNextReferenceColor();
        arrowRefColor = color;
        // Set anchor for potential Shift+Arrow range extension
        arrowRefAnchor = { row: newRow, col: newCol };
      } else {
        // Continue from current cursor position
        newRow = currentCursor.row;
        newCol = currentCursor.col;
        // Reuse the same color from the current arrow navigation session
        color = arrowRefColor || getNextReferenceColor();
      }

      // Calculate new position based on direction
      switch (direction) {
        case "up":
          newRow = Math.max(0, newRow - 1);
          break;
        case "down":
          newRow = newRow + 1;
          break;
        case "left":
          newCol = Math.max(0, newCol - 1);
          break;
        case "right":
          newCol = newCol + 1;
          break;
      }

      // Update the cursor position
      arrowRefCursor = { row: newRow, col: newCol };

      const targetSheet = getTargetSheetName();
      const sourceSheet = getSourceSheetName();

      let reference: string;
      let refStartRow: number;
      let refStartCol: number;
      let refEndRow: number;
      let refEndCol: number;

      if (extend && arrowRefAnchor) {
        // Shift+Arrow: expand into a range reference from anchor to cursor
        refStartRow = arrowRefAnchor.row;
        refStartCol = arrowRefAnchor.col;
        refEndRow = newRow;
        refEndCol = newCol;
        reference = rangeToReference(refStartRow, refStartCol, refEndRow, refEndCol, targetSheet, sourceSheet);
      } else {
        // Normal arrow: single cell reference, reset anchor to current position
        arrowRefAnchor = { row: newRow, col: newCol };
        refStartRow = newRow;
        refStartCol = newCol;
        refEndRow = newRow;
        refEndCol = newCol;
        reference = cellToReference(newRow, newCol, targetSheet, sourceSheet);
      }

      // Replace the formula from the insert index with the new reference
      const newValue = editing.value.substring(0, arrowRefInsertIndex) + reference;

      // Update the value synchronously
      setGlobalEditingValue(newValue);
      dispatch(updateEditing(newValue));

      // Update formula references for highlighting
      const newRef: FormulaReference = {
        startRow: Math.min(refStartRow, refEndRow),
        startCol: Math.min(refStartCol, refEndCol),
        endRow: Math.max(refStartRow, refEndRow),
        endCol: Math.max(refStartCol, refEndCol),
        color: color,
        sheetName: targetSheet ?? undefined,
      };

      // Filter out the previous arrow reference (same color) and add the new one
      const filteredRefs = formulaReferences.filter(ref => ref.color !== color);
      dispatch(setFormulaReferences([...filteredRefs, newRef]));

      // Dispatch event to restore focus to the InlineEditor
      dispatchReferenceInsertedEvent();
    },
    [editing, dispatch, formulaReferences, getNextReferenceColor, getTargetSheetName, getSourceSheetName]
  );

  // ==========================================================================
  // REFERENCE DRAGGING METHODS
  // ==========================================================================

  /**
   * Check if currently dragging a reference.
   */
  const isRefDragging = isReferenceDragging();

  /**
   * Start dragging an existing reference to move it.
   * Returns true if a reference was found at the cell and drag started, false otherwise.
   *
   * @param row - The row that was clicked
   * @param col - The column that was clicked
   * @returns True if drag started, false if no reference at that position
   */
  const startRefDrag = useCallback(
    (row: number, col: number): boolean => {
      if (!editing || !editing.value.startsWith("=")) {
        return false;
      }

      const refs = parseFormulaReferencesWithPositions(editing.value);
      const refIndex = findReferenceAtCell(
        refs,
        row,
        col,
        sheetContext.activeSheetName,
        editing.sourceSheetName
      );

      if (refIndex === -1) {
        return false;
      }

      const ref = refs[refIndex];
      startReferenceDrag(ref, refIndex, row, col);
      return true;
    },
    [editing, sheetContext.activeSheetName]
  );

  /**
   * Update the reference position during drag (live preview).
   * This updates the visual highlighting but doesn't commit the formula change yet.
   *
   * @param row - Current mouse row position
   * @param col - Current mouse column position
   */
  const updateRefDrag = useCallback(
    (row: number, col: number) => {
      const ref = getDraggedReference();
      const startCell = getDragStartCell();
      if (!ref || !startCell || !editing) {
        return;
      }

      // Calculate offset from drag start to current position
      const rowOffset = row - startCell.row;
      const colOffset = col - startCell.col;

      // Calculate new reference position
      const newStartRow = Math.max(0, ref.startRow + rowOffset);
      const newStartCol = Math.max(0, ref.startCol + colOffset);
      const refHeight = ref.endRow - ref.startRow;
      const refWidth = ref.endCol - ref.startCol;
      const newEndRow = newStartRow + refHeight;
      const newEndCol = newStartCol + refWidth;

      // Get the target sheet for cross-sheet references
      const targetSheet = getTargetSheetName();

      // Create a new pending reference for visual preview
      const dragPreviewRef: FormulaReference = {
        startRow: newStartRow,
        startCol: newStartCol,
        endRow: newEndRow,
        endCol: newEndCol,
        color: ref.color,
        sheetName: targetSheet ?? ref.sheetName,
      };

      // Update formula references - replace the original ref with the preview
      const updatedRefs = formulaReferences.map((existingRef) => {
        // Find the ref being dragged by matching the color (assigned during parse)
        if (existingRef.color === ref.color) {
          return dragPreviewRef;
        }
        return existingRef;
      });

      dispatch(setFormulaReferences(updatedRefs));
    },
    [editing, formulaReferences, dispatch, getTargetSheetName]
  );

  /**
   * Complete the reference drag and update the formula.
   *
   * @param row - Final mouse row position
   * @param col - Final mouse column position
   */
  const completeRefDrag = useCallback(
    (row: number, col: number) => {
      const ref = getDraggedReference();
      const startCell = getDragStartCell();
      if (!ref || !startCell || !editing) {
        clearReferenceDrag();
        return;
      }

      // Calculate offset from drag start to final position
      const rowOffset = row - startCell.row;
      const colOffset = col - startCell.col;

      // FIX: Prevent blur commit during reference drag completion
      // The blur event fires when focus shifts during the drag, and we don't want
      // it to commit the formula - we want to continue editing.
      setPreventBlurCommit(true);

      // If no movement, just clear the drag state
      if (rowOffset === 0 && colOffset === 0) {
        clearReferenceDrag();
        dispatchReferenceInsertedEvent();
        return;
      }

      // Calculate new reference position
      const newStartRow = Math.max(0, ref.startRow + rowOffset);
      const newStartCol = Math.max(0, ref.startCol + colOffset);

      // Get the new formula with the moved reference
      const newFormula = moveReferenceToPosition(newStartRow, newStartCol);

      if (newFormula) {
        // Update the editing value
        setGlobalEditingValue(newFormula);
        dispatch(updateEditing(newFormula));

        // Re-parse and update the formula references for highlighting
        const newRefs = parseFormulaReferences(newFormula, false);
        dispatch(setFormulaReferences(newRefs));
      }

      clearReferenceDrag();
      dispatchReferenceInsertedEvent();
    },
    [editing, dispatch]
  );

  /**
   * Cancel the reference drag and restore the original highlighting.
   */
  const cancelRefDrag = useCallback(() => {
    if (!editing) {
      clearReferenceDrag();
      return;
    }

    // Re-parse the original formula to restore highlighting
    const refs = parseFormulaReferences(editing.value, false);
    dispatch(setFormulaReferences(refs));

    clearReferenceDrag();
  }, [editing, dispatch]);

  // ==========================================================================
  // REFERENCE RESIZE METHODS
  // ==========================================================================

  /**
   * Check if currently resizing a reference.
   */
  const isRefResizing = isReferenceResizing();

  /**
   * Start resizing an existing reference by a corner handle.
   * Returns true if a reference was found and resize started.
   */
  const startRefResize = useCallback(
    (row: number, col: number, corner: "topLeft" | "topRight" | "bottomLeft" | "bottomRight"): boolean => {
      if (!editing || !editing.value.startsWith("=")) {
        return false;
      }

      const refs = parseFormulaReferencesWithPositions(editing.value);
      const refIndex = findReferenceAtCell(
        refs,
        row,
        col,
        sheetContext.activeSheetName,
        editing.sourceSheetName
      );

      if (refIndex === -1) {
        return false;
      }

      const ref = refs[refIndex];
      startReferenceResize(ref, refIndex, corner);
      return true;
    },
    [editing, sheetContext.activeSheetName]
  );

  /**
   * Update the reference bounds during resize (live preview).
   */
  const updateRefResize = useCallback(
    (row: number, col: number) => {
      const ref = getResizedReference();
      const anchor = getResizeAnchor();
      if (!ref || !anchor || !editing) {
        return;
      }

      const newStartRow = Math.min(anchor.row, row);
      const newStartCol = Math.min(anchor.col, col);
      const newEndRow = Math.max(anchor.row, row);
      const newEndCol = Math.max(anchor.col, col);

      const resizePreviewRef: FormulaReference = {
        startRow: newStartRow,
        startCol: newStartCol,
        endRow: newEndRow,
        endCol: newEndCol,
        color: ref.color,
        sheetName: ref.sheetName,
      };

      const updatedRefs = formulaReferences.map((existingRef) => {
        if (existingRef.color === ref.color) {
          return resizePreviewRef;
        }
        return existingRef;
      });

      dispatch(setFormulaReferences(updatedRefs));
    },
    [editing, formulaReferences, dispatch]
  );

  /**
   * Complete the reference resize and update the formula.
   */
  const completeRefResize = useCallback(
    (row: number, col: number) => {
      const ref = getResizedReference();
      const anchor = getResizeAnchor();
      if (!ref || !anchor || !editing) {
        clearReferenceResize();
        return;
      }

      // Prevent blur commit during resize completion
      setPreventBlurCommit(true);

      // Get the new formula with the resized reference
      const newFormula = resizeReferenceToPosition(row, col);

      if (newFormula) {
        setGlobalEditingValue(newFormula);
        dispatch(updateEditing(newFormula));

        // Re-parse and update the formula references for highlighting
        const newRefs = parseFormulaReferences(newFormula, false);
        dispatch(setFormulaReferences(newRefs));
      }

      clearReferenceResize();
      dispatchReferenceInsertedEvent();
    },
    [editing, dispatch]
  );

  /**
   * Cancel the reference resize and restore the original highlighting.
   */
  const cancelRefResize = useCallback(() => {
    if (!editing) {
      clearReferenceResize();
      return;
    }

    const refs = parseFormulaReferences(editing.value, false);
    dispatch(setFormulaReferences(refs));

    clearReferenceResize();
  }, [editing, dispatch]);

  return {
    editing,
    isEditing: editing !== null,
    isEditingRef,
    isFormulaMode,
    lastError,
    isCommitting,
    formulaReferences,
    startEdit,
    startEditing,
    updateValue,
    commitEdit,
    cancelEdit,
    editCurrentCell,
    replaceCurrentCell,
    clearError,
    insertReference,
    insertRangeReference,
    insertColumnReference,
    insertColumnRangeReference,
    insertRowReference,
    insertRowRangeReference,
    updatePendingReference,
    updatePendingColumnReference,
    updatePendingRowReference,
    clearPendingReference,
    getSourceSheetName,
    isOnDifferentSheet,
    navigateReferenceWithArrow,
    startRefDrag,
    updateRefDrag,
    completeRefDrag,
    cancelRefDrag,
    isRefDragging,
    startRefResize,
    updateRefResize,
    completeRefResize,
    cancelRefResize,
    isRefResizing,
  };
}