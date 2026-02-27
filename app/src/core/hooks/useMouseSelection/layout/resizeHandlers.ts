//! FILENAME: app/src/core/hooks/useMouseSelection/layout/resizeHandlers.ts
// PURPOSE: Factory function for creating column and row resize handlers.
// CONTEXT: Creates handlers for detecting resize handles on header edges
// and performing drag-to-resize operations for columns and rows.
// UPDATED: Added uniform multi-resize (batch) and zero-width hiding via drag.

import type { GridConfig, Viewport, DimensionOverrides, Selection } from "../../../types";
import type { ResizeState } from "../types";
import { getColumnResizeHandle, getRowResizeHandle } from "../../../lib/gridRenderer";
import { getCurrentDimensionSize } from "../utils/cellUtils";

/** Threshold below which dragging triggers hiding (fraction of minWidth/minHeight). */
const HIDE_THRESHOLD_FACTOR = 0.5;
/** Visual snap-to-zero width/height shown during drag when below hide threshold. */
const SNAP_TO_ZERO_SIZE = 2;

interface ResizeDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  selection?: Selection | null;
  onColumnResize?: (col: number, width: number) => void;
  onRowResize?: (row: number, height: number) => void;
  onBatchColumnResize?: (cols: number[], width: number) => void;
  onBatchRowResize?: (rows: number[], height: number) => void;
  onHideColumns?: (cols: number[]) => void;
  onHideRows?: (rows: number[]) => void;
  setIsResizing: (value: boolean) => void;
  setCursorStyle: (style: string) => void;
  resizeStateRef: React.MutableRefObject<ResizeState | null>;
}

interface ResizeHandlers {
  checkResizeHandle: (mouseX: number, mouseY: number) => boolean;
  handleResizeMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
  handleResizeMouseMove: (mouseX: number, mouseY: number) => void;
  handleResizeMouseUp: () => void;
  updateCursorForPosition: (mouseX: number, mouseY: number) => void;
}

/**
 * Collect all selected column indices from a column selection,
 * including the primary range and any additional ranges.
 */
function getSelectedColumnIndices(sel: Selection): number[] {
  const cols: number[] = [];
  const minCol = Math.min(sel.startCol, sel.endCol);
  const maxCol = Math.max(sel.startCol, sel.endCol);
  for (let c = minCol; c <= maxCol; c++) {
    cols.push(c);
  }
  if (sel.additionalRanges) {
    for (const range of sel.additionalRanges) {
      const rMin = Math.min(range.startCol, range.endCol);
      const rMax = Math.max(range.startCol, range.endCol);
      for (let c = rMin; c <= rMax; c++) {
        if (!cols.includes(c)) {
          cols.push(c);
        }
      }
    }
  }
  return cols;
}

/**
 * Collect all selected row indices from a row selection,
 * including the primary range and any additional ranges.
 */
function getSelectedRowIndices(sel: Selection): number[] {
  const rows: number[] = [];
  const minRow = Math.min(sel.startRow, sel.endRow);
  const maxRow = Math.max(sel.startRow, sel.endRow);
  for (let r = minRow; r <= maxRow; r++) {
    rows.push(r);
  }
  if (sel.additionalRanges) {
    for (const range of sel.additionalRanges) {
      const rMin = Math.min(range.startRow, range.endRow);
      const rMax = Math.max(range.startRow, range.endRow);
      for (let r = rMin; r <= rMax; r++) {
        if (!rows.includes(r)) {
          rows.push(r);
        }
      }
    }
  }
  return rows;
}

/**
 * Check if a column index falls within a column selection (primary + additional ranges).
 */
function isColumnInSelection(col: number, sel: Selection): boolean {
  const minCol = Math.min(sel.startCol, sel.endCol);
  const maxCol = Math.max(sel.startCol, sel.endCol);
  if (col >= minCol && col <= maxCol) return true;
  if (sel.additionalRanges) {
    for (const range of sel.additionalRanges) {
      const rMin = Math.min(range.startCol, range.endCol);
      const rMax = Math.max(range.startCol, range.endCol);
      if (col >= rMin && col <= rMax) return true;
    }
  }
  return false;
}

