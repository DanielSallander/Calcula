//! FILENAME: app/extensions/Tracing/rendering/traceArrowRenderer.ts
// PURPOSE: Grid overlay renderer that draws trace arrows on the canvas.
// CONTEXT: Registered as a grid overlay with priority 25 (above AutoFilter).

import type { OverlayRenderContext } from "../../../src/api";
import { getArrows } from "../lib/tracingStore";
import { computeArrowPath, getRangeRect } from "../lib/arrowGeometry";
import { drawCrossSheetIcon } from "./crossSheetIcon";

// ============================================================================
// Constants
// ============================================================================

/** Arrow colors by style. */
const COLORS: Record<string, string> = {
  "solid-blue": "#4472C4",
  "dashed-black": "#333333",
  "solid-red": "#C0392B",
};

/** Arrowhead size in pixels. */
const ARROWHEAD_SIZE = 8;

/** Half-angle of the arrowhead (radians). ~25 degrees */
const ARROWHEAD_HALF_ANGLE = Math.PI / 7;

/** Radius of the small circle at the arrow origin. */
const START_DOT_RADIUS = 3;

/** Line width for arrows. */
const LINE_WIDTH = 1.5;

/** Line width for range borders. */
const RANGE_BORDER_WIDTH = 2;

// ============================================================================
// Public API
// ============================================================================

/**
 * Render all trace arrows on the canvas.
 * Called by the core renderer for each "tracing" grid region.
 */
export function renderTraceArrows(ctx: OverlayRenderContext): void {
  const arrowList = getArrows();
  if (arrowList.length === 0) return;

  const canvasCtx = ctx.ctx;
  canvasCtx.save();

  // Draw range borders first (underneath arrows)
  for (const arrow of arrowList) {
    if (arrow.targetRange) {
      drawRangeBorder(canvasCtx, arrow, ctx);
    }
  }

  // Draw arrows
  for (const arrow of arrowList) {
    const path = computeArrowPath(arrow, ctx);
    if (!path) continue;

    const color = COLORS[arrow.style] ?? COLORS["solid-blue"];

    // Set line style
    canvasCtx.strokeStyle = color;
    canvasCtx.lineWidth = LINE_WIDTH;
    if (arrow.style === "dashed-black") {
      canvasCtx.setLineDash([6, 4]);
    } else {
      canvasCtx.setLineDash([]);
    }

    // Draw the line
    canvasCtx.beginPath();
    canvasCtx.moveTo(path.startX, path.startY);
    canvasCtx.lineTo(path.endX, path.endY);
    canvasCtx.stroke();

    // Draw arrowhead at the endpoint
    drawArrowhead(canvasCtx, path.endX, path.endY, path.angle, color);

    // Draw small dot at the start point
    canvasCtx.setLineDash([]);
    canvasCtx.fillStyle = color;
    canvasCtx.beginPath();
    canvasCtx.arc(path.startX, path.startY, START_DOT_RADIUS, 0, Math.PI * 2);
    canvasCtx.fill();

    // Cross-sheet icon at the endpoint
    if (arrow.isCrossSheet) {
      drawCrossSheetIcon(canvasCtx, path.endX, path.endY);
    }
  }

  canvasCtx.restore();
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Draw a filled triangular arrowhead.
 */
function drawArrowhead(
  canvasCtx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  angle: number,
  color: string,
): void {
  canvasCtx.save();
  canvasCtx.fillStyle = color;
  canvasCtx.setLineDash([]);
  canvasCtx.beginPath();

  // Left wing
  canvasCtx.moveTo(tipX, tipY);
  canvasCtx.lineTo(
    tipX - ARROWHEAD_SIZE * Math.cos(angle - ARROWHEAD_HALF_ANGLE),
    tipY - ARROWHEAD_SIZE * Math.sin(angle - ARROWHEAD_HALF_ANGLE),
  );

  // Right wing
  canvasCtx.lineTo(
    tipX - ARROWHEAD_SIZE * Math.cos(angle + ARROWHEAD_HALF_ANGLE),
    tipY - ARROWHEAD_SIZE * Math.sin(angle + ARROWHEAD_HALF_ANGLE),
  );

  canvasCtx.closePath();
  canvasCtx.fill();
  canvasCtx.restore();
}

/**
 * Draw a colored border around a trace range.
 */
function drawRangeBorder(
  canvasCtx: CanvasRenderingContext2D,
  arrow: { targetRange?: { startRow: number; startCol: number; endRow: number; endCol: number }; style: string },
  ctx: OverlayRenderContext,
): void {
  if (!arrow.targetRange) return;

  const rect = getRangeRect(arrow.targetRange, ctx);
  const color = COLORS[arrow.style] ?? COLORS["solid-blue"];

  canvasCtx.save();
  canvasCtx.strokeStyle = color;
  canvasCtx.lineWidth = RANGE_BORDER_WIDTH;
  canvasCtx.setLineDash([]);
  canvasCtx.strokeRect(
    rect.x + 0.5,
    rect.y + 0.5,
    rect.width - 1,
    rect.height - 1,
  );
  canvasCtx.restore();
}
