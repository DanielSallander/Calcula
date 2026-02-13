//! FILENAME: app/src/core/hooks/useMouseSelection/selection/selectionDragHandlers.ts
// PURPOSE: Factory function for creating selection drag handlers.
// CONTEXT: Creates handlers for dragging selected cells, rows, or columns
// to move them to a new location. This allows users to click on a selection
// border and drag it to reposition the cells (like in Excel).

import type { GridConfig, Viewport, DimensionOverrides, Selection } from "../../../types";
import type { SelectionDragState, CellPosition, MousePosition } from "../types";
import { getCellFromPixel, getSelectionBorderAtPixel, getRowFromHeader, getColumnFromHeader } from "../../../lib/gridRenderer";
import { getCellFromMousePosition } from "../utils/cellUtils";

interface SelectionDragDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  containerRef: React.RefObject<HTMLElement | null>;
  selection: Selection | null;
  onMoveCells?: (source: Selection, targetRow: number, targetCol: number) => Promise<void>;
  onMoveRows?: (sourceStartRow: number, sourceEndRow: number, targetRow: number) => Promise<void>;
  onMoveColumns?: (sourceStartCol: number, sourceEndCol: number, targetCol: number) => Promise<void>;
  setIsSelectionDragging: (value: boolean) => void;
  setCursorStyle: (style: string) => void;
  selectionDragRef: React.MutableRefObject<SelectionDragState | null>;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
  setSelectionDragPreview: (preview: Selection | null) => void;
}

interface SelectionDragHandlers {
  handleSelectionDragMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
  handleSelectionDragMove: (
    mouseX: number,
    mouseY: number,
    rect: DOMRect
  ) => void;
  handleSelectionDragMouseUp: (
    stopAutoScroll: () => void
  ) => Promise<void>;
  handleSelectionDragCancel: () => void;
  /** Check if mouse is over a selection border (for cursor display) */
  isOverSelectionBorder: (mouseX: number, mouseY: number) => boolean;
}

/**
 * Creates handlers for dragging selected cells, rows, or columns.
 * Handles clicking on a selection border and dragging it to a new position.
 */
