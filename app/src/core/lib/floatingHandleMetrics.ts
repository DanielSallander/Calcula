//! FILENAME: app/src/core/lib/floatingHandleMetrics.ts
// PURPOSE: The NUMBERS of a floating object's selection handles, in a module
//          with no imports. The geometry and the liveness rule that use them
//          are core/lib/floatingHandles.ts.
// CONTEXT: A leaf on purpose. @api/gridOverlays re-exports these (a floating
//          grid lays its own edge balls out against Core's hit size; the
//          canvas paints its lock mark in the selection colour), and
//          floatingHandles.ts imports @api/gridOverlays and
//          @api/objectSelection. Re-exporting from floatingHandles.ts would
//          make loading @api/gridOverlays load @api/objectSelection through a
//          cycle back into @api/gridOverlays -- which, under a test's module
//          mock of @api/gridOverlays, split @api/objectSelection into two
//          instances (a provider registered in one was invisible to the other).

/** Side of a PAINTED handle square, in logical px. */
export const FLOATING_HANDLE_PAINT_SIZE = 7;

/**
 * Half-side of a handle's HIT square, in logical px: a point within this many
 * px of a handle's centre on both axes grabs it (inclusive).
 *
 * Must stay BELOW 8: a selected chart's quick-access buttons start 8px right
 * of its right edge, and the resize scan runs before the chart's own hit test.
 * The floating grid derives the shortest edge that may carry a yellow edge
 * ball from this number (FloatingRange/lib/frDimensions.ts
 * `FR_EDGE_HANDLE_MIN_SPAN`), through the @api/gridOverlays re-export.
 */
export const FLOATING_HANDLE_HIT_HALF = 6;

/** Shortest edge, in logical px, that gets a MIDPOINT handle. */
export const FLOATING_HANDLE_MIDPOINT_MIN_EDGE = 48;

/**
 * The ONE colour of floating-object selection chrome (outline and handles):
 * the object-chrome blue the chart, the floating grid and the canvas already
 * used. Exported through @api/gridOverlays for the canvas's lock mark.
 */
export const FLOATING_SELECTION_COLOUR = "#0e639c";

// ---------------------------------------------------------------------------
// The six-dot GRIP (core/lib/floatingGrip.ts; BUG-0258 design phase 5)
// ---------------------------------------------------------------------------

/**
 * Side of the grip's HIT square, in SCREEN px: the 24 x 24 target the
 * accessibility rules ask for when a handle is the only drag area. It is the
 * one piece of object chrome that does not scale with the zoom -- its logical
 * size is this divided by the zoom (plan decision D1) -- so it stays a usable
 * target at 50% and does not balloon at 200%.
 */
export const FLOATING_GRIP_SCREEN_PX = 24;

/** The painted PLATE inside the hit square, in SCREEN px (centred in it). */
export const FLOATING_GRIP_PLATE_W_SCREEN = 20;
export const FLOATING_GRIP_PLATE_H_SCREEN = 14;

/** The six dots: radius and pitch, in SCREEN px (three columns, two rows). */
export const FLOATING_GRIP_DOT_RADIUS_SCREEN = 1.25;
export const FLOATING_GRIP_DOT_PITCH_X_SCREEN = 5;
export const FLOATING_GRIP_DOT_PITCH_Y_SCREEN = 5;

/**
 * How far right of the object's left edge the grip starts, in LOGICAL px: just
 * past the top-left handle's hit square, so the two never share a pixel.
 */
export const FLOATING_GRIP_GAP_X = FLOATING_HANDLE_HIT_HALF + 2;

/**
 * The grip's right edge must stay this many LOGICAL px left of the top (or
 * bottom) edge's MIDPOINT, which carries Core's n / s handle and a floating
 * grid's yellow edge ball. A narrower object gets its grip outside its left
 * edge instead.
 */
export const FLOATING_GRIP_MIDPOINT_CLEARANCE = 8;

/** The grip plate's colours when its object is HOVERED but not selected. */
export const FLOATING_GRIP_HOVER_PLATE = "#ffffff";
export const FLOATING_GRIP_HOVER_INK = "#605E5C";
