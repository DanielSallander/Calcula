//! FILENAME: app/extensions/Review/rendering/triangleRenderer.ts
// PURPOSE: Cell decoration that draws corner triangles for annotation indicators.
// CONTEXT: Registered via registerCellDecoration. Draws red (note), purple (comment),
//          or gray (resolved comment) triangles in the top-right corner of annotated cells.

import type { CellDecorationContext } from "../../../src/api";
import { getCommentIndicatorAt, getNoteIndicatorAt } from "../lib/annotationStore";

// ============================================================================
// Constants
// ============================================================================

/** Red triangle for legacy notes */
const NOTE_COLOR = "#FF0000";

/** Purple triangle for unresolved threaded comments */
const COMMENT_COLOR = "#7B68EE";

/** Gray triangle for resolved threaded comments */
const RESOLVED_COLOR = "#A0A0A0";

/** Size of the corner triangle in pixels */
const TRIANGLE_SIZE = 6;

// ============================================================================
// Decoration Function
// ============================================================================

/**
 * Cell decoration callback that draws annotation indicator triangles.
 * Called by the Core renderer for each visible cell during the paint cycle.
 */
export function drawAnnotationTriangle(context: CellDecorationContext): void {
  const { ctx, row, col, cellRight, cellTop } = context;

  // Check for note indicator
  const noteIndicator = getNoteIndicatorAt(row, col);
  if (noteIndicator) {
    drawTriangle(ctx, cellRight, cellTop, NOTE_COLOR);
    return;
  }

  // Check for comment indicator
  const commentIndicator = getCommentIndicatorAt(row, col);
  if (commentIndicator) {
    const color = commentIndicator.resolved ? RESOLVED_COLOR : COMMENT_COLOR;
    drawTriangle(ctx, cellRight, cellTop, color);
    return;
  }
}

/**
 * Draw a filled right-triangle in the top-right corner of the cell.
 * The triangle points from (right - size, top) to (right, top) to (right, top + size).
 */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  cellRight: number,
  cellTop: number,
  color: string
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cellRight - TRIANGLE_SIZE, cellTop);
  ctx.lineTo(cellRight, cellTop);
  ctx.lineTo(cellRight, cellTop + TRIANGLE_SIZE);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
