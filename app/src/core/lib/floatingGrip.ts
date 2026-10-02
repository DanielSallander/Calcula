//! FILENAME: app/src/core/lib/floatingGrip.ts
// PURPOSE: THE six-dot GRIP of a floating object -- where it sits, where it is
//          PAINTED, where it is HIT, and THE rule for when it SHOWS (BUG-0258
//          design phase 5). Core's painter (lib/gridRenderer/rendering/
//          floatingObjectChrome.ts `paintFloatingGrips`), Core's press and
//          hover (hooks/useMouseSelection: overlayMoveHandlers `checkGrip` /
//          `handleGripMouseDown`), Core's right-click (Spreadsheet.tsx) and
//          every family's "what is under this point" question
//          (@api/gridOverlays `topFloatingRegionAt`, through the probe this
//          module registers) all read this module and nothing else, so the grip
//          cannot be painted where it is not grabbable, nor grabbable where it
//          is not painted.
// CONTEXT: The rule of the grammar is "the FRAME moves an object, its CONTENT
//          works". An object with no frame to speak of -- a slicer or a
//          timeline with its header hidden, a floating grid without a title --
//          has almost nothing left to grab, so it shows a small grip while the
//          pointer is over it or while it is selected (`data.grip: "hover"`,
//          published by the family). On a CANVAS page the selected object shows
//          one too, whatever its family (Power BI's visual header): only the
//          PRIMARY member of a multi-selection (plan decision D2). Owner
//          decision: charts, shapes and pictures on a WORKSHEET get no grip --
//          they move by their body, as in Excel.
//
//          Dragging the grip moves the object exactly as a frame drag does
//          (Core's move); CLICKING it -- a release within the 3px threshold --
//          dispatches `floatingObject:gripClick` (FLOATING_GRIP_CLICK_EVENT),
//          which opens the grip's menu (Size and Position first: the no-drag
//          route WCAG 2.2 SC 2.5.7 requires). A right-click on a grip no family
//          claimed dispatches the same event with `button: 2`.
//
// GEOMETRY. The hit square is FLOATING_GRIP_SCREEN_PX (24) SCREEN px on a
// side: logical 24 / zoom, the one piece of object chrome that does not scale
// (plan decision D1). It sits just OUTSIDE the object -- above its top edge,
// FLOATING_GRIP_GAP_X logical px right of the left edge (clear of the
// top-left handle's hit square) -- so it never covers a month, an item or a
// cell. Where there is no room above (the object's sheet y is less than the
// grip), it sits below the bottom edge instead; on a canvas page with no room
// below either, there is no grip (Size and Position is still in the object's
// menu). An object too narrow for the grip to stay FLOATING_GRIP_MIDPOINT_
// CLEARANCE px left of its edge midpoint (Core's n / s handle, a floating
// grid's yellow ball) gets it BESIDE its LEFT edge instead, level with its top
// edge: the two share a stretch of that edge, so a hand moving from the body
// onto a hover grip never crosses a point that is neither (the hover, and with
// it the grip, would end there). Level with the bottom edge where a grip taller
// than the object would overhang a canvas page's bottom.
//
// The hit square is HALF-OPEN on the object's side: a point on the object's own
// rectangle (edges included) is never the grip's, so the grip can never take a
// press from the object it belongs to -- nor a point the object claims past its
// rectangle through its overlay's extended hitTest (a selected floating grid's
// yellow edge ball, painted above the grip; `ownObjectClaims`). It CAN lie over a neighbour on a dense
// page; there it is painted above the neighbour and wins its press (paint and
// hit agree). A Core handle that overlaps it wins over it -- the press scans
// the handles first (priority 1.5, the grip 1.6, the body 1.7) and the painter
// paints the handles after the grips.
//
// THE PROBE. `topFloatingRegionAt` (@api/gridOverlays) answers the grip's
// object for a point on a VISIBLE grip (plan decision D6), so every family's
// right-click, wheel and hover lookup agrees with Core's press about who owns
// that point. The facade cannot import this module (it imports the facade and
// the selection seam: a cycle), so this module registers a probe at load in a
// LEAF both of them read (core/lib/floatingChromeProbe.ts) -- the
// `registerGridReferencePickProbe` inversion. Not through a function the
// facade exports: a test that replaces the facade with a module mock lacking
// it would fail every file that loads the grid renderer.

