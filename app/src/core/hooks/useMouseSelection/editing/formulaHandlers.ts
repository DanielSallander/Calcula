//! FILENAME: app/src/core/hooks/useMouseSelection/editing/formulaHandlers.ts
// PURPOSE: Factory function for creating formula mode cell reference handlers.
// CONTEXT: Creates handlers for inserting cell references when clicking
// on cells while in formula editing mode, supporting both single cell
// and range references via drag selection.

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import type { CellPosition, MousePosition } from "../types";
import { getCellFromPixel } from "../../../lib/gridRenderer";
import { getCellFromMousePosition } from "../utils/cellUtils";

interface FormulaDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  containerRef: React.RefObject<HTMLElement | null>;
  onInsertReference?: (row: number, col: number) => void;
  onInsertRangeReference?: (startRow: number, startCol: number, endRow: number, endCol: number) => void;
  onUpdatePendingReference?: (startRow: number, startCol: number, endRow: number, endCol: number) => void;
  onClearPendingReference?: () => void;
  setIsFormulaDragging: (value: boolean) => void;
  formulaDragStartRef: React.MutableRefObject<CellPosition | null>;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
}

interface FormulaHandlers {
  handleFormulaCellMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
  handleFormulaCellDragMove: (
    mouseX: number,
    mouseY: number,
    rect: DOMRect
  ) => void;
  handleFormulaCellMouseUp: (
    stopAutoScroll: () => void
  ) => void;
}

/**
 * Creates handlers for formula mode cell reference operations.
 * Handles clicking on cells to insert references during formula editing.
 */
export function createFormulaHandlers(deps: FormulaDependencies): FormulaHandlers {
  const {
    config,
    viewport,
    dimensions,
    containerRef,
    onInsertReference,
    onInsertRangeReference,
    onUpdatePendingReference,
    onClearPendingReference,
    setIsFormulaDragging,
    formulaDragStartRef,
    lastMousePosRef,
  } = deps;

  /**
   * Handle mouse down on a cell in formula mode.
   * Starts a formula reference drag operation.
   */
  const handleFormulaCellMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    const cell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);

    if (!cell) {
      return false;
    }

    const { row, col } = cell;

    event.preventDefault();
    setIsFormulaDragging(true);
    formulaDragStartRef.current = { row, col };
    lastMousePosRef.current = { x: mouseX, y: mouseY };

    // Update pending reference for immediate visual feedback
    if (onUpdatePendingReference) {
      onUpdatePendingReference(row, col, row, col);
    }

    return true;
  };

  /**
   * Handle mouse move during formula cell drag.
   * Updates the pending reference range.
   */
  const handleFormulaCellDragMove = (
    mouseX: number,
    mouseY: number,
    rect: DOMRect
  ): void => {
    if (!formulaDragStartRef.current || !onUpdatePendingReference) {
      return;
    }

    const cell = getCellFromMousePosition(mouseX, mouseY, rect, config, viewport, dimensions);
    if (cell) {
      onUpdatePendingReference(
        formulaDragStartRef.current.row,
        formulaDragStartRef.current.col,
        cell.row,
        cell.col
      );
    }
  };

  /**
   * Handle mouse up to complete formula cell reference.
   * Inserts either a single cell or range reference.
   */
  const handleFormulaCellMouseUp = (stopAutoScroll: () => void): void => {
    if (!formulaDragStartRef.current) {
      return;
    }

    // Get the current mouse position to determine final cell
    const rect = containerRef.current?.getBoundingClientRect();
    const mousePos = lastMousePosRef.current;

    if (rect && mousePos) {
      const cell = getCellFromMousePosition(mousePos.x, mousePos.y, rect, config, viewport, dimensions);
      if (cell) {
        const startCell = formulaDragStartRef.current;
        if (startCell.row === cell.row && startCell.col === cell.col) {
          // Single cell reference
          if (onInsertReference) {
            onInsertReference(cell.row, cell.col);
          }
        } else {
          // Range reference
          if (onInsertRangeReference) {
            onInsertRangeReference(startCell.row, startCell.col, cell.row, cell.col);
          }
        }
      }
    }

    setIsFormulaDragging(false);
    stopAutoScroll();
    formulaDragStartRef.current = null;
    lastMousePosRef.current = null;
    
    if (onClearPendingReference) {
      onClearPendingReference();
    }
  };

  return {
    handleFormulaCellMouseDown,
    handleFormulaCellDragMove,
    handleFormulaCellMouseUp,
  };
}