//! FILENAME: app/src/core/lib/gridRenderer/layout/viewport.ts
//PURPOSE: Viewport and visible cell range calculations for virtual scrolling
//CONTEXT: Maps scroll positions to cell indices for efficient rendering
//UPDATED: Added freeze pane zone calculations for split viewport rendering

import type { GridConfig, Viewport, DimensionOverrides, FreezeConfig, VisibleRange, FreezePaneLayout } from "../../../types";
import { ensureDimensions } from "../styles/styleUtils";
import { getColumnWidth, getRowHeight } from "./dimensions";

/**
 * Calculate the visible cell range based on viewport and scroll position.
 * This is the core function for virtual scrolling - it maps scroll pixels
 * to cell indices for efficient rendering.
 */
export function calculateVisibleRange(
  viewport: Viewport,
  config: GridConfig,
  canvasWidth: number,
  canvasHeight: number,
  dimensions?: DimensionOverrides
): VisibleRange {
  // Defensive: ensure we have valid inputs
  if (!viewport || !config || canvasWidth <= 0 || canvasHeight <= 0) {
    return {
      startRow: 0,
      endRow: 0,
      startCol: 0,
      endCol: 0,
      offsetX: 0,
      offsetY: 0,
    };
  }

  const scrollX = viewport.scrollX || 0;
  const scrollY = viewport.scrollY || 0;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;

  const dims = ensureDimensions(dimensions);

  // Calculate starting column from scroll position
  let accumulatedWidth = 0;
  let startCol = 0;
  let offsetX = 0;

  while (startCol < totalCols) {
    const colWidth = getColumnWidth(startCol, config, dims);
    if (colWidth <= 0) break; // Safety check
    if (accumulatedWidth + colWidth > scrollX) {
      break;
    }
    accumulatedWidth += colWidth;
    startCol++;
  }
  offsetX = -(scrollX - accumulatedWidth);

  // Calculate starting row from scroll position
  let accumulatedHeight = 0;
  let startRow = 0;
  let offsetY = 0;

  while (startRow < totalRows) {
    const rowHeight = getRowHeight(startRow, config, dims);
    if (rowHeight <= 0) break; // Safety check
    if (accumulatedHeight + rowHeight > scrollY) {
      break;
    }
    accumulatedHeight += rowHeight;
    startRow++;
  }
  offsetY = -(scrollY - accumulatedHeight);

  // Calculate end column
  let endCol = startCol;
  let widthAccum = offsetX;
  const visibleWidth = canvasWidth - rowHeaderWidth;

  while (endCol < totalCols && widthAccum < visibleWidth) {
    const colWidth = getColumnWidth(endCol, config, dims);
    if (colWidth <= 0) break; // Safety check
    widthAccum += colWidth;
    endCol++;
  }

  // Calculate end row
  let endRow = startRow;
  let heightAccum = offsetY;
  const visibleHeight = canvasHeight - colHeaderHeight;

  while (endRow < totalRows && heightAccum < visibleHeight) {
    const rowHeight = getRowHeight(endRow, config, dims);
    if (rowHeight <= 0) break; // Safety check
    heightAccum += rowHeight;
    endRow++;
  }

  return {
    startRow: Math.max(0, startRow),
    endRow: Math.min(endRow, totalRows - 1),
    startCol: Math.max(0, startCol),
    endCol: Math.min(endCol, totalCols - 1),
    offsetX,
    offsetY,
  };
}

/**
 * Calculate the pixel dimensions of frozen areas.
 */
export function calculateFreezePaneLayout(
  freezeConfig: FreezeConfig,
  config: GridConfig,
  dimensions?: DimensionOverrides
): FreezePaneLayout {
  const { freezeRow, freezeCol } = freezeConfig;
  const defaultCellWidth = config.defaultCellWidth || 100;
  const defaultCellHeight = config.defaultCellHeight || 24;
  const dims = ensureDimensions(dimensions);
  
  let frozenColsWidth = 0;
  let frozenRowsHeight = 0;
  const frozenColCount = freezeCol ?? 0;
  const frozenRowCount = freezeRow ?? 0;
  
  // Calculate width of frozen columns
  if (freezeCol !== null && freezeCol > 0) {
    for (let col = 0; col < freezeCol; col++) {
      frozenColsWidth += getColumnWidth(col, config, dims);
    }
  }
  
  // Calculate height of frozen rows
  if (freezeRow !== null && freezeRow > 0) {
    for (let row = 0; row < freezeRow; row++) {
      frozenRowsHeight += getRowHeight(row, config, dims);
    }
  }
  
  return {
    frozenColsWidth,
    frozenRowsHeight,
    hasFrozenRows: freezeRow !== null && freezeRow > 0,
    hasFrozenCols: freezeCol !== null && freezeCol > 0,
    frozenRowCount,
    frozenColCount,
  };
}

