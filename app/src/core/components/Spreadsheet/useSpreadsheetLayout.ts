//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheetLayout.ts
// PURPOSE: Handles visual layout calculations and status bar text.
// CONTEXT: Purely presentational logic for determining what is visible and what to show in the status bar.

import { useEffect, useCallback } from "react";
import { useViewport } from "../../hooks";
import { useGridState } from "../../state";
import { calculateVisibleRange } from "../../lib/gridRenderer";
import type { GridCanvasHandle } from "../Grid";

type GridState = ReturnType<typeof useGridState>;

interface UseSpreadsheetLayoutProps {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<GridCanvasHandle | null>;
  state: GridState;
  isFocused: boolean;
  getSelectionReference: () => string;
  mouseCursorStyle: string;
  isResizing: boolean;
  isFormulaDragging: boolean;
  isDragging: boolean;
  isFillDragging?: boolean;
}

export function useSpreadsheetLayout({
  scrollRef,
  containerRef,
  canvasRef,
  state,
  isFocused,
  getSelectionReference,
  mouseCursorStyle,
  isResizing,
  isFormulaDragging,
  isDragging,
  isFillDragging = false,
}: UseSpreadsheetLayoutProps) {
  const { viewport, config, selection, dimensions } = state;
  
  const {
    handleScroll,
    getContentSize,
    getVirtualBounds,
  } = useViewport();

  useEffect(() => {
    if (scrollRef.current) {
      const scrollEl = scrollRef.current;
      if (
        Math.abs(scrollEl.scrollLeft - viewport.scrollX) > 1 ||
        Math.abs(scrollEl.scrollTop - viewport.scrollY) > 1
      ) {
        scrollEl.scrollLeft = viewport.scrollX;
        scrollEl.scrollTop = viewport.scrollY;
      }
    }
  }, [viewport.scrollX, viewport.scrollY, scrollRef]);

  const handleScrollEvent = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      handleScroll(event);
      canvasRef.current?.redraw();
    },
    [handleScroll, canvasRef]
  );

  const contentSize = getContentSize();

  const containerWidth = containerRef.current?.clientWidth || 800;
  const containerHeight = containerRef.current?.clientHeight || 600;
  const visibleRange = calculateVisibleRange(viewport, config, containerWidth, containerHeight, dimensions);

  const getSelectionSize = (): string => {
    if (!selection) return "";
    const rows = Math.abs(selection.endRow - selection.startRow) + 1;
    const cols = Math.abs(selection.endCol - selection.startCol) + 1;
    if (rows === 1 && cols === 1) return "";
    return `[${rows}R x ${cols}C]`;
  };

  const statusText = selection
    ? `${getSelectionReference()} ${getSelectionSize()} | Row: ${selection.endRow + 1}, Col: ${selection.endCol + 1}`
    : "Ready";

  const bounds = getVirtualBounds();
  const boundsInfo = `Bounds: ${bounds.maxRow + 1}R x ${bounds.maxCol + 1}C`;
  const scrollInfo = `Visible: R${visibleRange.startRow + 1}-${visibleRange.endRow + 1}, C${visibleRange.startCol + 1}-${visibleRange.endCol + 1}`;

  const getModeStatus = (): string => {
    if (isFillDragging) return "[Fill]";
    if (isResizing) return "[Resizing]";
    if (isFormulaDragging) return "[Selecting Ref]";
    if (isDragging) return "[Selecting]";
    if (state.editing) return "[Editing]";
    if (isFocused) return "[Ready]";
    return "[Click to focus]";
  };

  const gridCursor = isFillDragging 
    ? "crosshair" 
    : isResizing 
      ? mouseCursorStyle 
      : (mouseCursorStyle !== "default" ? mouseCursorStyle : "cell");

  return {
    contentSize,
    handleScrollEvent,
    statusText,
    scrollInfo,
    boundsInfo,
    getModeStatus,
    gridCursor
  };
}