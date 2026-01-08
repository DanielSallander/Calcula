// FILENAME: app/src/hooks/useSelection.ts
// PURPOSE: Custom hook for managing cell selection state.
// CONTEXT: This hook provides selection functionality including:
// - Selecting a single cell
// - Extending selection to a range
// - Moving the active cell (for Tab/Enter navigation)
// - Getting selection reference in A1 notation
// - Selecting entire columns or rows

import { useCallback } from "react";
import { useGridContext } from "../state/GridContext";
import { setSelection, extendSelection, moveSelection } from "../state/gridActions";
import { indexToCol } from "../lib/tauri-api";
import type { Selection, SelectionType } from "../types";
import { stateLog } from '../../utils/component-logger';

/**
 * Return type for the useSelection hook.
 */
export interface UseSelectionReturn {
  /** Current selection or null */
  selection: Selection | null;
  /** Select a single cell (or start of range) */
  selectCell: (row: number, col: number, type?: SelectionType) => void;
  /** Extend selection to include the given cell */
  extendTo: (row: number, col: number) => void;
  /** Move the active cell by delta (used after Tab/Enter) */
  moveActiveCell: (deltaRow: number, deltaCol: number) => void;
  /** Get selection reference in A1 notation */
  getSelectionReference: () => string;
  /** Check if a cell is within the current selection */
  isCellSelected: (row: number, col: number) => boolean;
  /** Check if a cell is the active cell */
  isActiveCell: (row: number, col: number) => boolean;
  /** Select an entire column */
  selectColumn: (col: number, extend?: boolean) => void;
  /** Select an entire row */
  selectRow: (row: number, extend?: boolean) => void;
}

/**
 * Hook for managing cell selection state.
 *
 * @returns Object containing selection state and management functions
 */
export function useSelection(): UseSelectionReturn {
  const { state, dispatch } = useGridContext();
  const { selection, config } = state;

  /**
   * Select a single cell (collapses any existing range).
   */
  const selectCell = useCallback(
    (row: number, col: number, type: SelectionType = "cells") => {
      stateLog.action('Selection', 'selectCell', `row=${row} col=${col} type=${type}`);
      dispatch(
        setSelection({
          startRow: row,
          startCol: col,
          endRow: row,
          endCol: col,
          type,
        })
      );
    },
    [dispatch]
  );

  /**
   * Extend selection to include the given cell.
   * Keeps the start anchor and moves the end.
   */
  const extendTo = useCallback(
    (row: number, col: number) => {
      stateLog.action('Selection', 'extendTo', `row=${row} col=${col}`);
      dispatch(extendSelection(row, col));
    },
    [dispatch]
  );

  /**
   * Move the active cell by a delta (used after Tab/Enter commits).
   * This collapses the selection to a single cell.
   */
  const moveActiveCell = useCallback(
    (deltaRow: number, deltaCol: number) => {
      stateLog.action('Selection', 'moveActiveCell', `dr=${deltaRow} dc=${deltaCol}`);
      dispatch(moveSelection(deltaRow, deltaCol, false));
    },
    [dispatch]
  );

  /**
   * Select an entire column.
   * If extend is true and there's an existing selection, extend to include this column.
   */
  const selectColumn = useCallback(
    (col: number, extend: boolean = false) => {
      stateLog.action('Selection', 'selectColumn', `col=${col} extend=${extend}`);
      if (extend && selection) {
        // Extend existing selection to include this column
        const minCol = Math.min(selection.startCol, col);
        const maxCol = Math.max(selection.startCol, col);
        dispatch(
          setSelection({
            startRow: 0,
            startCol: minCol,
            endRow: config.totalRows - 1,
            endCol: maxCol,
            type: "columns",
          })
        );
      } else {
        // New column selection
        dispatch(
          setSelection({
            startRow: 0,
            startCol: col,
            endRow: config.totalRows - 1,
            endCol: col,
            type: "columns",
          })
        );
      }
    },
    [dispatch, selection, config.totalRows]
  );

  /**
   * Select an entire row.
   * If extend is true and there's an existing selection, extend to include this row.
   */
  const selectRow = useCallback(
    (row: number, extend: boolean = false) => {
      stateLog.action('Selection', 'selectRow', `row=${row} extend=${extend}`);
      if (extend && selection) {
        // Extend existing selection to include this row
        const minRow = Math.min(selection.startRow, row);
        const maxRow = Math.max(selection.startRow, row);
        dispatch(
          setSelection({
            startRow: minRow,
            startCol: 0,
            endRow: maxRow,
            endCol: config.totalCols - 1,
            type: "rows",
          })
        );
      } else {
        // New row selection
        dispatch(
          setSelection({
            startRow: row,
            startCol: 0,
            endRow: row,
            endCol: config.totalCols - 1,
            type: "rows",
          })
        );
      }
    },
    [dispatch, selection, config.totalCols]
  );

  /**
   * Get the selection reference in A1 notation.
   * Returns "A1" for single cell, "A1:B2" for range,
   * "A:A" for column, "1:1" for row.
   */
  const getSelectionReference = useCallback((): string => {
    if (!selection) {
      return "";
    }

    const { startRow, startCol, endRow, endCol, type } = selection;

    // Normalize to get top-left and bottom-right
    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);

    // Column selection (e.g., A:A or A:C)
    if (type === "columns") {
      const startColLetter = indexToCol(minCol);
      const endColLetter = indexToCol(maxCol);
      if (minCol === maxCol) {
        return `${startColLetter}:${startColLetter}`;
      }
      return `${startColLetter}:${endColLetter}`;
    }

    // Row selection (e.g., 1:1 or 1:5)
    if (type === "rows") {
      if (minRow === maxRow) {
        return `${minRow + 1}:${minRow + 1}`;
      }
      return `${minRow + 1}:${maxRow + 1}`;
    }

    // Regular cell selection
    const startRef = `${indexToCol(minCol)}${minRow + 1}`;

    // If single cell, return just the cell reference
    if (minRow === maxRow && minCol === maxCol) {
      return startRef;
    }

    // For range, return start:end
    const endRef = `${indexToCol(maxCol)}${maxRow + 1}`;
    return `${startRef}:${endRef}`;
  }, [selection]);

  /**
   * Check if a cell is within the current selection.
   */
  const isCellSelected = useCallback(
    (row: number, col: number): boolean => {
      if (!selection) {
        return false;
      }

      const minRow = Math.min(selection.startRow, selection.endRow);
      const maxRow = Math.max(selection.startRow, selection.endRow);
      const minCol = Math.min(selection.startCol, selection.endCol);
      const maxCol = Math.max(selection.startCol, selection.endCol);

      return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
    },
    [selection]
  );

  /**
   * Check if a cell is the active cell (the end of selection).
   */
  const isActiveCell = useCallback(
    (row: number, col: number): boolean => {
      if (!selection) {
        return false;
      }
      return row === selection.endRow && col === selection.endCol;
    },
    [selection]
  );

  return {
    selection,
    selectCell,
    extendTo,
    moveActiveCell,
    getSelectionReference,
    isCellSelected,
    isActiveCell,
    selectColumn,
    selectRow,
  };
}