/**
 * Calculate visible range for the frozen top-left zone (no scrolling).
 */
export function calculateFrozenTopLeftRange(
  freezeConfig: FreezeConfig,
  config: GridConfig,
  canvasWidth: number,
  canvasHeight: number,
  dimensions?: DimensionOverrides
): VisibleRange | null {
  const { freezeRow, freezeCol } = freezeConfig;
  
  // Only exists if both rows and columns are frozen
  if (freezeRow === null || freezeRow <= 0 || freezeCol === null || freezeCol <= 0) {
    return null;
  }
  
  return {
    startRow: 0,
    endRow: freezeRow - 1,
    startCol: 0,
    endCol: freezeCol - 1,
    offsetX: 0,
    offsetY: 0,
  };
}

/**
 * Calculate visible range for the frozen top-right zone (scrolls horizontally only).
 */
export function calculateFrozenTopRange(
  viewport: Viewport,
  freezeConfig: FreezeConfig,
  config: GridConfig,
  canvasWidth: number,
  canvasHeight: number,
  dimensions?: DimensionOverrides
): VisibleRange | null {
  const { freezeRow, freezeCol } = freezeConfig;
  
  // Only exists if rows are frozen
  if (freezeRow === null || freezeRow <= 0) {
    return null;
  }
  
  const layout = calculateFreezePaneLayout(freezeConfig, config, dimensions);
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const totalCols = config.totalCols || 100;
  const dims = ensureDimensions(dimensions);
  
  // Calculate scrollable area width
  const scrollableWidth = canvasWidth - rowHeaderWidth - layout.frozenColsWidth;
  if (scrollableWidth <= 0) {
    return null;
  }
  
  const scrollX = viewport.scrollX || 0;
  const startColAfterFrozen = freezeCol ?? 0;
  
  // Find starting column based on scroll
  let accumulatedWidth = 0;
  let startCol = startColAfterFrozen;
  
  // Skip frozen columns' worth of scroll offset
  let frozenWidth = 0;
  for (let c = 0; c < startColAfterFrozen; c++) {
    frozenWidth += getColumnWidth(c, config, dims);
  }
  
  while (startCol < totalCols) {
    const colWidth = getColumnWidth(startCol, config, dims);
    if (colWidth <= 0) break;
    if (accumulatedWidth + colWidth > scrollX) {
      break;
    }
    accumulatedWidth += colWidth;
    startCol++;
  }
  const offsetX = -(scrollX - accumulatedWidth);
  
  // Find ending column
  let endCol = startCol;
  let widthAccum = offsetX;
  while (endCol < totalCols && widthAccum < scrollableWidth) {
    widthAccum += getColumnWidth(endCol, config, dims);
    endCol++;
  }
  
  return {
    startRow: 0,
    endRow: freezeRow - 1,
    startCol: Math.max(startColAfterFrozen, startCol),
    endCol: Math.min(endCol, totalCols - 1),
    offsetX,
    offsetY: 0,
  };
}

/**
 * Calculate visible range for the frozen bottom-left zone (scrolls vertically only).
 */
