// FILENAME: app/src/core/hooks/useEditing.ts
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

import { useCallback, useState, useEffect, useRef } from "react";
import { useGridContext } from "../state/GridContext";
import { 
  startEditing as startEditingAction, 
  updateEditing, 
  stopEditing,
  setFormulaReferences,
  clearFormulaReferences,
  setActiveSheet,
} from "../../core/state/gridActions";
import { updateCell, getCell, setActiveSheet as setActiveSheetApi } from "../lib/tauri-api";
import { cellEvents } from "../lib/cellEvents";
import { 
  rangeToReference, 
  columnToReference, 
  columnRangeToReference, 
  rowToReference, 
  rowRangeToReference 
} from "../lib/gridRenderer";
import type { EditingCell, CellUpdateResult, FormulaReference } from "../types";
import { isFormula, isFormulaExpectingReference, FORMULA_REFERENCE_COLORS } from "../types";

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
 * Set the global editing flag. Used internally by the hook.
 */
function setGlobalIsEditing(value: boolean): void {
  globalIsEditing = value;
}

/**
 * Get the global editing flag. Can be used for synchronous checks.
 */
export function getGlobalIsEditing(): boolean {
  return globalIsEditing;
}

/**
 * Maximum rows/cols to include in formula reference highlighting.
 * This prevents performance issues when highlighting entire column/row references.
 * The visual highlight will show this many rows/cols, which is sufficient for
 * indicating a full column/row reference without iterating over millions of cells.
 */
