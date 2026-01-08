//FILENAME: app/src/lib/gridRenderer/interaction/hitTesting.ts
//PURPOSE: Pixel coordinate to cell coordinate conversion and resize handle detection
//CONTEXT: Handles mouse interaction with grid cells, headers, and resize handles

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import { ensureDimensions } from "../styles/styleUtils";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { calculateVisibleRange } from "../layout/viewport";

/**
 * Options for getCellFromPixel behavior.
 */
export interface GetCellOptions {
  /**
   * When true, uses midpoint threshold for cell detection.
   * A cell is only "selected" when the cursor passes its center point.
   * This provides better UX for drag-to-select operations.
   */
  useMidpointThreshold?: boolean;
}

/**
 * Get cell coordinates from pixel position.
 * Returns null if click is on headers.
 * 
 * @param pixelX - X coordinate in pixels relative to container
 * @param pixelY - Y coordinate in pixels relative to container
 * @param config - Grid configuration
 * @param viewport - Current viewport state
 * @param dimensions - Optional dimension overrides
 * @param options - Optional behavior options (e.g., midpoint threshold for drag)
 */
export function getCellFromPixel(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides,
  options?: GetCellOptions
): { row: number; col: number } | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;
  const useMidpoint = options?.useMidpointThreshold ?? false;

  // Check if click is on headers
  if (pixelX < rowHeaderWidth || pixelY < colHeaderHeight) {
    return null;
  }
  const dims = ensureDimensions(dimensions);
  const scrollX = viewport.scrollX || 0;
  const scrollY = viewport.scrollY || 0;

  // Calculate column from X position
  const contentX = pixelX - rowHeaderWidth + scrollX;
  let col = 0;
  let accumulatedWidth = 0;
  
  while (col < totalCols) {
    const colWidth = getColumnWidth(col, config, dims);
    if (colWidth <= 0) break;
    
    const cellEnd = accumulatedWidth + colWidth;
    
    if (useMidpoint) {
      // Midpoint mode: cell is selected only when cursor passes its center
      // This provides "snapping" behavior for drag selection
      const cellCenter = accumulatedWidth + colWidth / 2;
      if (contentX < cellCenter) {
        // Cursor is before this cell's center - return previous cell
        if (col > 0) col--;
        break;
      }
      if (contentX < cellEnd) {
        // Cursor is past center but still in cell - return this cell
        break;
      }
    } else {
      // Standard mode: cell is selected when cursor is anywhere within it
      if (cellEnd > contentX) {
        break;
      }
    }
    
    accumulatedWidth += colWidth;
    col++;
  }
  
  // Calculate row from Y position
  const contentY = pixelY - colHeaderHeight + scrollY;
  let row = 0;
  let accumulatedHeight = 0;
  
  while (row < totalRows) {
    const rowHeight = getRowHeight(row, config, dims);
    if (rowHeight <= 0) break;
    
    const cellEnd = accumulatedHeight + rowHeight;
    
    if (useMidpoint) {
      // Midpoint mode for rows
      const cellCenter = accumulatedHeight + rowHeight / 2;
      if (contentY < cellCenter) {
        if (row > 0) row--;
        break;
      }
      if (contentY < cellEnd) {
        break;
      }
    } else {
      // Standard mode
      if (cellEnd > contentY) {
        break;
      }
    }
    
    accumulatedHeight += rowHeight;
    row++;
  }
  
  // Clamp to valid range
  if (row < 0 || row >= totalRows || col < 0 || col >= totalCols) {
    return null;
  }
  return { row, col };
}

/**
 * Check if a pixel position is on a column resize handle.
 * Returns the column index if on a resize handle, null otherwise.
 */
export function getColumnResizeHandle(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides
): number | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalCols = config.totalCols || 100;
  const handleWidth = 6; // Width of resize handle zone

  // Must be in the header area
  if (pixelY >= colHeaderHeight) {
    return null;
  }
  // Must be past the row header
  if (pixelX < rowHeaderWidth) {
    return null;
  }
  const dims = ensureDimensions(dimensions);
  // Find the column edge closest to the click
  const range = calculateVisibleRange(viewport, config, pixelX + handleWidth, colHeaderHeight, dims);
  let x = rowHeaderWidth + range.offsetX;
  for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
    const colWidth = getColumnWidth(col, config, dims);
    x += colWidth;
    // Check if click is near the right edge of this column
    if (Math.abs(pixelX - x) <= handleWidth / 2) {
      return col;
    }
  }
  return null;
}

/**
 * Check if a pixel position is on a row resize handle.
 * Returns the row index if on a resize handle, null otherwise.
 */
export function getRowResizeHandle(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides
): number | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const handleHeight = 6; // Height of resize handle zone

  // Must be in the header area
  if (pixelX >= rowHeaderWidth) {
    return null;
  }
  // Must be past the column header
  if (pixelY < colHeaderHeight) {
    return null;
  }
  const dims = ensureDimensions(dimensions);
  // Find the row edge closest to the click
  const range = calculateVisibleRange(viewport, config, rowHeaderWidth, pixelY + handleHeight, dims);
  let y = colHeaderHeight + range.offsetY;
  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = getRowHeight(row, config, dims);
    y += rowHeight;
    // Check if click is near the bottom edge of this row
    if (Math.abs(pixelY - y) <= handleHeight / 2) {
      return row;
    }
  }
  return null;
}

/**
 * Get the column index from a click in the column header area.
 * Returns null if not in the column header area.
 */
export function getColumnFromHeader(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides
): number | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalCols = config.totalCols || 100;

  // Must be in the column header area
  if (pixelY >= colHeaderHeight || pixelX < rowHeaderWidth) {
    return null;
  }
  const dims = ensureDimensions(dimensions);
  const scrollX = viewport.scrollX || 0;

  // Calculate column from X position
  const contentX = pixelX - rowHeaderWidth + scrollX;
  let col = 0;
  let accumulatedWidth = 0;
  while (col < totalCols) {
    const colWidth = getColumnWidth(col, config, dims);
    if (colWidth <= 0) break;
    if (accumulatedWidth + colWidth > contentX) {
      return col;
    }
    accumulatedWidth += colWidth;
    col++;
  }
  return null;
}

/**
 * Get the row index from a click in the row header area.
 * Returns null if not in the row header area.
 */
export function getRowFromHeader(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides
): number | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;

  // Must be in the row header area
  if (pixelX >= rowHeaderWidth || pixelY < colHeaderHeight) {
    return null;
  }
  const dims = ensureDimensions(dimensions);
  const scrollY = viewport.scrollY || 0;

  // Calculate row from Y position
  const contentY = pixelY - colHeaderHeight + scrollY;
  let row = 0;
  let accumulatedHeight = 0;
  while (row < totalRows) {
    const rowHeight = getRowHeight(row, config, dims);
    if (rowHeight <= 0) break;
    if (accumulatedHeight + rowHeight > contentY) {
      return row;
    }
    accumulatedHeight += rowHeight;
    row++;
  }
  return null;
}