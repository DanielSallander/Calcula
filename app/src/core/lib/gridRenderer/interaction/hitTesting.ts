//FILENAME: app/src/lib/gridRenderer/interaction/hitTesting.ts
//PURPOSE: Pixel coordinate to cell coordinate conversion and resize handle detection
//CONTEXT: Handles mouse interaction with grid cells, headers, and resize handles

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import { ensureDimensions } from "../styles/styleUtils";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { calculateVisibleRange } from "../layout/viewport";

// =============================================================================
// SELECTION THRESHOLDS
// =============================================================================
// "Fixated" values for the application's selection feel.
// X = 0.0: Instant selection (cell selects as soon as cursor touches it)
// Y = 1.2: Delayed selection (requires dragging significantly past the border)
const SELECTION_THRESHOLD_X = 0.0;
const SELECTION_THRESHOLD_Y = 1.2;

/**
 * Options for getCellFromPixel behavior.
 */
export interface GetCellOptions {
  /**
   * The starting row of the drag operation.
   * Required for relative threshold calculation.
   */
  dragStartRow?: number;
  
  /**
   * The starting column of the drag operation.
   * Required for relative threshold calculation.
   */
  dragStartCol?: number;
}

/**
 * Get cell coordinates from pixel position.
 * Returns null if click is on headers.
 * * @param pixelX - X coordinate in pixels relative to container
 * @param pixelY - Y coordinate in pixels relative to container
 * @param config - Grid configuration
 * @param viewport - Current viewport state
 * @param dimensions - Optional dimension overrides
 * @param options - Optional behavior options
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
  
  const dragStartRow = options?.dragStartRow;
  const dragStartCol = options?.dragStartCol;
  
  // Check if click is on headers
  if (pixelX < rowHeaderWidth || pixelY < colHeaderHeight) {
    return null;
  }
  
  const dims = ensureDimensions(dimensions);
  const scrollX = viewport.scrollX || 0;
  const scrollY = viewport.scrollY || 0;

  // Calculate content position (relative to grid data area, accounting for scroll)
  const contentX = pixelX - rowHeaderWidth + scrollX;
  const contentY = pixelY - colHeaderHeight + scrollY;

  // =========================================================================
  // COLUMN CALCULATION
  // =========================================================================
  
  let col = 0;
  let accumulatedWidth = 0;
  let currentColWidth = 0;
  
  // 1. Find the physical column under the cursor
  while (col < totalCols) {
    currentColWidth = getColumnWidth(col, config, dims);
    if (currentColWidth <= 0) break; 
    
    if (accumulatedWidth + currentColWidth > contentX) {
      break;
    }
    
    accumulatedWidth += currentColWidth;
    col++;
  }

  // 2. Apply Relative Threshold Logic
  if (dragStartCol !== undefined && col !== dragStartCol) {
    // 0.0 = Left edge, 1.0 = Right edge
    const relativePos = (contentX - accumulatedWidth) / currentColWidth;

    if (col > dragStartCol) {
      // Dragging Right
      if (relativePos < SELECTION_THRESHOLD_X) {
        col--;
      }
    } else {
      // Dragging Left
      if (relativePos > (1 - SELECTION_THRESHOLD_X)) {
        col++;
      }
    }
  }

  // Clamp Column
  if (col < 0) col = 0;
  if (col >= totalCols) col = totalCols - 1;
  
  // =========================================================================
  // ROW CALCULATION
  // =========================================================================
  
  let row = 0;
  let accumulatedHeight = 0;
  let currentRowHeight = 0;
  
  // 1. Find the physical row under the cursor
  while (row < totalRows) {
    currentRowHeight = getRowHeight(row, config, dims);
    if (currentRowHeight <= 0) break;

    if (accumulatedHeight + currentRowHeight > contentY) {
      break;
    }
    accumulatedHeight += currentRowHeight;
    row++;
  }
  
  // 2. Apply Relative Threshold Logic
  if (dragStartRow !== undefined && row !== dragStartRow) {
    // 0.0 = Top edge, 1.0 = Bottom edge
    const relativePos = (contentY - accumulatedHeight) / currentRowHeight;

    if (row > dragStartRow) {
      // Dragging Down
      if (relativePos < SELECTION_THRESHOLD_Y) {
        row--;
      }
    } else {
      // Dragging Up
      if (relativePos > (1 - SELECTION_THRESHOLD_Y)) {
        row++;
      }
    }
  }

  // Clamp Row
  if (row < 0) row = 0;
  if (row >= totalRows) row = totalRows - 1;
  
  // Final bounds check
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
  const handleWidth = 6; 

  if (pixelY >= colHeaderHeight) return null;
  if (pixelX < rowHeaderWidth) return null;

  const dims = ensureDimensions(dimensions);
  const range = calculateVisibleRange(viewport, config, pixelX + handleWidth, colHeaderHeight, dims);
  let x = rowHeaderWidth + range.offsetX;
  for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
    const colWidth = getColumnWidth(col, config, dims);
    x += colWidth;
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
  const handleHeight = 6; 

  if (pixelX >= rowHeaderWidth) return null;
  if (pixelY < colHeaderHeight) return null;

  const dims = ensureDimensions(dimensions);
  const range = calculateVisibleRange(viewport, config, rowHeaderWidth, pixelY + handleHeight, dims);
  let y = colHeaderHeight + range.offsetY;
  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = getRowHeight(row, config, dims);
    y += rowHeight;
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

  if (pixelY >= colHeaderHeight || pixelX < rowHeaderWidth) return null;
  
  const dims = ensureDimensions(dimensions);
  const scrollX = viewport.scrollX || 0;

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

  if (pixelX >= rowHeaderWidth || pixelY < colHeaderHeight) return null;
  
  const dims = ensureDimensions(dimensions);
  const scrollY = viewport.scrollY || 0;

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