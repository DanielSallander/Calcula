//! FILENAME: app/extensions/Pivot/rendering/pivotCrossFilterBadge.ts
// PURPOSE: The badge a canvas pivot box paints while another visual's
//          selection reaches it (P4, G4, S7): "Filtered by <source>" over the
//          filtered view, or "Not filtered by <source>: <reason>" over the
//          REAL view when the backend refused the filtered one.
// CONTEXT: Drawn in the top-right corner of the box's CONTENT rect, clipped to
//          it, in the pivot's own theme tokens (the header band's colours for
//          "filtered", the value area's with the selection border for a
//          refusal), so it follows the PivotTable style like the cells do.
//          Text wider than the box wraps at spaces onto at most
//          PIVOT_BADGE_MAX_LINES lines (a refusal's reason is a sentence); the
//          last line is cut with "..." when even that is not enough.

import type { PivotTheme } from "./pivot";
import type { PivotVisualBox } from "./pivotVisualRenderer";
import type { PivotCrossFilterBadge } from "../lib/pivotCrossFilterView";

/** Inner padding of the badge, px. */
const PAD_X = 6;
/** Height of one badge line, px. */
export const PIVOT_BADGE_LINE_HEIGHT = 16;
/** The most lines a badge wraps onto. */
export const PIVOT_BADGE_MAX_LINES = 3;
/** Vertical padding of the badge, px. */
const PAD_Y = 2;
/** Distance from the content rect's top and right edges, px. */
const INSET = 4;

/** `text` cut to `maxWidth` (measured), ending in "..." when it was cut. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "...";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis;
}

/**
 * `text` broken at spaces into lines no wider than `maxWidth`, at most
 * `maxLines`; a word wider than a line, and the last line when text is left
 * over, are cut with "...".
 */
export function wrapBadgeText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== "");
  const lines: string[] = [];
  let line = "";
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    const candidate = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      i++;
      continue;
    }
    if (!line) {
      // One word wider than the line: cut it.
      lines.push(fitText(ctx, words[i], maxWidth));
      i++;
      continue;
    }
    lines.push(line);
    line = "";
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (i < words.length && lines.length > 0) {
    const rest = [lines[lines.length - 1], ...words.slice(i)].join(" ");
    lines[lines.length - 1] = fitText(ctx, rest, maxWidth);
  }
  return lines.length > 0 ? lines : [""];
}

/**
 * Paint `badge` in the top-right of `box`. Returns the rect it covered (box
 * canvas px), or null when the box is too small to hold one.
 */
export function paintPivotCrossFilterBadge(
  ctx: CanvasRenderingContext2D,
  box: PivotVisualBox,
  badge: PivotCrossFilterBadge,
  theme: PivotTheme,
): { x: number; y: number; width: number; height: number } | null {
  const maxWidth = box.width - 2 * INSET;
  if (maxWidth < 2 * PAD_X + 8 || box.height < PIVOT_BADGE_LINE_HEIGHT + 2 * PAD_Y + 2 * INSET) return null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.font = `${Math.max(9, Math.round(theme.fontSize * 0.9))}px ${theme.fontFamily}`;
  const fitLines = Math.max(1, Math.floor((box.height - 2 * INSET - 2 * PAD_Y) / PIVOT_BADGE_LINE_HEIGHT));
  const lines = wrapBadgeText(ctx, badge.text, maxWidth - 2 * PAD_X, Math.min(PIVOT_BADGE_MAX_LINES, fitLines));
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const width = Math.min(maxWidth, Math.ceil(widest) + 2 * PAD_X);
  const rect = {
    x: box.x + box.width - INSET - width,
    y: box.y + INSET,
    width,
    height: lines.length * PIVOT_BADGE_LINE_HEIGHT + 2 * PAD_Y,
  };
  const filtered = badge.kind === "filtered";
  ctx.fillStyle = filtered ? theme.headerBackground : theme.valueBackground;
  ctx.strokeStyle = filtered ? theme.headerBorderColor : theme.selectionBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = filtered ? theme.headerText : theme.valueText;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  lines.forEach((line, n) => {
    ctx.fillText(line, rect.x + PAD_X, rect.y + PAD_Y + (n + 0.5) * PIVOT_BADGE_LINE_HEIGHT);
  });
  ctx.restore();
  return rect;
}
