//! FILENAME: app/extensions/Animation/overlay/pillGeometry.ts
// PURPOSE: Where the viewport-pinned play pill sits — pure geometry, so the
//          placement can be tested without a layout engine.
// CONTEXT: The pill follows the GRID CANVAS's bottom-left corner rather than the
//          window's, which is what keeps it out of the panel/layout system's
//          way: opening the sidebar or the task pane resizes the canvas, and the
//          pill moves with it instead of overlapping whatever the layout put
//          there. See PlayPill.tsx for why it is bottom-left, and §2q / D4 for
//          why it is no longer anchored to CELLS.

/** Gap between the pill and the grid canvas's left / bottom edges. */
export const PILL_MARGIN = 12;

/** Fallback distance above the window bottom when no grid canvas is mounted. */
export const PILL_FALLBACK_BOTTOM = 64;

/**
 * Above the grid canvas (z 0) and below the scrollbars (100), the task pane
 * (100), menus (1000) and dialogs. The pill is document furniture, not a modal:
 * anything the user deliberately opened must be allowed to cover it.
 */
export const PILL_Z_INDEX = 90;

export interface PillPosition {
  left: number;
  bottom: number;
}

/**
 * Fixed-position offsets for the pill, given the grid canvas rect and the window
 * height. A null rect (no grid mounted) falls back to the window's bottom-left.
 */
export function pillPosition(
  canvasRect: { left: number; bottom: number } | null,
  windowHeight: number,
): PillPosition {
  if (!canvasRect) return { left: PILL_MARGIN, bottom: PILL_FALLBACK_BOTTOM };
  return {
    left: canvasRect.left + PILL_MARGIN,
    bottom: Math.max(0, windowHeight - canvasRect.bottom + PILL_MARGIN),
  };
}
