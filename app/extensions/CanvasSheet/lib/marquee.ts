//! FILENAME: app/extensions/CanvasSheet/lib/marquee.ts
// PURPOSE: The canvas MARQUEE: a press on the empty page starts a selection
//          band; releasing it selects every object the band TOUCHES, across
//          families. A plain click (no drag past the threshold) just deselects.
// CONTEXT: Core announces a left press that no floating object took as the
//          generic `floatingObject:backgroundPointerDown` (detail {x, y,
//          button, shiftKey, ctrlKey} in logical canvas px). A canvas has no
//          cells, so that press is the whole of the gesture: this file turns it
//          into a band.
//
//          The rules:
//            - a PLAIN left press clears the selection at once (the same as
//              clicking an empty cell on a worksheet) and starts a band;
//            - Shift or Ctrl keeps the selection and ADDS what the band touches;
//            - a secondary press leaves the selection alone (it asks for a
//              menu), and a worksheet is never touched;
//            - the band exists only once the pointer has travelled more than
//              3px in either axis -- Core's own click-vs-drag threshold -- so a
//              plain click is a deselect and nothing more;
//            - an object is hit when its rectangle INTERSECTS the band, edges
//              included: Power BI selects the visuals a lasso touches, and so
//              does this. (PowerPoint's "fully enclosed" rule makes a band that
//              clips the corner of a large visual select nothing, which reads
//              as a failed gesture on a report page.)
//
//          The selection is applied ONCE, at mouseup, through the
//          object-selection seam (`setObjectSelectionSet`), never by
//          dispatching Core's `floatingObject:selected` -- that event is a
//          CLICK to every family (a run-mode button would run its script).
//          The band is painted by one grid layer at "over-selection", above
//          every object.
//
//          The mousemove/mouseup listeners are SESSION-SCOPED: bound by the
//          background press, removed at its mouseup (or when the next press
//          finds a session whose mouseup never arrived) -- see the census in
//          app/src/core/lib/globalInputListeners.ts.

import { getGridStateSnapshot } from "@api/grid";
import { currentFloatingHitGeometry, requestOverlayRedraw, type GridRegion } from "@api/gridOverlays";
import {
  clearObjectSelection,
  getSelectedObjectRegions,
  selectableFloatingRegions,
  setObjectSelectionSet,
} from "@api/objectSelection";
import type { GridLayerContext } from "@api";

/** The event Core dispatches when a canvas press lands on no object. */
export const BACKGROUND_POINTER_DOWN_EVENT = "floatingObject:backgroundPointerDown";

/** The id of the band's grid layer. */
export const CANVAS_MARQUEE_LAYER_ID = "canvas-sheet-marquee";

/** Travel (logical px, either axis) before a press becomes a band: Core's click threshold. */
export const MARQUEE_THRESHOLD_PX = 3;

/** A point or rectangle in PAGE coordinates (the sheet origin, logical px). */
export interface PagePoint {
  x: number;
  y: number;
}
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BandSession {
  /** Where the press landed, in page px. */
  start: PagePoint;
  /** Where the pointer is now, in page px. */
  current: PagePoint;
  /** Where the press landed, in canvas px (the threshold is measured here). */
  pressCanvas: PagePoint;
  /** The band exists (the pointer passed the threshold). */
  active: boolean;
  /** Shift/Ctrl: add to the selection instead of replacing it. */
  additive: boolean;
  detach: () => void;
}

let session: BandSession | null = null;

function onCanvas(): boolean {
  return getGridStateSnapshot()?.surface === "canvas";
}

// ============================================================================
// Pure geometry (exported for tests)
// ============================================================================

/** The rectangle two corners span, whichever way the band was dragged. */
export function bandRect(a: PagePoint, b: PagePoint): PageRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/**
 * The regions whose floating rectangle INTERSECTS `band` (a shared edge
 * counts), in the order given. Cell-anchored regions never do.
 */
export function regionsTouchingBand(regions: readonly GridRegion[], band: PageRect): GridRegion[] {
  const right = band.x + band.width;
  const bottom = band.y + band.height;
  return regions.filter((r) => {
    const f = r.floating;
    if (!f) return false;
    return f.x <= right && f.x + f.width >= band.x && f.y <= bottom && f.y + f.height >= band.y;
  });
}

/** Whether the pointer has left the click dead zone around the press. */
export function pastThreshold(press: PagePoint, now: PagePoint, threshold = MARQUEE_THRESHOLD_PX): boolean {
  return Math.abs(now.x - press.x) > threshold || Math.abs(now.y - press.y) > threshold;
}

// ============================================================================
// Coordinates
// ============================================================================

/** A logical canvas point as a page point: gutters (0 on a canvas) and scroll. */
function canvasToPage(x: number, y: number): PagePoint {
  const geo = currentFloatingHitGeometry();
  if (!geo) return { x, y };
  return { x: x - geo.rowHeaderWidth + geo.scrollX, y: y - geo.colHeaderHeight + geo.scrollY };
}

