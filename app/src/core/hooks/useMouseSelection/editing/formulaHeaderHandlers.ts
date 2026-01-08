// FILENAME: app/src/hooks/useMouseSelection/editing/formulaHeaderHandlers.ts
// PURPOSE: Factory function for creating formula mode header reference handlers.
// CONTEXT: Creates handlers for inserting column and row references when
// clicking on headers while in formula editing mode, supporting both
// single column/row and range references via drag selection.

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import type { FormulaHeaderDragState, MousePosition } from "../types";
import { getColumnFromHeader, getRowFromHeader } from "../../../lib/gridRenderer";

interface FormulaHeaderDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  onInsertColumnReference?: (col: number) => void;
  onInsertColumnRangeReference?: (startCol: number, endCol: number) => void;
  onInsertRowReference?: (row: number) => void;
  onInsertRowRangeReference?: (startRow: number, endRow: number) => void;
  onUpdatePendingColumnReference?: (startCol: number, endCol: number) => void;
  onUpdatePendingRowReference?: (startRow: number, endRow: number) => void;
  onClearPendingReference?: () => void;
  setIsFormulaDragging: (value: boolean) => void;
  formulaHeaderDragStartRef: React.MutableRefObject<FormulaHeaderDragState | null>;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
}

interface FormulaHeaderHandlers {
  handleFormulaColumnHeaderMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
  handleFormulaRowHeaderMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
  handleFormulaHeaderDragMove: (
    mouseX: number,
    mouseY: number
  ) => void;
  handleFormulaHeaderMouseUp: (
    stopAutoScroll: () => void
  ) => void;
}

/**
 * Creates handlers for formula mode header reference operations.
 * Handles clicking on column/row headers to insert references during formula editing.
 */
export function createFormulaHeaderHandlers(deps: FormulaHeaderDependencies): FormulaHeaderHandlers {
  const {
    config,
    viewport,
    dimensions,
    onInsertColumnReference,
    onInsertColumnRangeReference,
    onInsertRowReference,
    onInsertRowRangeReference,
    onUpdatePendingColumnReference,
    onUpdatePendingRowReference,
    onClearPendingReference,
    setIsFormulaDragging,
    formulaHeaderDragStartRef,
    lastMousePosRef,
  } = deps;

  /**
   * Handle mouse down on column header in formula mode.
   * Returns true if the event was handled.
   */
  const handleFormulaColumnHeaderMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    const headerCol = getColumnFromHeader(mouseX, mouseY, config, viewport, dimensions);
    
    if (headerCol === null || !onInsertColumnReference) {
      return false;
    }

    event.preventDefault();
    setIsFormulaDragging(true);
    formulaHeaderDragStartRef.current = { type: "column", index: headerCol };
    lastMousePosRef.current = { x: mouseX, y: mouseY };

    // Update pending column reference for immediate visual feedback
    if (onUpdatePendingColumnReference) {
      onUpdatePendingColumnReference(headerCol, headerCol);
    }

    return true;
  };

  /**
   * Handle mouse down on row header in formula mode.
   * Returns true if the event was handled.
   */
  const handleFormulaRowHeaderMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    const headerRow = getRowFromHeader(mouseX, mouseY, config, viewport, dimensions);
    
    if (headerRow === null || !onInsertRowReference) {
      return false;
    }

    event.preventDefault();
    setIsFormulaDragging(true);
    formulaHeaderDragStartRef.current = { type: "row", index: headerRow };
    lastMousePosRef.current = { x: mouseX, y: mouseY };

    // Update pending row reference for immediate visual feedback
    if (onUpdatePendingRowReference) {
      onUpdatePendingRowReference(headerRow, headerRow);
    }

    return true;
  };

  /**
   * Handle mouse move during formula header drag.
   * Updates the pending column or row reference range.
   */
  const handleFormulaHeaderDragMove = (
    mouseX: number,
    mouseY: number
  ): void => {
    if (!formulaHeaderDragStartRef.current) {
      return;
    }

    const { type, index: startIndex } = formulaHeaderDragStartRef.current;

    if (type === "column") {
      const currentCol = getColumnFromHeader(mouseX, mouseY, config, viewport, dimensions);
      if (currentCol !== null && onUpdatePendingColumnReference) {
        onUpdatePendingColumnReference(startIndex, currentCol);
      }
    } else {
      const currentRow = getRowFromHeader(mouseX, mouseY, config, viewport, dimensions);
      if (currentRow !== null && onUpdatePendingRowReference) {
        onUpdatePendingRowReference(startIndex, currentRow);
      }
    }
  };

  /**
   * Handle mouse up to complete formula header reference.
   * Inserts either a single column/row or range reference.
   */
  const handleFormulaHeaderMouseUp = (stopAutoScroll: () => void): void => {
    if (!formulaHeaderDragStartRef.current) {
      return;
    }

    const { type, index: startIndex } = formulaHeaderDragStartRef.current;
    const mousePos = lastMousePosRef.current;

    if (mousePos) {
      if (type === "column") {
        const endCol = getColumnFromHeader(mousePos.x, mousePos.y, config, viewport, dimensions);
        const finalCol = endCol !== null ? endCol : startIndex;

        if (startIndex === finalCol) {
          // Single column reference
          if (onInsertColumnReference) {
            onInsertColumnReference(startIndex);
          }
        } else {
          // Column range reference
          if (onInsertColumnRangeReference) {
            onInsertColumnRangeReference(startIndex, finalCol);
          }
        }
      } else {
        const endRow = getRowFromHeader(mousePos.x, mousePos.y, config, viewport, dimensions);
        const finalRow = endRow !== null ? endRow : startIndex;

        if (startIndex === finalRow) {
          // Single row reference
          if (onInsertRowReference) {
            onInsertRowReference(startIndex);
          }
        } else {
          // Row range reference
          if (onInsertRowRangeReference) {
            onInsertRowRangeReference(startIndex, finalRow);
          }
        }
      }
    }

    setIsFormulaDragging(false);
    stopAutoScroll();
    formulaHeaderDragStartRef.current = null;
    lastMousePosRef.current = null;

    if (onClearPendingReference) {
      onClearPendingReference();
    }
  };

  return {
    handleFormulaColumnHeaderMouseDown,
    handleFormulaRowHeaderMouseDown,
    handleFormulaHeaderDragMove,
    handleFormulaHeaderMouseUp,
  };
}