export function createSelectionDragHandlers(deps: SelectionDragDependencies): SelectionDragHandlers {
  const {
    config,
    viewport,
    dimensions,
    containerRef,
    selection,
    onMoveCells,
    onMoveRows,
    onMoveColumns,
    setIsSelectionDragging,
    setCursorStyle,
    selectionDragRef,
    lastMousePosRef,
    setSelectionDragPreview,
  } = deps;

  /**
   * Check if the mouse is over a selection border (for cursor display).
   * This is used to show the move cursor when hovering over a draggable border.
   */
  const isOverSelectionBorder = (mouseX: number, mouseY: number): boolean => {
    const borderHit = getSelectionBorderAtPixel(
      mouseX,
      mouseY,
      config,
      viewport,
      selection,
      dimensions
    );
    return borderHit !== null;
  };

  /**
   * Handle mouse down to start a selection drag.
   * Returns true if a drag was started (clicked on selection border),
   * false otherwise (clicked somewhere else, should be handled by other handlers).
   */
  const handleSelectionDragMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    if (!selection) {
      return false;
    }

    // Check if clicking on a selection border
    const borderHit = getSelectionBorderAtPixel(
      mouseX,
      mouseY,
      config,
      viewport,
      selection,
      dimensions
    );

    if (!borderHit) {
      return false;
    }

    // Get the cell under the cursor for offset calculation
    let dragStartRow: number;
    let dragStartCol: number;

    if (selection.type === "rows") {
      // For row selection, get the row from header
      const row = getRowFromHeader(mouseX, mouseY, config, viewport, dimensions);
      dragStartRow = row ?? Math.min(selection.startRow, selection.endRow);
      dragStartCol = 0;
    } else if (selection.type === "columns") {
      // For column selection, get the column from header
      const col = getColumnFromHeader(mouseX, mouseY, config, viewport, dimensions);
      dragStartRow = 0;
      dragStartCol = col ?? Math.min(selection.startCol, selection.endCol);
    } else {
      // For cell selection, get the cell from the grid
      const cell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);
      dragStartRow = cell?.row ?? Math.min(selection.startRow, selection.endRow);
      dragStartCol = cell?.col ?? Math.min(selection.startCol, selection.endCol);
    }

    // Calculate offset from mouse to selection top-left
    const minRow = Math.min(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);

    event.preventDefault();
    setIsSelectionDragging(true);
    setCursorStyle("move");

    selectionDragRef.current = {
      sourceSelection: { ...selection },
      dragHandle: borderHit.edge,
      targetRow: minRow,
      targetCol: minCol,
      offsetRow: dragStartRow - minRow,
      offsetCol: dragStartCol - minCol,
    };

    lastMousePosRef.current = { x: mouseX, y: mouseY };

    // Initialize preview
    updateDragPreview(minRow, minCol);

    return true;
  };

  /**
   * Update the drag preview based on target position.
   */
  const updateDragPreview = (targetRow: number, targetCol: number): void => {
    if (!selectionDragRef.current) {
      setSelectionDragPreview(null);
      return;
    }

    const { sourceSelection } = selectionDragRef.current;
    const height = Math.abs(sourceSelection.endRow - sourceSelection.startRow);
    const width = Math.abs(sourceSelection.endCol - sourceSelection.startCol);

    setSelectionDragPreview({
      startRow: targetRow,
      startCol: targetCol,
      endRow: targetRow + height,
      endCol: targetCol + width,
      type: sourceSelection.type,
    });
  };

  /**
   * Handle mouse move during selection drag.
   * Updates the target position preview.
   */
  const handleSelectionDragMove = (
    mouseX: number,
    mouseY: number,
    rect: DOMRect
  ): void => {
    if (!selectionDragRef.current) {
      return;
    }

    lastMousePosRef.current = { x: mouseX, y: mouseY };

    const { sourceSelection, offsetRow, offsetCol } = selectionDragRef.current;
    const totalRows = config.totalRows || 1000;
    const totalCols = config.totalCols || 100;

    let newTargetRow: number;
    let newTargetCol: number;

    if (sourceSelection.type === "rows") {
      // For row selection, only track row position from row header
      const row = getRowFromHeader(mouseX, mouseY, config, viewport, dimensions);
      if (row !== null) {
        newTargetRow = Math.max(0, row - offsetRow);
      } else {
        // If not in row header, try to get from cell area
        const cell = getCellFromMousePosition(mouseX, mouseY, rect, config, viewport, dimensions);
        newTargetRow = cell ? Math.max(0, cell.row - offsetRow) : selectionDragRef.current.targetRow;
      }
      newTargetCol = 0;

      // Clamp row to valid range
      const height = Math.abs(sourceSelection.endRow - sourceSelection.startRow) + 1;
      newTargetRow = Math.min(newTargetRow, totalRows - height);
    } else if (sourceSelection.type === "columns") {
      // For column selection, only track column position from column header
      const col = getColumnFromHeader(mouseX, mouseY, config, viewport, dimensions);
      if (col !== null) {
        newTargetCol = Math.max(0, col - offsetCol);
      } else {
        // If not in column header, try to get from cell area
        const cell = getCellFromMousePosition(mouseX, mouseY, rect, config, viewport, dimensions);
        newTargetCol = cell ? Math.max(0, cell.col - offsetCol) : selectionDragRef.current.targetCol;
      }
      newTargetRow = 0;

      // Clamp column to valid range
      const width = Math.abs(sourceSelection.endCol - sourceSelection.startCol) + 1;
      newTargetCol = Math.min(newTargetCol, totalCols - width);
    } else {
      // For cell selection, track both row and column
      const cell = getCellFromMousePosition(mouseX, mouseY, rect, config, viewport, dimensions);
      if (cell) {
        newTargetRow = Math.max(0, cell.row - offsetRow);
        newTargetCol = Math.max(0, cell.col - offsetCol);
      } else {
        newTargetRow = selectionDragRef.current.targetRow;
        newTargetCol = selectionDragRef.current.targetCol;
      }

      // Clamp to valid range
      const height = Math.abs(sourceSelection.endRow - sourceSelection.startRow) + 1;
      const width = Math.abs(sourceSelection.endCol - sourceSelection.startCol) + 1;
      newTargetRow = Math.min(newTargetRow, totalRows - height);
      newTargetCol = Math.min(newTargetCol, totalCols - width);
    }

    // Update drag state
    selectionDragRef.current.targetRow = newTargetRow;
    selectionDragRef.current.targetCol = newTargetCol;

    // Update preview
    updateDragPreview(newTargetRow, newTargetCol);
  };

  /**
   * Handle mouse up to complete the selection drag.
   */
  const handleSelectionDragMouseUp = async (stopAutoScroll: () => void): Promise<void> => {
    if (!selectionDragRef.current) {
      return;
    }

    // Capture state and reset refs IMMEDIATELY (synchronously) to prevent
    // the global window mouseup handler from firing a second concurrent call.
    const { sourceSelection, targetRow, targetCol } = selectionDragRef.current;
    selectionDragRef.current = null;
    lastMousePosRef.current = null;
    setIsSelectionDragging(false);
    setCursorStyle("cell");
    setSelectionDragPreview(null);
    stopAutoScroll();

    const sourceMinRow = Math.min(sourceSelection.startRow, sourceSelection.endRow);
    const sourceMinCol = Math.min(sourceSelection.startCol, sourceSelection.endCol);

    // Check if target is same as source (no-op)
    const isSamePosition =
      (sourceSelection.type === "rows" && targetRow === sourceMinRow) ||
      (sourceSelection.type === "columns" && targetCol === sourceMinCol) ||
      (sourceSelection.type === "cells" && targetRow === sourceMinRow && targetCol === sourceMinCol);

    if (!isSamePosition) {
      // Execute the move operation
      try {
        if (sourceSelection.type === "rows" && onMoveRows) {
          await onMoveRows(
            sourceSelection.startRow,
            sourceSelection.endRow,
            targetRow
          );
        } else if (sourceSelection.type === "columns" && onMoveColumns) {
          await onMoveColumns(
            sourceSelection.startCol,
            sourceSelection.endCol,
            targetCol
          );
        } else if (sourceSelection.type === "cells" && onMoveCells) {
          await onMoveCells(sourceSelection, targetRow, targetCol);
        }
      } catch (error) {
        console.error("[SelectionDrag] Move operation failed:", error);
      }
    }
  };

  /**
   * Cancel the selection drag operation.
   */
  const handleSelectionDragCancel = (): void => {
    setIsSelectionDragging(false);
    setCursorStyle("cell");
    setSelectionDragPreview(null);
    selectionDragRef.current = null;
    lastMousePosRef.current = null;
  };

  return {
    handleSelectionDragMouseDown,
    handleSelectionDragMove,
    handleSelectionDragMouseUp,
    handleSelectionDragCancel,
    isOverSelectionBorder,
  };
}
