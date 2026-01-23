// FILENAME: app/src/hooks/useSelection.ts
// PURPOSE: Custom hook for managing cell selection state.
// CONTEXT: This hook provides selection functionality including:
// - Selecting a single cell
// - Extending selection to a range
// - Moving the active cell (for Tab/Enter navigation)
// - Getting selection reference in A1 notation
// - Selecting entire columns or rows
// UPDATED: Added merge-aware selection expansion
// FIX: extendToWithMergeExpansion now uses getMergedRegions for proper intersection checking
// FIX: selectCell now accepts optional endRow/endCol for merged cell clicks
// FIX: Both start and end coordinates now expand based on merged region bounds

import { useCallback } from "react";
import { useGridContext } from "../state/GridContext";
import { setSelection, extendSelection, moveSelection } from "../state/gridActions";
import { indexToCol, getMergeInfo, getMergedRegions } from "../lib/tauri-api";
import type { Selection, SelectionType } from "../types";
import { stateLog } from '../../utils/component-logger';

/**
 * Return type for the useSelection hook.
 */
export interface UseSelectionReturn {
  /** Current selection or null */
  selection: Selection | null;
  /** Select a single cell (or range if endRow/endCol provided) */
  selectCell: (row: number, col: number, type?: SelectionType, endRow?: number, endCol?: number) => void;
  /** Extend selection to include the given cell */
  extendTo: (row: number, col: number) => void;
  /** Extend selection with merge expansion - expands to include entire merged regions */
  extendToWithMergeExpansion: (row: number, col: number) => Promise<void>;
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
  /** Select a cell, expanding to cover any merged region */
  selectCellWithMergeExpansion: (row: number, col: number, type?: SelectionType) => Promise<void>;
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
   * FIX: Now accepts optional endRow/endCol for selecting a range in one dispatch.
   * This is used when clicking on merged cells to avoid stale state issues.
   */
  const selectCell = useCallback(
    (row: number, col: number, type: SelectionType = "cells", endRow?: number, endCol?: number) => {
      stateLog.action('Selection', 'selectCell', `row=${row} col=${col} type=${type} endRow=${endRow} endCol=${endCol}`);
      dispatch(
        setSelection({
          startRow: row,
          startCol: col,
          endRow: endRow ?? row,
          endCol: endCol ?? col,
          type,
        })
      );
    },
    [dispatch]
  );

  /**
   * Select a cell, automatically expanding to cover any merged region.
   * This is the merge-aware version that should be used for user interactions.
   */
  const selectCellWithMergeExpansion = useCallback(
    async (row: number, col: number, type: SelectionType = "cells") => {
      stateLog.action('Selection', 'selectCellWithMergeExpansion', `row=${row} col=${col} type=${type}`);
      
      try {
        // Check if this cell is part of a merged region
        const mergeInfo = await getMergeInfo(row, col);
        
        if (mergeInfo) {
          // Expand selection to cover the entire merged region
          dispatch(
            setSelection({
              startRow: mergeInfo.startRow,
              startCol: mergeInfo.startCol,
              endRow: mergeInfo.endRow,
              endCol: mergeInfo.endCol,
              type,
            })
          );
        } else {
          // Normal single cell selection
          dispatch(
            setSelection({
              startRow: row,
              startCol: col,
              endRow: row,
              endCol: col,
              type,
            })
          );
        }
      } catch (error) {
        console.error('[useSelection] Failed to get merge info:', error);
        // Fallback to normal selection
        dispatch(
          setSelection({
            startRow: row,
            startCol: col,
            endRow: row,
            endCol: col,
            type,
          })
        );
      }
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
   * Extend selection with merge expansion.
   * When extending, checks ALL merged regions to see if they INTERSECT with the
   * selection bounds, and expands to include any intersecting regions.
   * FIX: Both start AND end coordinates are updated based on expanded bounds.
   * This handles cases where a merge expands the bounds on the anchor side.
   */
  const extendToWithMergeExpansion = useCallback(
    async (row: number, col: number) => {
      if (!selection) {
        // No existing selection, just select the cell with merge expansion
        await selectCellWithMergeExpansion(row, col);
        return;
      }

      stateLog.action('Selection', 'extendToWithMergeExpansion', `row=${row} col=${col}`);

      try {
        // Get ALL merged regions - this allows us to check for intersection
        const mergedRegions = await getMergedRegions();
        
        // Calculate initial bounds from selection anchor and target
        let minRow = Math.min(selection.startRow, row);
        let maxRow = Math.max(selection.startRow, row);
        let minCol = Math.min(selection.startCol, col);
        let maxCol = Math.max(selection.startCol, col);
        
        // Expand bounds to include any intersecting merged regions
        // Loop until no more expansion occurs (handles adjacent/nested merges)
        let expanded = true;
        let iterations = 0;
        const maxIterations = 100; // Safety limit
        
        while (expanded && iterations < maxIterations) {
          expanded = false;
          iterations++;
          
          for (const region of mergedRegions) {
            // Check if this region INTERSECTS with current bounds
            // Two rectangles intersect if they overlap in both dimensions
            const intersects = !(
              region.endRow < minRow ||    // region is above
              region.startRow > maxRow ||  // region is below
              region.endCol < minCol ||    // region is to the left
              region.startCol > maxCol     // region is to the right
            );
            
            if (intersects) {
              // Expand bounds to fully include this region
              if (region.startRow < minRow) {
                minRow = region.startRow;
                expanded = true;
              }
              if (region.endRow > maxRow) {
                maxRow = region.endRow;
                expanded = true;
              }
              if (region.startCol < minCol) {
                minCol = region.startCol;
                expanded = true;
              }
              if (region.endCol > maxCol) {
                maxCol = region.endCol;
                expanded = true;
              }
            }
          }
        }
        
        // FIX: Determine BOTH start and end coordinates based on drag direction
        // and expanded bounds. The selection must cover the full expanded rectangle.
        // - When dragging down/right: start at min, end at max
        // - When dragging up/left: start at max, end at min
        // This ensures the visual selection covers all expanded bounds.
        
        let newStartRow: number;
        let newStartCol: number;
        let newEndRow: number;
        let newEndCol: number;
        
        // Row direction
        if (row >= selection.startRow) {
          // Dragging down or same row: anchor at top, active at bottom
          newStartRow = minRow;
          newEndRow = maxRow;
        } else {
          // Dragging up: anchor at bottom, active at top
          newStartRow = maxRow;
          newEndRow = minRow;
        }
        
        // Column direction
        if (col >= selection.startCol) {
          // Dragging right or same column: anchor at left, active at right
          newStartCol = minCol;
          newEndCol = maxCol;
        } else {
          // Dragging left: anchor at right, active at left
          newStartCol = maxCol;
          newEndCol = minCol;
        }
        
        // Dispatch the expanded selection
        dispatch(
          setSelection({
            startRow: newStartRow,
            startCol: newStartCol,
            endRow: newEndRow,
            endCol: newEndCol,
            type: selection.type,
          })
        );
      } catch (error) {
        console.error('[useSelection] Failed to extend with merge expansion:', error);
        // Fallback to simple extend
        dispatch(extendSelection(row, col));
      }
    },
    [selection, dispatch, selectCellWithMergeExpansion]
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
    selectCellWithMergeExpansion,
    extendTo,
    extendToWithMergeExpansion,
    moveActiveCell,
    getSelectionReference,
    isCellSelected,
    isActiveCell,
    selectColumn,
    selectRow,
  };
}