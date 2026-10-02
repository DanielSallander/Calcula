//! FILENAME: app/src/core/lib/floatingHandles.ts
// PURPOSE: THE geometry of a floating object's selection handles -- where each
//          one is PAINTED, where it is HIT, which edges it drags and which
//          pointer it shows -- and THE rule for when they are LIVE. Core's
//          resize hit test (hooks/useMouseSelection/layout/overlayResizeHandlers.ts)
//          and Core's selection-chrome painter
//          (lib/gridRenderer/rendering/floatingObjectChrome.ts) both read this
//          module and nothing else, so a handle cannot be painted where it is
//          not grabbable, nor grabbable where it is not painted (BUG-0258
//          design phase 3, "handles only where they work").
// CONTEXT: Before this module the four floating corner boxes were a 10px
//          SQUARE around each corner, live on EVERY floating object that did
//          not publish `resizable: false` -- selected or not -- and reaching
//          10px past the object: a press just outside an unselected chart
//          resized it without selecting it, and a slicer's or timeline's
//          corners took presses on their first item or month with nothing
//          painted there. Every family painted its own chrome (four different
//          looks, some handles INSIDE the corners, some centred on them), and
//          the shape and picture families painted eight handles of which only
//          the four corners worked: an edge-midpoint press MOVED the shape.
//
//          Now: handles exist only on a SELECTED object (family-held or held
//          by the canvas selection set, @api/objectSelection
//          `isObjectInSelection`), are centred on the corners and -- on edges
//          of at least MIDPOINT_MIN_EDGE px -- on the edge midpoints, and every
//          one of the eight resizes (`edges` says which sides it drags).
//
//          A region publishes `data.handles: "corners"` to get the four corners
//          only: the floating grid, whose yellow edge balls (its own content
//          zone, frZoneAt) scale the CELLS and must not be pre-empted by a
//          Core midpoint (the resize scan runs BEFORE the body press).
//
// STACKING. Handles are the topmost thing on the canvas: the painter draws
// them after every floating object (so a selected object's handle shows over
// an object stacked above it, as in Excel), and `floatingHandleAt` therefore
// tests every live handle BEFORE any object's body can occlude it -- a handle
// painted over another object is grabbable there. Between two selected
// objects whose handles overlap, the one on top wins: the hit walks
// `floatingHitOrder` (topmost first) and the painter paints in its exact
// reverse, so the handle painted last is the handle hit first.
//
// THE REFERENCE PICK. While a formula is picking a reference no handle is live
// (the press belongs to the pick, which only the object's own content zone
// knows how to make). The external editors answer through
// core/lib/formulaEditTarget; the GRID editor's formula mode lives in
// core/hooks/useEditing, which imports the renderer this module is painted
// from, so it is handed in through `registerGridReferencePickProbe` by the
// resize handlers (the module that owns the press and already depends on it)
// rather than imported here -- an import would close a cycle through the
// renderer.

import { getGridRegions, floatingHitOrder, type GridRegion } from "../../api/gridOverlays";
import { isObjectInSelection } from "../../api/objectSelection";
import { getLayoutSurface, isRegionLocked, type DraggedEdges } from "./layoutSurface";
import { getGridStateSnapshot } from "../state/GridContext";
import { getExternalFormulaTarget } from "./formulaEditTarget";
import {
  FLOATING_HANDLE_HIT_HALF,
  FLOATING_HANDLE_MIDPOINT_MIN_EDGE,
  FLOATING_HANDLE_PAINT_SIZE,
} from "./floatingHandleMetrics";

// ============================================================================
// Constants (the numbers live in a leaf module: see floatingHandleMetrics.ts)
// ============================================================================

export {
  FLOATING_HANDLE_HIT_HALF,
  FLOATING_HANDLE_MIDPOINT_MIN_EDGE,
  FLOATING_HANDLE_PAINT_SIZE,
  FLOATING_SELECTION_COLOUR,
} from "./floatingHandleMetrics";

// ============================================================================
// Types
// ============================================================================

/** A handle, named by its compass point. */
export type FloatingHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Which handles an object offers: all eight, or the four corners only. */
export type FloatingHandleMode = "all" | "corners";

