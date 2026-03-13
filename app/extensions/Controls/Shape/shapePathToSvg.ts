//! FILENAME: app/extensions/Controls/Shape/shapePathToSvg.ts
// PURPOSE: Convert ShapePathCommand[] to SVG path `d` attribute string.
// CONTEXT: Used by ShapeGalleryOverlay to render shape thumbnails as inline SVGs.

import type { ShapePathCommand } from "./shapeCatalog";

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
