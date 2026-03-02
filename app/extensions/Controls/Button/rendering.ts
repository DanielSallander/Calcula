//! FILENAME: app/extensions/Controls/Button/rendering.ts
// PURPOSE: Canvas rendering logic for in-cell button controls.
// CONTEXT: Registered as a cell decoration. Draws button graphics
//          for cells whose style has button=true.

import type { CellDecorationContext } from "../../../src/api/cellDecorations";
import { getDesignMode } from "../lib/designMode";

// ============================================================================
// Button Drawing
// ============================================================================

/**
 * Cell decoration function that renders button graphics.
 * Called for every visible cell during the render loop.
 * Only draws for cells whose style has button=true.
 */
export function drawButton(context: CellDecorationContext): void {
  const {
    ctx,
    cellLeft,
    cellTop,
    cellRight,
    cellBottom,
    styleIndex,
    display,
    styleCache,
  } = context;

  // Look up the full style to check the button flag
  const style = styleCache.get(styleIndex) ?? styleCache.get(0);
  if (!style || !style.button) {
    return;
  }

  const cellWidth = cellRight - cellLeft;
  const cellHeight = cellBottom - cellTop;

  if (cellWidth < 16 || cellHeight < 12) {
    return; // Cell too small to render a button
  }

  // Button dimensions with padding
  const padX = 2;
  const padY = 2;
  const btnLeft = cellLeft + padX;
  const btnTop = cellTop + padY;
  const btnWidth = cellWidth - padX * 2;
  const btnHeight = cellHeight - padY * 2;
  const borderRadius = 3;

  const isDesignMode = getDesignMode();

  // Draw button background with gradient-like 3D effect
  const bgColor = "#e0e0e0";
  const borderColor = "#999999";
  const highlightColor = "#f0f0f0";

  // Background fill
  ctx.beginPath();
  ctx.roundRect(btnLeft, btnTop, btnWidth, btnHeight, borderRadius);
  ctx.fillStyle = bgColor;
  ctx.fill();

  // Top highlight for 3D effect
  ctx.beginPath();
  ctx.roundRect(btnLeft, btnTop, btnWidth, btnHeight / 2, [borderRadius, borderRadius, 0, 0]);
  ctx.fillStyle = highlightColor;
  ctx.globalAlpha = 0.4;
  ctx.fill();
  ctx.globalAlpha = 1.0;

  // Border
  ctx.beginPath();
  ctx.roundRect(btnLeft + 0.5, btnTop + 0.5, btnWidth - 1, btnHeight - 1, borderRadius);
  ctx.lineWidth = 1;
  ctx.strokeStyle = borderColor;
  ctx.stroke();

  // Button text (from cell display value)
  const text = display || "Button";
  const fontSize = style.fontSize || 11;
  const textColor = style.textColor || "#000000";

  ctx.font = `${fontSize}px ${style.fontFamily || "system-ui"}`;
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const centerX = btnLeft + btnWidth / 2;
  const centerY = btnTop + btnHeight / 2;

  // Clip text to button bounds
  ctx.save();
  ctx.beginPath();
  ctx.rect(btnLeft + 4, btnTop, btnWidth - 8, btnHeight);
  ctx.clip();
  ctx.fillText(text, centerX, centerY);
  ctx.restore();

  // Design mode indicator: dotted border overlay
  if (isDesignMode) {
    ctx.beginPath();
    ctx.roundRect(btnLeft - 1, btnTop - 1, btnWidth + 2, btnHeight + 2, borderRadius + 1);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#0078d4";
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
