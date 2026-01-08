// FILENAME: core/components/Scrollbar/useScrollbarMetrics.ts
// PURPOSE: Hook to calculate scrollbar metrics based on used range
// CONTEXT: Combines backend used range with current viewport for proportional scrollbars
// UPDATED: Excel-like behavior - thumb contracts when scrolling back within used range

import { useState, useEffect, useCallback } from "react";
import { getGridBounds } from "../../lib/tauri-api";
import type { GridConfig, Viewport, ViewportDimensions } from "../../types";

export interface ScrollbarMetrics {
  /** Total scrollable content width in pixels */
  contentWidth: number;
  /** Total scrollable content height in pixels */
  contentHeight: number;
  /** Maximum horizontal scroll position */
  maxScrollX: number;
  /** Maximum vertical scroll position */
  maxScrollY: number;
  /** Whether horizontal scrollbar should be visible */
  showHorizontal: boolean;
  /** Whether vertical scrollbar should be visible */
  showVertical: boolean;
  /** Refresh the used range from backend */
  refresh: () => void;
}

export interface UseScrollbarMetricsOptions {
  config: GridConfig;
  viewport: Viewport;
  viewportDimensions: ViewportDimensions;
  /** How often to refresh used range from backend (ms) */
  refreshInterval?: number;
}

const SCROLLBAR_SIZE = 14;
// Buffer rows/cols beyond the used range (Excel-like behavior)
const BUFFER_ROWS = 1;
const BUFFER_COLS = 1;

/**
 * Hook to calculate scrollbar metrics based on the used range.
 * Excel-like behavior: thumb size reflects used range, contracts when scrolling back.
 */
export function useScrollbarMetrics({
  config,
  viewport,
  viewportDimensions,
  refreshInterval = 2000,
}: UseScrollbarMetricsOptions): ScrollbarMetrics {
  const [usedRange, setUsedRange] = useState<{ maxRow: number; maxCol: number }>({
    maxRow: 0,
    maxCol: 0,
  });

  // Fetch used range from backend
  const refreshUsedRange = useCallback(async () => {
    try {
      const bounds = await getGridBounds();
      if (bounds) {
        // getGridBounds returns [rows, cols] as the count of used cells
        // Convert to 0-based max indices
        setUsedRange({
          maxRow: Math.max(0, bounds[0] - 1),
          maxCol: Math.max(0, bounds[1] - 1),
        });
      }
    } catch (error) {
      // Silently handle errors - grid bounds might not be available yet
      console.debug("[Scrollbar] Failed to get grid bounds:", error);
    }
  }, []);

  // Initial fetch and periodic refresh
  useEffect(() => {
    refreshUsedRange();

    // Set up periodic refresh
    const interval = setInterval(() => {
      refreshUsedRange();
    }, refreshInterval);

    return () => {
      clearInterval(interval);
    };
  }, [refreshUsedRange, refreshInterval]);

  // Available viewport size (minus headers and scrollbar space)
  const availableWidth = Math.max(
    1,
    viewportDimensions.width - config.rowHeaderWidth - SCROLLBAR_SIZE
  );
  const availableHeight = Math.max(
    1,
    viewportDimensions.height - config.colHeaderHeight - SCROLLBAR_SIZE
  );

  // Calculate how many rows/cols fit in the viewport
  const viewportRows = Math.ceil(availableHeight / config.defaultCellHeight);
  const viewportCols = Math.ceil(availableWidth / config.defaultCellWidth);

  // Current scroll position in row/col units
  const currentScrollRow = Math.floor(viewport.scrollY / config.defaultCellHeight);
  const currentScrollCol = Math.floor(viewport.scrollX / config.defaultCellWidth);

  // Excel-like effective bounds calculation:
  // - Base: the actual used range from backend data
  // - Expand temporarily if user scrolls past the used range
  // - Contract back when user scrolls back within used range
  // 
  // The key insight: we DON'T use virtualBounds which is sticky.
  // Instead, we dynamically compute based on:
  // 1. Used range (data extent)
  // 2. Current scroll position + viewport (where user is looking)
  
  // Minimum content extent = what's needed to show current viewport
  const viewportExtentRow = currentScrollRow + viewportRows;
  const viewportExtentCol = currentScrollCol + viewportCols;

  // Effective extent = max of used range and viewport extent
  // This means:
  // - If used range is large, thumb stays small
  // - If used range is small but we scrolled far, thumb stays small while there
  // - If used range is small and we're viewing it, thumb is large
  const effectiveMaxRow = Math.max(usedRange.maxRow, viewportExtentRow - 1);
  const effectiveMaxCol = Math.max(usedRange.maxCol, viewportExtentCol - 1);

  // Add small buffer for breathing room (Excel adds ~1 row/col beyond used range)
  const boundedMaxRow = Math.min(effectiveMaxRow + BUFFER_ROWS, config.totalRows - 1);
  const boundedMaxCol = Math.min(effectiveMaxCol + BUFFER_COLS, config.totalCols - 1);

  // Calculate content size in pixels
  // +1 because maxRow is 0-indexed, so row 0 means 1 row of content
  const contentWidth = (boundedMaxCol + 1) * config.defaultCellWidth;
  const contentHeight = (boundedMaxRow + 1) * config.defaultCellHeight;

  // Maximum scroll positions
  const maxScrollX = Math.max(0, contentWidth - availableWidth);
  const maxScrollY = Math.max(0, contentHeight - availableHeight);

  return {
    contentWidth,
    contentHeight,
    maxScrollX,
    maxScrollY,
    showHorizontal: maxScrollX > 0,
    showVertical: maxScrollY > 0,
    refresh: refreshUsedRange,
  };
}