/**
 * A mouse event's point in logical canvas px, the way Core measures a press:
 * relative to the grid area, divided by the zoom. Null before the grid mounts.
 */
function clientToCanvas(clientX: number, clientY: number): PagePoint | null {
  if (typeof document === "undefined") return null;
  const area = document.querySelector("[data-grid-area]");
  if (!area) return null;
  const rect = area.getBoundingClientRect();
  const zoom = getGridStateSnapshot()?.zoom || 1;
  return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
}

// ============================================================================
// The gesture
// ============================================================================

/** The live band in page coordinates, or null when none is being drawn. */
export function currentMarqueeBand(): PageRect | null {
  return session?.active ? bandRect(session.start, session.current) : null;
}

/** Move the band's free corner to a logical canvas point. Exported for tests. */
export function updateMarquee(canvasX: number, canvasY: number): void {
  const s = session;
  if (!s) return;
  if (!s.active && !pastThreshold(s.pressCanvas, { x: canvasX, y: canvasY })) return;
  s.active = true;
  s.current = canvasToPage(canvasX, canvasY);
  requestOverlayRedraw();
}

/**
 * End the band. With `apply`, the objects it touches become the selection (or
 * join it, for an additive band); a band that never passed the threshold
 * applies nothing -- the press already did what a click does.
 */
export function endMarquee(apply: boolean): void {
  const s = session;
  if (!s) return;
  s.detach();
  session = null;
  if (!apply || !s.active) return;
  requestOverlayRedraw();
  const hits = regionsTouchingBand(selectableFloatingRegions(), bandRect(s.start, s.current));
  if (hits.length === 0) return;
  const members = s.additive ? [...getSelectedObjectRegions(), ...hits] : hits;
  setObjectSelectionSet(members, hits[hits.length - 1]);
}

/**
 * The background press. Exported for tests; installed by
 * {@link installCanvasMarquee}.
 */
export function handleBackgroundPointerDown(e: Event): void {
  if (!onCanvas()) return;
  const d =
    (e as CustomEvent<{ x?: number; y?: number; button?: number; shiftKey?: boolean; ctrlKey?: boolean }>).detail ??
    {};
  // A secondary (or middle) press asks for a menu: the selection stays.
  if (typeof d.button === "number" && d.button !== 0) return;
  // A band whose mouseup never arrived (released outside the window) ends here.
  endMarquee(false);

  const additive = d.shiftKey === true || d.ctrlKey === true;
  if (!additive) clearObjectSelection();
  if (typeof d.x !== "number" || typeof d.y !== "number") return;

  const start = canvasToPage(d.x, d.y);
  const onMove = (ev: MouseEvent): void => {
    // A band exists only while the primary button is HELD. A move with it up
    // means the release was never heard -- and then the band followed the
    // bare pointer and the next click anywhere (on an object) "released" it,
    // selecting everything between (found live 2026-09-29, e2e fixall-canvas
    // LIVE-2: an instant press-and-release on the empty page). The press
    // already did what a click does (it deselected), so nothing is applied.
    if ((ev.buttons & 1) === 0) {
      endMarquee(false);
      return;
    }
    const p = clientToCanvas(ev.clientX, ev.clientY);
    if (p) updateMarquee(p.x, p.y);
  };
  const onUp = (ev: MouseEvent): void => {
    const p = clientToCanvas(ev.clientX, ev.clientY);
    if (p) updateMarquee(p.x, p.y);
    endMarquee(true);
  };
  session = {
    start,
    current: start,
    pressCanvas: { x: d.x, y: d.y },
    active: false,
    additive,
    detach: () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    },
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// ============================================================================
// Paint
// ============================================================================

/** Band colours: the object-chrome blue every family's selection frame uses. */
export const MARQUEE_STROKE = "#0e639c";
export const MARQUEE_FILL = "rgba(14, 99, 156, 0.08)";

/** Paint the live band (a grid layer at "over-selection"). */
export function paintMarquee(context: GridLayerContext): void {
  const band = currentMarqueeBand();
  if (!band || !onCanvas()) return;
  const { ctx, viewport, config } = context;
  const x = (config.rowHeaderWidth ?? 0) + band.x - viewport.scrollX;
  const y = (config.colHeaderHeight ?? 0) + band.y - viewport.scrollY;
  const zoom = getGridStateSnapshot()?.zoom || 1;
  ctx.fillStyle = MARQUEE_FILL;
  ctx.fillRect(x, y, band.width, band.height);
  ctx.strokeStyle = MARQUEE_STROKE;
  ctx.lineWidth = Math.max(1, 1 / zoom);
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, band.width, band.height);
}

/** Install the background-press listener; returns the cleanups. */
export function installCanvasMarquee(): Array<() => void> {
  window.addEventListener(BACKGROUND_POINTER_DOWN_EVENT, handleBackgroundPointerDown);
  return [
    () => window.removeEventListener(BACKGROUND_POINTER_DOWN_EVENT, handleBackgroundPointerDown),
    () => endMarquee(false),
  ];
}
