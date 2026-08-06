//! FILENAME: app/extensions/DataValidation/rendering/dropdownChevronRenderer.ts
// PURPOSE: Grid overlay renderer for dropdown chevron arrows on list-validated cells.
// CONTEXT: Draws a small down-arrow button on cells with list validation + inCellDropdown.

import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  type OverlayRenderContext,
  type OverlayHitTestContext,
} from "@api";
import { getChevronRect, isPointInChevron } from "../lib/chevronGeometry";
import { getCellCanvasRect } from "../lib/gridGeometry";

/**
 * Render dropdown chevrons on cells with list validation + inCellDropdown.
 * Called by the grid overlay system during each paint cycle.
 * Grid regions of type "validation-dropdown" are added by validationStore.
 */
export function renderDropdownChevrons(ctx: OverlayRenderContext): void {
  const region = ctx.region;
  if (!region || region.type !== "validation-dropdown") return;

  const canvasCtx = ctx.ctx;

  const row = region.startRow;
  const col = region.startCol;
  const colX = overlayGetColumnX(ctx, col);
  const rowY = overlayGetRowY(ctx, row);
  const colWidth = overlayGetColumnWidth(ctx, col);
  const rowHeight = overlayGetRowHeight(ctx, row);

  if (rowHeight <= 0 || colWidth <= 0) return; // Hidden row/col

  // Position the button from the SHARED geometry, so the pixels drawn here are
  // exactly the pixels the click interceptor claims.
  const btn = getChevronRect({ x: colX, y: rowY, width: colWidth, height: rowHeight });
  if (btn.width <= 0 || btn.height <= 0) return;

  const btnX = btn.x;
  const btnY = btn.y;
  const btnWidth = btn.width;
  const btnHeight = btn.height;

  canvasCtx.save();

  // Draw button background
  canvasCtx.fillStyle = "#f8f8f8";
  canvasCtx.strokeStyle = "#c0c0c0";
  canvasCtx.lineWidth = 1;

  // Simple rectangle button
  canvasCtx.fillRect(btnX, btnY, btnWidth, btnHeight);
  canvasCtx.strokeRect(btnX, btnY, btnWidth, btnHeight);

  // Draw down-arrow chevron centered in the button
  const centerX = btnX + btnWidth / 2;
  const centerY = btnY + btnHeight / 2;

  canvasCtx.strokeStyle = "#333333";
  canvasCtx.lineWidth = 1.5;
  canvasCtx.lineCap = "round";
  canvasCtx.lineJoin = "round";
  canvasCtx.beginPath();
  canvasCtx.moveTo(centerX - 4, centerY - 2);
  canvasCtx.lineTo(centerX, centerY + 2);
  canvasCtx.lineTo(centerX + 4, centerY - 2);
  canvasCtx.stroke();

  canvasCtx.restore();
}

/**
 * Hit test for dropdown chevron buttons.
 * Returns true only when the point is within the chevron BUTTON of the region's
 * cell — the rest of the cell belongs to normal grid selection.
 *
 * The point is tested geometrically when the grid state is resolvable; if it is
 * not, the test fails closed (false) rather than claiming the whole cell.
 */
export function hitTestDropdownChevron(ctx: OverlayHitTestContext): boolean {
  const region = ctx.region;
  if (!region || region.type !== "validation-dropdown") return false;

  // A region covers exactly one cell (see syncDropdownChevronRegions).
  if (ctx.row !== region.startRow || ctx.col !== region.startCol) return false;

  const cell = getCellCanvasRect(region.startRow, region.startCol);
  if (!cell) return false;

  return isPointInChevron(ctx.canvasX, ctx.canvasY, cell);
}

/**
 * Cursor over a list-validated cell: a pointer on the chevron BUTTON, the grid's
 * own cell cursor everywhere else. This is the affordance for the narrowed hit
 * area — the arrow looks clickable, the cell body looks selectable.
 */
export function getDropdownChevronCursor(ctx: OverlayHitTestContext): string | null {
  return hitTestDropdownChevron(ctx) ? "pointer" : null;
}
