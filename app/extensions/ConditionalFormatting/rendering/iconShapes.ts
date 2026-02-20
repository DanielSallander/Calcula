//! FILENAME: app/extensions/ConditionalFormatting/rendering/iconShapes.ts
// PURPOSE: Canvas drawing functions for conditional formatting icon sets.
// CONTEXT: Provides a lookup table mapping (IconSetType, iconIndex) to draw functions.

import type { IconSetType } from "../../../src/api";

// ============================================================================
// Shape Primitives
// ============================================================================

function drawUpArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + size / 2, y);
  ctx.lineTo(x + size, y + size);
  ctx.lineTo(x, y + size);
  ctx.closePath();
  ctx.fill();
}

function drawDownArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x + size / 2, y + size);
  ctx.closePath();
  ctx.fill();
}

function drawRightArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.fillStyle = color;
  const h = size * 0.3;
  ctx.beginPath();
  ctx.moveTo(x, y + size / 2 - h);
  ctx.lineTo(x + size * 0.6, y + size / 2 - h);
  ctx.lineTo(x + size * 0.6, y);
  ctx.lineTo(x + size, y + size / 2);
  ctx.lineTo(x + size * 0.6, y + size);
  ctx.lineTo(x + size * 0.6, y + size / 2 + h);
  ctx.lineTo(x, y + size / 2 + h);
  ctx.closePath();
  ctx.fill();
}

function drawCircleFilled(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
}

function drawDiamond(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + size / 2, y);
  ctx.lineTo(x + size, y + size / 2);
  ctx.lineTo(x + size / 2, y + size);
  ctx.lineTo(x, y + size / 2);
  ctx.closePath();
  ctx.fill();
}

function drawFlag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.fillStyle = color;
  // Pole
  ctx.fillRect(x + 1, y, 2, size);
  // Flag body
  ctx.beginPath();
  ctx.moveTo(x + 3, y);
  ctx.lineTo(x + size, y + 2);
  ctx.lineTo(x + size - 2, y + size * 0.45);
  ctx.lineTo(x + 3, y + size * 0.55);
  ctx.closePath();
  ctx.fill();
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.fillStyle = color;
  const cx = x + size / 2;
  const cy = y + size / 2;
  const outer = size / 2 - 1;
  const inner = outer * 0.4;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const angle = (Math.PI / 2) * -1 + (Math.PI * 2 * i) / 5;
    const rx = cx + Math.cos(angle) * outer;
    const ry = cy + Math.sin(angle) * outer;
    if (i === 0) ctx.moveTo(rx, ry);
    else ctx.lineTo(rx, ry);
    const innerAngle = angle + Math.PI / 5;
    ctx.lineTo(
      cx + Math.cos(innerAngle) * inner,
      cy + Math.sin(innerAngle) * inner
    );
  }
  ctx.closePath();
  ctx.fill();
}

function drawCheckmark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x + size * 0.15, y + size * 0.55);
  ctx.lineTo(x + size * 0.4, y + size * 0.8);
  ctx.lineTo(x + size * 0.85, y + size * 0.2);
  ctx.stroke();
}

function drawCross(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x + size * 0.2, y + size * 0.2);
  ctx.lineTo(x + size * 0.8, y + size * 0.8);
  ctx.moveTo(x + size * 0.8, y + size * 0.2);
  ctx.lineTo(x + size * 0.2, y + size * 0.8);
  ctx.stroke();
}

function drawExclamation(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  // Triangle background
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + size / 2, y);
  ctx.lineTo(x + size, y + size);
  ctx.lineTo(x, y + size);
  ctx.closePath();
  ctx.fill();
  // Exclamation mark in white
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(x + size / 2 - 1, y + size * 0.3, 2, size * 0.35);
  ctx.fillRect(x + size / 2 - 1, y + size * 0.75, 2, 2);
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  fillPercent: number
): void {
  // Empty background
  ctx.fillStyle = "#E0E0E0";
  ctx.fillRect(x, y + size * 0.35, size, size * 0.3);
  // Filled portion
  ctx.fillStyle = color;
  ctx.fillRect(x, y + size * 0.35, size * fillPercent, size * 0.3);
}

