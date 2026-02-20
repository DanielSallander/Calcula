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
} from "../../../src/api";

// Size of the chevron button area (pixels)
const BUTTON_SIZE = 18;
const BUTTON_MARGIN = 1;

/**
 * Render dropdown chevrons on cells with list validation + inCellDropdown.
 * Called by the grid overlay system during each paint cycle.
 * Grid regions of type "validation-dropdown" are added by validationStore.
 */
export function renderDropdownChevrons(ctx: OverlayRenderContext): void {
  const regions = ctx.regions;
  if (!regions || regions.length === 0) return;

  const canvasCtx = ctx.ctx;

  for (const region of regions) {
    if (region.type !== "validation-dropdown") continue;

    const row = region.startRow;
    const col = region.startCol;
    const colX = overlayGetColumnX(ctx, col);
    const rowY = overlayGetRowY(ctx, row);
    const colWidth = overlayGetColumnWidth(ctx, col);
    const rowHeight = overlayGetRowHeight(ctx, row);

    if (rowHeight <= 0 || colWidth <= 0) continue; // Hidden row/col

    // Position the button on the right side of the cell, vertically centered
    const btnX = colX + colWidth - BUTTON_SIZE - BUTTON_MARGIN;
    const btnY = rowY + BUTTON_MARGIN;
    const btnHeight = rowHeight - BUTTON_MARGIN * 2;

    canvasCtx.save();

    // Draw button background
    canvasCtx.fillStyle = "#f8f8f8";
    canvasCtx.strokeStyle = "#c0c0c0";
    canvasCtx.lineWidth = 1;

    // Simple rectangle button
    canvasCtx.fillRect(btnX, btnY, BUTTON_SIZE, btnHeight);
    canvasCtx.strokeRect(btnX, btnY, BUTTON_SIZE, btnHeight);

    // Draw down-arrow chevron centered in the button
    const centerX = btnX + BUTTON_SIZE / 2;
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
}

/**
 * Hit test for dropdown chevron buttons.
 * Returns true if the click is within a validation dropdown chevron area.
 */
export function hitTestDropdownChevron(ctx: OverlayHitTestContext): boolean {
  const regions = ctx.regions;
  if (!regions || regions.length === 0) return false;

  // Check if the clicked cell has a dropdown region
  for (const region of regions) {
    if (region.type !== "validation-dropdown") continue;
    if (ctx.row === region.startRow && ctx.col === region.startCol) {
      return true;
    }
  }

  return false;
}
