//! FILENAME: app/extensions/AutoFilter/rendering/filterChevronRenderer.ts
// PURPOSE: Grid overlay renderer that draws filter chevrons/funnels on header cells.
// CONTEXT: When AutoFilter is active, draws dropdown indicators on the header row.

import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  type OverlayRenderContext,
  type OverlayHitTestContext,
} from "../../../src/api";
import { getAutoFilterInfo } from "../lib/filterStore";

// Size of the chevron button area (pixels)
const BUTTON_SIZE = 18;
const BUTTON_MARGIN = 2;

/**
 * Render filter dropdown chevrons/funnels on header cells.
 * Called by the grid overlay system during each paint cycle.
 */
export function renderFilterChevrons(ctx: OverlayRenderContext): void {
  const info = getAutoFilterInfo();
  if (!info || !info.enabled) return;

  const canvasCtx = ctx.ctx;
  const headerRow = info.startRow;

  for (let col = info.startCol; col <= info.endCol; col++) {
    const colX = overlayGetColumnX(ctx, col);
    const rowY = overlayGetRowY(ctx, headerRow);
    const colWidth = overlayGetColumnWidth(ctx, col);
    const rowHeight = overlayGetRowHeight(ctx, headerRow);

    if (rowHeight <= 0) continue; // Hidden row

    // Position the button in the bottom-right corner of the header cell
    const btnX = colX + colWidth - BUTTON_SIZE - BUTTON_MARGIN;
    const btnY = rowY + rowHeight - BUTTON_SIZE - BUTTON_MARGIN;

    // Check if this column has an active filter
    const relCol = col - info.startCol;
    const hasActiveFilter = info.criteria[relCol] != null;

    // Draw button background
    canvasCtx.save();
    canvasCtx.fillStyle = hasActiveFilter ? "#e8f0fe" : "#f0f0f0";
    canvasCtx.strokeStyle = hasActiveFilter ? "#1a73e8" : "#c0c0c0";
    canvasCtx.lineWidth = 1;

    // Rounded rect
    const radius = 3;
    canvasCtx.beginPath();
    canvasCtx.moveTo(btnX + radius, btnY);
    canvasCtx.lineTo(btnX + BUTTON_SIZE - radius, btnY);
    canvasCtx.arcTo(btnX + BUTTON_SIZE, btnY, btnX + BUTTON_SIZE, btnY + radius, radius);
    canvasCtx.lineTo(btnX + BUTTON_SIZE, btnY + BUTTON_SIZE - radius);
    canvasCtx.arcTo(btnX + BUTTON_SIZE, btnY + BUTTON_SIZE, btnX + BUTTON_SIZE - radius, btnY + BUTTON_SIZE, radius);
    canvasCtx.lineTo(btnX + radius, btnY + BUTTON_SIZE);
    canvasCtx.arcTo(btnX, btnY + BUTTON_SIZE, btnX, btnY + BUTTON_SIZE - radius, radius);
    canvasCtx.lineTo(btnX, btnY + radius);
    canvasCtx.arcTo(btnX, btnY, btnX + radius, btnY, radius);
    canvasCtx.closePath();
    canvasCtx.fill();
    canvasCtx.stroke();

    // Draw icon
    const centerX = btnX + BUTTON_SIZE / 2;
    const centerY = btnY + BUTTON_SIZE / 2;

    if (hasActiveFilter) {
      // Draw funnel icon for active filter
      drawFunnelIcon(canvasCtx, centerX, centerY, "#1a73e8");
    } else {
      // Draw chevron (down arrow) for inactive filter
      drawChevronIcon(canvasCtx, centerX, centerY, "#666666");
    }

    canvasCtx.restore();
  }
}

/**
 * Draw a small down-arrow chevron.
 */
function drawChevronIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy - 2);
  ctx.lineTo(cx, cy + 2);
  ctx.lineTo(cx + 4, cy - 2);
  ctx.stroke();
}

/**
 * Draw a small funnel icon for active filters.
 */
function drawFunnelIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  // Funnel shape: wide top, narrow bottom with a stem
  ctx.moveTo(cx - 5, cy - 4);  // Top-left
  ctx.lineTo(cx + 5, cy - 4);  // Top-right
  ctx.lineTo(cx + 1, cy);      // Narrow right
  ctx.lineTo(cx + 1, cy + 4);  // Stem right
  ctx.lineTo(cx - 1, cy + 4);  // Stem left
  ctx.lineTo(cx - 1, cy);      // Narrow left
  ctx.closePath();
  ctx.fill();
}

/**
 * Hit test for chevron buttons.
 * Returns true if the click is within a filter chevron area.
 */
export function hitTestFilterChevron(ctx: OverlayHitTestContext): boolean {
  const info = getAutoFilterInfo();
  if (!info || !info.enabled) return false;

  // Only hit-test the header row
  if (ctx.row !== info.startRow) return false;

  // Only hit-test columns in the filter range
  if (ctx.col < info.startCol || ctx.col > info.endCol) return false;

  return true;
}

/**
 * Get the chevron button rect for a given column (for positioning the dropdown).
 * Returns null if no AutoFilter is active or column is out of range.
 */
export function getChevronRect(
  col: number,
  canvas: HTMLCanvasElement,
  ctx: OverlayRenderContext
): { x: number; y: number; width: number; height: number } | null {
  const info = getAutoFilterInfo();
  if (!info || !info.enabled) return null;
  if (col < info.startCol || col > info.endCol) return null;

  const colX = overlayGetColumnX(ctx, col);
  const rowY = overlayGetRowY(ctx, info.startRow);
  const colWidth = overlayGetColumnWidth(ctx, col);
  const rowHeight = overlayGetRowHeight(ctx, info.startRow);

  const canvasRect = canvas.getBoundingClientRect();
  const scaleX = canvasRect.width / canvas.width;
  const scaleY = canvasRect.height / canvas.height;

  return {
    x: canvasRect.left + (colX + colWidth - BUTTON_SIZE - BUTTON_MARGIN) * scaleX,
    y: canvasRect.top + (rowY + rowHeight) * scaleY,
    width: BUTTON_SIZE * scaleX,
    height: BUTTON_SIZE * scaleY,
  };
}
