//FILENAME: app/src/lib/gridRenderer/layout/dimensions.ts
//PURPOSE: Column width and row height calculations with custom dimension support
//CONTEXT: Handles cell positioning in the grid coordinate system

import type { GridConfig, DimensionOverrides } from "../../../types";
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
 */
export function getColumnX(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  startCol: number,
  offsetX: number
): number {
  const dims = ensureDimensions(dimensions);
  let x = (config.rowHeaderWidth || 50) + offsetX;
  for (let c = startCol; c < col; c++) {
    x += getColumnWidth(c, config, dims);
  }
  return x;
}

/**
 * Calculate the Y position of a row (top edge).
 */
export function getRowY(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  startRow: number,
  offsetY: number
): number {
  const dims = ensureDimensions(dimensions);
  let y = (config.colHeaderHeight || 24) + offsetY;
  for (let r = startRow; r < row; r++) {
    y += getRowHeight(r, config, dims);
  }
  return y;
}