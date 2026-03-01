//! FILENAME: app/extensions/BuiltIn/CellBookmarks/rendering/bookmarkDecoration.ts
// PURPOSE: Cell decoration renderer for bookmark dots.
// CONTEXT: Draws a small colored circle in the bottom-left corner of bookmarked cells.
//          Follows the same pattern as Review/rendering/triangleRenderer.ts.

import type { CellDecorationContext } from "../../../../src/api";
import { hasBookmarkAt, getBookmarkAt } from "../lib/bookmarkStore";
import { BOOKMARK_DOT_COLORS } from "../lib/bookmarkTypes";

/** Dot size in pixels */
const DOT_RADIUS = 4;
/** Padding from cell edges */
const DOT_PADDING = 5;

/**
 * Draw a colored dot in the bottom-left corner of bookmarked cells.
 * Called by the Core renderer for every visible cell during paint.
 */
export function drawBookmarkDot(context: CellDecorationContext): void {
  const { ctx, row, col, cellLeft, cellBottom } = context;

  if (!hasBookmarkAt(row, col)) {
    return;
  }

  const bookmark = getBookmarkAt(row, col);
  if (!bookmark) return;

  const color = BOOKMARK_DOT_COLORS[bookmark.color];

  const cx = cellLeft + DOT_PADDING + DOT_RADIUS;
  const cy = cellBottom - DOT_PADDING - DOT_RADIUS;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}
