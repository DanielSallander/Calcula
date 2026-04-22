//! FILENAME: app/extensions/ErrorChecking/rendering/errorTriangleRenderer.ts
// PURPOSE: Cell decoration that draws green triangles in the top-left corner of cells with errors.
// CONTEXT: Registered via registerCellDecoration. Mimics Excel's error checking indicator.

import type { CellDecorationContext } from "@api";
import { getErrorIndicatorAt } from "../lib/errorCheckingStore";

// ============================================================================
// Constants
// ============================================================================

/** Green color for error indicator triangles (matches Excel) */
const ERROR_INDICATOR_COLOR = "#008000";

/** Size of the corner triangle in pixels */
const TRIANGLE_SIZE = 5;

// ============================================================================
// Decoration Function
// ============================================================================

/**
 * Cell decoration callback that draws error indicator triangles.
 * Called by the Core renderer for each visible cell during the paint cycle.
 * Draws a small green triangle in the top-left corner of cells that have
 * error checking warnings (e.g., number stored as text, formula error).
 */
export function drawErrorTriangle(context: CellDecorationContext): void {
  const { ctx, row, col, cellLeft, cellTop } = context;

  // Fast O(1) lookup from the cached indicator map
  const indicator = getErrorIndicatorAt(row, col);
  if (!indicator) return;

  ctx.save();
  ctx.fillStyle = ERROR_INDICATOR_COLOR;
  ctx.beginPath();
  ctx.moveTo(cellLeft, cellTop);
  ctx.lineTo(cellLeft + TRIANGLE_SIZE, cellTop);
  ctx.lineTo(cellLeft, cellTop + TRIANGLE_SIZE);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
