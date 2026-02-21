//! FILENAME: app/extensions/Tracing/rendering/traceArrowHitTest.ts
// PURPOSE: Hit-test logic for trace arrows (double-click navigation).
// CONTEXT: Registered as the hit-test function for the "tracing" grid overlay.

import type { OverlayHitTestContext, OverlayRenderContext } from "../../../src/api";
import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
} from "../../../src/api";
import { getArrows } from "../lib/tracingStore";
import type { TraceArrow } from "../types";

// ============================================================================
// Constants
// ============================================================================

/** Maximum distance in pixels from the arrow line to register a hit. */
const HIT_TOLERANCE = 6;

// ============================================================================
// Module State
// ============================================================================

/** The last arrow that was hit-tested (for navigation). */
let lastHitArrow: TraceArrow | null = null;

// ============================================================================
// Public API
// ============================================================================

/** Get the arrow from the most recent successful hit test. */
export function getLastHitArrow(): TraceArrow | null {
  return lastHitArrow;
}

/** Clear the last hit arrow (after navigation). */
export function clearLastHitArrow(): void {
  lastHitArrow = null;
}

/**
 * Hit-test: check if the canvas point (canvasX, canvasY) is near any arrow line.
 * The overlay system calls this to determine if a click lands on a trace arrow.
 */
export function hitTestTraceArrow(ctx: OverlayHitTestContext): boolean {
  const arrowList = getArrows();
  if (arrowList.length === 0) return false;

  // We need the render context helpers, but the hit-test context doesn't provide
  // all of them. We build a minimal OverlayRenderContext-like object for the
  // arrow coordinate computation. Since we only need canvasX/canvasY for distance
  // calculation, we compute arrow endpoints using the cell center approach.
  for (const arrow of arrowList) {
    if (arrow.isCrossSheet) continue; // Cross-sheet arrows use a different click handler

    // Get source cell center in canvas coordinates
    // We don't have the full OverlayRenderContext in a hit test, so we rely on
    // the cell (row, col) from the hit test context to do a simplified check.
    // The hit test is called with the cell coordinate, so we check if the click
    // is within the source or target cell bounds.
    const { row, col, canvasX, canvasY } = ctx;

    // Simple approach: check if the clicked cell is one of the arrow's endpoints
    if (
      (row === arrow.sourceRow && col === arrow.sourceCol) ||
      (row === arrow.targetRow && col === arrow.targetCol)
    ) {
      lastHitArrow = arrow;
      return true;
    }

    // Check if the click is within a target range
    if (arrow.targetRange) {
      const r = arrow.targetRange;
      if (
        row >= r.startRow &&
        row <= r.endRow &&
        col >= r.startCol &&
        col <= r.endCol
      ) {
        lastHitArrow = arrow;
        return true;
      }
    }
  }

  lastHitArrow = null;
  return false;
}
