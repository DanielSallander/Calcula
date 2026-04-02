//! FILENAME: app/src/core/lib/gridRenderer/styles/fillRenderer.ts
// PURPOSE: Renders gradient and pattern fills on HTML5 Canvas cells.
// CONTEXT: Called by the cell renderer when a cell has a non-solid fill.

import type { FillData, PatternType } from "../../../types";

/**
 * Draw a cell fill (solid, gradient, or pattern) on the canvas.
 * Returns true if a fill was drawn, false if no fill was applicable.
 */
export function drawCellFill(
  ctx: CanvasRenderingContext2D,
  fill: FillData,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  switch (fill.type) {
    case "none":
      return false;

    case "solid":
      ctx.fillStyle = fill.color;
      ctx.fillRect(x, y, w, h);
      return true;

    case "gradient":
      drawGradientFill(ctx, fill.color1, fill.color2, fill.direction, x, y, w, h);
      return true;

    case "pattern":
      drawPatternFill(ctx, fill.patternType, fill.fgColor, fill.bgColor, x, y, w, h);
      return true;
  }
}

/**
 * Draw a two-color gradient fill.
 */
function drawGradientFill(
  ctx: CanvasRenderingContext2D,
  color1: string,
  color2: string,
  direction: string,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  let gradient: CanvasGradient;

  switch (direction) {
    case "vertical":
      gradient = ctx.createLinearGradient(x, y, x, y + h);
      break;
    case "diagonalDown":
      gradient = ctx.createLinearGradient(x, y, x + w, y + h);
      break;
    case "diagonalUp":
      gradient = ctx.createLinearGradient(x, y + h, x + w, y);
      break;
    case "fromCenter": {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const radius = Math.max(w, h) / 2;
      gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      break;
    }
    case "horizontal":
    default:
      gradient = ctx.createLinearGradient(x, y, x + w, y);
      break;
  }

  gradient.addColorStop(0, color1);
  gradient.addColorStop(1, color2);
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
}

/**
 * Draw a pattern fill with foreground pattern on background color.
 */
function drawPatternFill(
  ctx: CanvasRenderingContext2D,
  patternType: PatternType,
  fgColor: string,
  bgColor: string,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  // Draw background first
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, y, w, h);

  // Then draw the pattern on top
  if (patternType === "none" || patternType === "solid") {
    // For solid, the fg color IS the fill
    if (patternType === "solid") {
      ctx.fillStyle = fgColor;
      ctx.fillRect(x, y, w, h);
    }
    return;
  }

  // Get or create a cached pattern
  const canvasPattern = getOrCreatePattern(ctx, patternType, fgColor);
  if (canvasPattern) {
    ctx.save();
    ctx.fillStyle = canvasPattern;
    // Translate so the pattern tiles align with the cell origin
    ctx.translate(x, y);
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

// ============================================================================
// Pattern Cache
// ============================================================================

const patternCache = new Map<string, CanvasPattern | null>();

/**
 * Get or create a CanvasPattern for the given pattern type and color.
 * Patterns are cached by type+color for performance.
 */
function getOrCreatePattern(
  ctx: CanvasRenderingContext2D,
  patternType: PatternType,
  color: string
): CanvasPattern | null {
  const key = `${patternType}:${color}`;
  if (patternCache.has(key)) {
    return patternCache.get(key)!;
  }

  const tileSize = getPatternTileSize(patternType);
  const offscreen = new OffscreenCanvas(tileSize, tileSize);
  const pctx = offscreen.getContext("2d");
  if (!pctx) return null;

  drawPatternTile(pctx, patternType, color, tileSize);

  const pattern = ctx.createPattern(offscreen, "repeat");
  patternCache.set(key, pattern);
  return pattern;
}

/**
 * Clear the pattern cache (e.g., when theme changes).
 */
export function clearPatternCache(): void {
  patternCache.clear();
}

function getPatternTileSize(patternType: PatternType): number {
  switch (patternType) {
    case "darkGray":
    case "mediumGray":
    case "lightGray":
    case "gray125":
    case "gray0625":
      return 4;
    default:
      return 8;
  }
}

/**
 * Draw a single tile of the pattern on an offscreen canvas.
 */
function drawPatternTile(
  ctx: OffscreenCanvasRenderingContext2D,
  patternType: PatternType,
  color: string,
  size: number
): void {
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;

  switch (patternType) {
    // Gray density patterns - draw dots
    case "darkGray": // 75%
      ctx.fillRect(0, 0, size, size);
      ctx.clearRect(0, 0, 1, 1);
      ctx.clearRect(2, 2, 1, 1);
      break;
    case "mediumGray": // 50%
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if ((x + y) % 2 === 0) ctx.fillRect(x, y, 1, 1);
        }
      }
      break;
    case "lightGray": // 25%
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillRect(2, 2, 1, 1);
      break;
    case "gray125": // 12.5%
      ctx.fillRect(0, 0, 1, 1);
      break;
    case "gray0625": // 6.25%
      ctx.fillRect(0, 0, 1, 1);
      break;

    // Horizontal lines
    case "darkHorizontal":
      ctx.fillRect(0, 0, size, 2);
      ctx.fillRect(0, 4, size, 2);
      break;
    case "lightHorizontal":
      ctx.fillRect(0, 0, size, 1);
      break;

    // Vertical lines
    case "darkVertical":
      ctx.fillRect(0, 0, 2, size);
      ctx.fillRect(4, 0, 2, size);
      break;
    case "lightVertical":
      ctx.fillRect(0, 0, 1, size);
      break;

    // Diagonal down (\)
    case "darkDown":
      ctx.beginPath();
      for (let i = -size; i < size * 2; i += 4) {
        ctx.moveTo(i, 0);
        ctx.lineTo(i + size, size);
        ctx.moveTo(i + 1, 0);
        ctx.lineTo(i + size + 1, size);
      }
      ctx.stroke();
      break;
    case "lightDown":
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(size, size);
      ctx.stroke();
      break;

    // Diagonal up (/)
    case "darkUp":
      ctx.beginPath();
      for (let i = -size; i < size * 2; i += 4) {
        ctx.moveTo(i, size);
        ctx.lineTo(i + size, 0);
        ctx.moveTo(i + 1, size);
        ctx.lineTo(i + size + 1, 0);
      }
      ctx.stroke();
      break;
    case "lightUp":
      ctx.beginPath();
      ctx.moveTo(0, size);
      ctx.lineTo(size, 0);
      ctx.stroke();
      break;

    // Grid (cross-hatch)
    case "darkGrid":
      ctx.fillRect(0, 0, size, 2);
      ctx.fillRect(0, 4, size, 2);
      ctx.fillRect(0, 0, 2, size);
      ctx.fillRect(4, 0, 2, size);
      break;
    case "lightGrid":
      ctx.fillRect(0, 0, size, 1);
      ctx.fillRect(0, 0, 1, size);
      break;

    // Trellis (diagonal cross-hatch)
    case "darkTrellis":
      ctx.beginPath();
      for (let i = -size; i < size * 2; i += 4) {
        ctx.moveTo(i, 0);
        ctx.lineTo(i + size, size);
        ctx.moveTo(i, size);
        ctx.lineTo(i + size, 0);
      }
      ctx.stroke();
      break;
    case "lightTrellis":
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(size, size);
      ctx.moveTo(0, size);
      ctx.lineTo(size, 0);
      ctx.stroke();
      break;
  }
}
