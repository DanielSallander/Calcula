// FILENAME: core/components/Scrollbar/useScrollbarMetrics.ts
// PURPOSE: Hook to calculate scrollbar metrics based on used range
// CONTEXT: Combines backend used range with current viewport for proportional scrollbars
// UPDATED: Excel-like behavior - thumb contracts when scrolling back within used range

import { useState, useEffect, useCallback } from "react";
// Assuming this is the correct path for your API
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
const BUFFER_ROWS = 5;
const BUFFER_COLS = 2;

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
      if (bounds && Array.isArray(bounds) && bounds.length === 2) {
        // getGridBounds returns [rowCount, colCount]
        // Convert to 0-based max indices
        setUsedRange({
          maxRow: Math.max(0, bounds[0] - 1),
          maxCol: Math.max(0, bounds[1] - 1),
        });
      }
    } catch (error) {
      // Silently handle errors - grid bounds might not be available yet
      // console.debug("[Scrollbar] Failed to get grid bounds:", error);
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

  // Guard: If viewportDimensions not yet initialized, return safe defaults
  // This prevents NaN calculations when width/height are 0
  if (viewportDimensions.width <= 0 || viewportDimensions.height <= 0) {
    return {
      contentWidth: 1,
      contentHeight: 1,
      maxScrollX: 0,
      maxScrollY: 0,
      showHorizontal: false,
      showVertical: false,
      refresh: refreshUsedRange,
    };
  }

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

  // EXCEL-LIKE THUMB SIZING:
  // The key insight: content size should be based on the USED RANGE (+ buffer),
  // but must also be large enough to contain the current scroll position.
  //
  // When used range is small --> content size is small --> thumb is LARGE
  // When used range is large --> content size is large --> thumb is SMALL

  // Step 1: Calculate content bounds based purely on used range + small buffer
  // This is what determines the thumb size ratio
  const usedBasedMaxRow = usedRange.maxRow + BUFFER_ROWS;
  const usedBasedMaxCol = usedRange.maxCol + BUFFER_COLS;

  // Step 2: Ensure we can display the current viewport (don't clip the view)
  const viewportExtentRow = currentScrollRow + viewportRows;
  const viewportExtentCol = currentScrollCol + viewportCols;

  // Step 3: Final effective bounds = max of used range and current view extent
  // This ensures scrolling past the used range works, but thumb reflects data size
  const effectiveMaxRow = Math.max(usedBasedMaxRow, viewportExtentRow);
  const effectiveMaxCol = Math.max(usedBasedMaxCol, viewportExtentCol);

  // Clamp to grid limits
  const boundedMaxRow = Math.min(effectiveMaxRow, config.totalRows - 1);
  const boundedMaxCol = Math.min(effectiveMaxCol, config.totalCols - 1);

  // Calculate content size in pixels
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