export function calculateFrozenLeftRange(
  viewport: Viewport,
  freezeConfig: FreezeConfig,
  config: GridConfig,
  canvasWidth: number,
  canvasHeight: number,
  dimensions?: DimensionOverrides
): VisibleRange | null {
  const { freezeRow, freezeCol } = freezeConfig;
  
  // Only exists if columns are frozen
  if (freezeCol === null || freezeCol <= 0) {
    return null;
  }
  
  const layout = calculateFreezePaneLayout(freezeConfig, config, dimensions);
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const dims = ensureDimensions(dimensions);
  
  // Calculate scrollable area height
  const scrollableHeight = canvasHeight - colHeaderHeight - layout.frozenRowsHeight;
  if (scrollableHeight <= 0) {
    return null;
  }
  
  const scrollY = viewport.scrollY || 0;
  const startRowAfterFrozen = freezeRow ?? 0;
  
  // Find starting row based on scroll
  let accumulatedHeight = 0;
  let startRow = startRowAfterFrozen;
  
  while (startRow < totalRows) {
    const rowHeight = getRowHeight(startRow, config, dims);
    if (rowHeight <= 0) break;
    if (accumulatedHeight + rowHeight > scrollY) {
      break;
    }
    accumulatedHeight += rowHeight;
    startRow++;
  }
  const offsetY = -(scrollY - accumulatedHeight);
  
  // Find ending row
  let endRow = startRow;
  let heightAccum = offsetY;
  while (endRow < totalRows && heightAccum < scrollableHeight) {
    heightAccum += getRowHeight(endRow, config, dims);
    endRow++;
  }
  
  return {
    startRow: Math.max(startRowAfterFrozen, startRow),
    endRow: Math.min(endRow, totalRows - 1),
    startCol: 0,
    endCol: freezeCol - 1,
    offsetX: 0,
    offsetY,
  };
}

/**
 * Calculate visible range for the main scrollable zone (scrolls both directions).
 * This is the bottom-right zone when freeze panes are active.
 */
export function calculateScrollableRange(
  viewport: Viewport,
  freezeConfig: FreezeConfig,
  config: GridConfig,
  canvasWidth: number,
  canvasHeight: number,
  dimensions?: DimensionOverrides
): VisibleRange {
  const { freezeRow, freezeCol } = freezeConfig;
  const layout = calculateFreezePaneLayout(freezeConfig, config, dimensions);
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;
  const dims = ensureDimensions(dimensions);
  
  const scrollX = viewport.scrollX || 0;
  const scrollY = viewport.scrollY || 0;
  
  const startRowAfterFrozen = freezeRow ?? 0;
  const startColAfterFrozen = freezeCol ?? 0;
  
  // Calculate scrollable area dimensions
  const scrollableWidth = canvasWidth - rowHeaderWidth - layout.frozenColsWidth;
  const scrollableHeight = canvasHeight - colHeaderHeight - layout.frozenRowsHeight;
  
  if (scrollableWidth <= 0 || scrollableHeight <= 0) {
    return {
      startRow: startRowAfterFrozen,
      endRow: startRowAfterFrozen,
      startCol: startColAfterFrozen,
      endCol: startColAfterFrozen,
      offsetX: 0,
      offsetY: 0,
    };
  }
  
  // Find starting column based on scroll
  let accumulatedWidth = 0;
  let startCol = startColAfterFrozen;
  
  while (startCol < totalCols) {
    const colWidth = getColumnWidth(startCol, config, dims);
    if (colWidth <= 0) break;
    if (accumulatedWidth + colWidth > scrollX) {
      break;
    }
    accumulatedWidth += colWidth;
    startCol++;
  }
  const offsetX = -(scrollX - accumulatedWidth);
  
  // Find starting row based on scroll
  let accumulatedHeight = 0;
  let startRow = startRowAfterFrozen;
  
  while (startRow < totalRows) {
    const rowHeight = getRowHeight(startRow, config, dims);
    if (rowHeight <= 0) break;
    if (accumulatedHeight + rowHeight > scrollY) {
      break;
    }
    accumulatedHeight += rowHeight;
    startRow++;
  }
  const offsetY = -(scrollY - accumulatedHeight);
  
  // Find ending column
  let endCol = startCol;
  let widthAccum = offsetX;
  while (endCol < totalCols && widthAccum < scrollableWidth) {
    widthAccum += getColumnWidth(endCol, config, dims);
    endCol++;
  }
  
  // Find ending row
  let endRow = startRow;
  let heightAccum = offsetY;
  while (endRow < totalRows && heightAccum < scrollableHeight) {
    heightAccum += getRowHeight(endRow, config, dims);
    endRow++;
  }
  
  return {
    startRow: Math.max(startRowAfterFrozen, startRow),
    endRow: Math.min(endRow, totalRows - 1),
    startCol: Math.max(startColAfterFrozen, startCol),
    endCol: Math.min(endCol, totalCols - 1),
    offsetX,
    offsetY,
  };
}