/** A rectangle in logical CANVAS px (zoom-corrected, gutters and scroll applied). */
export interface FloatingCanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One handle: what it drags, where it is painted, where it is hit, its pointer. */
export interface FloatingHandle {
  id: FloatingHandleId;
  /** The sides of the object this handle drags (`e` drags only the right edge). */
  edges: DraggedEdges;
  /** Centre, on the object's corner or edge midpoint. */
  cx: number;
  cy: number;
  /** The painted square (FLOATING_HANDLE_PAINT_SIZE, whole px). */
  paint: FloatingCanvasRect;
  /** The hit square: centre +/- FLOATING_HANDLE_HIT_HALF, inclusive. */
  hit: FloatingCanvasRect;
  /** The pointer over it: nwse / nesw / ns / ew -resize. */
  cursor: string;
}

/** The painted header gutters, in logical px (0 on a canvas or with headings off). */
export interface FloatingGutters {
  rowHeaderWidth: number;
  colHeaderHeight: number;
}

/** The viewport scroll, in logical px. */
export interface FloatingScroll {
  scrollX: number;
  scrollY: number;
}

// ============================================================================
// Geometry (pure)
// ============================================================================

/**
 * Where a FLOATING region sits on the canvas: sheet px shifted by the painted
 * gutters and the scroll -- the same formula the overlay renderers paint with.
 * Null for a cell-anchored region.
 */
export function floatingCanvasRect(
  region: GridRegion,
  gutters: FloatingGutters,
  scroll: FloatingScroll,
): FloatingCanvasRect | null {
  const f = region.floating;
  if (!f) return null;
  return {
    x: gutters.rowHeaderWidth + f.x - scroll.scrollX,
    y: gutters.colHeaderHeight + f.y - scroll.scrollY,
    width: f.width,
    height: f.height,
  };
}

/** The handle mode a region publishes: `data.handles === "corners"`, else all eight. */
export function floatingHandleMode(region: GridRegion): FloatingHandleMode {
  return region.data?.handles === "corners" ? "corners" : "all";
}

const CURSOR: Record<FloatingHandleId, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

function edgesOf(id: FloatingHandleId): DraggedEdges {
  return {
    left: id === "nw" || id === "w" || id === "sw",
    right: id === "ne" || id === "e" || id === "se",
    top: id === "nw" || id === "n" || id === "ne",
    bottom: id === "sw" || id === "s" || id === "se",
  };
}

function handleAt(id: FloatingHandleId, cx: number, cy: number): FloatingHandle {
  const px = Math.round(cx - FLOATING_HANDLE_PAINT_SIZE / 2);
  const py = Math.round(cy - FLOATING_HANDLE_PAINT_SIZE / 2);
  return {
    id,
    edges: edgesOf(id),
    cx,
    cy,
    paint: { x: px, y: py, width: FLOATING_HANDLE_PAINT_SIZE, height: FLOATING_HANDLE_PAINT_SIZE },
    hit: {
      x: cx - FLOATING_HANDLE_HIT_HALF,
      y: cy - FLOATING_HANDLE_HIT_HALF,
      width: 2 * FLOATING_HANDLE_HIT_HALF,
      height: 2 * FLOATING_HANDLE_HIT_HALF,
    },
    cursor: CURSOR[id],
  };
}

/**
 * The handles of an object at `rect`: the four corners, then -- in mode
 * "all" -- the midpoint of every edge at least FLOATING_HANDLE_MIDPOINT_MIN_EDGE
 * long (n and s on a wide enough object, e and w on a tall enough one).
 * Corners first, so on the rare overlap the corner wins.
 */
export function floatingHandleGeometry(rect: FloatingCanvasRect, mode: FloatingHandleMode): FloatingHandle[] {
  const { x, y, width: w, height: h } = rect;
  const out: FloatingHandle[] = [
    handleAt("nw", x, y),
    handleAt("ne", x + w, y),
    handleAt("se", x + w, y + h),
    handleAt("sw", x, y + h),
  ];
  if (mode === "all") {
    if (w >= FLOATING_HANDLE_MIDPOINT_MIN_EDGE) {
      out.push(handleAt("n", x + w / 2, y), handleAt("s", x + w / 2, y + h));
    }
    if (h >= FLOATING_HANDLE_MIDPOINT_MIN_EDGE) {
      out.push(handleAt("e", x + w, y + h / 2), handleAt("w", x, y + h / 2));
    }
  }
  return out;
}

