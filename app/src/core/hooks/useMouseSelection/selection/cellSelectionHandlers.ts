//! FILENAME: app/src/core/hooks/useMouseSelection/selection/cellSelectionHandlers.ts
// PURPOSE: Factory function for creating cell selection event handlers.
// CONTEXT: Creates handlers for mouse down on cells, supporting single
// click selection and shift-click to extend selection ranges.
// FIX: Right-click within selection now preserves the selection.
// FIX: Clicking on merged cells now uses single dispatch to avoid stale state.

import type { GridConfig, Viewport, Selection, DimensionOverrides, SelectionType } from "../../../types";
import type { CellPosition, MousePosition, HeaderDragState } from "../types";
import { getCellFromPixel } from "../../../lib/gridRenderer";
import { getMergeInfo } from "../../../lib/tauri-api";

interface CellSelectionDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  selection: Selection | null;
  /** FIX: Updated signature to accept optional endRow/endCol for merged cells */
  onSelectCell: (row: number, col: number, type?: SelectionType, endRow?: number, endCol?: number) => void;
  onExtendTo: (row: number, col: number) => void;
  /** Callback to add to selection (Ctrl+Click multi-select) */
  onAddToSelection?: (row: number, col: number, endRow?: number, endCol?: number) => void;
  onCommitBeforeSelect?: () => Promise<void>;
  setIsDragging: (value: boolean) => void;
  dragStartRef: React.MutableRefObject<CellPosition | null>;
  headerDragRef: React.MutableRefObject<HeaderDragState | null>;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
}

interface CellSelectionHandlers {
  handleCellMouseDown: (
    mouseX: number,
    mouseY: number,
    shiftKey: boolean,
    event: React.MouseEvent<HTMLElement>
  ) => Promise<boolean>;
}

/**
 * Check if a cell is within the given selection range.
 */
function isCellWithinSelection(
  row: number,
  col: number,
  selection: Selection | null
): boolean {
  if (!selection) return false;

  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
}

/**
 * Creates handlers for cell selection operations.
 * Handles regular clicks and shift-clicks for range selection.
 */
export function createCellSelectionHandlers(deps: CellSelectionDependencies): CellSelectionHandlers {
  const {
    config,
    viewport,
    dimensions,
    selection,
    onSelectCell,
    onExtendTo,
    onAddToSelection,
    onCommitBeforeSelect,
    setIsDragging,
    dragStartRef,
    headerDragRef,
    lastMousePosRef,
  } = deps;

  /**
   * Handle mouse down on a cell.
   * Returns true if the event was handled, false otherwise.
   */
  const handleCellMouseDown = async (
    mouseX: number,
    mouseY: number,
    shiftKey: boolean,
    event: React.MouseEvent<HTMLElement>
  ): Promise<boolean> => {
    const cell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);

    if (!cell) {
      // Clicked on header corner or outside grid
      return false;
    }

    const { row, col } = cell;

    // Check if this is a right-click (button === 2)
    const isRightClick = event.button === 2;

    // If right-clicking within current selection, preserve the selection
    // and don't start a drag operation
    if (isRightClick && isCellWithinSelection(row, col, selection)) {
      // Don't change selection, don't start drag
      // Context menu will be handled by onContextMenu event
      event.preventDefault();
      return true;
    }

    // If we're editing, commit first
    if (onCommitBeforeSelect) {
      await onCommitBeforeSelect();
    }

    // Check if this cell is part of a merged region
    let effectiveStartRow = row;
    let effectiveStartCol = col;
    let effectiveEndRow = row;
    let effectiveEndCol = col;
    let isMergedCell = false;
    
    try {
      const mergeInfo = await getMergeInfo(row, col);
      if (mergeInfo) {
        // Cell is part of a merge - use the merged region bounds
        effectiveStartRow = mergeInfo.startRow;
        effectiveStartCol = mergeInfo.startCol;
        effectiveEndRow = mergeInfo.endRow;
        effectiveEndCol = mergeInfo.endCol;
        isMergedCell = true;
      }
    } catch (error) {
      console.error('[cellSelectionHandlers] Failed to get merge info:', error);
      // Continue with normal single-cell selection on error
    }

    if (shiftKey && selection) {
      // Shift-click extends selection
      // For merged cells, extend to the farthest corner of the merge
      onExtendTo(effectiveEndRow, effectiveEndCol);
    } else if (event.ctrlKey && onAddToSelection && !isRightClick) {
      // Ctrl+Click adds to selection (multi-select)
      if (isMergedCell) {
        onAddToSelection(effectiveStartRow, effectiveStartCol, effectiveEndRow, effectiveEndCol);
      } else {
        onAddToSelection(row, col);
      }
    } else {
      // Regular click (or right-click outside selection) starts new selection
      if (isMergedCell) {
        // FIX: For merged cells, use single dispatch with all coordinates
        // This avoids stale state issues from calling selectCell then extendTo
        onSelectCell(effectiveStartRow, effectiveStartCol, "cells", effectiveEndRow, effectiveEndCol);
      } else {
        // Single cell selection
        onSelectCell(row, col);
      }
    }

    // Only start drag for left-click (button === 0)
    if (!isRightClick) {
      setIsDragging(true);
      // For drag operations, use the effective start position (master cell for merges)
      dragStartRef.current = { row: effectiveStartRow, col: effectiveStartCol };
      headerDragRef.current = null;
      lastMousePosRef.current = { x: mouseX, y: mouseY };
    }

    event.preventDefault();
    return true;
  };

  return {
    handleCellMouseDown,
  };
}