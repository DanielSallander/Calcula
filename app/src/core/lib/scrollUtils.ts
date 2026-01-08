// FILENAME: app/src/lib/scrollUtils.ts
// PURPOSE: Utility functions for virtual scrolling calculations.
// CONTEXT: This module provides optimized functions for mapping scrollbar
// positions to row/column indices, calculating visible ranges, handling
// scroll boundaries, and supporting smooth scrolling behavior. These utilities
// are designed for high-performance rendering of large datasets (1M+ rows).
// Phase 3.4 implementation of virtual scrolling logic.

import type { GridConfig, Viewport } from "../types";

/**
 * Scroll direction enumeration for navigation.
 */
export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * Scroll unit for determining scroll amount.
 */
export type ScrollUnit = "cell" | "page" | "document";

/**
 * Result of a scroll position calculation.
 */
export interface ScrollPosition {
  scrollX: number;
  scrollY: number;
  startRow: number;
  startCol: number;
}

/**
 * Visible range of cells in the viewport.
 */
export interface VisibleRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  /** Pixel offset for smooth scrolling (horizontal) */
  offsetX: number;
  /** Pixel offset for smooth scrolling (vertical) */
  offsetY: number;
}

/**
 * Calculate the maximum scroll values based on grid configuration.
 *
 * @param config - Grid configuration
 * @param viewportWidth - Available viewport width in pixels
 * @param viewportHeight - Available viewport height in pixels
 * @returns Maximum scroll X and Y values
 */
export function calculateMaxScroll(
  config: GridConfig,
  viewportWidth: number,
  viewportHeight: number
): { maxScrollX: number; maxScrollY: number } {
  const { totalRows, totalCols, defaultCellWidth, defaultCellHeight, rowHeaderWidth, colHeaderHeight } = config;

  // Total content size
  const totalContentWidth = totalCols * defaultCellWidth;
  const totalContentHeight = totalRows * defaultCellHeight;

  // Available viewport size (minus headers)
  const availableWidth = viewportWidth - rowHeaderWidth;
  const availableHeight = viewportHeight - colHeaderHeight;

  // Maximum scroll is content size minus viewport size
  const maxScrollX = Math.max(0, totalContentWidth - availableWidth);
  const maxScrollY = Math.max(0, totalContentHeight - availableHeight);

  return { maxScrollX, maxScrollY };
}

/**
 * Clamp scroll values to valid bounds.
 *
 * @param scrollX - Desired horizontal scroll
 * @param scrollY - Desired vertical scroll
 * @param config - Grid configuration
 * @param viewportWidth - Viewport width in pixels
 * @param viewportHeight - Viewport height in pixels
 * @returns Clamped scroll position
 */
export function clampScroll(
  scrollX: number,
  scrollY: number,
  config: GridConfig,
  viewportWidth: number,
  viewportHeight: number
): ScrollPosition {
  const { maxScrollX, maxScrollY } = calculateMaxScroll(config, viewportWidth, viewportHeight);
  const { defaultCellWidth, defaultCellHeight } = config;

  const clampedX = Math.max(0, Math.min(scrollX, maxScrollX));
  const clampedY = Math.max(0, Math.min(scrollY, maxScrollY));

  // Calculate starting row/col from scroll position
  const startRow = Math.floor(clampedY / defaultCellHeight);
  const startCol = Math.floor(clampedX / defaultCellWidth);

  return {
    scrollX: clampedX,
    scrollY: clampedY,
    startRow,
    startCol,
  };
}

/**
 * Convert scroll position to visible cell range.
 * This is the core virtual scrolling calculation.
 *
 * @param scrollX - Horizontal scroll offset in pixels
 * @param scrollY - Vertical scroll offset in pixels
 * @param config - Grid configuration
 * @param viewportWidth - Viewport width in pixels
 * @param viewportHeight - Viewport height in pixels
 * @returns Visible range of cells with pixel offsets
 */