// ============================================================================
// Icon Definition Table
// ============================================================================

type DrawFn = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
) => void;

interface IconDef {
  draw: DrawFn;
  color: string;
}

/** Maps icon set type and icon index to a draw function + color */
const ICON_TABLE: Record<string, IconDef[]> = {
  threeArrows: [
    { draw: drawDownArrow, color: "#FF0000" },
    { draw: drawRightArrow, color: "#FFB628" },
    { draw: drawUpArrow, color: "#00B050" },
  ],
  threeArrowsGray: [
    { draw: drawDownArrow, color: "#808080" },
    { draw: drawRightArrow, color: "#808080" },
    { draw: drawUpArrow, color: "#808080" },
  ],
  threeFlags: [
    { draw: drawFlag, color: "#FF0000" },
    { draw: drawFlag, color: "#FFB628" },
    { draw: drawFlag, color: "#00B050" },
  ],
  threeTrafficLights1: [
    { draw: drawCircleFilled, color: "#FF0000" },
    { draw: drawCircleFilled, color: "#FFB628" },
    { draw: drawCircleFilled, color: "#00B050" },
  ],
  threeTrafficLights2: [
    { draw: drawCircleFilled, color: "#FF0000" },
    { draw: drawCircleFilled, color: "#FFB628" },
    { draw: drawCircleFilled, color: "#00B050" },
  ],
  threeSigns: [
    { draw: drawDiamond, color: "#FF0000" },
    { draw: drawExclamation, color: "#FFB628" },
    { draw: drawCircleFilled, color: "#00B050" },
  ],
  threeSymbols: [
    { draw: drawCross, color: "#FF0000" },
    { draw: drawExclamation, color: "#FFB628" },
    { draw: drawCheckmark, color: "#00B050" },
  ],
  threeSymbols2: [
    { draw: drawCross, color: "#FF0000" },
    { draw: drawExclamation, color: "#FFB628" },
    { draw: drawCheckmark, color: "#00B050" },
  ],
  threeStars: [
    { draw: drawStar, color: "#C0C0C0" },
    { draw: drawStar, color: "#FFB628" },
    { draw: drawStar, color: "#FFD700" },
  ],
  threeTriangles: [
    { draw: drawDownArrow, color: "#FF0000" },
    { draw: drawDiamond, color: "#FFB628" },
    { draw: drawUpArrow, color: "#00B050" },
  ],
  fourArrows: [
    { draw: drawDownArrow, color: "#FF0000" },
    { draw: (ctx, x, y, s, c) => { ctx.save(); ctx.translate(x + s / 2, y + s / 2); ctx.rotate(Math.PI / 4); drawDownArrow(ctx, -s / 2, -s / 2, s, c); ctx.restore(); }, color: "#FFB628" },
    { draw: (ctx, x, y, s, c) => { ctx.save(); ctx.translate(x + s / 2, y + s / 2); ctx.rotate(-Math.PI / 4); drawUpArrow(ctx, -s / 2, -s / 2, s, c); ctx.restore(); }, color: "#92D050" },
    { draw: drawUpArrow, color: "#00B050" },
  ],
  fourArrowsGray: [
    { draw: drawDownArrow, color: "#808080" },
    { draw: drawRightArrow, color: "#A0A0A0" },
    { draw: drawRightArrow, color: "#A0A0A0" },
    { draw: drawUpArrow, color: "#808080" },
  ],
  fourRating: [
    { draw: (ctx, x, y, s, c) => drawBar(ctx, x, y, s, c, 0.25), color: "#FF0000" },
    { draw: (ctx, x, y, s, c) => drawBar(ctx, x, y, s, c, 0.5), color: "#FFB628" },
    { draw: (ctx, x, y, s, c) => drawBar(ctx, x, y, s, c, 0.75), color: "#92D050" },
    { draw: (ctx, x, y, s, c) => drawBar(ctx, x, y, s, c, 1.0), color: "#00B050" },
  ],
  fourTrafficLights: [
    { draw: drawCircleFilled, color: "#000000" },
    { draw: drawCircleFilled, color: "#FF0000" },
    { draw: drawCircleFilled, color: "#FFB628" },
    { draw: drawCircleFilled, color: "#00B050" },
  ],
  fourRedToBlack: [
    { draw: drawCircleFilled, color: "#000000" },
    { draw: drawCircleFilled, color: "#808080" },
    { draw: drawCircleFilled, color: "#FF6060" },
    { draw: drawCircleFilled, color: "#FF0000" },
  ],
  fiveArrows: [
    { draw: drawDownArrow, color: "#FF0000" },
    { draw: (ctx, x, y, s, c) => { ctx.save(); ctx.translate(x + s / 2, y + s / 2); ctx.rotate(Math.PI / 4); drawDownArrow(ctx, -s / 2, -s / 2, s, c); ctx.restore(); }, color: "#FFB628" },
    { draw: drawRightArrow, color: "#FFD700" },
    { draw: (ctx, x, y, s, c) => { ctx.save(); ctx.translate(x + s / 2, y + s / 2); ctx.rotate(-Math.PI / 4); drawUpArrow(ctx, -s / 2, -s / 2, s, c); ctx.restore(); }, color: "#92D050" },
    { draw: drawUpArrow, color: "#00B050" },
  ],
  fiveArrowsGray: [
    { draw: drawDownArrow, color: "#808080" },
    { draw: drawDownArrow, color: "#A0A0A0" },
    { draw: drawRightArrow, color: "#C0C0C0" },
    { draw: drawUpArrow, color: "#A0A0A0" },
    { draw: drawUpArrow, color: "#808080" },
  ],
  fiveRating: [
    { draw: (ctx, x, y, s, c) => drawBar(ctx, x, y, s, c, 0.0), color: "#E0E0E0" },
    { draw: (ctx, x, y, s, c) => drawBar(ctx, x, y, s, c, 0.25), color: "#FF0000" },
    { draw: (ctx, x, y, s, c) => drawBar(ctx, x, y, s, c, 0.5), color: "#FFB628" },
    { draw: (ctx, x, y, s, c) => drawBar(ctx, x, y, s, c, 0.75), color: "#92D050" },
    { draw: (ctx, x, y, s, c) => drawBar(ctx, x, y, s, c, 1.0), color: "#00B050" },
  ],
  fiveQuarters: [
    { draw: drawCircleFilled, color: "#FFFFFF" },
    { draw: drawCircleFilled, color: "#C0C0C0" },
    { draw: drawCircleFilled, color: "#808080" },
    { draw: drawCircleFilled, color: "#404040" },
    { draw: drawCircleFilled, color: "#000000" },
  ],
  fiveBoxes: [
    { draw: (ctx, x, y, s, c) => { ctx.fillStyle = c; ctx.fillRect(x, y + s * 0.2, s, s * 0.6); }, color: "#FFFFFF" },
    { draw: (ctx, x, y, s, c) => { ctx.fillStyle = c; ctx.fillRect(x, y + s * 0.2, s, s * 0.6); }, color: "#C0C0C0" },
    { draw: (ctx, x, y, s, c) => { ctx.fillStyle = c; ctx.fillRect(x, y + s * 0.2, s, s * 0.6); }, color: "#808080" },
    { draw: (ctx, x, y, s, c) => { ctx.fillStyle = c; ctx.fillRect(x, y + s * 0.2, s, s * 0.6); }, color: "#404040" },
    { draw: (ctx, x, y, s, c) => { ctx.fillStyle = c; ctx.fillRect(x, y + s * 0.2, s, s * 0.6); }, color: "#000000" },
  ],
};

/**
 * Draw an icon from an icon set.
 * @param ctx - Canvas rendering context
 * @param iconSetType - The icon set type (e.g., "threeTrafficLights1")
 * @param iconIndex - Zero-based icon index (0 = lowest/worst, N-1 = highest/best)
 * @param x - X position
 * @param y - Y position
 * @param size - Icon size in pixels
 */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  iconSetType: IconSetType,
  iconIndex: number,
  x: number,
  y: number,
  size: number
): void {
  const icons = ICON_TABLE[iconSetType];
  if (!icons) return;

  const idx = Math.max(0, Math.min(iconIndex, icons.length - 1));
  const def = icons[idx];
  def.draw(ctx, x, y, size, def.color);
}
