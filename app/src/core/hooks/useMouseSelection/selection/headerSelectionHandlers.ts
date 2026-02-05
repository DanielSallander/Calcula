//! FILENAME: app/src/core/hooks/useMouseSelection/selection/headerSelectionHandlers.ts
// PURPOSE: Factory function for creating header selection event handlers.
// CONTEXT: Creates handlers for column and row header clicks, supporting
// entire column/row selection and shift-click to extend selections.
// FIX: Right-click within existing header selection now preserves the selection.
// FIX: Drag selection now works in both directions (left-to-right and right-to-left for columns,
//      top-to-bottom and bottom-to-top for rows) by keeping the start position as anchor.
// FIX: Eliminated flickering by only calling onExtendTo when the column/row actually changes,
//      and by not resetting the selection start on every mouse move.

import type { GridConfig, Viewport, Selection, SelectionType, DimensionOverrides } from "../../../types";
import type { MousePosition, HeaderDragState } from "../types";
import { getColumnFromHeader, getRowFromHeader } from "../../../lib/gridRenderer";

interface HeaderSelectionDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  selection: Selection | null;
  onSelectCell: (row: number, col: number, type?: SelectionType) => void;
  onExtendTo: (row: number, col: number) => void;
  onSelectColumn?: (col: number, extend?: boolean) => void;
  onSelectRow?: (row: number, extend?: boolean) => void;
  onCommitBeforeSelect?: () => Promise<void>;
  setIsDragging: (value: boolean) => void;
  headerDragRef: React.MutableRefObject<HeaderDragState | null>;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
}

interface HeaderSelectionHandlers {
  handleColumnHeaderMouseDown: (
    mouseX: number,
    mouseY: number,
    shiftKey: boolean,
    event: React.MouseEvent<HTMLElement>
  ) => Promise<boolean>;
  handleRowHeaderMouseDown: (
    mouseX: number,
    mouseY: number,
    shiftKey: boolean,
    event: React.MouseEvent<HTMLElement>
  ) => Promise<boolean>;
  handleHeaderDragMove: (
    mouseX: number,
    mouseY: number
  ) => void;
}

/**
 * Check if a column is within the current column selection.
 */
function isColumnWithinSelection(col: number, selection: Selection | null): boolean {
  if (!selection || selection.type !== "columns") {
    return false;
  }
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);
  return col >= minCol && col <= maxCol;
}

/**
 * Check if a row is within the current row selection.
 */
function isRowWithinSelection(row: number, selection: Selection | null): boolean {
  if (!selection || selection.type !== "rows") {
    return false;
  }
  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  return row >= minRow && row <= maxRow;
}

/**
 * Creates handlers for header selection operations.
 * Handles column and row header clicks for entire column/row selection.
 */
