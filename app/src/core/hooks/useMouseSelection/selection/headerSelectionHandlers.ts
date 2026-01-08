// FILENAME: app/src/hooks/useMouseSelection/selection/headerSelectionHandlers.ts
// PURPOSE: Factory function for creating header selection event handlers.
// CONTEXT: Creates handlers for column and row header clicks, supporting
// entire column/row selection and shift-click to extend selections.

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

    // Start header drag for extending selection
    setIsDragging(true);
    headerDragRef.current = { type: "column", startIndex: headerCol };
    lastMousePosRef.current = { x: mouseX, y: mouseY };

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

    // Start header drag for extending selection
    setIsDragging(true);
    headerDragRef.current = { type: "row", startIndex: headerRow };
    lastMousePosRef.current = { x: mouseX, y: mouseY };

    return true;
  };

  /**
   * Handle mouse move during header drag.
   * Extends the column or row selection as the mouse moves.
   */
  const handleHeaderDragMove = (mouseX: number, mouseY: number): void => {
    if (!headerDragRef.current) {
      return;
    }

    const { type, startIndex } = headerDragRef.current;

    if (type === "column") {
      const currentCol = getColumnFromHeader(mouseX, mouseY, config, viewport, dimensions);
      if (currentCol !== null && onSelectColumn) {
        // Extend column selection by setting selection range
        const minCol = Math.min(startIndex, currentCol);
        const maxCol = Math.max(startIndex, currentCol);
        onSelectCell(0, minCol, "columns");
        onExtendTo(config.totalRows - 1, maxCol);
      }
    } else {
      const currentRow = getRowFromHeader(mouseX, mouseY, config, viewport, dimensions);
      if (currentRow !== null && onSelectRow) {
        // Extend row selection
        const minRow = Math.min(startIndex, currentRow);
        const maxRow = Math.max(startIndex, currentRow);
        onSelectCell(minRow, 0, "rows");
        onExtendTo(maxRow, config.totalCols - 1);
      }
    }
  };

  return {
    handleColumnHeaderMouseDown,
    handleRowHeaderMouseDown,
    handleHeaderDragMove,
  };
}