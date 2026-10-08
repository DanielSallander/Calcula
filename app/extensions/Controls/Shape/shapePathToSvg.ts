//! FILENAME: app/extensions/Controls/Shape/shapePathToSvg.ts
// PURPOSE: Convert ShapePathCommand[] to SVG path `d` attribute string.
// CONTEXT: Used by ShapeGalleryOverlay to render shape thumbnails as inline SVGs,
//          and by the @api/controlsService catalog (shapeThumbnail) so a host
//          outside Controls -- the Canvas tab's Shapes menu -- shows the same
//          pictures without importing this extension.

import type { ShapeDefinition, ShapePathCommand } from "./shapeCatalog";

/**
 * Convert an array of ShapePathCommand (normalized 0-1 coordinates)
 * to an SVG path `d` attribute string.
 */
export function shapePathToSvgD(commands: ShapePathCommand[]): string {
  const parts: string[] = [];
  for (const cmd of commands) {
    switch (cmd.op) {
      case "M":
        parts.push(`M ${cmd.x} ${cmd.y}`);
        break;
      case "L":
        parts.push(`L ${cmd.x} ${cmd.y}`);
        break;
      case "C":
        parts.push(`C ${cmd.x1} ${cmd.y1} ${cmd.x2} ${cmd.y2} ${cmd.x} ${cmd.y}`);
        break;
      case "Q":
        parts.push(`Q ${cmd.x1} ${cmd.y1} ${cmd.x} ${cmd.y}`);
        break;
      case "Z":
        parts.push("Z");
        break;
    }
  }
  return parts.join(" ");
}

// ============================================================================
// Thumbnails for the @api/controlsService catalog (Canvas contract §4.3)
// ============================================================================

/** The margin around a thumbnail's drawing, in unit-square units: room for a
 *  0.04 stroke on both sides, the same frame the insert gallery draws in
 *  (`viewBox="-0.05 -0.05 1.1 1.1"`, ShapeGalleryOverlay.tsx). */
const THUMBNAIL_MARGIN = 0.05;

/** A coordinate for a thumbnail path: four decimals, no trailing zeros, no "-0".
 *  Polygons come from cos/sin and would otherwise print 17 digits; a hundredth
 *  of a pixel at 160px is as fine as a menu picture can show. */
function thumbNumber(v: number): string {
  const rounded = Math.round(v * 10000) / 10000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * The thumbnail of a catalog shape: its own normalized path as an SVG `d`
 * (rounded, see `thumbNumber`) and a `viewBox` that frames the WHOLE drawing.
 *
 * The frame is the unit square plus the margin, grown to cover any point that
 * lies outside it -- a callout's tail, an arrow's head -- because a fixed
 * square frame would clip exactly the part that tells those shapes apart.
 * Control points count too: a curve stays inside the hull of its control
 * points, so covering them covers the curve.
 */
export function shapeThumbnail(def: Pick<ShapeDefinition, "path">): { viewBox: string; d: string } {
  let minX = 0;
  let minY = 0;
  let maxX = 1;
  let maxY = 1;
  const parts: string[] = [];
  const cover = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const cmd of def.path) {
    switch (cmd.op) {
      case "M":
      case "L":
        cover(cmd.x, cmd.y);
        parts.push(`${cmd.op} ${thumbNumber(cmd.x)} ${thumbNumber(cmd.y)}`);
        break;
      case "C":
        cover(cmd.x1, cmd.y1);
        cover(cmd.x2, cmd.y2);
        cover(cmd.x, cmd.y);
        parts.push(
          `C ${thumbNumber(cmd.x1)} ${thumbNumber(cmd.y1)} ${thumbNumber(cmd.x2)} ${thumbNumber(cmd.y2)} ` +
            `${thumbNumber(cmd.x)} ${thumbNumber(cmd.y)}`,
        );
        break;
      case "Q":
        cover(cmd.x1, cmd.y1);
        cover(cmd.x, cmd.y);
        parts.push(`Q ${thumbNumber(cmd.x1)} ${thumbNumber(cmd.y1)} ${thumbNumber(cmd.x)} ${thumbNumber(cmd.y)}`);
        break;
      case "Z":
        parts.push("Z");
        break;
    }
  }
  const x = minX - THUMBNAIL_MARGIN;
  const y = minY - THUMBNAIL_MARGIN;
  const w = maxX - minX + 2 * THUMBNAIL_MARGIN;
  const h = maxY - minY + 2 * THUMBNAIL_MARGIN;
  return {
    viewBox: [x, y, w, h].map(thumbNumber).join(" "),
    d: parts.join(" "),
  };
}
