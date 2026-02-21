//! FILENAME: app/extensions/Tracing/lib/arrowGeometry.ts
// PURPOSE: Compute pixel coordinates for trace arrows on the canvas.
// CONTEXT: Maps cell row/col to canvas pixel positions using the overlay API helpers.

import type { OverlayRenderContext } from "../../../src/api";
import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlayGetColumnsWidth,
  overlayGetRowsHeight,
} from "../../../src/api";
import type { TraceArrow, ArrowPath } from "../types";

// ============================================================================
// Constants
// ============================================================================

/** Pixel offset for cross-sheet icon from the source cell edge. */
const CROSS_SHEET_OFFSET_X = 50;

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute the pixel path for a trace arrow.
 *
 * @returns The arrow path with start/end coordinates and angle, or null if
 *          both endpoints are off-screen.
 */
export function computeArrowPath(
  arrow: TraceArrow,
  ctx: OverlayRenderContext,
): ArrowPath | null {
  let startX: number;
  let startY: number;
  let endX: number;
  let endY: number;

  // Compute source cell center
  const srcX = overlayGetColumnX(ctx, arrow.sourceCol);
  const srcW = overlayGetColumnWidth(ctx, arrow.sourceCol);
  const srcY = overlayGetRowY(ctx, arrow.sourceRow);
  const srcH = overlayGetRowHeight(ctx, arrow.sourceRow);
  const srcCenterX = srcX + srcW / 2;
  const srcCenterY = srcY + srcH / 2;

  if (arrow.isCrossSheet) {
    // Cross-sheet arrows: from source center to an icon offset to the right
    startX = srcCenterX;
    startY = srcCenterY;
    endX = srcX + srcW + CROSS_SHEET_OFFSET_X;
    endY = srcCenterY;
  } else if (arrow.targetRange) {
    // Range arrows: from source center to the nearest edge midpoint of the range border
    const rangePath = computeRangeArrowEndpoint(
      srcCenterX,
      srcCenterY,
      arrow.targetRange,
      ctx,
    );
    startX = srcCenterX;
    startY = srcCenterY;
    endX = rangePath.x;
    endY = rangePath.y;
  } else {
    // Single cell arrows: from source center to target cell center
    const tgtX = overlayGetColumnX(ctx, arrow.targetCol);
    const tgtW = overlayGetColumnWidth(ctx, arrow.targetCol);
    const tgtY = overlayGetRowY(ctx, arrow.targetRow);
    const tgtH = overlayGetRowHeight(ctx, arrow.targetRow);
    const tgtCenterX = tgtX + tgtW / 2;
    const tgtCenterY = tgtY + tgtH / 2;

    startX = srcCenterX;
    startY = srcCenterY;
    endX = tgtCenterX;
    endY = tgtCenterY;
  }

  // For "precedents" direction, arrows point FROM the target TO the source.
  // Swap start/end so the arrowhead is at the source cell.
  if (arrow.direction === "precedents") {
    const tmpX = startX;
    const tmpY = startY;
    startX = endX;
    startY = endY;
    endX = tmpX;
    endY = tmpY;
  }

  // Off-screen culling: skip if both endpoints are far outside the canvas
  const margin = 100;
  if (
    startX < -margin &&
    endX < -margin ||
    startY < -margin &&
    endY < -margin ||
    startX > ctx.canvasWidth + margin &&
    endX > ctx.canvasWidth + margin ||
    startY > ctx.canvasHeight + margin &&
    endY > ctx.canvasHeight + margin
  ) {
    return null;
  }

  const angle = Math.atan2(endY - startY, endX - startX);

  return { startX, startY, endX, endY, angle };
}

/**
 * Get the pixel rectangle for a target range (for border drawing).
 */
export function getRangeRect(
  range: { startRow: number; startCol: number; endRow: number; endCol: number },
  ctx: OverlayRenderContext,
): { x: number; y: number; width: number; height: number } {
  const x = overlayGetColumnX(ctx, range.startCol);
  const y = overlayGetRowY(ctx, range.startRow);
  const width = overlayGetColumnsWidth(ctx, range.startCol, range.endCol);
  const height = overlayGetRowsHeight(ctx, range.startRow, range.endRow);
  return { x, y, width, height };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Compute the endpoint for an arrow targeting a range.
 * The endpoint is the midpoint of the nearest edge of the range's bounding rectangle.
 */
function computeRangeArrowEndpoint(
  srcX: number,
  srcY: number,
  range: { startRow: number; startCol: number; endRow: number; endCol: number },
  ctx: OverlayRenderContext,
): { x: number; y: number } {
  const rect = getRangeRect(range, ctx);

  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;

  // Determine which edge is closest to the source point
  const distances = [
    { x: midX, y: top, dist: Math.abs(srcY - top) },       // top edge
    { x: midX, y: bottom, dist: Math.abs(srcY - bottom) },  // bottom edge
    { x: left, y: midY, dist: Math.abs(srcX - left) },      // left edge
    { x: right, y: midY, dist: Math.abs(srcX - right) },    // right edge
  ];

  // If source is inside the range, pick the edge with the smallest distance
  // Otherwise pick the closest edge
  distances.sort((a, b) => a.dist - b.dist);
  return { x: distances[0].x, y: distances[0].y };
}