/** Whether (px, py) is inside a handle's HIT square (inclusive). */
export function floatingHandleHits(handle: FloatingHandle, px: number, py: number): boolean {
  const r = handle.hit;
  return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height;
}

/** The handles `region` offers at its place on the canvas (none for a cell-anchored region). */
export function floatingHandlesOf(
  region: GridRegion,
  gutters: FloatingGutters,
  scroll: FloatingScroll,
): FloatingHandle[] {
  const rect = floatingCanvasRect(region, gutters, scroll);
  return rect ? floatingHandleGeometry(rect, floatingHandleMode(region)) : [];
}

// ============================================================================
// When handles are live
// ============================================================================

let gridReferencePickProbe: (() => boolean) | null = null;

/**
 * Hand this module the GRID editor's "a formula is picking a reference" probe
 * (see the header: an import would close a cycle through the renderer). Last
 * registration wins; the cleanup removes only what is still this probe.
 */
export function registerGridReferencePickProbe(probe: () => boolean): () => void {
  gridReferencePickProbe = probe;
  return () => {
    if (gridReferencePickProbe === probe) gridReferencePickProbe = null;
  };
}

/**
 * Whether a formula is PICKING a reference right now -- in the grid's own
 * editor, or in an extension's external editor (a floating grid's cell editor,
 * @api/editing). A press on a floating object then belongs to the pick.
 */
export function floatingReferencePickActive(): boolean {
  let grid = false;
  try {
    grid = gridReferencePickProbe?.() === true;
  } catch (err) {
    console.error("[floatingHandles] reference-pick probe threw:", err);
  }
  return grid || getExternalFormulaTarget()?.isExpectingReference() === true;
}

function activeLayoutSurface() {
  return getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
}

/**
 * Whether `region`'s handles are LIVE -- painted AND grabbable. All of:
 *
 *   - a floating region whose family did not publish `resizable: false`;
 *   - the active sheet's layout surface is editable (not a subscribed page);
 *   - the surface does not LOCK it (a locked object shows its padlock and no
 *     handles; it still occludes and still selects);
 *   - no formula is picking a reference;
 *   - it is SELECTED -- by its family or by the canvas selection set.
 */
export function floatingHandlesLive(region: GridRegion): boolean {
  if (!region.floating) return false;
  if (region.data?.resizable === false) return false;
  // The selection first: almost every region is unselected, and Core asks this
  // for every floating region on every hover move (and the painter per frame).
  if (!isObjectInSelection(region)) return false;
  const surface = activeLayoutSurface();
  if (surface && !surface.editable) return false;
  if (isRegionLocked(surface, region)) return false;
  return !floatingReferencePickActive();
}

/**
 * The live handle under the canvas point, with its object, or null.
 *
 * Walks `floatingHitOrder` (topmost first) over the objects whose handles are
 * live and returns the first handle whose hit square contains the point. No
 * object's BODY occludes a handle (see STACKING in the header): only selected
 * objects have handles, and they are painted above every object.
 *
 * Nothing in the header GUTTERS: renderGrid paints the row and column headers
 * AFTER the selection chrome, so the part of a handle that reaches into a
 * gutter -- the top half of an object's nw / n / ne at sheet y 0, or a handle
 * scrolled under the header -- is covered there, and a press on that header
 * band selects the column or row, never resizes an object it cannot see.
 */
export function floatingHandleAt(
  px: number,
  py: number,
  gutters: FloatingGutters,
  scroll: FloatingScroll,
  regions: readonly GridRegion[] = getGridRegions(),
): { region: GridRegion; handle: FloatingHandle } | null {
  if (px < gutters.rowHeaderWidth || py < gutters.colHeaderHeight) return null;
  for (const region of floatingHitOrder(regions)) {
    if (!floatingHandlesLive(region)) continue;
    for (const handle of floatingHandlesOf(region, gutters, scroll)) {
      if (floatingHandleHits(handle, px, py)) return { region, handle };
    }
  }
  return null;
}
