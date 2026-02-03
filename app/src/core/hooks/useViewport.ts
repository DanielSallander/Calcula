//! FILENAME: app/src/core/hooks/useViewport.ts
// PURPOSE: Custom hook for managing viewport calculations and scroll handling.
// CONTEXT: This hook provides viewport management functionality including:
// - Calculating visible rows/columns based on container dimensions
// - Handling scroll events with throttling for performance
// - Ensuring selected cells remain visible (scroll into view)
// - Converting pixel coordinates to cell coordinates
// - Page-based scrolling (Page Up/Down, Ctrl+Home, Ctrl+End)

import React, { useCallback, useEffect, useRef, useMemo } from "react";
import { useGridContext } from "../state/GridContext";
import { updateScroll, setViewportSize, setViewportDimensions, scrollBy, scrollToCell as scrollToCellAction, expandVirtualBounds } from "../state/gridActions";
import type { Selection } from "../types";
import { DEFAULT_VIRTUAL_BOUNDS_CONFIG } from "../types";
import {
  createThrottledScrollHandler,
  scrollToVisibleRange,
  calculateScrollDelta,
  isCellVisible,
} from "../../core/lib/scrollUtils";
import type { ScrollDirection, ScrollUnit, VisibleRange } from "../../core/lib/scrollUtils";

/**
 * Return type for the useViewport hook.
 */
export interface UseViewportReturn {
  /** Reference to attach to the scrollable container */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Handle scroll events from the container */
  handleScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  /** Scroll to make a cell visible */
  scrollToCell: (row: number, col: number, center?: boolean) => void;
  /** Scroll to make the selection visible */
  scrollToSelection: () => void;
  /** Convert pixel coordinates to cell coordinates */
  pixelToCell: (pixelX: number, pixelY: number) => { row: number; col: number };
  /** Convert cell coordinates to pixel position */
  cellToPixel: (row: number, col: number) => { x: number; y: number };
  /** Get the total content size in pixels (using virtual bounds) */
  getContentSize: () => { width: number; height: number };
  /** Update viewport size based on container dimensions */
  updateViewportFromContainer: () => void;
  /** Get the visible cell range */
  getVisibleRange: () => VisibleRange;
  /** Scroll by direction and unit (for keyboard navigation) */
  scrollByUnit: (direction: ScrollDirection, unit: ScrollUnit) => void;
  /** Check if a cell is currently visible */
  isCellInView: (row: number, col: number) => boolean;
  /** Get maximum scroll values (based on virtual bounds) */
  getMaxScroll: () => { maxScrollX: number; maxScrollY: number };
  /** Programmatically set scroll position */
  setScrollPosition: (scrollX: number, scrollY: number) => void;
  /** Get current virtual bounds */
  getVirtualBounds: () => { maxRow: number; maxCol: number };
  /** Register a scroll container element */
  registerScrollContainer: (element: HTMLDivElement | null) => void;
}

/**
 * Hook for managing viewport state and scroll behavior.
 * Implements virtual scrolling for efficient rendering of large grids.
 *
 * @returns Object containing viewport management functions and refs
 */
