//! FILENAME: app/extensions/Table/lib/tableOverlayRenderer.ts
// PURPOSE: Overlay renderer that draws visible borders around table objects.
// CONTEXT: Registered with the grid overlay system so the core canvas renders
//          a distinctive border around each table region. Uses API dimension
//          helpers only (no direct core imports).

import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnsWidth,
  overlayGetRowsHeight,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  type OverlayRenderContext,
} from "../../../src/api/gridOverlays";

// ============================================================================
// Table Border Style Constants
// ============================================================================

/** Border color for the table outline (subtle grey-blue) */
const TABLE_BORDER_COLOR = "#8EAACC";

/** Border width in pixels */
const TABLE_BORDER_WIDTH = 1;

/** Resize handle hit area size in pixels */
export const TABLE_RESIZE_HANDLE_SIZE = 6;

// ============================================================================
// Renderer
// ============================================================================

/**
 * Draw the table border overlay.
 * Renders a solid colored border around the table region to visually indicate
 * where the table is defined, similar to Excel's table border behavior.
 *
 * Also draws a small resize handle at the bottom-right corner that the user
 * can drag to resize the table (handled by mouse interaction code).
 */
export function drawTableBorder(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  // Calculate pixel positions using API helpers
  const startX = overlayGetColumnX(overlayCtx, region.startCol);
  const startY = overlayGetRowY(overlayCtx, region.startRow);
  const regionWidth = overlayGetColumnsWidth(overlayCtx, region.startCol, region.endCol);
  const regionHeight = overlayGetRowsHeight(overlayCtx, region.startRow, region.endRow);

  const endX = startX + regionWidth;
  const endY = startY + regionHeight;

  // Only draw if any part is visible
  if (endX < rowHeaderWidth || endY < colHeaderHeight) {
    return;
  }
  if (startX > overlayCtx.canvasWidth || startY > overlayCtx.canvasHeight) {
    return;
  }

  // Clip to cell area (not headers)
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    overlayCtx.canvasWidth - rowHeaderWidth,
    overlayCtx.canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  // Clamp drawing coordinates to visible area
  const drawX1 = Math.max(startX, rowHeaderWidth);
  const drawY1 = Math.max(startY, colHeaderHeight);
  const drawX2 = Math.min(endX, overlayCtx.canvasWidth);
  const drawY2 = Math.min(endY, overlayCtx.canvasHeight);

  // Draw the table border
  ctx.strokeStyle = TABLE_BORDER_COLOR;
  ctx.lineWidth = TABLE_BORDER_WIDTH;
  ctx.setLineDash([]);
  ctx.beginPath();

  // Draw each side individually so partial visibility works correctly
  // Top edge
  if (startY >= colHeaderHeight) {
    ctx.moveTo(drawX1, Math.floor(startY) + 0.5);
    ctx.lineTo(drawX2, Math.floor(startY) + 0.5);
  }
  // Bottom edge
  if (endY <= overlayCtx.canvasHeight) {
    ctx.moveTo(drawX1, Math.floor(endY) - 0.5);
    ctx.lineTo(drawX2, Math.floor(endY) - 0.5);
  }
  // Left edge
  if (startX >= rowHeaderWidth) {
    ctx.moveTo(Math.floor(startX) + 0.5, drawY1);
    ctx.lineTo(Math.floor(startX) + 0.5, drawY2);
  }
  // Right edge
  if (endX <= overlayCtx.canvasWidth) {
    ctx.moveTo(Math.floor(endX) - 0.5, drawY1);
    ctx.lineTo(Math.floor(endX) - 0.5, drawY2);
  }

  ctx.stroke();

  // Draw resize handle at the bottom-right corner
  const handleSize = TABLE_RESIZE_HANDLE_SIZE;
  const handleX = Math.floor(endX) - handleSize;
  const handleY = Math.floor(endY) - handleSize;

  // Only draw handle if the corner is visible
  if (handleX > rowHeaderWidth && handleY > colHeaderHeight &&
      handleX < overlayCtx.canvasWidth && handleY < overlayCtx.canvasHeight) {
    // Small filled triangle in the corner
    ctx.fillStyle = TABLE_BORDER_COLOR;
    ctx.beginPath();
    ctx.moveTo(handleX + handleSize, handleY);
    ctx.lineTo(handleX + handleSize, handleY + handleSize);
    ctx.lineTo(handleX, handleY + handleSize);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Hit-test for table overlay regions.
 * Returns true if the cell is within the table boundaries.
 */
export function hitTestTable(hitCtx: {
  region: { startRow: number; startCol: number; endRow: number; endCol: number };
  row: number;
  col: number;
}): boolean {
  return (
    hitCtx.row >= hitCtx.region.startRow &&
    hitCtx.row <= hitCtx.region.endRow &&
    hitCtx.col >= hitCtx.region.startCol &&
    hitCtx.col <= hitCtx.region.endCol
  );
}
