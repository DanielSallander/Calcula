//! FILENAME: app/src/core/hooks/useMouseSelection/editing/referenceDragHandlers.ts
// PURPOSE: Factory function for creating formula reference drag handlers.
// CONTEXT: Creates handlers for dragging existing cell references in a formula
// to move them to a new location. This allows users to click on a highlighted
// reference border and drag it to change the cell/range it refers to.
// NOTE: Dragging only works when clicking on the reference border (like Excel).

import type { GridConfig, Viewport, DimensionOverrides, FormulaReference } from "../../../types";
import type { CellPosition, MousePosition } from "../types";
import { getCellFromPixel, getFormulaReferenceBorderAtPixel } from "../../../lib/gridRenderer";
import { getCellFromMousePosition } from "../utils/cellUtils";
import { setHoveringOverReferenceBorder } from "../../../hooks/useEditing";

interface ReferenceDragDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  containerRef: React.RefObject<HTMLElement | null>;
  formulaReferences: FormulaReference[];
  currentSheetName?: string;
  formulaSourceSheetName?: string;
  onStartRefDrag?: (row: number, col: number) => boolean;
  onUpdateRefDrag?: (row: number, col: number) => void;
  onCompleteRefDrag?: (row: number, col: number) => void;
  onCancelRefDrag?: () => void;
  setIsRefDragging: (value: boolean) => void;
  setCursorStyle: (style: string) => void;
  refDragStartRef: React.MutableRefObject<CellPosition | null>;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
}

interface ReferenceDragHandlers {
  handleReferenceDragMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
  handleReferenceDragMove: (
    mouseX: number,
    mouseY: number,
    rect: DOMRect
  ) => void;
  handleReferenceDragMouseUp: (
    stopAutoScroll: () => void
  ) => void;
  handleReferenceDragCancel: () => void;
  /** Check if mouse is over a reference border (for cursor display) */
  isOverReferenceBorder: (mouseX: number, mouseY: number) => boolean;
}

/**
 * Creates handlers for dragging existing formula references.
 * Handles clicking on a highlighted reference and dragging it to a new position.
 */
export function createReferenceDragHandlers(deps: ReferenceDragDependencies): ReferenceDragHandlers {
  const {
    config,
    viewport,
    dimensions,
    containerRef,
    formulaReferences,
    currentSheetName,
    formulaSourceSheetName,
    onStartRefDrag,
    onUpdateRefDrag,
    onCompleteRefDrag,
    onCancelRefDrag,
    setIsRefDragging,
    setCursorStyle,
    refDragStartRef,
    lastMousePosRef,
  } = deps;

  /**
   * Check if the mouse is over a reference border (for cursor display).
   * This is used to show the move cursor when hovering over a draggable border.
   */
  const isOverReferenceBorder = (mouseX: number, mouseY: number): boolean => {
    const borderHit = getFormulaReferenceBorderAtPixel(
      mouseX,
      mouseY,
      config,
      viewport,
      formulaReferences,
      dimensions,
      currentSheetName,
      formulaSourceSheetName
    );
    return borderHit !== null;
  };

  /**
   * Handle mouse down to start a reference drag.
   * Returns true if a drag was started (clicked on reference border),
   * false otherwise (clicked somewhere else, should be handled by other handlers).
   * NOTE: Dragging only starts when clicking on the reference BORDER, not inside.
   */
  const handleReferenceDragMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    // Check if clicking on a reference border (not just inside the reference)
    const borderHit = getFormulaReferenceBorderAtPixel(
      mouseX,
      mouseY,
      config,
      viewport,
      formulaReferences,
      dimensions,
      currentSheetName,
      formulaSourceSheetName
    );

    if (!borderHit) {
      return false;
    }

    // FIX: Use the reference's startRow/startCol instead of the cell under cursor.
    // When clicking on a border, the cursor might be over an adjacent cell (e.g.,
    // clicking on the right border of B1 might have cursor over C1). Using the
    // reference bounds ensures we correctly identify which reference is being dragged.
    const { startRow, startCol } = borderHit.reference;

    // Get the actual cell under the cursor for tracking the drag offset
    const cell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);
    const dragStartRow = cell?.row ?? startRow;
    const dragStartCol = cell?.col ?? startCol;

    // Try to start a reference drag - pass a cell that's definitely inside the reference
    if (onStartRefDrag && onStartRefDrag(startRow, startCol)) {
      event.preventDefault();
      setIsRefDragging(true);
      setCursorStyle("move");  // Visual feedback: show move cursor during drag
      // Store the actual cell under cursor for offset calculation during drag
      refDragStartRef.current = { row: dragStartRow, col: dragStartCol };
      lastMousePosRef.current = { x: mouseX, y: mouseY };
      return true;
    }

    return false;
  };

  /**
   * Handle mouse move during reference drag.
   * Updates the reference position preview.
   */
  const handleReferenceDragMove = (
    mouseX: number,
    mouseY: number,
    rect: DOMRect
  ): void => {
    if (!refDragStartRef.current || !onUpdateRefDrag) {
      return;
    }

    lastMousePosRef.current = { x: mouseX, y: mouseY };

    const cell = getCellFromMousePosition(mouseX, mouseY, rect, config, viewport, dimensions);
    if (cell) {
      onUpdateRefDrag(cell.row, cell.col);
    }
  };

  /**
   * Handle mouse up to complete the reference drag.
   */
  const handleReferenceDragMouseUp = (stopAutoScroll: () => void): void => {
    if (!refDragStartRef.current) {
      return;
    }

    // Get the current mouse position to determine final cell
    const rect = containerRef.current?.getBoundingClientRect();
    const mousePos = lastMousePosRef.current;

    if (rect && mousePos && onCompleteRefDrag) {
      const cell = getCellFromMousePosition(mousePos.x, mousePos.y, rect, config, viewport, dimensions);
      if (cell) {
        onCompleteRefDrag(cell.row, cell.col);
      }
    }

    setIsRefDragging(false);
    setCursorStyle("cell");  // Reset cursor after drag completes
    setHoveringOverReferenceBorder(false);  // Clear hover flag after drag ends
    stopAutoScroll();
    refDragStartRef.current = null;
    lastMousePosRef.current = null;
  };

  /**
   * Cancel the reference drag operation.
   */
  const handleReferenceDragCancel = (): void => {
    if (onCancelRefDrag) {
      onCancelRefDrag();
    }
    setIsRefDragging(false);
    setCursorStyle("cell");  // Reset cursor after drag cancels
    setHoveringOverReferenceBorder(false);  // Clear hover flag after drag cancels
    refDragStartRef.current = null;
    lastMousePosRef.current = null;
  };

  return {
    handleReferenceDragMouseDown,
    handleReferenceDragMove,
    handleReferenceDragMouseUp,
    handleReferenceDragCancel,
    isOverReferenceBorder,
  };
}