export function scrollToVisibleRange(
  scrollX: number,
  scrollY: number,
  config: GridConfig,
  viewportWidth: number,
  viewportHeight: number
): VisibleRange {
  const {
    defaultCellWidth,
    defaultCellHeight,
    rowHeaderWidth,
    colHeaderHeight,
    totalRows,
    totalCols,
  } = config;

  // Calculate starting cell indices
  const startCol = Math.floor(scrollX / defaultCellWidth);
  const startRow = Math.floor(scrollY / defaultCellHeight);

  // Calculate pixel offset for smooth scrolling (sub-cell precision)
  const offsetX = -(scrollX % defaultCellWidth);
  const offsetY = -(scrollY % defaultCellHeight);

  // Calculate available viewport size
  const availableWidth = viewportWidth - rowHeaderWidth;
  const availableHeight = viewportHeight - colHeaderHeight;

  // Calculate how many cells fit in the viewport (add 1 for partial cells)
  const visibleCols = Math.ceil(availableWidth / defaultCellWidth) + 1;
  const visibleRows = Math.ceil(availableHeight / defaultCellHeight) + 1;

  // Calculate end indices (clamped to grid bounds)
  const endCol = Math.min(startCol + visibleCols, totalCols - 1);
  const endRow = Math.min(startRow + visibleRows, totalRows - 1);

  return {
    startRow: Math.max(0, startRow),
    endRow,
    startCol: Math.max(0, startCol),
    endCol,
    offsetX,
    offsetY,
  };
}

/**
 * Convert cell coordinates to scroll position.
 * Used for scrolling to a specific cell.
 *
 * @param row - Target row index
 * @param col - Target column index
 * @param config - Grid configuration
 * @returns Scroll position that shows the cell at the top-left of viewport
 */
export function cellToScroll(row: number, col: number, config: GridConfig): { scrollX: number; scrollY: number } {
  const { defaultCellWidth, defaultCellHeight } = config;

  return {
    scrollX: col * defaultCellWidth,
    scrollY: row * defaultCellHeight,
  };
}

/**
 * Calculate scroll position to center a cell in the viewport.
 *
 * @param row - Target row index
 * @param col - Target column index
 * @param config - Grid configuration
 * @param viewportWidth - Viewport width in pixels
 * @param viewportHeight - Viewport height in pixels
 * @returns Scroll position that centers the cell
 */
export function cellToCenteredScroll(
  row: number,
  col: number,
  config: GridConfig,
  viewportWidth: number,
  viewportHeight: number
): { scrollX: number; scrollY: number } {
  const { defaultCellWidth, defaultCellHeight, rowHeaderWidth, colHeaderHeight } = config;

  // Calculate cell position
  const cellX = col * defaultCellWidth;
  const cellY = row * defaultCellHeight;

  // Calculate viewport center offset
  const availableWidth = viewportWidth - rowHeaderWidth;
  const availableHeight = viewportHeight - colHeaderHeight;

  // Position cell at center of viewport
  const scrollX = cellX - availableWidth / 2 + defaultCellWidth / 2;
  const scrollY = cellY - availableHeight / 2 + defaultCellHeight / 2;

  return { scrollX, scrollY };
}

/**
 * Calculate scroll delta for directional navigation.
 *
 * @param direction - Scroll direction
 * @param unit - Scroll unit (cell, page, or document)
 * @param config - Grid configuration
 * @param viewport - Current viewport state
 * @param viewportWidth - Viewport width in pixels
 * @param viewportHeight - Viewport height in pixels
 * @returns Scroll delta (pixels to scroll)
 */