export function createHeaderSelectionHandlers(deps: HeaderSelectionDependencies): HeaderSelectionHandlers {
  const {
    config,
    viewport,
    dimensions,
    selection,
    onSelectCell,
    onExtendTo,
    onSelectColumn,
    onSelectRow,
    onCommitBeforeSelect,
    setIsDragging,
    headerDragRef,
    lastMousePosRef,
  } = deps;

  // Track the last extended index to avoid redundant updates
  let lastExtendedIndex: number | null = null;

  /**
   * Handle mouse down on column header.
   * Returns true if the event was handled.
   */
  const handleColumnHeaderMouseDown = async (
    mouseX: number,
    mouseY: number,
    shiftKey: boolean,
    event: React.MouseEvent<HTMLElement>
  ): Promise<boolean> => {
    const headerCol = getColumnFromHeader(mouseX, mouseY, config, viewport, dimensions);
    
    if (headerCol === null) {
      return false;
    }

    event.preventDefault();

    // Right-click (button === 2) within existing column selection: preserve selection
    if (event.button === 2 && isColumnWithinSelection(headerCol, selection)) {
      // Don't change selection, just let context menu appear
      return true;
    }

    // If we're editing, commit first
    if (onCommitBeforeSelect) {
      await onCommitBeforeSelect();
    }

    if (shiftKey && selection && onSelectColumn) {
      // Extend column selection
      onSelectColumn(headerCol, true);
    } else if (onSelectColumn) {
      // Select entire column
      onSelectColumn(headerCol, false);
    } else {
      // Fallback: select all rows in this column
      onSelectCell(0, headerCol, "columns");
      onExtendTo(config.totalRows - 1, headerCol);
    }

    // Start header drag for extending selection (only for left-click)
    if (event.button === 0) {
      setIsDragging(true);
      headerDragRef.current = { type: "column", startIndex: headerCol };
      lastMousePosRef.current = { x: mouseX, y: mouseY };
      // Reset last extended index for new drag operation
      lastExtendedIndex = headerCol;
    }

    return true;
  };

  /**
   * Handle mouse down on row header.
   * Returns true if the event was handled.
   */
  const handleRowHeaderMouseDown = async (
    mouseX: number,
    mouseY: number,
    shiftKey: boolean,
    event: React.MouseEvent<HTMLElement>
  ): Promise<boolean> => {
    const headerRow = getRowFromHeader(mouseX, mouseY, config, viewport, dimensions);
    
    if (headerRow === null) {
      return false;
    }

    event.preventDefault();

    // Right-click (button === 2) within existing row selection: preserve selection
    if (event.button === 2 && isRowWithinSelection(headerRow, selection)) {
      // Don't change selection, just let context menu appear
      return true;
    }

    // If we're editing, commit first
    if (onCommitBeforeSelect) {
      await onCommitBeforeSelect();
    }

    if (shiftKey && selection && onSelectRow) {
      // Extend row selection
      onSelectRow(headerRow, true);
    } else if (onSelectRow) {
      // Select entire row
      onSelectRow(headerRow, false);
    } else {
      // Fallback: select all columns in this row
      onSelectCell(headerRow, 0, "rows");
      onExtendTo(headerRow, config.totalCols - 1);
    }

    // Start header drag for extending selection (only for left-click)
    if (event.button === 0) {
      setIsDragging(true);
      headerDragRef.current = { type: "row", startIndex: headerRow };
      lastMousePosRef.current = { x: mouseX, y: mouseY };
      // Reset last extended index for new drag operation
      lastExtendedIndex = headerRow;
    }

    return true;
  };

  /**
   * Handle mouse move during header drag.
   * Extends the column or row selection as the mouse moves.
   * The startIndex is kept as the anchor point, allowing selection
   * in both directions (e.g., left-to-right AND right-to-left for columns).
   * 
   * Only updates when the target column/row actually changes to prevent flickering.
   */
  const handleHeaderDragMove = (mouseX: number, mouseY: number): void => {
    if (!headerDragRef.current) {
      return;
    }

    const { type, startIndex } = headerDragRef.current;

    if (type === "column") {
      const currentCol = getColumnFromHeader(mouseX, mouseY, config, viewport, dimensions);
      if (currentCol !== null && currentCol !== lastExtendedIndex) {
        // Only update if the column actually changed
        lastExtendedIndex = currentCol;
        // Extend column selection from startIndex (anchor) to currentCol
        // Do NOT call onSelectCell here - it was already called in handleColumnHeaderMouseDown
        // Just extend to the new column
        onExtendTo(config.totalRows - 1, currentCol);
      }
    } else {
      const currentRow = getRowFromHeader(mouseX, mouseY, config, viewport, dimensions);
      if (currentRow !== null && currentRow !== lastExtendedIndex) {
        // Only update if the row actually changed
        lastExtendedIndex = currentRow;
        // Extend row selection from startIndex (anchor) to currentRow
        // Do NOT call onSelectCell here - it was already called in handleRowHeaderMouseDown
        // Just extend to the new row
        onExtendTo(currentRow, config.totalCols - 1);
      }
    }
  };

  return {
    handleColumnHeaderMouseDown,
    handleRowHeaderMouseDown,
    handleHeaderDragMove,
  };
}