import {
  floatingHitOrder,
  getLiveGridRegions,
  getGridRegions,
  getOverlayRegistration,
  isContentGestureHeld,
  onRegionChange,
  requestOverlayRedraw,
  type GridRegion,
} from "../../api/gridOverlays";
import { registerFloatingChromeHitProbe, type FloatingChromeHitProbe } from "./floatingChromeProbe";
import { getPrimaryObjectRegion, isObjectInSelection } from "../../api/objectSelection";
import { getLayoutSurface, isRegionLocked, type LayoutSurface } from "./layoutSurface";
import { getGridStateSnapshot } from "../state/GridContext";
import { isPointModeOnForeignSheet } from "./pointModeView";
import {
  floatingCanvasRect,
  floatingReferencePickActive,
  type FloatingCanvasRect,
  type FloatingGutters,
  type FloatingScroll,
} from "./floatingHandles";
import {
  clearFloatingHover,
  getHoveredFloatingRegionId,
  isFloatingGestureActive,
  onFloatingGestureChanged,
  onFloatingHoverChanged,
} from "./objectHover";
import {
  FLOATING_GRIP_DOT_PITCH_X_SCREEN,
  FLOATING_GRIP_DOT_PITCH_Y_SCREEN,
  FLOATING_GRIP_DOT_RADIUS_SCREEN,
  FLOATING_GRIP_GAP_X,
  FLOATING_GRIP_MIDPOINT_CLEARANCE,
  FLOATING_GRIP_PLATE_H_SCREEN,
  FLOATING_GRIP_PLATE_W_SCREEN,
  FLOATING_GRIP_SCREEN_PX,
} from "./floatingHandleMetrics";

// ============================================================================
// The click event
// ============================================================================

/** Core's grip-click event: a click (or a right-click no family claimed) on a grip. */
export const FLOATING_GRIP_CLICK_EVENT = "floatingObject:gripClick";

/** A rectangle in CLIENT (viewport) px -- what a menu is anchored to. */
export interface FloatingGripAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The detail of FLOATING_GRIP_CLICK_EVENT. */
export interface FloatingGripClickDetail {
  regionId: string;
  regionType: string;
  data?: Record<string, unknown>;
  /** The grip's hit square, in CLIENT px. */
  anchor: FloatingGripAnchor;
  /** 0: a left click (a press released within the move threshold); 2: a right-click. */
  button: 0 | 2;
}

// ============================================================================
// Geometry (pure)
// ============================================================================

/**
 * Where the grip sits relative to its object: above its top edge, below its
 * bottom edge (no room above), or -- on an object too narrow for either --
 * beside its LEFT edge, sharing a stretch of that edge.
 */
export type FloatingGripPlacement = "above" | "below" | "left";

/** One grip: its object's rectangle, its hit square, its plate and its dots. All logical canvas px. */
export interface FloatingGripGeometry {
  placement: FloatingGripPlacement;
  /** True when a narrow object pushed the grip beside its LEFT edge (`placement` "left"). */
  outsideLeft: boolean;
  /** The object's rectangle (the part of the hit square that overlaps it is never the grip's). */
  object: FloatingCanvasRect;
  /** The hit square: FLOATING_GRIP_SCREEN_PX / zoom on a side. */
  hit: FloatingCanvasRect;
  /** The painted plate, centred in the hit square. */
  plate: FloatingCanvasRect;
  /** The six dots' centres (three columns, two rows), centred on the plate. */
  dots: Array<{ cx: number; cy: number }>;
  /** Each dot's radius. */
  dotRadius: number;
}

function safeZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * The PLATE painted inside a grip's hit square at `zoom`: the fixed SCREEN
 * size, centred. The painter and the hit test both take it from here (through
 * `floatingGripGeometry`), so the plate cannot drift off the target.
 */
export function floatingGripPlate(hit: FloatingCanvasRect, zoom: number): FloatingCanvasRect {
  const z = safeZoom(zoom);
  const width = FLOATING_GRIP_PLATE_W_SCREEN / z;
  const height = FLOATING_GRIP_PLATE_H_SCREEN / z;
  return {
    x: hit.x + (hit.width - width) / 2,
    y: hit.y + (hit.height - height) / 2,
    width,
    height,
  };
}

/**
 * The grip of an object at canvas `rect` (whose SHEET rectangle is
 * `sheetRect`), on a surface whose page is `page` (null: a worksheet,
 * unbounded), at `zoom` -- or null when there is no room for one (a canvas
 * object whose page leaves no room above or below it, or -- beside a narrow
 * object -- no room for a grip taller than it either way).
 */
