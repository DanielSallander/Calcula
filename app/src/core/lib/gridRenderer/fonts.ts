//! FILENAME: app/src/core/lib/gridRenderer/fonts.ts
// PURPOSE: Point<->pixel font conversion + the canonical Canvas cell-font builder.
// CONTEXT: Excel and the .xlsx/.cala file formats store font sizes in POINTS.
//          The Canvas 2D API measures fonts in PIXELS. At the CSS reference of
//          96 DPI, 1pt = 96/72 px, so 11pt Calibri renders at ~14.667px (which is
//          what Excel draws). Every canvas cell-text render/measure site MUST route
//          its stored point size through here so the grid matches Excel exactly and
//          so measurement (autofit) matches rendering. Core/pure.

/** CSS reference DPI (96) over the typographic point DPI (72): 1pt = 4/3 px. */
export const PT_TO_PX = 96 / 72;

/**
 * Fallback family chain appended to every cell font. If the primary family is
 * absent on the host (e.g. Calibri on a stripped Windows install), the glyphs
 * degrade to the closest-metric Windows font instead of the Canvas default
 * serif. Calibri ships with Windows itself, so this is a safety net, not the
 * common path.
 */
export const CELL_FONT_FALLBACK = `"Segoe UI", Arial, sans-serif`;

/** Convert a point font size (as stored on a cell style) to CSS pixels. */
export function pointsToPixels(points: number): number {
  return points * PT_TO_PX;
}

/**
 * Build a Canvas 2D `font` shorthand from a cell style. `sizePoints` is the
 * stored point size and is converted to pixels here; a fallback family chain is
 * appended so the primary family degrades gracefully. Use this for BOTH drawing
 * and measuring so the two never diverge.
 */
export function buildCellFont(
  fontStyle: string,
  fontWeight: string,
  sizePoints: number,
  fontFamily: string,
): string {
  const px = pointsToPixels(sizePoints);
  return `${fontStyle} ${fontWeight} ${px}px ${fontFamily}, ${CELL_FONT_FALLBACK}`.trim();
}
