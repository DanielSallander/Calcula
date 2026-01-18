// FILENAME: app/src/lib/gridRenderer/layout/dimensions.ts
// PURPOSE: Column width and row height calculations with custom dimension support
// CONTEXT: Handles cell positioning in the grid coordinate system
// Updated: Added insertion animation offset support for smooth row/column insertion

import type { GridConfig, DimensionOverrides, InsertionAnimation } from "../../../types";
import { ensureDimensions } from "../styles/styleUtils";

/**
 * Get the width of a specific column, using custom width if set.
 */
export function getColumnWidth(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  const dims = ensureDimensions(dimensions);
  const customWidth = dims.columnWidths.get(col);
  if (customWidth !== undefined && customWidth > 0) {
    return customWidth;
  }
  return config.defaultCellWidth || 100;
}

/**
 * Get the height of a specific row, using custom height if set.
 */
export function getRowHeight(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  const dims = ensureDimensions(dimensions);
  const customHeight = dims.rowHeights.get(row);
  if (customHeight !== undefined && customHeight > 0) {
    return customHeight;
  }
  return config.defaultCellHeight || 24;
}

/**
 * Calculate the X position of a column (left edge).
 * Optionally applies insertion animation offset.
 */
export function getColumnX(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  startCol: number,
  offsetX: number,
  insertionAnimation?: InsertionAnimation
): number {
  const dims = ensureDimensions(dimensions);
  let x = (config.rowHeaderWidth || 50) + offsetX;
  for (let c = startCol; c < col; c++) {
    x += getColumnWidth(c, config, dims);
  }

  // Apply insertion animation offset for columns at or after the insertion point
  if (insertionAnimation && insertionAnimation.type === "column" && col >= insertionAnimation.index) {
    const animOffset = insertionAnimation.progress * insertionAnimation.targetSize * insertionAnimation.count;
    x += animOffset;
  }

  return x;
}

/**
 * Calculate the Y position of a row (top edge).
 * Optionally applies insertion animation offset.
 */
export function getRowY(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  startRow: number,
  offsetY: number,
  insertionAnimation?: InsertionAnimation
): number {
  const dims = ensureDimensions(dimensions);
  let y = (config.colHeaderHeight || 24) + offsetY;
  for (let r = startRow; r < row; r++) {
    y += getRowHeight(r, config, dims);
  }

  // Apply insertion animation offset for rows at or after the insertion point
  if (insertionAnimation && insertionAnimation.type === "row" && row >= insertionAnimation.index) {
    const animOffset = insertionAnimation.progress * insertionAnimation.targetSize * insertionAnimation.count;
    y += animOffset;
  }

  return y;
}