export function useViewport(): UseViewportReturn {
  const { state, dispatch } = useGridContext();
  const { viewport, config, selection, viewportDimensions, virtualBounds } = state;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  
  // Track if we're programmatically scrolling to avoid feedback loops
  const isProgrammaticScrollRef = useRef(false);
  // Track the last scroll position we set to detect external changes
  const lastProgrammaticScrollRef = useRef({ x: 0, y: 0 });

  /**
   * Register a scroll container element for programmatic scrolling.
   */
  const registerScrollContainer = useCallback((element: HTMLDivElement | null) => {
    scrollContainerRef.current = element;
  }, []);

  /**
   * Get current container dimensions.
   */
  const getContainerDimensions = useCallback((): { width: number; height: number } => {
    if (containerRef.current) {
      return {
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      };
    }
    return { width: viewportDimensions.width, height: viewportDimensions.height };
  }, [viewportDimensions]);

  /**
   * Calculate max scroll for current virtual bounds.
   */
  const calculateMaxScrollForCurrentBounds = useCallback((): { maxScrollX: number; maxScrollY: number } => {
    const dims = getContainerDimensions();
    const contentWidth = (virtualBounds.maxCol + 1) * config.defaultCellWidth;
    const contentHeight = (virtualBounds.maxRow + 1) * config.defaultCellHeight;
    
    const availableWidth = Math.max(1, dims.width - config.rowHeaderWidth);
    const availableHeight = Math.max(1, dims.height - config.colHeaderHeight);
    
    return {
      maxScrollX: Math.max(0, contentWidth - availableWidth),
      maxScrollY: Math.max(0, contentHeight - availableHeight),
    };
  }, [virtualBounds, config, getContainerDimensions]);

  /**
   * Proactively expand bounds if scroll is approaching maximum.
   */
  const checkAndExpandBounds = useCallback((scrollX: number, scrollY: number) => {
    const maxScroll = calculateMaxScrollForCurrentBounds();
    const threshold = DEFAULT_VIRTUAL_BOUNDS_CONFIG.expansionThreshold;
    const cellThresholdY = threshold * config.defaultCellHeight;
    const cellThresholdX = threshold * config.defaultCellWidth;

    let needsExpansion = false;
    let targetRow = virtualBounds.maxRow;
    let targetCol = virtualBounds.maxCol;

    // Check if approaching vertical maximum
    if (maxScroll.maxScrollY > 0 && scrollY >= maxScroll.maxScrollY - cellThresholdY) {
      targetRow = virtualBounds.maxRow + DEFAULT_VIRTUAL_BOUNDS_CONFIG.rowBuffer;
      needsExpansion = true;
    }

    // Check if approaching horizontal maximum
    if (maxScroll.maxScrollX > 0 && scrollX >= maxScroll.maxScrollX - cellThresholdX) {
      targetCol = virtualBounds.maxCol + DEFAULT_VIRTUAL_BOUNDS_CONFIG.colBuffer;
      needsExpansion = true;
    }

    if (needsExpansion) {
      dispatch(expandVirtualBounds(targetRow, targetCol));
    }
  }, [virtualBounds, config, calculateMaxScrollForCurrentBounds, dispatch]);

  /**
   * Throttled scroll update to prevent excessive re-renders.
   */
  /* eslint-disable react-hooks/refs -- Ref is read inside scroll callback, not during render */
  const throttledScrollUpdate = useMemo(
    () =>
      createThrottledScrollHandler((scrollX: number, scrollY: number) => {
        // Skip if this is our own programmatic scroll
        if (isProgrammaticScrollRef.current) {
          return;
        }
        // First check if we need to expand bounds proactively
        checkAndExpandBounds(scrollX, scrollY);
        // Then update the scroll position
        dispatch(updateScroll(scrollX, scrollY));
      }),
    [dispatch, checkAndExpandBounds]
  );
  /* eslint-enable react-hooks/refs */

  /**
   * Handle scroll events from the container element.
   */
  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      // Store reference to scroll container for programmatic scrolling
      scrollContainerRef.current = target;
      throttledScrollUpdate(target.scrollLeft, target.scrollTop);
    },
    [throttledScrollUpdate]
  );

  /**
   * Sync DOM scroll position with state.
   * This effect ensures the DOM scroll container matches the state.
   */
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const stateScrollX = viewport.scrollX;
    const stateScrollY = viewport.scrollY;
    const domScrollX = container.scrollLeft;
    const domScrollY = container.scrollTop;

    // Check if DOM scroll position differs significantly from state
    // Use a threshold to avoid fighting with sub-pixel differences
    const threshold = 1;
    const needsSyncX = Math.abs(domScrollX - stateScrollX) > threshold;
    const needsSyncY = Math.abs(domScrollY - stateScrollY) > threshold;

    if (needsSyncX || needsSyncY) {
      console.log('[VIEWPORT] Syncing DOM scroll to state:', {
        state: { scrollX: stateScrollX, scrollY: stateScrollY },
        dom: { scrollX: domScrollX, scrollY: domScrollY }
      });

      // Set flag to prevent feedback loop
      isProgrammaticScrollRef.current = true;
      lastProgrammaticScrollRef.current = { x: stateScrollX, y: stateScrollY };

      container.scrollLeft = stateScrollX;
      container.scrollTop = stateScrollY;

      // Clear the flag after the scroll event would have fired
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
      });
    }
  }, [viewport.scrollX, viewport.scrollY]);

  /**
   * Convert pixel coordinates (relative to content) to cell coordinates.
   */
  const pixelToCell = useCallback(
    (pixelX: number, pixelY: number): { row: number; col: number } => {
      const col = Math.floor(pixelX / config.defaultCellWidth);
      const row = Math.floor(pixelY / config.defaultCellHeight);

      return {
        row: Math.max(0, Math.min(row, config.totalRows - 1)),
        col: Math.max(0, Math.min(col, config.totalCols - 1)),
      };
    },
    [config]
  );

  /**
   * Convert cell coordinates to pixel position (top-left corner of cell).
   */
  const cellToPixel = useCallback(
    (row: number, col: number): { x: number; y: number } => {
      return {
        x: col * config.defaultCellWidth,
        y: row * config.defaultCellHeight,
      };
    },
    [config]
  );

  /**
   * Get the total content size in pixels.
   * Uses virtual bounds for dynamic scrollbar behavior.
   */
  const getContentSize = useCallback((): { width: number; height: number } => {
    // Use virtual bounds instead of full grid size
    return {
      width: (virtualBounds.maxCol + 1) * config.defaultCellWidth,
      height: (virtualBounds.maxRow + 1) * config.defaultCellHeight,
    };
  }, [config, virtualBounds]);

  /**
   * Get the visible cell range based on current scroll position.
   */
  const getVisibleRange = useCallback((): VisibleRange => {
    const dims = getContainerDimensions();
    return scrollToVisibleRange(viewport.scrollX, viewport.scrollY, config, dims.width, dims.height);
  }, [viewport.scrollX, viewport.scrollY, config, getContainerDimensions]);

  /**
   * Get maximum scroll values based on virtual bounds.
   */
  const getMaxScroll = useCallback((): { maxScrollX: number; maxScrollY: number } => {
    return calculateMaxScrollForCurrentBounds();
  }, [calculateMaxScrollForCurrentBounds]);

  /**
   * Check if a cell is currently visible.
   */
  const isCellInView = useCallback(
    (row: number, col: number): boolean => {
      const dims = getContainerDimensions();
      return isCellVisible(row, col, viewport, config, dims.width, dims.height);
    },
    [viewport, config, getContainerDimensions]
  );

  /**
   * Programmatically set scroll position.
   */
  const setScrollPosition = useCallback(
    (scrollX: number, scrollY: number) => {
      // Update state first
      dispatch(updateScroll(scrollX, scrollY));
      
      // DOM will be synced by the effect
    },
    [dispatch]
  );

  /**
   * Scroll to make a specific cell visible.
   */
  const scrollToCell = useCallback(
    (row: number, col: number, center: boolean = false) => {
      console.log('[VIEWPORT] scrollToCell called:', { row, col, center });
      dispatch(scrollToCellAction(row, col, center));
      // DOM scroll position will be synced by the useEffect
    },
    [dispatch]
  );

  /**
   * Scroll to make the current selection visible.
   */
  const scrollToSelection = useCallback(() => {
    if (!selection) {
      return;
    }

    console.log('[VIEWPORT] scrollToSelection called:', { 
      endRow: selection.endRow, 
      endCol: selection.endCol 
    });

    // Scroll to the active cell (end of selection)
    scrollToCell(selection.endRow, selection.endCol, false);
  }, [selection, scrollToCell]);

  /**
   * Scroll by direction and unit (for keyboard navigation).
   */
  const scrollByUnit = useCallback(
    (direction: ScrollDirection, unit: ScrollUnit) => {
      const dims = getContainerDimensions();
      const delta = calculateScrollDelta(direction, unit, config, viewport, dims.width, dims.height);
      dispatch(scrollBy(delta.deltaX, delta.deltaY));
      // DOM scroll position will be synced by the useEffect
    },
    [config, viewport, dispatch, getContainerDimensions]
  );

  /**
   * Update viewport size based on container dimensions.
   */
  const updateViewportFromContainer = useCallback(() => {
    if (!containerRef.current) {
      return;
    }

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Update pixel dimensions for scroll calculations
    dispatch(setViewportDimensions(width, height));

    const availableWidth = width - config.rowHeaderWidth;
    const availableHeight = height - config.colHeaderHeight;

    const colCount = Math.ceil(availableWidth / config.defaultCellWidth) + 1;
    const rowCount = Math.ceil(availableHeight / config.defaultCellHeight) + 1;

    dispatch(setViewportSize(rowCount, colCount));
  }, [config, dispatch]);

  /**
   * Get current virtual bounds.
   */
  const getVirtualBounds = useCallback(() => {
    return { ...virtualBounds };
  }, [virtualBounds]);

  /**
   * Update viewport size when container resizes.
   */
  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const container = containerRef.current;

    // Initial size calculation
    updateViewportFromContainer();

    // Set up ResizeObserver for container size changes
    const resizeObserver = new ResizeObserver(() => {
      updateViewportFromContainer();
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [updateViewportFromContainer]);

  return {
    containerRef,
    handleScroll,
    scrollToCell,
    scrollToSelection,
    pixelToCell,
    cellToPixel,
    getContentSize,
    updateViewportFromContainer,
    getVisibleRange,
    scrollByUnit,
    isCellInView,
    getMaxScroll,
    setScrollPosition,
    getVirtualBounds,
    registerScrollContainer,
  };
}

