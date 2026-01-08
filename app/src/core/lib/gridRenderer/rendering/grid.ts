//FILENAME: app/src/lib/gridRenderer/rendering/grid.ts
//PURPOSE: Grid line and cell background rendering
//CONTEXT: Draws the grid structure and default cell backgrounds

import type { RenderState } from "../types";
import { calculateVisibleRange } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";

/**
 * Draw the grid lines for the cell area.
 */
export function drawGridLines(state: RenderState): void {
  const { ctx, width, height, config, viewport, theme, dimensions } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;

  const range = calculateVisibleRange(viewport, config, width, height, dimensions);
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  // Draw vertical lines
  let x = rowHeaderWidth + range.offsetX;
  for (let col = range.startCol; col <= range.endCol + 1 && col <= totalCols; col++) {
    if (x >= rowHeaderWidth && x <= width) {
      ctx.beginPath();
      ctx.moveTo(Math.floor(x) + 0.5, colHeaderHeight);
      ctx.lineTo(Math.floor(x) + 0.5, height);
      ctx.stroke();
    }
    if (col <= range.endCol) {
      x += getColumnWidth(col, config, dimensions);
    }
  }
  // Draw horizontal lines
  let y = colHeaderHeight + range.offsetY;
  for (let row = range.startRow; row <= range.endRow + 1 && row <= totalRows; row++) {
    if (y >= colHeaderHeight && y <= height) {
      ctx.beginPath();
      ctx.moveTo(rowHeaderWidth, Math.floor(y) + 0.5);
      ctx.lineTo(width, Math.floor(y) + 0.5);
      ctx.stroke();
    }
    if (row <= range.endRow) {
      y += getRowHeight(row, config, dimensions);
    }
  }
}

/**
 * Draw cell backgrounds (for non-default colored cells).
 * Currently draws all visible cells with the default background.
 * In the future, this will support per-cell styling.
 */
export function drawCellBackgrounds(state: RenderState): void {
  const { ctx, width, height, config, theme } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  // For now, just fill the entire cell area with the default background
  // In the future, we'll iterate through cells and apply individual styles
  ctx.fillStyle = theme.cellBackground;
  const startX = rowHeaderWidth;
  const startY = colHeaderHeight;
  const areaWidth = width - rowHeaderWidth;
  const areaHeight = height - colHeaderHeight;
  ctx.fillRect(startX, startY, areaWidth, areaHeight);
}