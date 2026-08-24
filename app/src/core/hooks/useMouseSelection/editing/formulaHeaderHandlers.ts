//! FILENAME: app/src/core/hooks/useMouseSelection/editing/formulaHeaderHandlers.ts
// PURPOSE: Factory function for creating formula mode header reference handlers.
// CONTEXT: Creates handlers for inserting column and row references when
// clicking on headers while in formula editing mode, supporting both
// single column/row and range references via drag selection.
// UPDATED: The select-all corner inserts the whole-sheet reference. It is a
// click, not a drag -- see handleFormulaCornerMouseDown for why a drag would
// insert `1:1` instead of `1:1048576`.

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import type { FormulaHeaderDragState, MousePosition } from "../types";
import { getColumnFromHeader, getRowFromHeader, isSelectAllCorner } from "../../../lib/gridRenderer";

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
  handleFormulaCornerMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
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
   * Handle mouse down on the select-all corner in formula mode.
   * Inserts the whole-sheet reference and returns true if the event was handled.
   *
   * The corner is the header intersection, so it belongs to this file -- and it
   * had to be added here because the two handlers below cannot see it: their hit
   * tests return null for every corner pixel by construction. Before this
   * existed, a corner click during formula entry inserted NOTHING and said
   * nothing; `insertRowRangeReference` had exactly one caller (the row-header
   * mouse-up below), reachable only from a row-header pixel, so no code path in
   * the repo could emit `1:1048576`.
   *
   * A CLICK, NOT A DRAG -- deliberately, and Excel's corner is the same. The two
   * handlers below seed `formulaHeaderDragStartRef` and insert on mouse UP so a
   * drag can widen the range; doing that here would insert the WRONG reference,
   * because mouse up re-reads the pointer through `getRowFromHeader`, which is
   * null on corner pixels, so `finalRow` would fall back to the start index and
   * the whole sheet would collapse to `1:1`. There is also nothing to widen: the
   * corner already names every row of the sheet.
   *
   * Sheet qualification comes for free: `insertRowRangeReference` prefixes the
   * source sheet exactly as the row-header path does, so a formula being written
   * on another sheet gets `Sheet2!1:1048576`.
   */
  const handleFormulaCornerMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    if (!isSelectAllCorner(mouseX, mouseY, config) || !onInsertRowRangeReference) {
      return false;
    }

    event.preventDefault();
    onInsertRowRangeReference(0, config.totalRows - 1);

    return true;
  };

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
    handleFormulaCornerMouseDown,
    handleFormulaColumnHeaderMouseDown,
    handleFormulaRowHeaderMouseDown,
    handleFormulaHeaderDragMove,
    handleFormulaHeaderMouseUp,
  };
}