export function calculateScrollDelta(
  direction: ScrollDirection,
  unit: ScrollUnit,
  config: GridConfig,
  viewport: Viewport,
  viewportWidth: number,
  viewportHeight: number
): { deltaX: number; deltaY: number } {
  const { defaultCellWidth, defaultCellHeight, rowHeaderWidth, colHeaderHeight, totalRows, totalCols } = config;

  // Calculate available viewport size
  const availableWidth = viewportWidth - rowHeaderWidth;
  const availableHeight = viewportHeight - colHeaderHeight;

  let deltaX = 0;
  let deltaY = 0;

  switch (unit) {
    case "cell":
      // Scroll by one cell
      if (direction === "up") deltaY = -defaultCellHeight;
      if (direction === "down") deltaY = defaultCellHeight;
      if (direction === "left") deltaX = -defaultCellWidth;
      if (direction === "right") deltaX = defaultCellWidth;
      break;

    case "page":
      // Scroll by visible page (minus one row/col for context)
      const pageRows = Math.max(1, Math.floor(availableHeight / defaultCellHeight) - 1);
      const pageCols = Math.max(1, Math.floor(availableWidth / defaultCellWidth) - 1);

      if (direction === "up") deltaY = -pageRows * defaultCellHeight;
      if (direction === "down") deltaY = pageRows * defaultCellHeight;
      if (direction === "left") deltaX = -pageCols * defaultCellWidth;
      if (direction === "right") deltaX = pageCols * defaultCellWidth;
      break;

    case "document":
      // Scroll to start or end of document
      if (direction === "up") deltaY = -viewport.scrollY;
      if (direction === "down") deltaY = totalRows * defaultCellHeight - viewport.scrollY;
      if (direction === "left") deltaX = -viewport.scrollX;
      if (direction === "right") deltaX = totalCols * defaultCellWidth - viewport.scrollX;
      break;
  }

  return { deltaX, deltaY };
}

/**
 * Check if a cell is currently visible in the viewport.
 *
 * @param row - Cell row index
 * @param col - Cell column index
 * @param viewport - Current viewport state
 * @param config - Grid configuration
 * @param viewportWidth - Viewport width in pixels
 * @param viewportHeight - Viewport height in pixels
 * @returns True if the cell is visible
 */
export function isCellVisible(
  row: number,
  col: number,
  viewport: Viewport,
  config: GridConfig,
  viewportWidth: number,
  viewportHeight: number
): boolean {
  const range = scrollToVisibleRange(
    viewport.scrollX,
    viewport.scrollY,
    config,
    viewportWidth,
    viewportHeight
  );

  return (
    row >= range.startRow &&
    row <= range.endRow &&
    col >= range.startCol &&
    col <= range.endCol
  );
}

/**
 * Calculate the scroll position needed to make a cell visible.
 * Returns null if the cell is already visible.
 *
 * @param row - Target row index
 * @param col - Target column index
 * @param viewport - Current viewport state
 * @param config - Grid configuration
 * @param viewportWidth - Viewport width in pixels
 * @param viewportHeight - Viewport height in pixels
 * @returns New scroll position or null if already visible
 */
export function scrollToMakeVisible(
  row: number,
  col: number,
  viewport: Viewport,
  config: GridConfig,
  viewportWidth: number,
  viewportHeight: number
): { scrollX: number; scrollY: number } | null {
  const { defaultCellWidth, defaultCellHeight, rowHeaderWidth, colHeaderHeight } = config;

  // Cell position in pixels
  const cellLeft = col * defaultCellWidth;
  const cellTop = row * defaultCellHeight;
  const cellRight = cellLeft + defaultCellWidth;
  const cellBottom = cellTop + defaultCellHeight;

  // Current visible area
  const viewLeft = viewport.scrollX;
  const viewTop = viewport.scrollY;
  const viewRight = viewLeft + viewportWidth - rowHeaderWidth;
  const viewBottom = viewTop + viewportHeight - colHeaderHeight;

  let newScrollX = viewport.scrollX;
  let newScrollY = viewport.scrollY;
  let needsScroll = false;

  // Check horizontal visibility
  if (cellLeft < viewLeft) {
    newScrollX = cellLeft;
    needsScroll = true;
  } else if (cellRight > viewRight) {
    newScrollX = cellRight - (viewportWidth - rowHeaderWidth);
    needsScroll = true;
  }

  // Check vertical visibility
  if (cellTop < viewTop) {
    newScrollY = cellTop;
    needsScroll = true;
  } else if (cellBottom > viewBottom) {
    newScrollY = cellBottom - (viewportHeight - colHeaderHeight);
    needsScroll = true;
  }

  if (!needsScroll) {
    return null;
  }

  // Clamp the scroll position
  const clamped = clampScroll(newScrollX, newScrollY, config, viewportWidth, viewportHeight);
  return { scrollX: clamped.scrollX, scrollY: clamped.scrollY };
}

