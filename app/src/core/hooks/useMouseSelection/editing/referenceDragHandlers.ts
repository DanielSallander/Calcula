//! FILENAME: app/src/core/hooks/useMouseSelection/editing/referenceDragHandlers.ts
// PURPOSE: Factory function for creating formula reference drag handlers.
// CONTEXT: Creates handlers for dragging existing cell references in a formula
// to move them to a new location. This allows users to click on a highlighted
// reference and drag it to change the cell/range it refers to.

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import type { CellPosition, MousePosition } from "../types";
import { getCellFromPixel } from "../../../lib/gridRenderer";
import { getCellFromMousePosition } from "../utils/cellUtils";

interface ReferenceDragDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  containerRef: React.RefObject<HTMLElement | null>;
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
   * Handle mouse down to start a reference drag.
   * Returns true if a drag was started (clicked on an existing reference),
   * false otherwise (clicked somewhere else, should be handled by other handlers).
   */
  const handleReferenceDragMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    const cell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);

    if (!cell) {
      return false;
    }

    const { row, col } = cell;

    // Try to start a reference drag - this returns true if the cell is part
    // of an existing reference in the formula
    if (onStartRefDrag && onStartRefDrag(row, col)) {
      event.preventDefault();
      setIsRefDragging(true);
      setCursorStyle("move");  // Visual feedback: show move cursor during drag
      refDragStartRef.current = { row, col };
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
    refDragStartRef.current = null;
    lastMousePosRef.current = null;
  };

  return {
    handleReferenceDragMouseDown,
    handleReferenceDragMove,
    handleReferenceDragMouseUp,
    handleReferenceDragCancel,
  };
}
