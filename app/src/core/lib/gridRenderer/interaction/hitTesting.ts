//! FILENAME: app/src/core/lib/gridRenderer/interaction/hitTesting.ts
//PURPOSE: Pixel coordinate to cell coordinate conversion and resize handle detection
//CONTEXT: Handles mouse interaction with grid cells, headers, and resize handles
//UPDATED: Added freeze pane support for coordinate translation

import type { GridConfig, Viewport, DimensionOverrides, FreezeConfig, FreezeZone } from "../../../types";
import { ensureDimensions } from "../styles/styleUtils";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { calculateVisibleRange, calculateFreezePaneLayout } from "../layout/viewport";

// =============================================================================
// SELECTION THRESHOLDS
// =============================================================================
// X = 0.0: Instant selection (cell selects as soon as cursor touches it)
// Y = 1.2: Delayed selection (requires dragging significantly past the border)
const SELECTION_THRESHOLD_X = 0.0;
const SELECTION_THRESHOLD_Y = 0.0;

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
  
  /**
   * Freeze pane configuration for coordinate translation.
   */
  freezeConfig?: FreezeConfig;
}

/**
 * Result from getCellFromPixel including zone information.
 */
export interface CellFromPixelResult {
  row: number;
  col: number;
  zone: FreezeZone;
}

/**
 * Determine which freeze zone a pixel coordinate falls into.
 */
export function getZoneFromPixel(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  freezeConfig: FreezeConfig,
  dimensions?: DimensionOverrides
): FreezeZone {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  
  // If no freeze, everything is in bottomRight (main scrollable)
  if ((freezeConfig.freezeRow === null || freezeConfig.freezeRow <= 0) &&
      (freezeConfig.freezeCol === null || freezeConfig.freezeCol <= 0)) {
    return "bottomRight";
  }
  
  const layout = calculateFreezePaneLayout(freezeConfig, config, dimensions);
  
  const inFrozenCols = freezeConfig.freezeCol !== null && 
                       freezeConfig.freezeCol > 0 && 
                       pixelX < rowHeaderWidth + layout.frozenColsWidth;
  const inFrozenRows = freezeConfig.freezeRow !== null && 
                       freezeConfig.freezeRow > 0 && 
                       pixelY < colHeaderHeight + layout.frozenRowsHeight;
  
  if (inFrozenRows && inFrozenCols) {
    return "topLeft";
  } else if (inFrozenRows) {
    return "topRight";
  } else if (inFrozenCols) {
    return "bottomLeft";
  } else {
    return "bottomRight";
  }
}

/**
 * Get cell coordinates from pixel position.
 * Returns null if click is on headers.
 * Handles frozen pane coordinate translation.
 * 
 * @param pixelX - X coordinate in pixels relative to container
 * @param pixelY - Y coordinate in pixels relative to container
 * @param config - Grid configuration
 * @param viewport - Current viewport state
 * @param dimensions - Optional dimension overrides
 * @param options - Optional behavior options including freeze config
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
  const freezeConfig = options?.freezeConfig;
  
  // Check if click is on headers
  if (pixelX < rowHeaderWidth || pixelY < colHeaderHeight) {
    return null;
  }
  
  const dims = ensureDimensions(dimensions);
  const scrollX = viewport.scrollX || 0;
  const scrollY = viewport.scrollY || 0;

  // Determine which zone we're in and calculate appropriate content position
  let contentX: number;
  let contentY: number;
  let startCol = 0;
  let startRow = 0;
  
  if (freezeConfig && (freezeConfig.freezeRow !== null || freezeConfig.freezeCol !== null)) {
    const layout = calculateFreezePaneLayout(freezeConfig, config, dims);
    const zone = getZoneFromPixel(pixelX, pixelY, config, freezeConfig, dims);
    
    switch (zone) {
      case "topLeft":
        // Frozen corner - no scroll offset
        contentX = pixelX - rowHeaderWidth;
        contentY = pixelY - colHeaderHeight;
        break;
        
      case "topRight":
        // Frozen rows - horizontal scroll only
        contentX = pixelX - rowHeaderWidth - layout.frozenColsWidth + scrollX;
        contentY = pixelY - colHeaderHeight;
        startCol = freezeConfig.freezeCol ?? 0;
        break;
        
      case "bottomLeft":
        // Frozen columns - vertical scroll only
        contentX = pixelX - rowHeaderWidth;
        contentY = pixelY - colHeaderHeight - layout.frozenRowsHeight + scrollY;
        startRow = freezeConfig.freezeRow ?? 0;
        break;
        
      case "bottomRight":
        // Main scrollable area - both scrolls
        contentX = pixelX - rowHeaderWidth - layout.frozenColsWidth + scrollX;
        contentY = pixelY - colHeaderHeight - layout.frozenRowsHeight + scrollY;
        startCol = freezeConfig.freezeCol ?? 0;
        startRow = freezeConfig.freezeRow ?? 0;
        break;
    }
  } else {
    // No freeze panes - standard calculation
    contentX = pixelX - rowHeaderWidth + scrollX;
    contentY = pixelY - colHeaderHeight + scrollY;
  }

  // =========================================================================
  // COLUMN CALCULATION
  // =========================================================================
  
  let col = startCol;
  let accumulatedWidth = 0;
  let currentColWidth = 0;
  
  // For frozen zones, we need to account for frozen columns' width offset
  if (freezeConfig && freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0 && startCol === 0) {
    // We're in a frozen column zone - start from column 0
  } else if (startCol > 0) {
    // We're past frozen columns - content already adjusted for scroll
  }
  
  // Find the physical column under the cursor
  while (col < totalCols) {
    currentColWidth = getColumnWidth(col, config, dims);
    if (currentColWidth <= 0) break; 
    
    if (accumulatedWidth + currentColWidth > contentX) {
      break;
    }
    
    accumulatedWidth += currentColWidth;
    col++;
  }

  // Apply Relative Threshold Logic
  if (dragStartCol !== undefined && col !== dragStartCol) {
    const relativePos = (contentX - accumulatedWidth) / currentColWidth;

    if (col > dragStartCol) {
      if (relativePos < SELECTION_THRESHOLD_X) {
        col--;
      }
    } else {
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
  
  let row = startRow;
  let accumulatedHeight = 0;
  let currentRowHeight = 0;
  
  // Find the physical row under the cursor
  while (row < totalRows) {
    currentRowHeight = getRowHeight(row, config, dims);
    if (currentRowHeight <= 0) break;

    if (accumulatedHeight + currentRowHeight > contentY) {
      break;
    }
    accumulatedHeight += currentRowHeight;
    row++;
  }
  
  // Apply Relative Threshold Logic
  if (dragStartRow !== undefined && row !== dragStartRow) {
    const relativePos = (contentY - accumulatedHeight) / currentRowHeight;

    if (row > dragStartRow) {
      if (relativePos < SELECTION_THRESHOLD_Y) {
        row--;
      }
    } else {
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