const MAX_FORMULA_REFERENCE_ROWS = 1000;
const MAX_FORMULA_REFERENCE_COLS = 100;

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
   */
  const updatePendingReference = useCallback(
    (startRow: number, startCol: number, endRow: number, endCol: number) => {
      const newPending: FormulaReference = {
        startRow,
        startCol,
        endRow,
        endCol,
        color: pendingReference?.color || getNextReferenceColor(),
      };
      setPendingReference(newPending);
    },
    [pendingReference, getNextReferenceColor]
  );

  /**
   * Update pending column reference for live preview.
   * FIX: Limit the row range to prevent performance issues.
   */
  const updatePendingColumnReference = useCallback(
    (startCol: number, endCol: number) => {
      // FIX: Use limited bounds instead of totalRows to prevent performance issues
      const maxRow = Math.min(MAX_FORMULA_REFERENCE_ROWS - 1, (config?.totalRows || MAX_FORMULA_REFERENCE_ROWS) - 1);
      const newPending: FormulaReference = {
        startRow: 0,
        startCol: Math.min(startCol, endCol),
        endRow: maxRow,
        endCol: Math.max(startCol, endCol),
        color: pendingReference?.color || getNextReferenceColor(),
        isFullColumn: true, // Flag to indicate this is a full column reference
      };
      setPendingReference(newPending);
    },
    [pendingReference, getNextReferenceColor, config]
  );

  /**
   * Update pending row reference for live preview.
   * FIX: Limit the column range to prevent performance issues.
   */
  const updatePendingRowReference = useCallback(
    (startRow: number, endRow: number) => {
      // FIX: Use limited bounds instead of totalCols to prevent performance issues
      const maxCol = Math.min(MAX_FORMULA_REFERENCE_COLS - 1, (config?.totalCols || MAX_FORMULA_REFERENCE_COLS) - 1);
      const newPending: FormulaReference = {
        startRow: Math.min(startRow, endRow),
        startCol: 0,
        endRow: Math.max(startRow, endRow),
        endCol: maxCol,
        color: pendingReference?.color || getNextReferenceColor(),
        isFullRow: true, // Flag to indicate this is a full row reference
      };
      setPendingReference(newPending);
    },
    [pendingReference, getNextReferenceColor, config]
  );

  /**
   * Clear pending reference.
   */
  const clearPendingReference = useCallback(() => {
    setPendingReference(null);
  }, []);

  /**
   * Update formula references in state, including pending reference.
   */
  useEffect(() => {
    if (pendingReference) {
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), pendingReference]));
    }
  }, [pendingReference, dispatch]);

  /**
   * Start editing a cell by row/col.
   * FIX: Now fetches cell content BEFORE dispatching to prevent race conditions.
   * This ensures the InlineEditor receives the correct initial value immediately.
   */
  const startEdit = useCallback(
    async (row: number, col: number, initialValue?: string) => {
      setLastError(null);
      dispatch(clearFormulaReferences());
      setPendingReference(null);
      
      // FIX: Set global flag BEFORE any async operation to prevent race conditions
      // This ensures ALL useEditing() instances see editing state immediately
      setGlobalIsEditing(true);
      
      // Determine the initial value to use
      let value = initialValue ?? "";
      
      // FIX: If no initial value provided (EDIT mode), fetch cell content FIRST
      // This prevents the race condition where the editor renders with empty value
      // while the async fetch is in progress, allowing typed characters to replace content
      if (initialValue === undefined) {
        try {
          const cellData = await getCell(row, col);
          value = cellData?.formula || cellData?.display || "";
        } catch (error) {
          console.error("Failed to get cell data:", error);
          // Keep value as "" on error
        }
      }
      
      // Dispatch with the correct value (either provided or fetched)
      dispatch(
        startEditingAction({
          row,
          col,
          value,
          sourceSheetIndex: sheetContext.activeSheetIndex,
          sourceSheetName: sheetContext.activeSheetName,
        })
      );
    },
    [dispatch, sheetContext]
  );

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

      if (initialValue !== undefined) {
        // REPLACE mode - start with provided character
        setLastError(null);
        dispatch(clearFormulaReferences());
        setPendingReference(null);
        
        // FIX: Set global flag BEFORE dispatch
        setGlobalIsEditing(true);
        
        dispatch(
          startEditingAction({
            row,
            col,
            value: initialValue,
            sourceSheetIndex: sheetContext.activeSheetIndex,
            sourceSheetName: sheetContext.activeSheetName,
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
   */
  const updateValue = useCallback(
    (value: string) => {
      dispatch(updateEditing(value));
    },
    [dispatch]
  );

  /**
   * Insert a cell reference into the current formula.
   * Includes sheet prefix if on a different sheet.
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
      dispatch(updateEditing(newValue));

      const newRef: FormulaReference = {
        startRow: row,
        startCol: col,
        endRow: row,
        endCol: col,
        color: getNextReferenceColor(),
      };
      dispatch(setFormulaReferences([...formulaReferences, newRef]));
      setPendingReference(null);
    },
    [editing, dispatch, formulaReferences, getNextReferenceColor, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a range reference into the current formula.
   * Includes sheet prefix if on a different sheet.
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
      dispatch(updateEditing(newValue));

      const newRef: FormulaReference = {
        startRow,
        startCol,
        endRow,
        endCol,
        color: pendingReference?.color || getNextReferenceColor(),
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a column reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Use limited bounds for visual highlighting.
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
      dispatch(updateEditing(newValue));

      // FIX: Use limited bounds instead of totalRows to prevent performance issues
      // The actual formula will still reference the entire column, but the visual
      // highlight will only show a reasonable number of rows
      const maxRow = Math.min(MAX_FORMULA_REFERENCE_ROWS - 1, (config?.totalRows || MAX_FORMULA_REFERENCE_ROWS) - 1);
      const newRef: FormulaReference = {
        startRow: 0,
        startCol: col,
        endRow: maxRow,
        endCol: col,
        color: pendingReference?.color || getNextReferenceColor(),
        isFullColumn: true,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, config, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a column range reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Use limited bounds for visual highlighting.
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
      dispatch(updateEditing(newValue));

      // FIX: Use limited bounds instead of totalRows to prevent performance issues
      const maxRow = Math.min(MAX_FORMULA_REFERENCE_ROWS - 1, (config?.totalRows || MAX_FORMULA_REFERENCE_ROWS) - 1);
      const minCol = Math.min(startCol, endCol);
      const maxCol = Math.max(startCol, endCol);
      const newRef: FormulaReference = {
        startRow: 0,
        startCol: minCol,
        endRow: maxRow,
        endCol: maxCol,
        color: pendingReference?.color || getNextReferenceColor(),
        isFullColumn: true,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, config, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a row reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Use limited bounds for visual highlighting.
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
      dispatch(updateEditing(newValue));

      // FIX: Use limited bounds instead of totalCols to prevent performance issues
      const maxCol = Math.min(MAX_FORMULA_REFERENCE_COLS - 1, (config?.totalCols || MAX_FORMULA_REFERENCE_COLS) - 1);
      const newRef: FormulaReference = {
        startRow: row,
        startCol: 0,
        endRow: row,
        endCol: maxCol,
        color: pendingReference?.color || getNextReferenceColor(),
        isFullRow: true,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, config, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Insert a row range reference into the current formula.
   * Includes sheet prefix if on a different sheet.
   * FIX: Use limited bounds for visual highlighting.
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
      dispatch(updateEditing(newValue));

      // FIX: Use limited bounds instead of totalCols to prevent performance issues
      const maxCol = Math.min(MAX_FORMULA_REFERENCE_COLS - 1, (config?.totalCols || MAX_FORMULA_REFERENCE_COLS) - 1);
      const minRow = Math.min(startRow, endRow);
      const maxRow = Math.max(startRow, endRow);
      const newRef: FormulaReference = {
        startRow: minRow,
        startCol: 0,
        endRow: maxRow,
        endCol: maxCol,
        color: pendingReference?.color || getNextReferenceColor(),
        isFullRow: true,
      };
      dispatch(setFormulaReferences([...formulaReferences.filter(r => r !== pendingReference), newRef]));
      setPendingReference(null);
    },
    [editing, dispatch, formulaReferences, pendingReference, getNextReferenceColor, config, getTargetSheetName, getSourceSheetName]
  );

  /**
   * Commit the current edit to the backend.
   * FIX: If editing started on a different sheet, switch back to that sheet before committing.
*/
  const commitEdit = useCallback(async (): Promise<CellUpdateResult | null> => {
    if (!editing) {
      // FIX: Clear global flag even on early return to prevent stuck state
      setGlobalIsEditing(false);
      return null;
    }

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

      let oldValue: string | undefined;
      try {
        const oldCell = await getCell(editing.row, editing.col);
        oldValue = oldCell?.display;
      } catch {
        // Ignore - cell might not exist yet
      }

      const updatedCells = await updateCell(editing.row, editing.col, editing.value);
      const primaryCell = updatedCells[0];
      
      // FIX: Clear global flag when editing stops
      setGlobalIsEditing(false);
      
      if (primaryCell) {
        cellEvents.emit({
          row: primaryCell.row,
          col: primaryCell.col,
          oldValue,
          newValue: primaryCell.display,
          formula: primaryCell.formula ?? null,
        });
        
        for (let i = 1; i < updatedCells.length; i++) {
          const depCell = updatedCells[i];
          cellEvents.emit({
            row: depCell.row,
            col: depCell.col,
            oldValue: undefined,
            newValue: depCell.display,
            formula: depCell.formula ?? null,
          });
        }
        
        dispatch(stopEditing());
        dispatch(clearFormulaReferences());
        
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
      
      // FIX: Clear global flag on error too
      setGlobalIsEditing(false);
      
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
    }
  }, [editing, dispatch, sheetContext]);

  /**
   * Cancel the current edit without saving.
   * FIX: If editing started on a different sheet, switch back to that sheet.
   */
  const cancelEdit = useCallback(async () => {
    // FIX: Clear global flag immediately
    setGlobalIsEditing(false);
    
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
    (initialChar?: string) => {
      const { selection } = state;
      if (!selection) {
        return;
      }

      setLastError(null);
      dispatch(clearFormulaReferences());
      setPendingReference(null);
      
      // FIX: Set global flag BEFORE dispatch
      setGlobalIsEditing(true);
      
      dispatch(
        startEditingAction({
          row: selection.endRow,
          col: selection.endCol,
          value: initialChar || "",
          sourceSheetIndex: sheetContext.activeSheetIndex,
          sourceSheetName: sheetContext.activeSheetName,
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
  };
}