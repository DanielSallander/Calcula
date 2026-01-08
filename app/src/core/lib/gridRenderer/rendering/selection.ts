// FILENAME: app/src/lib/gridRenderer/rendering/selection.ts
// PURPOSE: Selection and active cell rendering
// CONTEXT: Draws selection highlights, active cell borders, fill handles, fill preview,
//          and clipboard marching ants animation

import type { RenderState } from "../types";
import { calculateVisibleRange } from "../layout/viewport";
import { getColumnWidth, getRowHeight, getColumnX, getRowY } from "../layout/dimensions";

/**
 * Draw the selection highlight.
 */
export function drawSelection(state: RenderState): void {
  const { ctx, width, height, config, viewport, selection, theme, dimensions } = state;

  if (!selection) {
    return;
  }
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const range = calculateVisibleRange(viewport, config, width, height, dimensions);
  
  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);
  
  const x1 = getColumnX(minCol, config, dimensions, range.startCol, range.offsetX);
  const y1 = getRowY(minRow, config, dimensions, range.startRow, range.offsetY);
  let x2 = x1;
  for (let c = minCol; c <= maxCol; c++) {
    x2 += getColumnWidth(c, config, dimensions);
  }
  let y2 = y1;
  for (let r = minRow; r <= maxRow; r++) {
    y2 += getRowHeight(r, config, dimensions);
  }
  
  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);
  
  if (visX1 >= visX2 || visY1 >= visY2) {
    return;
  }
  
  ctx.fillStyle = theme.selectionBackground;
  ctx.fillRect(visX1, visY1, visX2 - visX1, visY2 - visY1);

  ctx.strokeStyle = theme.selectionBorder;
  ctx.lineWidth = 2;

  const borderX1 = Math.max(x1, rowHeaderWidth) + 1;
  const borderY1 = Math.max(y1, colHeaderHeight) + 1;
  const borderX2 = Math.min(x2, width) - 1;
  const borderY2 = Math.min(y2, height) - 1;

  if (borderX2 > borderX1 && borderY2 > borderY1) {
    ctx.strokeRect(borderX1, borderY1, borderX2 - borderX1, borderY2 - borderY1);
  }

  // Draw fill handle (small square in bottom-right corner of selection)
  const handleSize = 8;
  const handleX = borderX2 - handleSize / 2;
  const handleY = borderY2 - handleSize / 2;
  
  if (handleX > rowHeaderWidth && handleY > colHeaderHeight) {
    // White background for fill handle
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
    // Green border for fill handle
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 2;
    ctx.strokeRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
  }
}

/**
 * Draw clipboard selection with marching ants animation.
 * The dotted border animates to show cells are on the clipboard.
 */
export function drawClipboardSelection(state: RenderState): void {
  const { 
    ctx, width, height, config, viewport, dimensions, 
    clipboardSelection, clipboardMode, clipboardAnimationOffset = 0 
  } = state;

  if (!clipboardSelection || clipboardMode === "none") {
    return;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const range = calculateVisibleRange(viewport, config, width, height, dimensions);

  const minRow = Math.min(clipboardSelection.startRow, clipboardSelection.endRow);
  const maxRow = Math.max(clipboardSelection.startRow, clipboardSelection.endRow);
  const minCol = Math.min(clipboardSelection.startCol, clipboardSelection.endCol);
  const maxCol = Math.max(clipboardSelection.startCol, clipboardSelection.endCol);

  const x1 = getColumnX(minCol, config, dimensions, range.startCol, range.offsetX);
  const y1 = getRowY(minRow, config, dimensions, range.startRow, range.offsetY);
  let x2 = x1;
  for (let c = minCol; c <= maxCol; c++) {
    x2 += getColumnWidth(c, config, dimensions);
  }
  let y2 = y1;
  for (let r = minRow; r <= maxRow; r++) {
    y2 += getRowHeight(r, config, dimensions);
  }

  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);

  if (visX1 >= visX2 || visY1 >= visY2) {
    return;
  }

  // Draw marching ants border
  // Use two passes: white background line, then colored dashed line
  const borderX = visX1 + 1;
  const borderY = visY1 + 1;
  const borderW = visX2 - visX1 - 2;
  const borderH = visY2 - visY1 - 2;

  // First pass: solid white background to make dashes visible on any cell color
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(borderX, borderY, borderW, borderH);

  // Second pass: colored dashed line with animation offset
  ctx.strokeStyle = clipboardMode === "cut" ? "#16a34a" : "#2563eb"; // Green for cut, blue for copy
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]); // Dash pattern: 4px dash, 4px gap
  ctx.lineDashOffset = -clipboardAnimationOffset; // Negative offset makes ants march clockwise
  ctx.strokeRect(borderX, borderY, borderW, borderH);
  
  // Reset line dash
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

