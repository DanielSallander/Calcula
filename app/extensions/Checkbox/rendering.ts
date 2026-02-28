//! FILENAME: app/extensions/Checkbox/rendering.ts
// PURPOSE: Canvas rendering logic for in-cell checkboxes.
// CONTEXT: Registered as a cell decoration. Draws checkbox graphics
//          for cells whose style has checkbox=true.

import type { CellDecorationContext } from "../../src/api/cellDecorations";

// ============================================================================
// Checkbox Drawing
// ============================================================================

/**
 * Cell decoration function that renders checkbox graphics.
 * Called for every visible cell during the render loop.
 * Only draws for cells whose style has checkbox=true.
 */
export function drawCheckbox(context: CellDecorationContext): void {
  const { ctx, cellLeft, cellTop, cellRight, cellBottom, styleIndex, display, styleCache } = context;

  // Look up the full style to check the checkbox flag
  const style = styleCache.get(styleIndex) ?? styleCache.get(0);
  if (!style || !style.checkbox) {
    return;
  }

  const cellWidth = cellRight - cellLeft;
  const cellHeight = cellBottom - cellTop;

  if (cellWidth < 8 || cellHeight < 8) {
    return; // Cell too small to render a checkbox
  }

  // Determine checkbox state
  const upperDisplay = display.toUpperCase();
  const isChecked = upperDisplay === "TRUE";
  const isGhost = display === ""; // Empty cell = ghost state

  // Calculate checkbox size - scale with font size, capped by cell dimensions
  const fontSize = style.fontSize || 11;
  const checkSize = Math.min(Math.max(Math.round(fontSize * 1.2), 10), cellHeight - 4, cellWidth - 4, 18);
  const halfSize = checkSize / 2;

  // Position: center in cell
  const centerX = (cellLeft + cellRight) / 2;
  const centerY = (cellTop + cellBottom) / 2;
  const boxLeft = Math.round(centerX - halfSize);
  const boxTop = Math.round(centerY - halfSize);

  // Determine colors from style
  let strokeColor = style.textColor || "#000000";
  // For default black text, use a slightly softer color for the box
  if (strokeColor === "#000000" || strokeColor === "rgb(0, 0, 0)") {
    strokeColor = "#404040";
  }

  // Ghost state: reduced opacity
  const globalAlpha = ctx.globalAlpha;
  if (isGhost) {
    ctx.globalAlpha = 0.3;
  }

  // Draw the checkbox box
  const borderRadius = 2;
  ctx.beginPath();
  ctx.roundRect(boxLeft + 0.5, boxTop + 0.5, checkSize - 1, checkSize - 1, borderRadius);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  // If checked, draw the checkmark
  if (isChecked) {
    // Fill the box with the stroke color
    ctx.fillStyle = strokeColor;
    ctx.beginPath();
    ctx.roundRect(boxLeft + 0.5, boxTop + 0.5, checkSize - 1, checkSize - 1, borderRadius);
    ctx.fill();

    // Draw white checkmark
    ctx.beginPath();
    const pad = checkSize * 0.2;
    const x1 = boxLeft + pad;
    const y1 = boxTop + checkSize * 0.5;
    const x2 = boxLeft + checkSize * 0.4;
    const y2 = boxTop + checkSize - pad;
    const x3 = boxLeft + checkSize - pad;
    const y3 = boxTop + pad;

    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);

    ctx.lineWidth = Math.max(1.5, checkSize * 0.15);
    ctx.strokeStyle = "#ffffff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  // Restore alpha
  if (isGhost) {
    ctx.globalAlpha = globalAlpha;
  }
}
