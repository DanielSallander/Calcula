//! FILENAME: app/extensions/_shared/lib/headerTitlePaint.ts
// PURPOSE: Paint a headered filter object's header TITLE (a slicer's or a
//          timeline's header bar text) from its visual container's RESOLVED
//          title style -- font, size, bold / italic, colour, alignment and
//          underline -- shared by Slicer/rendering/slicerRenderer.ts and
//          TimelineSlicer/rendering/timelineSlicerRenderer.ts.
// CONTEXT: WP-C D-FORMAT: those two families paint their own title
//          (`paint.title: "family"`), so the Format tab's Title card must reach
//          their header text through ONE rule rather than two copies.
//          A header is one line: it never wraps, and a long title is squeezed
//          into its width by `fillText`'s maxWidth.

import type { ResolvedVisualText } from "@api/visualContainer";
import { visualTextFont } from "@api/visualContainerPaint";

/**
 * Draw `text` styled by `title` between `left` and `right` (canvas px),
 * vertically centred on `midY`. Leaves `textAlign` at "left".
 */
export function drawHeaderTitle(
  c: CanvasRenderingContext2D,
  title: ResolvedVisualText,
  text: string,
  left: number,
  right: number,
  midY: number,
): void {
  const maxWidth = Math.max(0, right - left);
  if (maxWidth <= 0 || text === "") return;
  c.fillStyle = title.color;
  c.font = visualTextFont(title);
  c.textBaseline = "middle";
  const x = title.align === "center" ? left + maxWidth / 2 : title.align === "right" ? right : left;
  c.textAlign = title.align;
  c.fillText(text, x, midY, maxWidth);
  if (title.underline && typeof c.measureText === "function") {
    const width = Math.min(maxWidth, c.measureText(text).width);
    const xStart = title.align === "center" ? x - width / 2 : title.align === "right" ? x - width : x;
    const y = midY + Math.ceil(title.fontSize / 2) + 1;
    c.save();
    c.strokeStyle = title.color;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(xStart, y + 0.5);
    c.lineTo(xStart + width, y + 0.5);
    c.stroke();
    c.restore();
  }
  c.textAlign = "left";
}
