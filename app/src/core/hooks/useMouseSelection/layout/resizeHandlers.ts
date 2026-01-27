//! FILENAME: app/src/core/hooks/useMouseSelection/layout/resizeHandlers.ts
// PURPOSE: Factory function for creating column and row resize handlers.
// CONTEXT: Creates handlers for detecting resize handles on header edges
// and performing drag-to-resize operations for columns and rows.

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import type { ResizeState } from "../types";
import { getColumnResizeHandle, getRowResizeHandle } from "../../../lib/gridRenderer";
import { getCurrentDimensionSize } from "../utils/cellUtils";

interface ResizeDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  onColumnResize?: (col: number, width: number) => void;
  onRowResize?: (row: number, height: number) => void;
  setIsResizing: (value: boolean) => void;
  setCursorStyle: (style: string) => void;
  resizeStateRef: React.MutableRefObject<ResizeState | null>;
}

interface ResizeHandlers {
  checkResizeHandle: (mouseX: number, mouseY: number) => boolean;
  handleResizeMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
  handleResizeMouseMove: (mouseX: number, mouseY: number) => void;
  handleResizeMouseUp: () => void;
  updateCursorForPosition: (mouseX: number, mouseY: number) => void;
}

/**
 * Creates handlers for column and row resize operations.
 * Handles detection of resize handles and drag-to-resize functionality.
 */
export function createResizeHandlers(deps: ResizeDependencies): ResizeHandlers {
  const {
    config,
    viewport,
    dimensions,
    onColumnResize,
    onRowResize,
    setIsResizing,
    setCursorStyle,
    resizeStateRef,
  } = deps;

  /**
   * Check if the mouse is over a resize handle.
   * Returns true if over a column or row resize handle.
   */
  const checkResizeHandle = (mouseX: number, mouseY: number): boolean => {
    const colResize = getColumnResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    const rowResize = getRowResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    return colResize !== null || rowResize !== null;
  };

  /**
   * Handle mouse down on a resize handle.
   * Returns true if a resize operation was started.
   */
  const handleResizeMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ): boolean => {
    // Check for column resize handle
    const colResizeHandle = getColumnResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    if (colResizeHandle !== null && onColumnResize) {
      event.preventDefault();
      setIsResizing(true);
      const currentWidth = getCurrentDimensionSize("column", colResizeHandle, config, dimensions);
      resizeStateRef.current = {
        type: "column",
        index: colResizeHandle,
        startPos: mouseX,
        startSize: currentWidth,
      };
      return true;
    }

    // Check for row resize handle
    const rowResizeHandle = getRowResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    if (rowResizeHandle !== null && onRowResize) {
      event.preventDefault();
      setIsResizing(true);
      const currentHeight = getCurrentDimensionSize("row", rowResizeHandle, config, dimensions);
      resizeStateRef.current = {
        type: "row",
        index: rowResizeHandle,
        startPos: mouseY,
        startSize: currentHeight,
      };
      return true;
    }

    return false;
  };

  /**
   * Handle mouse move during resize operation.
   * Updates the column width or row height based on drag delta.
   */
  const handleResizeMouseMove = (mouseX: number, mouseY: number): void => {
    if (!resizeStateRef.current) {
      return;
    }

    const { type, index, startPos, startSize } = resizeStateRef.current;

    if (type === "column") {
      const delta = mouseX - startPos;
      const newWidth = Math.max(config.minColumnWidth, startSize + delta);
      if (onColumnResize) {
        onColumnResize(index, newWidth);
      }
    } else {
      const delta = mouseY - startPos;
      const newHeight = Math.max(config.minRowHeight, startSize + delta);
      if (onRowResize) {
        onRowResize(index, newHeight);
      }
    }
  };

  /**
   * Handle mouse up to end resize operation.
   */
  const handleResizeMouseUp = (): void => {
    setIsResizing(false);
    resizeStateRef.current = null;
  };

  /**
   * Update cursor style based on mouse position.
   * Shows resize cursors when over resize handles.
   */
  const updateCursorForPosition = (mouseX: number, mouseY: number): void => {
    const colResize = getColumnResizeHandle(mouseX, mouseY, config, viewport, dimensions);
    const rowResize = getRowResizeHandle(mouseX, mouseY, config, viewport, dimensions);

    if (colResize !== null) {
      setCursorStyle("col-resize");
    } else if (rowResize !== null) {
      setCursorStyle("row-resize");
    } else {
      setCursorStyle("default");
    }
  };

  return {
    checkResizeHandle,
    handleResizeMouseDown,
    handleResizeMouseMove,
    handleResizeMouseUp,
    updateCursorForPosition,
  };
}