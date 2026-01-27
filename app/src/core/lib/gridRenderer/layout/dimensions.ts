//! FILENAME: app/src/core/lib/gridRenderer/layout/dimensions.ts
// PURPOSE: Column width and row height calculations with custom dimension support
// CONTEXT: Handles cell positioning in the grid coordinate system
// Updated: Fixed insertion animation to work correctly with backend-first approach
// Updated: Added deletion animation support

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
 * Applies insertion/deletion animation offset for smooth structural changes.
 * 
 * Animation logic:
 * - INSERT: Cells at/after insertion point animate FROM old positions TO new positions
 *   Offset starts negative (appear at old position) and shrinks to 0 (final position)
 * - DELETE: Cells at/after deletion point animate FROM old positions TO new positions  
 *   Offset starts positive (appear at old position) and shrinks to 0 (final position)
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

  // Apply animation offset for columns at or after the change point
  if (insertionAnimation && insertionAnimation.type === "column" && col >= insertionAnimation.index) {
    const totalOffset = insertionAnimation.targetSize * insertionAnimation.count;
    // Progress goes 0 -> 1, so (1 - progress) goes 1 -> 0
    const remainingOffset = (1 - insertionAnimation.progress) * totalOffset;
    
    if (insertionAnimation.direction === "insert") {
      // INSERT: cells moved right, so offset is negative to show them at old (left) position
      x -= remainingOffset;
    } else {
      // DELETE: cells moved left, so offset is positive to show them at old (right) position
      x += remainingOffset;
    }
  }

  return x;
}

/**
 * Calculate the Y position of a row (top edge).
 * Applies insertion/deletion animation offset for smooth structural changes.
 * 
 * Animation logic:
 * - INSERT: Rows at/after insertion point animate FROM old positions TO new positions
 *   Offset starts negative (appear at old position) and shrinks to 0 (final position)
 * - DELETE: Rows at/after deletion point animate FROM old positions TO new positions
 *   Offset starts positive (appear at old position) and shrinks to 0 (final position)
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

  // Apply animation offset for rows at or after the change point
  if (insertionAnimation && insertionAnimation.type === "row" && row >= insertionAnimation.index) {
    const totalOffset = insertionAnimation.targetSize * insertionAnimation.count;
    // Progress goes 0 -> 1, so (1 - progress) goes 1 -> 0
    const remainingOffset = (1 - insertionAnimation.progress) * totalOffset;
    
    if (insertionAnimation.direction === "insert") {
      // INSERT: rows moved down, so offset is negative to show them at old (up) position
      y -= remainingOffset;
    } else {
      // DELETE: rows moved up, so offset is positive to show them at old (down) position
      y += remainingOffset;
    }
  }

  return y;
}