//! FILENAME: app/src/core/hooks/useMouseSelection/selection/useAutoScroll.ts
// PURPOSE: Hook for managing auto-scroll behavior during drag operations.
// CONTEXT: Provides auto-scroll functionality when the user drags near
// the edges of the viewport, enabling selection of cells outside the
// current visible area.

import { useCallback, useRef } from "react";
import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import type { MousePosition, CellPosition } from "../types";
import { DEFAULT_AUTO_SCROLL_CONFIG } from "../constants";
import { calculateAutoScrollDelta } from "../utils/autoScrollUtils";
import { getCellFromMousePosition } from "../utils/cellUtils";

interface UseAutoScrollProps {
  containerRef: React.RefObject<HTMLElement | null>;
  scrollRef: React.RefObject<HTMLElement | null>;
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
  isDragging: boolean;
  isFormulaDragging: boolean;
  formulaDragStartRef: React.MutableRefObject<CellPosition | null>;
  dragStartRef: React.MutableRefObject<CellPosition | null>;
  onScroll: (scrollX: number, scrollY: number) => void;
  onExtendTo: (row: number, col: number) => void;
  onUpdatePendingReference?: (startRow: number, startCol: number, endRow: number, endCol: number) => void;
}

interface UseAutoScrollReturn {
  startAutoScroll: () => void;
  stopAutoScroll: () => void;
}

/**
 * Hook for managing auto-scroll during drag selection operations.
 * Provides smooth scrolling when the mouse approaches viewport edges.
 */
export function useAutoScroll(props: UseAutoScrollProps): UseAutoScrollReturn {
  const {
    containerRef,
    scrollRef,
    config,
    viewport,
    dimensions,
    lastMousePosRef,
    isDragging,
    isFormulaDragging,
    formulaDragStartRef,
    dragStartRef,
    onScroll,
    onExtendTo,
    onUpdatePendingReference,
  } = props;

  const autoScrollRef = useRef<number | null>(null);

  /**
   * Auto-scroll loop that runs during drag selection.
   */
  const runAutoScroll = useCallback(() => {
    if ((!isDragging && !isFormulaDragging) || !lastMousePosRef.current || !containerRef.current || !scrollRef.current) {
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();
    const { x: mouseX, y: mouseY } = lastMousePosRef.current;

    // Calculate scroll delta
    const { deltaX, deltaY } = calculateAutoScrollDelta(mouseX, mouseY, rect, config);

    if (deltaX !== 0 || deltaY !== 0) {
      // Calculate new scroll position
      const scrollEl = scrollRef.current;
      const newScrollX = Math.max(0, scrollEl.scrollLeft + deltaX);
      const newScrollY = Math.max(0, scrollEl.scrollTop + deltaY);

      // Apply scroll
      scrollEl.scrollLeft = newScrollX;
      scrollEl.scrollTop = newScrollY;
      onScroll(newScrollX, newScrollY);

      // Update selection/reference to cell under mouse (with new scroll position)
      if (isFormulaDragging && formulaDragStartRef.current && onUpdatePendingReference) {
        const cell = getCellFromMousePosition(mouseX, mouseY, rect, config, viewport, dimensions);
        if (cell) {
          onUpdatePendingReference(
            formulaDragStartRef.current.row,
            formulaDragStartRef.current.col,
            cell.row,
            cell.col
          );
        }
      } else if (isDragging && dragStartRef.current) {
        // Use direction-aware 50% threshold during auto-scroll
        const cell = getCellFromMousePosition(
          mouseX, 
          mouseY, 
          rect, 
          config, 
          viewport, 
          dimensions,
          {
            dragStartRow: dragStartRef.current.row,
            dragStartCol: dragStartRef.current.col,
          }
        );
        if (cell) {
          onExtendTo(cell.row, cell.col);
        }
      }
    }

    // Schedule next frame
    // eslint-disable-next-line react-hooks/immutability -- Self-scheduling timer pattern requires self-reference
    autoScrollRef.current = window.setTimeout(runAutoScroll, DEFAULT_AUTO_SCROLL_CONFIG.intervalMs);
  }, [isDragging, isFormulaDragging, containerRef, scrollRef, config, viewport, dimensions, lastMousePosRef, formulaDragStartRef, dragStartRef, onScroll, onExtendTo, onUpdatePendingReference]);

  /**
   * Start auto-scroll loop.
   */
  const startAutoScroll = useCallback(() => {
    if (autoScrollRef.current === null) {
      runAutoScroll();
    }
  }, [runAutoScroll]);

  /**
   * Stop auto-scroll loop.
   */
  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) {
      clearTimeout(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  }, []);

  return {
    startAutoScroll,
    stopAutoScroll,
  };
}