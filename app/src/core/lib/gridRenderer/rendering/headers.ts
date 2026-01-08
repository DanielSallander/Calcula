//FILENAME: app/src/lib/gridRenderer/rendering/headers.ts
//PURPOSE: Drawing functions for row and column headers
//CONTEXT: Renders header cells with highlighting and borders

import type { RenderState } from "../types";
import { calculateVisibleRange } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { columnToLetter } from "../../../types";

/**
 * Draw the corner cell (intersection of row and column headers).
 */
export function drawCorner(state: RenderState): void {
  const { ctx, config, theme } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  // Background
  ctx.fillStyle = theme.cornerBackground;
  ctx.fillRect(0, 0, rowHeaderWidth, colHeaderHeight);

  // Border
  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, rowHeaderWidth - 1, colHeaderHeight - 1);
}

/**
 * Draw the column headers (A, B, C, ...).
 */
export function drawColumnHeaders(state: RenderState): void {
  const { ctx, width, height, config, viewport, theme, selection, dimensions } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalCols = config.totalCols || 100;

  const range = calculateVisibleRange(viewport, config, width, height, dimensions);

  // Draw header background
  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(rowHeaderWidth, 0, width - rowHeaderWidth, colHeaderHeight);

  // Set up text rendering
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Normalize selection for highlighting
  let selMinCol = -1;
  let selMaxCol = -1;
  let isEntireColumnSelected = false;

  if (selection) {
    selMinCol = Math.min(selection.startCol, selection.endCol);
    selMaxCol = Math.max(selection.startCol, selection.endCol);
    isEntireColumnSelected = selection.type === "columns";
  }

  // Draw each visible column header
  let x = rowHeaderWidth + range.offsetX;

  for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
    const colWidth = getColumnWidth(col, config, dimensions);

    // Skip if outside visible area
    if (x + colWidth < rowHeaderWidth || x > width) {
      x += colWidth;
      continue;
    }

    // Highlight if column is in selection
    const isSelected = col >= selMinCol && col <= selMaxCol;
    const isFullySelected = isSelected && isEntireColumnSelected;

    if (isFullySelected) {
      ctx.fillStyle = theme.headerHighlight;
      ctx.fillRect(x, 0, colWidth, colHeaderHeight);
    } else if (isSelected) {
      ctx.fillStyle = "#e3ecf7";
      ctx.fillRect(x, 0, colWidth, colHeaderHeight);
    }

    // Draw border
    ctx.strokeStyle = theme.headerBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + colWidth + 0.5, 0);
    ctx.lineTo(x + colWidth + 0.5, colHeaderHeight);
    ctx.stroke();

    // Draw column letter
    ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : theme.headerText;
    ctx.fillText(columnToLetter(col), x + colWidth / 2, colHeaderHeight / 2);

    x += colWidth;
  }

  // Draw bottom border of header row
  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rowHeaderWidth, colHeaderHeight + 0.5);
  ctx.lineTo(width, colHeaderHeight + 0.5);
  ctx.stroke();
}

/**
 * Draw the row headers (1, 2, 3, ...).
 */
export function drawRowHeaders(state: RenderState): void {
  const { ctx, width, height, config, viewport, theme, selection, dimensions } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;

  const range = calculateVisibleRange(viewport, config, width, height, dimensions);

  // Draw header background
  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(0, colHeaderHeight, rowHeaderWidth, height - colHeaderHeight);

  // Set up text rendering
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Normalize selection for highlighting
  let selMinRow = -1;
  let selMaxRow = -1;
  let isEntireRowSelected = false;

  if (selection) {
    selMinRow = Math.min(selection.startRow, selection.endRow);
    selMaxRow = Math.max(selection.startRow, selection.endRow);
    isEntireRowSelected = selection.type === "rows";
  }

  // Draw each visible row header
  let y = colHeaderHeight + range.offsetY;

  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = getRowHeight(row, config, dimensions);
    // Skip if outside visible area
    if (y + rowHeight < colHeaderHeight || y > height) {
      y += rowHeight;
      continue;
    }

    // Highlight if row is in selection
    const isSelected = row >= selMinRow && row <= selMaxRow;
    const isFullySelected = isSelected && isEntireRowSelected;

    if (isFullySelected) {
      ctx.fillStyle = theme.headerHighlight;
      ctx.fillRect(0, y, rowHeaderWidth, rowHeight);
    } else if (isSelected) {
      ctx.fillStyle = "#e3ecf7";
      ctx.fillRect(0, y, rowHeaderWidth, rowHeight);
    }

    // Draw border
    ctx.strokeStyle = theme.headerBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + rowHeight + 0.5);
    ctx.lineTo(rowHeaderWidth, y + rowHeight + 0.5);
    ctx.stroke();

    // Draw row number (1-based)
    ctx.fillStyle = isFullySelected ? theme.headerHighlightText : isSelected ? "#1a5fb4" : theme.headerText;
    ctx.fillText(String(row + 1), rowHeaderWidth / 2, y + rowHeight / 2);

    y += rowHeight;
  }
  // Draw right border of header column
  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rowHeaderWidth + 0.5, colHeaderHeight);
  ctx.lineTo(rowHeaderWidth + 0.5, height);
  ctx.stroke();
}