/**
 * Calculate the normalized selection bounds (ensuring start <= end).
 *
 * @param selection - The selection to normalize
 * @returns Object with minRow, maxRow, minCol, maxCol
 */
export function normalizeSelection(selection: Selection): {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
} {
  return {
    minRow: Math.min(selection.startRow, selection.endRow),
    maxRow: Math.max(selection.startRow, selection.endRow),
    minCol: Math.min(selection.startCol, selection.endCol),
    maxCol: Math.max(selection.startCol, selection.endCol),
  };
}

/**
 * Check if a cell is within the selection bounds.
 *
 * @param row - Cell row
 * @param col - Cell column
 * @param selection - The selection to check against
 * @returns True if the cell is selected
 */
export function isCellSelected(row: number, col: number, selection: Selection | null): boolean {
  if (!selection) {
    return false;
  }

  const { minRow, maxRow, minCol, maxCol } = normalizeSelection(selection);
  return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
}

/**
 * Check if a cell is the active cell (end of selection).
 *
 * @param row - Cell row
 * @param col - Cell column
 * @param selection - The selection to check against
 * @returns True if the cell is the active cell
 */
export function isActiveCell(row: number, col: number, selection: Selection | null): boolean {
  if (!selection) {
    return false;
  }

  return row === selection.endRow && col === selection.endCol;
}