export function floatingGripGeometry(
  rect: FloatingCanvasRect,
  sheetRect: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number } | null,
  zoom: number,
): FloatingGripGeometry | null {
  const z = safeZoom(zoom);
  const size = FLOATING_GRIP_SCREEN_PX / z;

  let placement: FloatingGripPlacement;
  let x = rect.x + FLOATING_GRIP_GAP_X;
  let y: number;
  if (x + size > rect.x + rect.width / 2 - FLOATING_GRIP_MIDPOINT_CLEARANCE) {
    // Too narrow to sit above or below: BESIDE the left edge, level with the
    // top edge, so the grip and its object share a stretch of that edge. A
    // hover grip shows only while its object is hovered, and the hover ends
    // the moment the pointer is over neither: from a square that met the
    // object only at its top-left CORNER (where this used to sit), a hand
    // crossing the corner lost the hover and the grip vanished before it was
    // reached. Where a grip taller than the object would overhang a canvas
    // page's bottom it is level with the bottom edge instead; with room for
    // neither, there is none.
    placement = "left";
    x = rect.x - size;
    if (!page || sheetRect.y + size <= page.height) y = rect.y;
    else if (sheetRect.y + sheetRect.height - size >= 0) y = rect.y + rect.height - size;
    else return null;
  } else if (sheetRect.y >= size) {
    placement = "above";
    y = rect.y - size;
  } else if (!page || sheetRect.y + sheetRect.height + size <= page.height) {
    placement = "below";
    y = rect.y + rect.height;
  } else {
    return null;
  }
  const outsideLeft = placement === "left";
  const hit = { x, y, width: size, height: size };
  const plate = floatingGripPlate(hit, z);

  const cx = plate.x + plate.width / 2;
  const cy = plate.y + plate.height / 2;
  const px = FLOATING_GRIP_DOT_PITCH_X_SCREEN / z;
  const py = FLOATING_GRIP_DOT_PITCH_Y_SCREEN / z;
  const dots: Array<{ cx: number; cy: number }> = [];
  for (const dy of [-py / 2, py / 2]) {
    for (const dx of [-px, 0, px]) dots.push({ cx: cx + dx, cy: cy + dy });
  }

  return {
    placement,
    outsideLeft,
    object: { ...rect },
    hit,
    plate,
    dots,
    dotRadius: FLOATING_GRIP_DOT_RADIUS_SCREEN / z,
  };
}

/**
 * Whether (px, py) is on the grip: inside its hit square (inclusive) and NOT
 * on its object's own rectangle (edges included) -- half-open on the object's
 * side, so a grip never takes a point of its own object.
 */
export function floatingGripHits(grip: FloatingGripGeometry, px: number, py: number): boolean {
  const h = grip.hit;
  if (px < h.x || px > h.x + h.width || py < h.y || py > h.y + h.height) return false;
  const o = grip.object;
  const onObject = px >= o.x && px <= o.x + o.width && py >= o.y && py <= o.y + o.height;
  return !onObject;
}

/** The grip of `region` at its place on the canvas (null: cell-anchored, or no room). */
export function floatingGripOf(
  region: GridRegion,
  gutters: FloatingGutters,
  scroll: FloatingScroll,
  zoom: number,
  page: { width: number; height: number } | null,
): FloatingGripGeometry | null {
  const rect = floatingCanvasRect(region, gutters, scroll);
  if (!rect || !region.floating) return null;
  return floatingGripGeometry(rect, region.floating, page, zoom);
}

/**
 * A grip's hit square in CLIENT px, given the grid area's client rectangle
 * (`container`: its left/top) and the zoom the canvas point was divided by.
 */
export function floatingGripAnchor(
  grip: FloatingGripGeometry,
  container: { left: number; top: number },
  zoom: number,
): FloatingGripAnchor {
  const z = safeZoom(zoom);
  return {
    x: container.left + grip.hit.x * z,
    y: container.top + grip.hit.y * z,
    width: grip.hit.width * z,
    height: grip.hit.height * z,
  };
}

// ============================================================================
// When the grip shows
// ============================================================================

/**
 * What the visibility rule reads about the moment, gathered ONCE per paint or
 * per hit test (the primary member of a canvas selection is a sorted walk of
 * the regions; asking it per region would be quadratic).
 */
export interface FloatingGripEnv {
  /** The active sheet's layout surface (null on a worksheet). */
  surface: LayoutSurface | null;
  /** The active sheet is a CANVAS page. */
  canvas: boolean;
  /** Core's hovered floating region (core/lib/objectHover.ts). */
  hoveredId: string | null;
  /** The PRIMARY member of the object selection, on a canvas only (else null). */
  primaryId: string | null;
  /**
   * No grip anywhere: a formula is picking a reference, cross-sheet point mode
   * shows a sheet the objects do not belong to, a Core move or resize is in
   * progress, or a content gesture holds the pointer.
   */
  blocked: boolean;
  /** The zoom the grid paints and hit-tests at. */
  zoom: number;
}