/**
 * Create a throttled scroll handler for performance optimization.
 * Uses requestAnimationFrame for smooth scrolling.
 *
 * @param callback - Function to call with scroll position
 * @returns Throttled scroll handler
 */
export function createThrottledScrollHandler(
  callback: (scrollX: number, scrollY: number) => void
): (scrollX: number, scrollY: number) => void {
  let rafId: number | null = null;
  let pendingX = 0;
  let pendingY = 0;

  return (scrollX: number, scrollY: number) => {
    pendingX = scrollX;
    pendingY = scrollY;

    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        callback(pendingX, pendingY);
        rafId = null;
      });
    }
  };
}

/**
 * Calculate scrollbar thumb size and position for custom scrollbars.
 *
 * @param config - Grid configuration
 * @param viewport - Current viewport state
 * @param viewportWidth - Viewport width in pixels
 * @param viewportHeight - Viewport height in pixels
 * @returns Scrollbar metrics
 */
export function calculateScrollbarMetrics(
  config: GridConfig,
  viewport: Viewport,
  viewportWidth: number,
  viewportHeight: number
): {
  horizontal: { thumbSize: number; thumbPosition: number; trackSize: number };
  vertical: { thumbSize: number; thumbPosition: number; trackSize: number };
} {
  const { totalRows, totalCols, defaultCellWidth, defaultCellHeight, rowHeaderWidth, colHeaderHeight } = config;

  // Content dimensions
  const contentWidth = totalCols * defaultCellWidth;
  const contentHeight = totalRows * defaultCellHeight;

  // Viewport dimensions (minus headers)
  const viewWidth = viewportWidth - rowHeaderWidth;
  const viewHeight = viewportHeight - colHeaderHeight;

  // Horizontal scrollbar
  const hTrackSize = viewWidth;
  const hThumbSize = Math.max(30, (viewWidth / contentWidth) * hTrackSize);
  const hScrollableRange = contentWidth - viewWidth;
  const hThumbRange = hTrackSize - hThumbSize;
  const hThumbPosition = hScrollableRange > 0 ? (viewport.scrollX / hScrollableRange) * hThumbRange : 0;

  // Vertical scrollbar
  const vTrackSize = viewHeight;
  const vThumbSize = Math.max(30, (viewHeight / contentHeight) * vTrackSize);
  const vScrollableRange = contentHeight - viewHeight;
  const vThumbRange = vTrackSize - vThumbSize;
  const vThumbPosition = vScrollableRange > 0 ? (viewport.scrollY / vScrollableRange) * vThumbRange : 0;

  return {
    horizontal: {
      thumbSize: hThumbSize,
      thumbPosition: hThumbPosition,
      trackSize: hTrackSize,
    },
    vertical: {
      thumbSize: vThumbSize,
      thumbPosition: vThumbPosition,
      trackSize: vTrackSize,
    },
  };
}

/**
 * Convert scrollbar thumb position to scroll offset.
 *
 * @param thumbPosition - Current thumb position in pixels
 * @param thumbSize - Thumb size in pixels
 * @param trackSize - Track size in pixels
 * @param contentSize - Total content size in pixels
 * @param viewportSize - Viewport size in pixels
 * @returns Scroll offset in pixels
 */
export function thumbPositionToScroll(
  thumbPosition: number,
  thumbSize: number,
  trackSize: number,
  contentSize: number,
  viewportSize: number
): number {
  const thumbRange = trackSize - thumbSize;
  const scrollRange = contentSize - viewportSize;

  if (thumbRange <= 0 || scrollRange <= 0) {
    return 0;
  }

  return (thumbPosition / thumbRange) * scrollRange;
}