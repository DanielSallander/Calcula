//! FILENAME: app/extensions/_shared/lib/objectWheelScroll.ts
// PURPOSE: Wheel scrolling for the CONTENT of a floating object: a wheel over a
//          registered object scrolls that object, not the sheet or the page.
// CONTEXT: The Slicer carries its own window wheel listener (Slicer/index.ts)
//          and the Timeline a copy of it; a canvas pivot box needs the same, and
//          a floating grid (M7) after it. One listener, shared, instead of a
//          third and fourth copy:
//
//          - ONE capture-phase `window` wheel listener (passive: false, so it
//            may preventDefault), installed with the first target and removed
//            with the last.
//          - A claimed pointer is not ours (`isPointerClaimed`): something an
//            extension stacked on the grid answered the gesture already.
//          - The client point becomes a LOGICAL canvas point by dividing by the
//            zoom, exactly as Core's own mouse handling does.
//          - The header gutters come from `resolveHeaderSizes` with the
//            SURFACE taken into account: a canvas forces the headings off but
//            leaves `config.rowHeaderWidth` at its stored value, so reading the
//            raw config (as the Slicer copy did until M8) puts the hit box one gutter
//            away from the painted object on a canvas.
//          - The TOPMOST floating region under the point decides, walking
//            `floatingHitOrder` (@api/gridOverlays) -- the order Core's own
//            press uses (overlayMoveHandlers.findFloatingRegionAt): reverse
//            publication order, or the exact reverse of the paint order when a
//            stacking order (a canvas's zOrder) is in force. If it belongs to
//            no registered target the wheel passes through: an object covered
//            by another must not scroll behind it.
//          - A wheel on an axis with no overflow passes through (the page
//            scrolls); on an axis that overflows it is CONSUMED, even at the
//            edge, so a box at its last row does not start scrolling the page
//            under the pointer.

import type { GridRegion } from "@api/gridOverlays";
import {
  getLiveGridRegions,
  requestOverlayRedraw,
  topFloatingRegionAt as topStackedFloatingRegionAt,
} from "@api/gridOverlays";
import { getGridStateSnapshot, resolveHeaderSizes } from "@api/grid";
import { isPointerClaimed } from "@api";

/** The scroll state of one object, in its own content px. */
export interface ObjectWheelScroll {
  left: number;
  top: number;
  maxLeft: number;
  maxTop: number;
}

export interface ObjectWheelTarget {
  /** The `GridRegion.type` values this target owns. */
  types: readonly string[];
  /** The object's scroll now, or null when it cannot scroll (e.g. not painted yet). */
  getScroll(region: GridRegion): ObjectWheelScroll | null;
  /** Apply a new scroll origin (already clamped to [0, max]). */
  setScroll(region: GridRegion, left: number, top: number): void;
  /** Pixels per wheel LINE (deltaMode 1). Default 20. */
  lineSize?: number;
  /**
   * One wheel PAGE (deltaMode 2), in content px: the size of the object's
   * scrolling VIEWPORT. Default: the whole floating frame, which is right only
   * for an object with no chrome around its content. A floating grid's
   * viewport is its cell area -- the title bar and headers do not scroll, and
   * a page sized by the frame skipped the rows under them (W16).
   */
  pageSize?(region: GridRegion): { width: number; height: number };
}

/** Where floating regions sit on the canvas right now. */
export interface WheelHitGeometry {
  rowHeaderWidth: number;
  colHeaderHeight: number;
  scrollX: number;
  scrollY: number;
}

const DEFAULT_LINE_SIZE = 20;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

const targets = new Map<string, ObjectWheelTarget>();
let listening = false;
let gridArea: HTMLElement | null = null;

/**
 * The topmost FLOATING region containing the logical canvas point, or null --
 * Core's one ordering (`topFloatingRegionAt`, @api/gridOverlays) over the
 * given regions and geometry. Pure over its inputs; exported for tests.
 */
export function topFloatingRegionAt(
  regions: readonly GridRegion[],
  canvasX: number,
  canvasY: number,
  geo: WheelHitGeometry,
): GridRegion | null {
  return topStackedFloatingRegionAt(canvasX, canvasY, geo, regions);
}

/**
 * The wheel delta in content px. Shift with a purely vertical wheel scrolls
 * horizontally (the Windows convention); then line mode multiplies by
 * `lineSize`, page mode by the object's own size ON THE AXIS IT MOVES. The
 * turn comes first: scaled first, a Shift page moved sideways by the
 * viewport's HEIGHT (review C).
 */