/** The zoom the painter and every grip hit test read: the grid state's (1 before mount). */
export function currentGripZoom(): number {
  return safeZoom(getGridStateSnapshot()?.zoom ?? 1);
}

/** The environment of the grip rule right now, over `regions` (default: the published list). */
export function currentGripEnv(regions: readonly GridRegion[] = getGridRegions()): FloatingGripEnv {
  const snap = getGridStateSnapshot();
  const canvas = snap?.surface === "canvas";
  const blocked =
    isFloatingGestureActive() ||
    isContentGestureHeld() ||
    isPointModeOnForeignSheet() ||
    floatingReferencePickActive();
  return {
    surface: getLayoutSurface(snap?.sheetContext.activeSheetIndex ?? 0),
    canvas,
    hoveredId: getHoveredFloatingRegionId(),
    primaryId: canvas && !blocked ? getPrimaryObjectRegion(regions)?.id ?? null : null,
    blocked,
    zoom: safeZoom(snap?.zoom ?? 1),
  };
}

/**
 * Whether `region` shows its grip. All of:
 *
 *   - it is floating, and no gesture, reference pick or foreign point mode is
 *     live (`env.blocked`);
 *   - it can MOVE: its family did not publish `movable: false` (a run-mode
 *     button), its layout surface does not lock it, and that surface is
 *     editable (not a subscribed page) -- a grip promises a move;
 *   - EITHER it publishes `data.grip: "hover"` (no header or title) and is
 *     hovered or selected, OR the page is a CANVAS and it is the selection's
 *     PRIMARY member.
 */
export function floatingGripShown(region: GridRegion, env: FloatingGripEnv = currentGripEnv()): boolean {
  if (!region.floating || env.blocked) return false;
  const hoverGrip =
    region.data?.grip === "hover" && (env.hoveredId === region.id || isObjectInSelection(region));
  const canvasGrip = env.canvas && env.primaryId === region.id;
  if (!hoverGrip && !canvasGrip) return false;
  if (region.data?.movable === false) return false;
  if (env.surface && !env.surface.editable) return false;
  if (isRegionLocked(env.surface, region)) return false;
  return true;
}

/**
 * Whether a change of Core's hover from `a` to `b` can change what any grip
 * shows: only a region publishing `grip: "hover"` depends on the hover. The
 * grid repaints on a hover change only then.
 */
export function hoverChangeAffectsGrips(
  a: string | null,
  b: string | null,
  regions: readonly GridRegion[] = getGridRegions(),
): boolean {
  if (a === b) return false;
  return regions.some((r) => (r.id === a || r.id === b) && r.data?.grip === "hover");
}

// ============================================================================
// The hit test
// ============================================================================

/** A visible grip under a canvas point, with its object. */
export interface FloatingGripHit {
  region: GridRegion;
  grip: FloatingGripGeometry;
}

/**
 * Whether the grip's OWN object claims the point through its overlay's
 * extended `hitTest` -- an affordance of its own reaching past its edge, such
 * as a selected floating grid's yellow edge ball, whose outer half lies
 * outside the frame. The half-open rule, carried past the rectangle: a grip
 * never takes a point its own object claims. The ball is painted ABOVE the
 * grip (its layer runs after Core's chrome) and the object's body press
 * reaches it, so paint and hit agree; without this a narrow, short floating
 * grid's grip beside its left edge took the press on the outer half of its
 * left ball. A throwing hit test is logged and claims nothing.
 */
function ownObjectClaims(region: GridRegion, grip: FloatingGripGeometry, px: number, py: number): boolean {
  const hitTest = getOverlayRegistration(region.type)?.hitTest;
  if (!hitTest) return false;
  try {
    return hitTest({ region, canvasX: px, canvasY: py, row: 0, col: 0, floatingCanvasBounds: grip.object }) === true;
  } catch (err) {
    console.error(`[floatingGrip] the ${region.type} overlay's hitTest threw; ignoring it:`, err);
    return false;
  }
}

/**
 * The VISIBLE grip under the logical canvas point, with its object, or null.
 *
 * Walks `floatingHitOrder` (topmost first) and returns the first object whose
 * grip shows and contains the point -- unless that object claims the point
 * itself (`ownObjectClaims`: its own affordance there is painted above the
 * grip, and the point is its body's). Nothing in the header GUTTERS: the
 * headers are painted after the grips (a grip scrolled under the column
 * header, or the left-hand grip of an object at the sheet's left edge, is
 * covered there), and a press on a header selects its column or row.
 */
