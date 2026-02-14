//! FILENAME: app/src/core/hooks/useMouseSelection/editing/referenceResizeHandlers.ts
// PURPOSE: Factory function for creating formula reference resize handlers.
// CONTEXT: Creates handlers for resizing existing cell references in a formula
// by dragging corner handles. This allows users to click on a corner handle
// of a highlighted reference and drag it to change the range bounds.

import type { GridConfig, Viewport, DimensionOverrides, FormulaReference } from "../../../types";
import type { ReferenceCorner } from "../../../lib/gridRenderer";
import type { CellPosition, MousePosition } from "../types";
import { getFormulaReferenceCornerAtPixel } from "../../../lib/gridRenderer";
import { getCellFromMousePosition } from "../utils/cellUtils";
import { setHoveringOverReferenceBorder } from "../../../hooks/useEditing";

interface ReferenceResizeDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  containerRef: React.RefObject<HTMLElement | null>;
  formulaReferences: FormulaReference[];
  currentSheetName?: string;
  formulaSourceSheetName?: string;
  onStartRefResize?: (row: number, col: number, corner: ReferenceCorner) => boolean;
  onUpdateRefResize?: (row: number, col: number) => void;
  onCompleteRefResize?: (row: number, col: number) => void;
  onCancelRefResize?: () => void;
  setIsRefResizing: (value: boolean) => void;
  setCursorStyle: (style: string) => void;
  refResizeStartRef: React.MutableRefObject<CellPosition | null>;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
}

interface ReferenceResizeHandlers {
  handleReferenceResizeMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
  handleReferenceResizeMove: (
    mouseX: number,
    mouseY: number,
    rect: DOMRect
  ) => void;
  handleReferenceResizeMouseUp: (
    stopAutoScroll: () => void
  ) => void;
  handleReferenceResizeCancel: () => void;
  /** Check if mouse is over a corner handle and return the hit info */
  getCornerAtPosition: (mouseX: number, mouseY: number) => { corner: ReferenceCorner } | null;
}

/**
 * Get the appropriate CSS cursor for a corner handle.
 */
function getCursorForCorner(corner: ReferenceCorner): string {
  switch (corner) {
    case "topLeft":
    case "bottomRight":
      return "nwse-resize";
    case "topRight":
    case "bottomLeft":
      return "nesw-resize";
  }
}

/**
 * Creates handlers for resizing existing formula references via corner handles.
 * Handles clicking on a corner handle and dragging it to resize the reference range.
 */
export function createReferenceResizeHandlers(deps: ReferenceResizeDependencies): ReferenceResizeHandlers {
  const {
    config,
    viewport,
    dimensions,
    containerRef,
    formulaReferences,
    currentSheetName,
    formulaSourceSheetName,
    onStartRefResize,
    onUpdateRefResize,
    onCompleteRefResize,
    onCancelRefResize,
    setIsRefResizing,
    setCursorStyle,
    refResizeStartRef,
    lastMousePosRef,
  } = deps;

  /**
   * Check if the mouse is over a corner handle.
   * Returns the corner info for cursor display, or null.
   */
  const getCornerAtPosition = (mouseX: number, mouseY: number): { corner: ReferenceCorner } | null => {
    const cornerHit = getFormulaReferenceCornerAtPixel(
      mouseX,
      mouseY,
      config,
      viewport,
      formulaReferences,
      dimensions,
      currentSheetName,
      formulaSourceSheetName
    );
    if (cornerHit) {
      return { corner: cornerHit.corner };
    }
    return null;
  };

  /**
   * Handle mouse down to start a reference resize.
   * Returns true if a resize was started (clicked on corner handle),
   * false otherwise.
   */
  const handleReferenceResizeMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    const cornerHit = getFormulaReferenceCornerAtPixel(
      mouseX,
      mouseY,
      config,
      viewport,
      formulaReferences,
      dimensions,
      currentSheetName,
      formulaSourceSheetName
    );

    if (!cornerHit) {
      return false;
    }

    const { startRow, startCol } = cornerHit.reference;

    if (onStartRefResize && onStartRefResize(startRow, startCol, cornerHit.corner)) {
      event.preventDefault();
      setIsRefResizing(true);
      setCursorStyle(getCursorForCorner(cornerHit.corner));
      refResizeStartRef.current = { row: startRow, col: startCol };
      lastMousePosRef.current = { x: mouseX, y: mouseY };
      return true;
    }

    return false;
  };

  /**
   * Handle mouse move during reference resize.
   * Updates the reference bounds preview.
   */
  const handleReferenceResizeMove = (
    mouseX: number,
    mouseY: number,
    rect: DOMRect
  ): void => {
    if (!refResizeStartRef.current || !onUpdateRefResize) {
      return;
    }

    lastMousePosRef.current = { x: mouseX, y: mouseY };

    const cell = getCellFromMousePosition(mouseX, mouseY, rect, config, viewport, dimensions);
    if (cell) {
      onUpdateRefResize(cell.row, cell.col);
    }
  };

  /**
   * Handle mouse up to complete the reference resize.
   */
  const handleReferenceResizeMouseUp = (stopAutoScroll: () => void): void => {
    if (!refResizeStartRef.current) {
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    const mousePos = lastMousePosRef.current;

    if (rect && mousePos && onCompleteRefResize) {
      const cell = getCellFromMousePosition(mousePos.x, mousePos.y, rect, config, viewport, dimensions);
      if (cell) {
        onCompleteRefResize(cell.row, cell.col);
      }
    }

    setIsRefResizing(false);
    setCursorStyle("cell");
    setHoveringOverReferenceBorder(false);
    stopAutoScroll();
    refResizeStartRef.current = null;
    lastMousePosRef.current = null;
  };

  /**
   * Cancel the reference resize operation.
   */
  const handleReferenceResizeCancel = (): void => {
    if (onCancelRefResize) {
      onCancelRefResize();
    }
    setIsRefResizing(false);
    setCursorStyle("cell");
    setHoveringOverReferenceBorder(false);
    refResizeStartRef.current = null;
    lastMousePosRef.current = null;
  };

  return {
    handleReferenceResizeMouseDown,
    handleReferenceResizeMove,
    handleReferenceResizeMouseUp,
    handleReferenceResizeCancel,
    getCornerAtPosition,
  };
}
