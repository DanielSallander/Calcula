//FILENAME: app/src/lib/gridRenderer/layout/viewport.ts
//PURPOSE: Viewport and visible cell range calculations for virtual scrolling
//CONTEXT: Maps scroll positions to cell indices for efficient rendering

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
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
): {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  offsetX: number;
  offsetY: number;
} {
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