export function floatingGripAt(
  px: number,
  py: number,
  gutters: FloatingGutters,
  scroll: FloatingScroll,
  zoom: number = currentGripZoom(),
  regions: readonly GridRegion[] = getLiveGridRegions(),
): FloatingGripHit | null {
  if (px < gutters.rowHeaderWidth || py < gutters.colHeaderHeight) return null;
  const env = currentGripEnv(regions);
  if (env.blocked) return null;
  const page = env.surface?.page ?? null;
  for (const region of floatingHitOrder(regions)) {
    if (!floatingGripShown(region, env)) continue;
    const grip = floatingGripOf(region, gutters, scroll, zoom, page);
    if (grip && floatingGripHits(grip, px, py)) {
      return ownObjectClaims(region, grip, px, py) ? null : { region, grip };
    }
  }
  return null;
}

// ============================================================================
// The grid's side: repaint, stale hover, right-click
// ============================================================================

/**
 * What the grid (Spreadsheet.tsx) keeps in step with Core's hover and gesture
 * facts while it is mounted. Returns the uninstall.
 *
 *   - a hover change repaints -- only when a `grip: "hover"` region is
 *     involved (`hoverChangeAffectsGrips`): moving between two objects without
 *     a hover grip repaints nothing;
 *   - a gesture change repaints (every grip hides during a Core move or resize,
 *     and comes back at its release);
 *   - a published region list that no longer holds the hovered object (it was
 *     deleted, moved to another sheet, re-published without it) clears the
 *     hover: nothing under a still pointer says so otherwise.
 */
export function installObjectHoverUpkeep(): () => void {
  const offHover = onFloatingHoverChanged((id, previous) => {
    if (hoverChangeAffectsGrips(previous, id)) requestOverlayRedraw();
  });
  const offGesture = onFloatingGestureChanged(() => requestOverlayRedraw());
  const offRegions = onRegionChange((regions) => {
    const id = getHoveredFloatingRegionId();
    if (id !== null && !regions.some((r) => r.id === id)) clearFloatingHover();
  });
  return () => {
    offHover();
    offGesture();
    offRegions();
  };
}

/**
 * The grid's right-click at a logical canvas point: on a VISIBLE grip, the
 * grip's menu -- FLOATING_GRIP_CLICK_EVENT with `button: 2`, anchored at the
 * grip in CLIENT px (`container` is the grid area's client rectangle) -- and
 * true; anywhere else nothing, and false. Asked by the grid's contextmenu
 * handler after every family's own capture-phase menu had its chance (a family
 * that looks the point up through `topFloatingRegionAt` finds the grip's
 * object and opens its own menu, which carries Size and Position too) and
 * before the cell menu: the cell under a grip is never the one right-clicked.
 */
export function dispatchGripContextMenu(
  px: number,
  py: number,
  gutters: FloatingGutters,
  scroll: FloatingScroll,
  zoom: number,
  container: { left: number; top: number },
): boolean {
  const hit = floatingGripAt(px, py, gutters, scroll, zoom);
  if (!hit) return false;
  const detail: FloatingGripClickDetail = {
    regionId: hit.region.id,
    regionType: hit.region.type,
    data: hit.region.data,
    anchor: floatingGripAnchor(hit.grip, container, zoom),
    button: 2,
  };
  window.dispatchEvent(new CustomEvent(FLOATING_GRIP_CLICK_EVENT, { detail }));
  return true;
}

/**
 * The facade's "topmost object at this point" answer for a VISIBLE grip (see
 * THE PROBE in the header): the grip's object, or null.
 */
export const floatingGripChromeProbe: FloatingChromeHitProbe = (canvasX, canvasY, geo, regions) => {
  const hit = floatingGripAt(
    canvasX,
    canvasY,
    { rowHeaderWidth: geo.rowHeaderWidth, colHeaderHeight: geo.colHeaderHeight },
    { scrollX: geo.scrollX, scrollY: geo.scrollY },
    currentGripZoom(),
    regions,
  );
  return hit ? hit.region : null;
};

// Registered once, at load, in the probe LEAF (core/lib/floatingChromeProbe.ts):
// this module is loaded by Core's painter and Core's press handlers, both of
// which load with the grid.
registerFloatingChromeHitProbe(floatingGripChromeProbe);
