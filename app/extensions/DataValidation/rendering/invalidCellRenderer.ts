//! FILENAME: app/extensions/DataValidation/rendering/invalidCellRenderer.ts
// PURPOSE: Grid overlay renderer for red circles around invalid cells.
// CONTEXT: Draws red dashed ovals when "Circle Invalid Data" is active.

import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  type OverlayRenderContext,
  type OverlayHitTestContext,
} from "../../../src/api";

// Circle appearance constants
const CIRCLE_COLOR = "#ff0000";
const CIRCLE_LINE_WIDTH = 1.5;
const CIRCLE_DASH = [4, 3];
const CIRCLE_PADDING_X = 3;
const CIRCLE_PADDING_Y = 2;

/**
 * Render red dashed ovals around invalid cells.
 * Called by the grid overlay system during each paint cycle.
 * Grid regions of type "validation-invalid" are added by validationStore.
 */
export function renderInvalidCells(ctx: OverlayRenderContext): void {
  const regions = ctx.regions;
  if (!regions || regions.length === 0) return;

  const canvasCtx = ctx.ctx;

  for (const region of regions) {
    if (region.type !== "validation-invalid") continue;

    const row = region.startRow;
    const col = region.startCol;
    const colX = overlayGetColumnX(ctx, col);
    const rowY = overlayGetRowY(ctx, row);
    const colWidth = overlayGetColumnWidth(ctx, col);
    const rowHeight = overlayGetRowHeight(ctx, row);

    if (rowHeight <= 0 || colWidth <= 0) continue; // Hidden row/col

    canvasCtx.save();

    // Draw a dashed red oval around the cell
    canvasCtx.strokeStyle = CIRCLE_COLOR;
    canvasCtx.lineWidth = CIRCLE_LINE_WIDTH;
    canvasCtx.setLineDash(CIRCLE_DASH);

    const centerX = colX + colWidth / 2;
    const centerY = rowY + rowHeight / 2;
    const radiusX = colWidth / 2 - CIRCLE_PADDING_X;
    const radiusY = rowHeight / 2 - CIRCLE_PADDING_Y;

    canvasCtx.beginPath();
    canvasCtx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
    canvasCtx.stroke();

    canvasCtx.restore();
  }
}

/**
 * Hit test for invalid cell circles.
 * Invalid cell circles are not interactive, so always return false.
 */
export function hitTestInvalidCell(_ctx: OverlayHitTestContext): boolean {
  return false;
}
