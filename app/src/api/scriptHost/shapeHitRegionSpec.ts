//! FILENAME: app/src/api/scriptHost/shapeHitRegionSpec.ts
// PURPOSE: The wire and the limits of a shape script's DECLARED HIT RECTANGLES
//          (M3b) — the regions of its own `ui.html` frame that may receive
//          pointer input, so the rest of the frame stays click-through and the
//          grid underneath keeps working.
// CONTEXT: Leaf module with NO imports, so the validator (validators.ts), the
//          host executor (host.ts) and the trusted painter that owns the DOM
//          (extensions/Controls/Shape/shapeHitRegions.ts) share one definition
//          without an import cycle and without a second copy of the budget.
//
// THE DEFECT THIS EXISTS TO CLOSE. `updateHtmlOverlay` set every `ui.html`
// iframe to `pointer-events: none` UNCONDITIONALLY, "allows click-through". A
// script's HTML frame could therefore never receive a click: the whole surface
// was decorative. Making the frame interactive wholesale would be the opposite
// error — the frame would swallow every pointer event inside the shape's box,
// including the ones that select, move, resize and right-click the shape
// itself. So the script says WHICH rectangles it wants, and the host claims
// only those.
//
// COORDINATE SPACE — stated here because a script must never name grid pixels.
// `x` / `y` / `width` / `height` are CSS pixels in the FRAME'S OWN space: the
// origin is the top-left of the frame as it is laid out (the same origin the
// frame's `<body>` measures from), x grows right and y grows down. The script
// knows nothing about scroll position, headers, zoom or where the shape sits on
// the sheet, and cannot learn any of it from this call. The host adds the
// frame's canvas origin and clips to the visible box.
//
// WHY A BOUNDED LIST. Every rectangle is a piece of the grid's pointer input
// handed to a script, and each one costs a DOM element the host must keep
// positioned every frame. Sixteen is enough for a toolbar of buttons and small
// enough that an over-declaration is a refusal a script author sees immediately
// rather than a renderer that quietly crawls.

// ============================================================================
// Limits (host-enforced; the worker never sees these)
// ============================================================================

/** Most rectangles one shape may claim at once. The whole call is refused past it. */
export const MAX_SHAPE_HIT_REGIONS = 16;

/**
 * Longest region id. The id is an IDENTIFIER, not a label: it is echoed back to
 * the script's own frame in the pointer message and is never rendered as host
 * chrome, so no script can author a sentence the user reads.
 */
export const MAX_SHAPE_HIT_REGION_ID = 64;

/**
 * Accepted region ids. Deliberately narrow — no whitespace, no punctuation that
 * reads as prose — so an id can never be mistaken for a user-facing label if a
 * future surface ever prints one, and so it is safe in a `data-` attribute.
 */
export const SHAPE_HIT_REGION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Smallest claimable edge, in frame pixels. A zero- or sub-pixel rectangle
 *  claims input at a point the user cannot aim at, so it is refused rather than
 *  silently kept as an invisible trap. */
export const MIN_SHAPE_HIT_SIZE = 1;

/**
 * Largest coordinate or edge, in frame pixels — and the bound on `x + width`
 * too. A shape's frame is a few hundred pixels; 20,000 is far past any real
 * frame and still finite, which is the point: it refuses `1e308` and any
 * arithmetic built on it before the number reaches CSS.
 */
export const MAX_SHAPE_HIT_COORD = 20_000;

/** The only keys a region carries. An unknown key is a refusal, never ignored. */
export const SHAPE_HIT_REGION_KEYS = ["id", "x", "y", "width", "height"] as const;

/** `SHAPE_HIT_REGION_KEYS` as a set, for the validator's per-key check. */
export const SHAPE_HIT_REGION_KEY_SET: ReadonlySet<string> = new Set(SHAPE_HIT_REGION_KEYS);

// ============================================================================
// The wire shape
// ============================================================================

/** One rectangle of a shape's HTML frame that should receive pointer input. */
export interface ShapeHitRegion {
  /** Script-chosen identifier, echoed back in the pointer message. Never shown to the user. */
  id: string;
  /** Frame-local CSS pixels from the frame's left edge. */
  x: number;
  /** Frame-local CSS pixels from the frame's top edge. */
  y: number;
  width: number;
  height: number;
}

/**
 * The app event `render.setHitRegions` emits. Named here rather than typed at
 * both ends, because the emitter (`host.ts`) and the only subscriber
 * (`extensions/Controls`) are in different layers and a typo in either would be
 * a feature that silently does nothing.
 */
export const SHAPE_HIT_REGIONS_EVENT = "shape:setHitRegions";

/**
 * The `type` of the message the host posts INTO the frame when a claimed
 * rectangle is clicked. Prefixed so it cannot collide with a type the script
 * chose for its own `render.sendMessage` traffic.
 */
export const SHAPE_HIT_POINTER_MESSAGE_TYPE = "calcula:pointer";

/** What rides in that message's `data`. Coordinates are frame-local, as declared. */
export interface ShapeHitPointerMessage {
  /** The `id` of the region that was hit. */
  region: string;
  /** Frame-local CSS pixels of the pointer. */
  x: number;
  y: number;
  /**
   * Which pointer phase this is.
   *
   * `dblclick` is here because the host GUARDS the grid's double-click door
   * against a claimed rectangle (core/components/Spreadsheet/gridPointerEntry.ts):
   * without forwarding, a double-click inside a declared rectangle would reach
   * nothing at all — not the grid, not the script — which is a worse answer than
   * either. A script that only listens for `click` is unaffected: the browser
   * delivers `click` for both presses of a double-click, exactly as it does
   * outside the frame, so `dblclick` ARRIVES AFTER the second `click` rather
   * than instead of it.
   */
  kind: "pointerdown" | "click" | "dblclick";
  /** `MouseEvent.button` — 0 for the primary button. */
  button: number;
}

// NO `hitRegionAt` HERE, DELIBERATELY. The host does not hit-test these
// rectangles: it places one transparent element per rectangle, in declaration
// order, and the browser answers "which region is this point in" the way it
// answers it for every other element on the page — later sibling on top, so a
// later declaration wins an overlap, which is the painter's order a script
// author already reasons in. A pure predicate here would be a SECOND definition
// of that answer that nothing runs, and the first divergence between it and the
// DOM would be invisible. `shapeHitShimRects` (the placement) is the one piece
// of geometry worth sharing, and it lives with the code that owns the elements.
