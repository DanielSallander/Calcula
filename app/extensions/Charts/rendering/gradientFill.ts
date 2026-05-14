//! FILENAME: app/extensions/Charts/rendering/gradientFill.ts
// PURPOSE: Canvas 2D gradient creation utilities for chart rendering.
// CONTEXT: Converts GradientFill specifications into CanvasGradient objects
//          that can be assigned to ctx.fillStyle. Supports linear and radial gradients.

import type { GradientFill, GradientDirection } from "../types";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ============================================================================
// Direction → Coordinate Mapping
// ============================================================================

/**
 * Map a GradientDirection to start/end coordinates within a bounding box.
 * Returns [x0, y0, x1, y1] as fractions of the box dimensions.
 */
function directionToCoords(
  direction: GradientDirection,
): [number, number, number, number] {
  switch (direction) {
    case "topToBottom":           return [0.5, 0, 0.5, 1];
    case "bottomToTop":           return [0.5, 1, 0.5, 0];
    case "leftToRight":           return [0, 0.5, 1, 0.5];
    case "rightToLeft":           return [1, 0.5, 0, 0.5];
    case "topLeftToBottomRight":   return [0, 0, 1, 1];
    case "bottomRightToTopLeft":   return [1, 1, 0, 0];
    case "topRightToBottomLeft":   return [1, 0, 0, 1];
    case "bottomLeftToTopRight":   return [0, 1, 1, 0];
    default:                      return [0.5, 0, 0.5, 1];
  }
}

// ============================================================================
// Gradient Creation
// ============================================================================

/**
 * Create a CanvasGradient from a GradientFill specification.
 *
 * @param ctx  Canvas 2D context
 * @param fill Gradient specification
 * @param x    Left edge of the element being filled
 * @param y    Top edge of the element being filled
 * @param w    Width of the element
 * @param h    Height of the element
 */
export function createCanvasGradient(
  ctx: Ctx2D,
  fill: GradientFill,
  x: number,
  y: number,
  w: number,
  h: number,
): CanvasGradient {
  let gradient: CanvasGradient;

  if (fill.type === "radial") {
    // Radial gradient: centered in the bounding box
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.max(w, h) / 2;
    gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  } else {
    // Linear gradient
    const dir = fill.direction ?? "topToBottom";
    const [fx0, fy0, fx1, fy1] = directionToCoords(dir);
    gradient = ctx.createLinearGradient(
      x + fx0 * w,
      y + fy0 * h,
      x + fx1 * w,
      y + fy1 * h,
    );
  }

  // Add color stops
  for (const stop of fill.stops) {
    gradient.addColorStop(
      Math.max(0, Math.min(1, stop.offset)),
      stop.color,
    );
  }

  return gradient;
}

/**
 * Apply a fill style to the context — either a solid color or a gradient.
 * Returns true if a gradient was applied (caller may need to restore state).
 *
 * @param ctx    Canvas 2D context
 * @param color  Solid color string (base color for the element)
 * @param fill   Optional gradient fill specification
 * @param x      Element bounds (for gradient coordinate computation)
 * @param y
 * @param w
 * @param h
 */
export function applyFillStyle(
  ctx: Ctx2D,
  color: string,
  fill: GradientFill | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  if (fill && fill.stops.length >= 2) {
    ctx.fillStyle = createCanvasGradient(ctx, fill, x, y, w, h);
    return true;
  }
  ctx.fillStyle = color;
  return false;
}

/**
 * Create a simple two-stop linear gradient from a base color.
 * Useful for auto-generating a gradient from a single series color.
 *
 * @param baseColor  The series color
 * @param lighten    Amount to lighten the second stop (0-1). Default: 0.3
 * @param direction  Gradient direction. Default: "topToBottom"
 */
export function autoGradientFromColor(
  baseColor: string,
  lighten: number = 0.3,
  direction: GradientDirection = "topToBottom",
): GradientFill {
  const lightColor = lightenHexColor(baseColor, lighten);
  return {
    type: "linear",
    direction,
    stops: [
      { offset: 0, color: baseColor },
      { offset: 1, color: lightColor },
    ],
  };
}

/**
 * Lighten a hex color by mixing it towards white.
 *
 * @param hex     Hex color (#RRGGBB or #RGB)
 * @param amount  0 = no change, 1 = pure white
 */
export function lightenHexColor(hex: string, amount: number): string {
  const clean = hex.replace("#", "");
  let r: number, g: number, b: number;

  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
  } else {
    r = parseInt(clean.substring(0, 2), 16);
    g = parseInt(clean.substring(2, 4), 16);
    b = parseInt(clean.substring(4, 6), 16);
  }

  r = Math.round(r + (255 - r) * amount);
  g = Math.round(g + (255 - g) * amount);
  b = Math.round(b + (255 - b) * amount);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