/**
 * Check if a row index falls within a row selection (primary + additional ranges).
 */
function isRowInSelection(row: number, sel: Selection): boolean {
  const minRow = Math.min(sel.startRow, sel.endRow);
  const maxRow = Math.max(sel.startRow, sel.endRow);
  if (row >= minRow && row <= maxRow) return true;
  if (sel.additionalRanges) {
    for (const range of sel.additionalRanges) {
      const rMin = Math.min(range.startRow, range.endRow);
      const rMax = Math.max(range.startRow, range.endRow);
      if (row >= rMin && row <= rMax) return true;
    }
  }
  return false;
}

/**
 * Creates handlers for column and row resize operations.
 * Handles detection of resize handles, drag-to-resize, uniform multi-resize,
 * and zero-width/height hiding.
 */
export function createResizeHandlers(deps: ResizeDependencies): ResizeHandlers {
  const {
    config,
    viewport,
    dimensions,
    selection,
    onColumnResize,
    onRowResize,
    onBatchColumnResize,
    onBatchRowResize,
    onHideColumns,
    onHideRows,
    setIsResizing,
    setCursorStyle,
    resizeStateRef,
  } = deps;

  /**
   * Check if the mouse is over a resize handle.
   * Returns true if over a column or row resize handle.
   */
  const checkResizeHandle = (mouseX: number, mouseY: number): boolean => {
    const colResize = getColumnResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    const rowResize = getRowResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    return colResize !== null || rowResize !== null;
  };

  /**
   * Handle mouse down on a resize handle.
   * Returns true if a resize operation was started.
   */
  const handleResizeMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    // Check for column resize handle
    const colResizeHandle = getColumnResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    if (colResizeHandle !== null && onColumnResize) {
      event.preventDefault();
      setIsResizing(true);
      const currentWidth = getCurrentDimensionSize("column", colResizeHandle, config, dimensions);
      resizeStateRef.current = {
        type: "column",
        index: colResizeHandle,
        startPos: mouseX,
        startSize: currentWidth,
      };
      return true;
    }

    // Check for row resize handle
    const rowResizeHandle = getRowResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    if (rowResizeHandle !== null && onRowResize) {
      event.preventDefault();
      setIsResizing(true);
      const currentHeight = getCurrentDimensionSize("row", rowResizeHandle, config, dimensions);
      resizeStateRef.current = {
        type: "row",
        index: rowResizeHandle,
        startPos: mouseY,
        startSize: currentHeight,
      };
      return true;
    }

    return false;
  };

  /**
   * Handle mouse move during resize operation.
   * Updates the column width or row height based on drag delta.
   * Allows dragging below minWidth/minHeight to indicate hiding intent.
   */
  const handleResizeMouseMove = (mouseX: number, mouseY: number): void => {
    if (!resizeStateRef.current) {
      return;
    }

    const { type, index, startPos, startSize } = resizeStateRef.current;

    if (type === "column") {
      const delta = mouseX - startPos;
      const rawWidth = startSize + delta;
      const hideThreshold = config.minColumnWidth * HIDE_THRESHOLD_FACTOR;

      if (rawWidth < hideThreshold) {
        // Below hiding threshold: show snap-to-zero visual hint
        if (onColumnResize) {
          onColumnResize(index, SNAP_TO_ZERO_SIZE);
        }
      } else {
        const newWidth = Math.max(config.minColumnWidth, rawWidth);
        if (onColumnResize) {
          onColumnResize(index, newWidth);
        }
      }
    } else {
      const delta = mouseY - startPos;
      const rawHeight = startSize + delta;
      const hideThreshold = config.minRowHeight * HIDE_THRESHOLD_FACTOR;

      if (rawHeight < hideThreshold) {
        // Below hiding threshold: show snap-to-zero visual hint
        if (onRowResize) {
          onRowResize(index, SNAP_TO_ZERO_SIZE);
        }
      } else {
        const newHeight = Math.max(config.minRowHeight, rawHeight);
        if (onRowResize) {
          onRowResize(index, newHeight);
        }
      }
    }
  };

  /**
   * Handle mouse up to end resize operation.
   * Applies uniform resize to all selected columns/rows if applicable,
   * or triggers hiding if dragged below threshold.
   */
  const handleResizeMouseUp = (): void => {
    if (resizeStateRef.current) {
      const { type, index, startPos, startSize } = resizeStateRef.current;

      if (type === "column") {
        // Determine if the column was dragged to hide
        const currentWidth = getCurrentDimensionSize("column", index, config, dimensions);
        const hideThreshold = config.minColumnWidth * HIDE_THRESHOLD_FACTOR;
        const rawWidth = startSize + ((resizeStateRef.current as ResizeState).startPos === startPos ? 0 : currentWidth - startSize);

        if (currentWidth <= SNAP_TO_ZERO_SIZE) {
          // Column was dragged to zero -> hide
          const colsToHide: number[] = [];
          if (selection?.type === "columns" && isColumnInSelection(index, selection)) {
            colsToHide.push(...getSelectedColumnIndices(selection));
          } else {
            colsToHide.push(index);
          }
          // Reset width back to default before hiding (hiding is via manuallyHiddenCols)
          if (onColumnResize) {
            onColumnResize(index, config.defaultCellWidth);
          }
          if (onHideColumns) {
            onHideColumns(colsToHide);
          }
        } else if (selection?.type === "columns" && isColumnInSelection(index, selection) && onBatchColumnResize) {
          // Uniform resize: apply this column's final width to all selected columns
          const allCols = getSelectedColumnIndices(selection);
          // Exclude the already-resized column since onColumnResize updated it during drag
          const otherCols = allCols.filter(c => c !== index);
          if (otherCols.length > 0) {
            onBatchColumnResize(otherCols, currentWidth);
          }
        }
      } else {
        // Row logic
        const currentHeight = getCurrentDimensionSize("row", index, config, dimensions);

        if (currentHeight <= SNAP_TO_ZERO_SIZE) {
          // Row was dragged to zero -> hide
          const rowsToHide: number[] = [];
          if (selection?.type === "rows" && isRowInSelection(index, selection)) {
            rowsToHide.push(...getSelectedRowIndices(selection));
          } else {
            rowsToHide.push(index);
          }
          // Reset height back to default before hiding
          if (onRowResize) {
            onRowResize(index, config.defaultCellHeight);
          }
          if (onHideRows) {
            onHideRows(rowsToHide);
          }
        } else if (selection?.type === "rows" && isRowInSelection(index, selection) && onBatchRowResize) {
          // Uniform resize: apply this row's final height to all selected rows
          const allRows = getSelectedRowIndices(selection);
          const otherRows = allRows.filter(r => r !== index);
          if (otherRows.length > 0) {
            onBatchRowResize(otherRows, currentHeight);
          }
        }
      }
    }

    setIsResizing(false);
    resizeStateRef.current = null;
  };

  /**
   * Update cursor style based on mouse position.
   * Shows resize cursors when over resize handles.
   */
  const updateCursorForPosition = (mouseX: number, mouseY: number): void => {
    const colResize = getColumnResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    const rowResize = getRowResizeHandle(mouseX, mouseY, config, viewport, dimensions);

    if (colResize !== null) {
      setCursorStyle("col-resize");
    } else if (rowResize !== null) {
      setCursorStyle("row-resize");
    } else {
      setCursorStyle("default");
    }
  };

  return {
    checkResizeHandle,
    handleResizeMouseDown,
    handleResizeMouseMove,
    handleResizeMouseUp,
    updateCursorForPosition,
  };
}