/**
 * Draw the active cell indicator.
 */
export function drawActiveCell(state: RenderState): void {
  const { ctx, width, height, config, viewport, selection, editing, theme, dimensions } = state;

  if (!selection) {
    return;
  }
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const range = calculateVisibleRange(viewport, config, width, height, dimensions);
  const activeRow = selection.endRow;
  const activeCol = selection.endCol;
  const cellWidth = getColumnWidth(activeCol, config, dimensions);
  const cellHeight = getRowHeight(activeRow, config, dimensions);
  
  const x = getColumnX(activeCol, config, dimensions, range.startCol, range.offsetX);
  const y = getRowY(activeRow, config, dimensions, range.startRow, range.offsetY);
  
  if (
    x + cellWidth < rowHeaderWidth ||
    x > width ||
    y + cellHeight < colHeaderHeight ||
    y > height
  ) {
    return;
  }
  
  const visX = Math.max(x, rowHeaderWidth);
  const visY = Math.max(y, colHeaderHeight);
  const visWidth = Math.min(x + cellWidth, width) - visX;
  const visHeight = Math.min(y + cellHeight, height) - visY;

  const isEditingThisCell = editing && editing.row === activeRow && editing.col === activeCol;

  if (!isEditingThisCell) {
    ctx.strokeStyle = theme.activeCellBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      Math.max(x, rowHeaderWidth) + 1,
      Math.max(y, colHeaderHeight) + 1,
      Math.min(cellWidth - 2, visWidth - 2),
      Math.min(cellHeight - 2, visHeight - 2)
    );
  }
}

/**
 * Draw the active cell background (white).
 */
export function drawActiveCellBackground(state: RenderState): void {
  const { ctx, width, height, config, viewport, selection, editing, theme, dimensions } = state;

  if (!selection) {
    return;
  }
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const range = calculateVisibleRange(viewport, config, width, height, dimensions);
  const activeRow = selection.endRow;
  const activeCol = selection.endCol;
  
  if (editing && editing.row === activeRow && editing.col === activeCol) {
    return;
  }
  const cellWidth = getColumnWidth(activeCol, config, dimensions);
  const cellHeight = getRowHeight(activeRow, config, dimensions);
  
  const x = getColumnX(activeCol, config, dimensions, range.startCol, range.offsetX);
  const y = getRowY(activeRow, config, dimensions, range.startRow, range.offsetY);
  
  if (
    x + cellWidth < rowHeaderWidth ||
    x > width ||
    y + cellHeight < colHeaderHeight ||
    y > height
  ) {
    return;
  }
  
  const visX = Math.max(x, rowHeaderWidth);
  const visY = Math.max(y, colHeaderHeight);
  const visWidth = Math.min(x + cellWidth, width) - visX;
  const visHeight = Math.min(y + cellHeight, height) - visY;
  
  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(visX, visY, visWidth, visHeight);
}

/**
 * Draw fill preview range (dashed border during fill drag).
 */
export function drawFillPreview(state: RenderState): void {
  const { ctx, width, height, config, viewport, dimensions, fillPreviewRange } = state;

  if (!fillPreviewRange) {
    return;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const range = calculateVisibleRange(viewport, config, width, height, dimensions);

  const minRow = Math.min(fillPreviewRange.startRow, fillPreviewRange.endRow);
  const maxRow = Math.max(fillPreviewRange.startRow, fillPreviewRange.endRow);
  const minCol = Math.min(fillPreviewRange.startCol, fillPreviewRange.endCol);
  const maxCol = Math.max(fillPreviewRange.startCol, fillPreviewRange.endCol);

  const x1 = getColumnX(minCol, config, dimensions, range.startCol, range.offsetX);
  const y1 = getRowY(minRow, config, dimensions, range.startRow, range.offsetY);
  let x2 = x1;
  for (let c = minCol; c <= maxCol; c++) {
    x2 += getColumnWidth(c, config, dimensions);
  }
  let y2 = y1;
  for (let r = minRow; r <= maxRow; r++) {
    y2 += getRowHeight(r, config, dimensions);
  }

  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);

  if (visX1 >= visX2 || visY1 >= visY2) {
    return;
  }

  // Draw semi-transparent fill
  ctx.fillStyle = "rgba(22, 163, 74, 0.1)";
  ctx.fillRect(visX1, visY1, visX2 - visX1, visY2 - visY1);

  // Draw dashed border
  ctx.strokeStyle = "#16a34a";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(visX1 + 1, visY1 + 1, visX2 - visX1 - 2, visY2 - visY1 - 2);
  ctx.setLineDash([]);
}