export function wheelDeltaPx(
  e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey">,
  lineSize: number,
  page: { width: number; height: number },
): { dx: number; dy: number } {
  let dx = e.deltaX;
  let dy = e.deltaY;
  if (e.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  if (e.deltaMode === DOM_DELTA_LINE) {
    dx *= lineSize;
    dy *= lineSize;
  } else if (e.deltaMode === DOM_DELTA_PAGE) {
    dx *= page.width;
    dy *= page.height;
  }
  return { dx, dy };
}

/**
 * The new scroll origin, or null when the wheel scrolls no axis that
 * overflows (the caller then lets it through to the page). The result is
 * clamped, so a wheel at the edge returns the unchanged origin -- still
 * consumed.
 */
export function applyWheelDelta(
  s: ObjectWheelScroll,
  dx: number,
  dy: number,
): { left: number; top: number } | null {
  const movesX = dx !== 0 && s.maxLeft > 0;
  const movesY = dy !== 0 && s.maxTop > 0;
  if (!movesX && !movesY) return null;
  const clamp = (v: number, max: number) => Math.min(Math.max(0, v), max);
  return {
    left: movesX ? clamp(s.left + dx, s.maxLeft) : clamp(s.left, s.maxLeft),
    top: movesY ? clamp(s.top + dy, s.maxTop) : clamp(s.top, s.maxTop),
  };
}

/** The grid's current geometry for floating regions, surface-aware. */
function currentHitGeometry(): { geo: WheelHitGeometry; zoom: number } | null {
  const s = getGridStateSnapshot();
  if (!s) return null;
  const displayHeadings = s.surface === "canvas" ? false : s.displayHeadings;
  const { rowHeaderWidth, colHeaderHeight } = resolveHeaderSizes(s.config, displayHeadings);
  return {
    geo: {
      rowHeaderWidth,
      colHeaderHeight,
      scrollX: s.viewport.scrollX,
      scrollY: s.viewport.scrollY,
    },
    zoom: s.zoom || 1,
  };
}

function findGridArea(): HTMLElement | null {
  if (!gridArea || !gridArea.isConnected) {
    gridArea = document.querySelector("[data-grid-area]") as HTMLElement | null;
  }
  return gridArea;
}

/**
 * The listener body. Returns true when it consumed the wheel (and scrolled an
 * object); exported for tests.
 */
export function handleObjectWheel(e: WheelEvent): boolean {
  if (targets.size === 0) return false;
  if (isPointerClaimed(e)) return false;

  const area = findGridArea();
  if (!area) return false;
  const hit = currentHitGeometry();
  if (!hit) return false;

  const rect = area.getBoundingClientRect();
  const canvasX = (e.clientX - rect.left) / hit.zoom;
  const canvasY = (e.clientY - rect.top) / hit.zoom;
  // Outside the grid area entirely: not a wheel over any object.
  if (canvasX < 0 || canvasY < 0 || canvasX > rect.width / hit.zoom || canvasY > rect.height / hit.zoom) {
    return false;
  }

  // LIVE regions: while a formula picks a reference on another sheet, the
  // published objects are not on screen, and a wheel there must scroll the
  // sheet, not an invisible floating grid of the edit's sheet.
  const region = topFloatingRegionAt(getLiveGridRegions(), canvasX, canvasY, hit.geo);
  if (!region) return false;
  const target = targets.get(region.type);
  if (!target) return false;

  const scroll = target.getScroll(region);
  if (!scroll) return false;

  const f = region.floating!;
  const page = target.pageSize?.(region) ?? { width: f.width, height: f.height };
  const { dx, dy } = wheelDeltaPx(e, target.lineSize ?? DEFAULT_LINE_SIZE, page);
  const next = applyWheelDelta(scroll, dx, dy);
  if (!next) return false;

  e.preventDefault();
  e.stopPropagation();
  if (next.left !== scroll.left || next.top !== scroll.top) {
    target.setScroll(region, next.left, next.top);
    requestOverlayRedraw();
  }
  return true;
}

function onWheel(e: WheelEvent): void {
  handleObjectWheel(e);
}

function ensureListener(): void {
  if (listening || typeof window === "undefined") return;
  // Capture phase, so the object sees the wheel before the grid scrolls.
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  listening = true;
}

function removeListener(): void {
  if (!listening || typeof window === "undefined") return;
  window.removeEventListener("wheel", onWheel, true);
  listening = false;
  gridArea = null;
}

/**
 * Register a wheel target for one or more region types. Last registration
 * wins per type; the cleanup removes only what is still this target's, and
 * removes the listener with the last target.
 */
export function registerObjectWheelTarget(target: ObjectWheelTarget): () => void {
  for (const t of target.types) targets.set(t, target);
  ensureListener();
  return () => {
    for (const t of target.types) {
      if (targets.get(t) === target) targets.delete(t);
    }
    if (targets.size === 0) removeListener();
  };
}

/** Test hook: whether the shared listener is installed. */
export function isObjectWheelListening(): boolean {
  return listening;
}
