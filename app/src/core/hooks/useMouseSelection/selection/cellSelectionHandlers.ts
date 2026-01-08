// FILENAME: app/src/hooks/useMouseSelection/selection/cellSelectionHandlers.ts
// PURPOSE: Factory function for creating cell selection event handlers.
// CONTEXT: Creates handlers for mouse down on cells, supporting single
// click selection and shift-click to extend selection ranges.

import type { GridConfig, Viewport, Selection, DimensionOverrides } from "../../../types";
import type { CellPosition, MousePosition, HeaderDragState } from "../types";
import { getCellFromPixel } from "../../../lib/gridRenderer";

interface CellSelectionDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  selection: Selection | null;
  onSelectCell: (row: number, col: number) => void;
  onExtendTo: (row: number, col: number) => void;
  onCommitBeforeSelect?: () => Promise<void>;
  setIsDragging: (value: boolean) => void;
  dragStartRef: React.MutableRefObject<CellPosition | null>;
  headerDragRef: React.MutableRefObject<HeaderDragState | null>;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
}

interface CellSelectionHandlers {
  handleCellMouseDown: (
    mouseX: number,
    mouseY: number,
    shiftKey: boolean,
    event: React.MouseEvent<HTMLElement>
  ) => Promise<boolean>;
}

/**
 * Creates handlers for cell selection operations.
 * Handles regular clicks and shift-clicks for range selection.
 */
export function createCellSelectionHandlers(deps: CellSelectionDependencies): CellSelectionHandlers {
  const {
    config,
    viewport,
    dimensions,
    selection,
    onSelectCell,
    onExtendTo,
    onCommitBeforeSelect,
    setIsDragging,
    dragStartRef,
    headerDragRef,
    lastMousePosRef,
  } = deps;

  /**
   * Handle mouse down on a cell.
   * Returns true if the event was handled, false otherwise.
   */
  const handleCellMouseDown = async (
    mouseX: number,
    mouseY: number,
    shiftKey: boolean,
    event: React.MouseEvent<HTMLElement>
  ): Promise<boolean> => {
    const cell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);

    if (!cell) {
      // Clicked on header corner or outside grid
      return false;
    }

    const { row, col } = cell;

    // If we're editing, commit first
    if (onCommitBeforeSelect) {
      await onCommitBeforeSelect();
    }

    if (shiftKey && selection) {
      // Shift-click extends selection
      onExtendTo(row, col);
    } else {
      // Regular click starts new selection
      onSelectCell(row, col);
    }

    // Start drag
    setIsDragging(true);
    dragStartRef.current = { row, col };
    headerDragRef.current = null;
    lastMousePosRef.current = { x: mouseX, y: mouseY };

    event.preventDefault();
    return true;
  };

  return {
    handleCellMouseDown,
  };
}