//! FILENAME: app/src/api/gridOverlays.ts
// PURPOSE: Generic overlay lifecycle system for grid canvas.
// CONTEXT: Allows extensions to register rectangular region overlays on the grid,
// with rendering, hit-testing, and lifecycle events. The Core renderer calls
// this generic API without knowing about any specific extension (e.g., pivot).
//
// STACKING. There is ONE answer to "which floating object is on top", and it
// lives here: `stackedFloatingRegions` (paint order, bottom first) and
// `floatingHitOrder` (topmost first). The renderer's above-selection pass, the
// body press, the resize-handle scan, the keyboard object cycler, the object
// wheel and every family's right-click lookup read it, so what paints on top
// is what a press, a wheel or a menu reaches. Without any effective z the two
// orders are exactly the ones those callers always used (paint: overlay
// priority then publication order; hit: reverse publication order). A region
// gets a z from `GridRegion.z` or from the one stacking resolver an extension
// registers (a canvas sheet maps its layout's zOrder); in that "z-mode" the
// hit order is the exact reverse of the paint order.

import type { GridConfig, Viewport, DimensionOverrides } from "./types";
import {
  getColumnWidth,
  getRowHeight,
  getColumnsWidth,
  calculateColumnX,
  calculateRowY,
  createDimensionGetterFromMap,
} from "./dimensions";
import { getGridStateSnapshot } from "../core/state/GridContext";
import { resolveHeaderSizes, paintedDisplayHeadings } from "../core/lib/gridRenderer/layout/headerVisibility";
import { isPointModeOnForeignSheet } from "../core/lib/pointModeView";
import { getLayoutSurface, isRegionLocked } from "../core/lib/layoutSurface";
import { floatingChromeHitProbe } from "../core/lib/floatingChromeProbe";

// What the grid SHOWS during cross-sheet point mode (a formula picking a
// reference on another sheet). A family that must hide DOM it hosts itself
// (embedded forms, html shapes) subscribes to the edge-triggered signal; paint
// and hit sites read `getLiveGridRegions()` below.
export { isPointModeOnForeignSheet, onPointModeViewChanged } from "../core/lib/pointModeView";

// ============================================================================
// Region Definition
// ============================================================================

/** A rectangular region on the grid that an extension claims ownership of. */
export interface GridRegion {
  /** Unique region identifier (e.g., "pivot-1") */
  id: string;
  /** Region type, used to match overlay renderers (e.g., "pivot") */
  type: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Extension-defined metadata */
  data?: Record<string, unknown>;
  /**
   * Pixel-based positioning for free-floating overlays.
   * When set, the overlay is positioned by pixel coordinates relative to the
   * sheet origin (top-left of cell A1) rather than by cell coordinates.
   * The startRow/startCol/endRow/endCol fields are ignored for floating overlays.
   */
  floating?: { x: number; y: number; width: number; height: number };
  /**
   * Stacking position of a FLOATING region: higher paints later (on top) and is
   * hit first. Optional; when absent the registered stacking resolver may
   * supply one (see `registerRegionStacking`). Floating regions WITHOUT an
   * effective z paint above every region that has one -- a newly inserted
   * object appears on top until something places it. Ignored on cell-anchored
   * regions.
   */
  z?: number;
}

// ============================================================================
// Overlay Renderer
// ============================================================================

/** Context passed to overlay render functions during grid paint. */
export interface OverlayRenderContext {
  ctx: CanvasRenderingContext2D;
  region: GridRegion;
  /** @internal Prefer using helper functions (overlayGetColumnWidth, overlayGetRowHeight, etc.) */
  config: GridConfig;
  /** @internal Prefer using helper functions (overlayGetColumnX, overlayGetRowY, etc.) */
  viewport: Viewport;
  /** @internal Prefer using helper functions (overlayGetColumnWidth, overlayGetRowHeight, etc.) */
  dimensions: DimensionOverrides;
  canvasWidth: number;
  canvasHeight: number;
}

/** A function that renders an overlay for a given region. */
export type OverlayRendererFn = (context: OverlayRenderContext) => void;

// ============================================================================
// Hit Testing
// ============================================================================

/** Context passed to overlay hit-test functions. */
export interface OverlayHitTestContext {
  region: GridRegion;
  canvasX: number;
  canvasY: number;
  row: number;
  col: number;
  /** Pre-computed canvas bounds for floating overlays. Only set when region.floating is defined. */
  floatingCanvasBounds?: { x: number; y: number; width: number; height: number };
}

/** A function that tests whether a point falls within an overlay region. */
export type OverlayHitTestFn = (context: OverlayHitTestContext) => boolean;

/**
 * The pointer over a CELL of a CELL-ANCHORED region (a worksheet pivot's +/-
 * icons, an AutoFilter or validation chevron), or null for the grid's own
 * cell cursor. Consulted ONLY for regions WITHOUT a `floating` box: a floating
 * object's pointer comes from its `zoneAt` answer, the same answer its press
 * is routed by, so the two can never disagree.
 */
export type OverlayCellCursorFn = (context: OverlayHitTestContext) => string | null;

/**
 * A function deciding what a DOUBLE-CLICK on an overlay means. Consulted by Core
 * when a double-click lands on a floating overlay, after the pointer-claim check
 * and BEFORE the grid's own double-click handling. Returning true means
 * "handled, do not fall through"; returning false leaves the gesture to Core,
 * which over a floating object is to do nothing at all -- a double-click on a
 * chart must never open the cell editor hidden underneath it.
 *
 * This is the only route by which an overlay's owner hears about a
 * double-click: `cellDoubleClickInterceptors` is asked about a CELL, and over a
 * floating overlay there is no cell to be asked about.
 */
export type OverlayDoubleClickFn = (context: OverlayHitTestContext) => boolean;

/**
 * What a point on a FLOATING object is FOR -- the one answer Core derives the
 * press, the hover pointer and the meaning of Ctrl/Shift from (BUG-0258's
 * grammar: the FRAME moves the object, the CONTENT does its own job).
 *
 *   frame    Core owns the press: it selects the object (Ctrl/Shift add or
 *            toggle it on a canvas) and a drag MOVES it, unless the object is
 *            immovable, locked or on a subscribed page. `cursor` is optional:
 *            without one Core shows 'move' where the object can move and
 *            'default' where it cannot, so a locked object never promises a
 *            move it will refuse.
 *   content  The object's own job (a range drag, a filter click, a brush, a
 *            cell). Core selects the object as a PLAIN press -- Ctrl/Shift
 *            belong to the content, never to object selection -- and hands
 *            the press over with `floatingObject:bodyDragStart`; it never
 *            moves the object, and it works on a locked object and on a
 *            subscribed page (reading the report is not editing it).
 *
 * `part` is the family's own name for the zone (a timeline's 'period', a
 * floating grid's 'title'); Core only carries it -- on both press events -- so
 * the handler acts on the zone decided BEFORE the press selected anything.
 */
export type OverlayZone =
  | { kind: "frame"; cursor?: string | null; part?: string }
  | { kind: "content"; cursor: string; part?: string };

/**
 * The zone under a point of a floating overlay; null means the whole point is
 * frame. See `OverlayRegistration.zoneAt` for the purity contract.
 */
export type OverlayZoneFn = (context: OverlayHitTestContext) => OverlayZone | null;

// ============================================================================
// Lifecycle Events
// ============================================================================

/** Handler called when the set of grid regions changes. */
export type RegionChangeHandler = (regions: GridRegion[]) => void;

// ============================================================================
// Overlay Registration
// ============================================================================

/** Describes an overlay renderer that handles a specific region type. */
export interface OverlayRegistration {
  /** Region type this overlay handles (e.g., "pivot") */
  type: string;
  /** Render function called during grid paint */
  render: OverlayRendererFn;
  /** Optional hit-test function for mouse interaction */
  hitTest?: OverlayHitTestFn;
  /** Priority for render ordering (higher = later = on top). Default: 0 */
  priority?: number;
  /**
   * When true, this overlay renders BEFORE the selection layer instead of after.
   * Use this for cell-based overlays (e.g., pivot tables) that should appear
   * underneath the standard selection highlight, so selection looks identical
   * to regular grid cells. Default: false (renders after selection).
   */
  renderBelowSelection?: boolean;
  /**
   * Optional: the pointer over a cell of a CELL-ANCHORED region of this type
   * (`OverlayCellCursorFn`). Core consults it ONLY for regions without a
   * `floating` box; a floating object's pointer is its `zoneAt` answer, so a
   * floating family that sets this changes nothing. There is deliberately no
   * second per-point answer for floating objects -- the pointer and the press
   * must come from one place (BUG-0258).
   */
  getCellCursor?: OverlayCellCursorFn;
  /**
   * Optional: the ZONE under a point of this FLOATING overlay (`OverlayZone`)
   * -- the ONE answer from which Core derives the press routing, the hover
   * pointer and whether Ctrl/Shift reach object selection
   * (`resolveFloatingZone`). A floating type that registers no `zoneAt` is
   * all frame: Core selects it and moves it by its body when it can move.
   *
   * PURE, and that is a contract: no store writes, no dispatch, no hover side
   * effects. It is asked on every hover move and ONCE per press, BEFORE the
   * press selects anything (before `noteObjectPress` and before
   * `floatingObject:selected`), so it must answer from the state the user saw
   * when they pressed -- never from a selection the press itself makes.
   */
  zoneAt?: OverlayZoneFn;
  /**
   * Optional: handle a DOUBLE-CLICK on this overlay. Consulted only when the
   * double-click lands on the overlay (the same body/extended-hit test the
   * press and the hover use) and only when the registration opts in.
   * Return true when the overlay took the gesture. Default: no handler, so the
   * double-click is swallowed exactly as it always was.
   */
  onDoubleClick?: OverlayDoubleClickFn;
}

// ============================================================================
// Internal State
// ============================================================================

const overlayRegistry = new Map<string, OverlayRegistration>();
let gridRegions: GridRegion[] = [];
const regionChangeListeners = new Set<RegionChangeHandler>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register an overlay renderer for a region type.
 * @returns A cleanup function that unregisters the overlay.
 */
export function registerGridOverlay(registration: OverlayRegistration): () => void {
  overlayRegistry.set(registration.type, registration);
  return () => {
    overlayRegistry.delete(registration.type);
  };
}

/** Unregister an overlay renderer by type. */
export function unregisterGridOverlay(type: string): void {
  overlayRegistry.delete(type);
}

/**
 * Set the current grid regions (replaces all).
 * Fires region change listeners.
 */
export function setGridRegions(regions: GridRegion[]): void {
  gridRegions = regions;
  notifyRegionChange();
}

/**
 * Add regions without replacing existing ones.
 * Fires region change listeners.
 */
export function addGridRegions(regions: GridRegion[]): void {
  gridRegions = [...gridRegions, ...regions];
  notifyRegionChange();
}

/** Remove all regions of a given type. Fires region change listeners. */
export function removeGridRegionsByType(type: string): void {
  gridRegions = gridRegions.filter((r) => r.type !== type);
  notifyRegionChange();
}

/**
 * Atomically replace all regions of a given type with new ones.
 * Fires region change listeners only once (not twice like remove+add).
 * This prevents intermediate renders where regions are briefly empty.
 *
 * @param notify - If false, skips notifying listeners. Use this when a
 *   subsequent event (e.g., grid:refresh) will trigger the redraw anyway,
 *   to avoid an intermediate draw with stale cell data.
 */
export function replaceGridRegionsByType(type: string, regions: GridRegion[], notify = true): void {
  gridRegions = [...gridRegions.filter((r) => r.type !== type), ...regions];
  if (notify) notifyRegionChange();
}

/** Get all current grid regions. */
export function getGridRegions(): GridRegion[] {
  return gridRegions;
}

/**
 * The regions the grid PAINTS and HIT-TESTS: none while
 * `isPointModeOnForeignSheet()` -- a formula is picking a reference on a sheet
 * other than the one the edit belongs to, and every published region belongs
 * to the EDIT's sheet (a point-mode switch emits no SHEET_CHANGED, so no family
 * re-filtered). Before this, a canvas's objects painted over Sheet1 and caught
 * the very click meant to pick Sheet1!E2.
 *
 * Paint and hit sites ONLY. A family reading regions for its own STATE keeps
 * `getGridRegions()`. Returns a fresh [] when suppressed.
 */
export function getLiveGridRegions(): GridRegion[] {
  return isPointModeOnForeignSheet() ? [] : gridRegions;
}

/**
 * Get all registered overlay renderers, sorted by priority (ascending).
 * Lower priority renders first (underneath); higher priority renders on top.
 */
export function getOverlayRenderers(): OverlayRegistration[] {
  return Array.from(overlayRegistry.values()).sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );
}

/** Get the overlay registration for a specific region type. */
export function getOverlayRegistration(type: string): OverlayRegistration | undefined {
  return overlayRegistry.get(type);
}

/**
 * Listen for region changes.
 * @returns A cleanup function that removes the listener.
 */
export function onRegionChange(handler: RegionChangeHandler): () => void {
  regionChangeListeners.add(handler);
  return () => {
    regionChangeListeners.delete(handler);
  };
}

/**
 * Request a canvas redraw for overlay changes.
 * Use this when overlay visual state changes (e.g., cached render completed)
 * without the grid regions themselves changing.
 */
export function requestOverlayRedraw(): void {
  notifyRegionChange();
}

/**
 * Hit-test: find which overlay region (if any) is at the given position.
 * Tests in reverse priority order so the topmost overlay wins.
 *
 * For floating overlays, pass scrollX/scrollY/rowHeaderWidth/colHeaderHeight
 * so that pixel-based canvas bounds can be computed for hit-testing.
 */
export function hitTestOverlays(
  canvasX: number,
  canvasY: number,
  row: number,
  col: number,
  scrollX?: number,
  scrollY?: number,
  rowHeaderWidth?: number,
  colHeaderHeight?: number,
): GridRegion | null {
  const renderers = getOverlayRenderers().reverse();
  // What the grid PAINTS is what a press can hit: nothing of the edit's sheet
  // while point mode shows another one.
  const live = getLiveGridRegions();

  for (const renderer of renderers) {
    if (!renderer.hitTest) continue;

    const matchingRegions = live.filter((r) => r.type === renderer.type);
    for (const region of matchingRegions) {
      // Pre-compute canvas bounds for floating overlays
      let floatingCanvasBounds: { x: number; y: number; width: number; height: number } | undefined;
      if (region.floating && scrollX != null && scrollY != null) {
        const rhw = rowHeaderWidth ?? 50;
        const chh = colHeaderHeight ?? 24;
        floatingCanvasBounds = {
          x: rhw + region.floating.x - scrollX,
          y: chh + region.floating.y - scrollY,
          width: region.floating.width,
          height: region.floating.height,
        };
      }

      if (renderer.hitTest({ region, canvasX, canvasY, row, col, floatingCanvasBounds })) {
        return region;
      }
    }
  }

  return null;
}

// ============================================================================
// Stacking (z-order)
// ============================================================================

/**
 * Supplies a floating region's stacking position when the region itself
 * carries none. Return undefined for "no opinion" (the region then paints above
 * every region that has a z). Must be cheap and pure: it is asked during paint
 * and on every pointer move.
 */
export type RegionStackingResolver = (region: GridRegion) => number | undefined;

let stackingResolver: RegionStackingResolver | null = null;

/**
 * Register THE stacking resolver. Last registration wins (like the other Core
 * seams); the cleanup removes only what is still this resolver, so a stale
 * cleanup cannot remove a newer one.
 */
export function registerRegionStacking(resolver: RegionStackingResolver): () => void {
  stackingResolver = resolver;
  return () => {
    if (stackingResolver === resolver) stackingResolver = null;
  };
}

function finiteOrUndefined(z: unknown): number | undefined {
  return typeof z === "number" && Number.isFinite(z) ? z : undefined;
}

/**
 * A region's effective stacking position: its own `z`, else the resolver's
 * answer, else undefined. A resolver that throws is treated as having no
 * opinion (logged), so one bad resolver cannot break paint or the mouse.
 */
export function effectiveZ(region: GridRegion): number | undefined {
  const own = finiteOrUndefined(region.z);
  if (own !== undefined) return own;
  if (!stackingResolver) return undefined;
  try {
    return finiteOrUndefined(stackingResolver(region));
  } catch (err) {
    console.error("[gridOverlays] stacking resolver threw:", err);
    return undefined;
  }
}

/**
 * Whether a stacking order is in force for `regions`: some FLOATING region has
 * an effective z. Without one, every ordering below is exactly the historical
 * one.
 */
export function hasStackingOrder(regions: readonly GridRegion[] = gridRegions): boolean {
  if (!stackingResolver && !regions.some((r) => r.z !== undefined)) return false;
  return regions.some((r) => !!r.floating && effectiveZ(r) !== undefined);
}

/**
 * Each registered type's position in the renderer's paint sequence:
 * below-selection renderers first, then the rest, each by priority with
 * registration order breaking ties -- exactly the order `renderGrid` walks.
 */
function paintRanks(): { rank: Map<string, number>; below: Set<string> } {
  const sorted = getOverlayRenderers();
  const belowList = sorted.filter((r) => r.renderBelowSelection === true);
  const aboveList = sorted.filter((r) => r.renderBelowSelection !== true);
  const rank = new Map<string, number>();
  [...belowList, ...aboveList].forEach((r, i) => rank.set(r.type, i));
  return { rank, below: new Set(belowList.map((r) => r.type)) };
}

/**
 * The FLOATING regions of `regions` in PAINT order, bottom first.
 *
 * Without a stacking order: the renderer's order -- overlay priority (with
 * below-selection renderers first and registration order on ties), then
 * publication order. With one (z-mode): below-selection renderers still first
 * (that pass is not re-ordered), then regions WITH an effective z by ascending
 * z, then regions WITHOUT one (a new object is on top); ties by the same
 * renderer order, then publication order. A type with no registered renderer
 * is not painted at all and sorts first.
 */
export function stackedFloatingRegions(regions: readonly GridRegion[] = gridRegions): GridRegion[] {
  const zMode = hasStackingOrder(regions);
  const { rank, below } = paintRanks();
  return regions
    .map((region, index) => ({
      region,
      index,
      layer: below.has(region.type) ? 0 : 1,
      rank: rank.get(region.type) ?? -1,
      z: zMode ? effectiveZ(region) : undefined,
    }))
    .filter((e) => !!e.region.floating)
    .sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      if (zMode) {
        const aNone = a.z === undefined ? 1 : 0;
        const bNone = b.z === undefined ? 1 : 0;
        if (aNone !== bNone) return aNone - bNone;
        if (a.z !== undefined && b.z !== undefined && a.z !== b.z) return a.z - b.z;
      }
      return a.rank - b.rank || a.index - b.index;
    })
    .map((e) => e.region);
}

/**
 * The FLOATING regions of `regions` in HIT order, topmost first -- the order
 * every "what is under the pointer" question must walk.
 *
 * Without a stacking order: reverse publication order (what Core's press has
 * always used). With one: the exact reverse of `stackedFloatingRegions`, so
 * the object painted on top is the object a press reaches.
 */
export function floatingHitOrder(regions: readonly GridRegion[] = gridRegions): GridRegion[] {
  if (hasStackingOrder(regions)) return stackedFloatingRegions(regions).reverse();
  const out: GridRegion[] = [];
  for (let i = regions.length - 1; i >= 0; i--) {
    if (regions[i].floating) out.push(regions[i]);
  }
  return out;
}

/** Where floating regions sit on the canvas: the PAINTED gutters and the scroll. */
export interface FloatingHitGeometry {
  rowHeaderWidth: number;
  colHeaderHeight: number;
  scrollX: number;
  scrollY: number;
}

/**
 * The live geometry of the active sheet, with the gutters the renderer PAINTED
 * (a canvas never shows headings, whatever the stored config says). Null
 * before the grid is mounted.
 */
export function currentFloatingHitGeometry(): FloatingHitGeometry | null {
  const s = getGridStateSnapshot();
  if (!s) return null;
  const { rowHeaderWidth, colHeaderHeight } = resolveHeaderSizes(
    s.config,
    paintedDisplayHeadings(s.surface, s.displayHeadings),
  );
  return { rowHeaderWidth, colHeaderHeight, scrollX: s.viewport.scrollX, scrollY: s.viewport.scrollY };
}

/**
 * The topmost FLOATING region whose rectangle contains the logical
 * (zoom-corrected) canvas point, walking `floatingHitOrder`. Plain bounds only
 * (the same test Core's press starts from). `geo` defaults to the live painted
 * geometry and `regions` to the published list. Null when no floating region
 * is there, or before the grid is mounted.
 *
 * A family's own right-click / wheel lookup asks this before claiming a point,
 * so an object covered by another cannot open its menu (or scroll) from behind.
 *
 * The default list is the LIVE one (`getLiveGridRegions`), so during
 * cross-sheet point mode no default-list caller -- `topFloatingRegionAtClient`,
 * `isOccludedAtClientPoint`, every family's right-click lookup -- can reach an
 * object of the sheet the edit belongs to.
 *
 * A point on an object's VISIBLE GRIP (BUG-0258 design phase 5) answers that
 * object, before any body: the grip sits just outside its object, is painted
 * above every object and wins Core's press there, so a family's right-click
 * there opens the grip owner's menu and a wheel there scrolls the grip's
 * object (plan decision D6).
 */
export function topFloatingRegionAt(
  canvasX: number,
  canvasY: number,
  geo: FloatingHitGeometry | null = currentFloatingHitGeometry(),
  regions: readonly GridRegion[] = getLiveGridRegions(),
): GridRegion | null {
  if (!geo) return null;
  // Core's object CHROME outside an object's rectangle first: a visible grip
  // (core/lib/floatingGrip.ts) is painted above every object and takes the
  // press there, so it is its object's point for every other lookup too. The
  // grip registers its hit test in a leaf (core/lib/floatingChromeProbe.ts):
  // it imports this facade, so the facade cannot import it.
  const chromeHitProbe = floatingChromeHitProbe();
  if (chromeHitProbe !== null) {
    try {
      const chrome = chromeHitProbe(canvasX, canvasY, geo, regions);
      if (chrome) return chrome;
    } catch (err) {
      console.error("[gridOverlays] the object-chrome hit probe threw; ignoring it:", err);
    }
  }
  for (const r of floatingHitOrder(regions)) {
    const f = r.floating!;
    const x = geo.rowHeaderWidth + f.x - geo.scrollX;
    const y = geo.colHeaderHeight + f.y - geo.scrollY;
    if (canvasX >= x && canvasX <= x + f.width && canvasY >= y && canvasY <= y + f.height) {
      return r;
    }
  }
  return null;
}

/**
 * `topFloatingRegionAt` for a CLIENT (mouse event) point: converted to the
 * logical canvas basis the way Core's own mouse handling does (relative to the
 * grid area, divided by the zoom). Null outside the grid area or before mount.
 */
export function topFloatingRegionAtClient(clientX: number, clientY: number): GridRegion | null {
  if (typeof document === "undefined") return null;
  const area = document.querySelector("[data-grid-area]");
  if (!area) return null;
  const rect = area.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null;
  }
  const zoom = getGridStateSnapshot()?.zoom || 1;
  return topFloatingRegionAt((clientX - rect.left) / zoom, (clientY - rect.top) / zoom);
}

/**
 * Whether ANOTHER floating object takes the logical canvas point before
 * `regionId` does, in Core's press order: another object's VISIBLE GRIP there
 * (the chrome probe, which Core's press asks first), or an object stacked
 * ABOVE `regionId` (`floatingHitOrder`) whose rectangle -- or its
 * registration's extended `hitTest` (a chart's quick-access buttons outside
 * its edge) -- contains the point. Objects BELOW `regionId` never cover it.
 *
 * THE "RELEASED INSIDE" RULE every content press keeps (BUG-0258 M7 review):
 * a button, a slicer's Select all / clear button, a pivot box's chrome and a
 * chart's buttons act at a release only over THEMSELVES, and a part of them
 * another object covers is not theirs to release on -- Core's press there
 * would have gone to the cover. The family's own hit test says WHICH part of
 * its object is under the point (it may lie outside the object's rectangle);
 * this says whether that part is reachable there.
 *
 * False -- nothing known to cover it -- when `regionId` is not among the live
 * floating regions, or before the grid is mounted (no geometry).
 */
export function isFloatingRegionCoveredAt(
  regionId: string,
  canvasX: number,
  canvasY: number,
  geo: FloatingHitGeometry | null = currentFloatingHitGeometry(),
  regions: readonly GridRegion[] = getLiveGridRegions(),
): boolean {
  if (!geo || !regions.some((r) => r.id === regionId && r.floating)) return false;
  const chromeHitProbe = floatingChromeHitProbe();
  if (chromeHitProbe !== null) {
    try {
      const chrome = chromeHitProbe(canvasX, canvasY, geo, regions);
      if (chrome) return chrome.id !== regionId;
    } catch (err) {
      console.error("[gridOverlays] the object-chrome hit probe threw; ignoring it:", err);
    }
  }
  for (const r of floatingHitOrder(regions)) {
    if (r.id === regionId) return false;
    const f = r.floating!;
    const x = geo.rowHeaderWidth + f.x - geo.scrollX;
    const y = geo.colHeaderHeight + f.y - geo.scrollY;
    if (canvasX >= x && canvasX <= x + f.width && canvasY >= y && canvasY <= y + f.height) return true;
    const hitTest = overlayRegistry.get(r.type)?.hitTest;
    if (hitTest) {
      try {
        if (
          hitTest({
            region: r,
            canvasX,
            canvasY,
            row: 0,
            col: 0,
            floatingCanvasBounds: { x, y, width: f.width, height: f.height },
          })
        ) {
          return true;
        }
      } catch (err) {
        console.error(`[gridOverlays] the ${r.type} overlay's hitTest threw; ignoring it:`, err);
      }
    }
  }
  return false;
}

/**
 * `isFloatingRegionCoveredAt` for a CLIENT (mouse event) point, converted the
 * way Core's own mouse handling does (relative to the grid area, divided by the
 * zoom). False outside the grid area, before mount, or without a grid area.
 */
export function isFloatingRegionCoveredAtClient(regionId: string, clientX: number, clientY: number): boolean {
  if (typeof document === "undefined") return false;
  const area = document.querySelector("[data-grid-area]");
  if (!area) return false;
  const rect = area.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return false;
  }
  const zoom = getGridStateSnapshot()?.zoom || 1;
  return isFloatingRegionCoveredAt(regionId, (clientX - rect.left) / zoom, (clientY - rect.top) / zoom);
}

/**
 * True when a floating object that `isMine` does NOT accept is the topmost one
 * at the client point -- the one question every family's right-click and wheel
 * handler asks before claiming the gesture. False when nothing floating is
 * there (the family's own lookup then decides, exactly as before).
 */
export function isOccludedAtClientPoint(
  clientX: number,
  clientY: number,
  isMine: (region: GridRegion) => boolean,
): boolean {
  const top = topFloatingRegionAtClient(clientX, clientY);
  return top !== null && !isMine(top);
}

// ============================================================================
// Zones: one answer per point (frame or content)
// ============================================================================

/** A point's zone, resolved against the object's movability -- Core's view. */
export interface ResolvedFloatingZone {
  kind: "frame" | "content";
  /** The family's own name for the zone, or null. */
  part: string | null;
  /** The pointer shape over this point (never null). */
  cursor: string;
  /**
   * Whether a FRAME drag would move the object: not published `movable:
   * false`, not locked on its layout surface, and the surface editable (not a
   * subscribed page).
   */
  canMove: boolean;
}

function activeSurface() {
  return getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
}

function zoneOf(ctx: OverlayHitTestContext): OverlayZone | null {
  const zoneAt = overlayRegistry.get(ctx.region.type)?.zoneAt;
  if (!zoneAt) return null;
  try {
    const zone = zoneAt(ctx);
    if (zone && (zone.kind === "frame" || zone.kind === "content")) return zone;
    return null;
  } catch (err) {
    // The effectiveZ precedent: one broken family must not break the mouse.
    console.error("[gridOverlays] zoneAt threw; treating the point as frame:", err);
    return null;
  }
}

/**
 * THE rule for a point on a floating object -- the only place it lives. Core's
 * press and Core's hover both read it, and a family's test can ask it too:
 *
 *   canMove = region.data.movable !== false
 *             && the active sheet's layout surface does not lock the object
 *             && that surface is editable (absent surface: a worksheet, free)
 *   content: its own cursor
 *   frame:   its own cursor if it has one, else 'move' when canMove, else
 *            'default' (a locked or subscribed object never shows 'move')
 *
 * A `zoneAt` that throws counts as null (logged); a type with no `zoneAt` is
 * all frame.
 */
export function resolveFloatingZone(ctx: OverlayHitTestContext): ResolvedFloatingZone {
  const region = ctx.region;
  const zone = zoneOf(ctx);
  const surface = activeSurface();
  const canMove =
    region.data?.movable !== false && !isRegionLocked(surface, region) && (surface?.editable ?? true);
  if (zone?.kind === "content") {
    const cursor = typeof zone.cursor === "string" && zone.cursor.length > 0 ? zone.cursor : "default";
    return { kind: "content", part: zone.part ?? null, cursor, canMove };
  }
  const own = zone?.cursor;
  return {
    kind: "frame",
    part: zone?.part ?? null,
    cursor: typeof own === "string" && own.length > 0 ? own : canMove ? "move" : "default",
    canMove,
  };
}

// A CONTENT gesture (the timeline's range drag) owns the pointer while its
// button is held: over its own object the pointer is the gesture's, whatever
// zone it passes over, while `zoneAt` keeps answering what a PRESS there
// would be. One slot -- there is one pointer.
let heldGestureCursor: { regionId: string; cursor: string; token: object } | null = null;

/**
 * Hold the pointer shape over `regionId` for a content gesture, or update the
 * one this region already holds. Returns the release; every release handed
 * out for one continuous hold releases it, and a release left over from an
 * older hold does nothing. Core also drops the hold at the next object press
 * (a backstop for a gesture whose release never came).
 */
export function holdContentGestureCursor(regionId: string, cursor: string): () => void {
  if (heldGestureCursor !== null && heldGestureCursor.regionId === regionId) {
    heldGestureCursor = { regionId, cursor, token: heldGestureCursor.token };
  } else {
    heldGestureCursor = { regionId, cursor, token: {} };
  }
  const token = heldGestureCursor.token;
  return () => {
    if (heldGestureCursor !== null && heldGestureCursor.token === token) heldGestureCursor = null;
  };
}

/** The pointer a live content gesture holds over `regionId`, or null. */
export function contentGestureCursorFor(regionId: string): string | null {
  return heldGestureCursor !== null && heldGestureCursor.regionId === regionId ? heldGestureCursor.cursor : null;
}

/**
 * Whether a content gesture holds the pointer at all. Core's hover asks it
 * before its resize handles: the gesture's button is held, so no handle can
 * start a resize, and a handle that turned live halfway through (the press
 * selected the object) must not take the pointer from the gesture.
 */
export function isContentGestureHeld(): boolean {
  return heldGestureCursor !== null;
}

/** Core's backstop at every object press: no gesture outlives the next press. */
export function clearContentGestureCursor(): void {
  heldGestureCursor = null;
}

// ============================================================================
// Selection handles (BUG-0258 design phase 3)
// ============================================================================

// Core paints a SELECTED floating object's outline and handles and hit-tests
// the handles from ONE geometry (core/lib/floatingHandles.ts): live only on a
// selected, resizable, unlocked object on an editable surface, eight of them
// (four corners, plus the edge midpoints on edges of at least 48px), or the
// four corners only for a region that publishes `data.handles: "corners"`.
// A family paints no selection chrome of its own. What a family may need is
// the numbers its OWN affordances are laid out against: a floating grid
// derives the shortest edge that may carry a yellow edge ball from Core's hit
// half-size (Core's handles are scanned first and win the press), and the
// canvas paints its lock mark in the selection colour.
// From the LEAF module of the numbers, never from floatingHandles.ts: that one
// imports this module and @api/objectSelection, and a re-export from it would
// make loading this facade load the selection seam through a cycle.
export {
  FLOATING_HANDLE_HIT_HALF,
  FLOATING_HANDLE_PAINT_SIZE,
  FLOATING_SELECTION_COLOUR,
} from "../core/lib/floatingHandleMetrics";

// ============================================================================
// Hover and the grip (BUG-0258 design phase 5)
// ============================================================================

// Core keeps ONE hover: the floating region under the pointer (a live handle's,
// a grip's or a body's -- the order the press takes them), cleared when the
// pointer leaves the grid area, the grid scrolls, the sheet changes or the
// hovered region is no longer published. A family that keeps a highlight of its
// own (the canvas pivot box's +/- buttons) listens here to clear it when Core's
// hover leaves its object -- which its own mousemove cannot see on a scroll or
// a sheet switch. From the LEAF module, never from the grip module (the cycle
// described above).
//
// A family publishes `data.grip: "hover"` on a region with no header or title
// to grab (a header-less slicer or timeline, a title-less floating grid): Core
// then shows a six-dot grip just outside its top-left edge while the object is
// hovered or selected. On a canvas page the selection's primary member shows
// one whatever it publishes. Core paints it, hit-tests it and moves the object
// by it; a click on it is `floatingObject:gripClick` (@api/objectGrip).
export { getHoveredFloatingRegionId, onFloatingHoverChanged } from "../core/lib/objectHover";

// ============================================================================
// Internal Helpers
// ============================================================================

function notifyRegionChange(): void {
  const snapshot = [...gridRegions];
  for (const handler of regionChangeListeners) {
    handler(snapshot);
  }
}

// ============================================================================
// Dimension Helpers for Overlay Renderers
// ============================================================================
// Extensions should use these helpers instead of accessing the raw
// config / viewport / dimensions objects on OverlayRenderContext.
// These functions delegate to the shared dimension utilities.

/** Get the width of a specific column, accounting for custom widths. */
export function overlayGetColumnWidth(ctx: OverlayRenderContext, col: number): number {
  return getColumnWidth(
    col,
    ctx.config.defaultCellWidth ?? 100,
    ctx.dimensions.columnWidths
  );
}

/** Get the height of a specific row, accounting for custom heights and hidden rows. */
export function overlayGetRowHeight(ctx: OverlayRenderContext, row: number): number {
  if (ctx.dimensions.hiddenRows && ctx.dimensions.hiddenRows.has(row)) {
    return 0;
  }
  return getRowHeight(
    row,
    ctx.config.defaultCellHeight ?? 20,
    ctx.dimensions.rowHeights
  );
}

/** Get the X pixel coordinate of a column's left edge, relative to the canvas. */
export function overlayGetColumnX(ctx: OverlayRenderContext, col: number): number {
  const getWidth = createDimensionGetterFromMap(
    ctx.config.defaultCellWidth ?? 100,
    ctx.dimensions.columnWidths
  );
  return calculateColumnX(
    col,
    ctx.config.rowHeaderWidth ?? 50,
    ctx.viewport.scrollX,
    getWidth
  );
}

/** Get the Y pixel coordinate of a row's top edge, relative to the canvas. Accounts for hidden rows. */
export function overlayGetRowY(ctx: OverlayRenderContext, row: number): number {
  const baseGetHeight = createDimensionGetterFromMap(
    ctx.config.defaultCellHeight ?? 20,
    ctx.dimensions.rowHeights
  );
  // Wrap the getter to return 0 for hidden rows
  const hiddenRows = ctx.dimensions.hiddenRows;
  const getHeight = hiddenRows && hiddenRows.size > 0
    ? (r: number) => hiddenRows.has(r) ? 0 : baseGetHeight(r)
    : baseGetHeight;
  return calculateRowY(
    row,
    ctx.config.colHeaderHeight ?? 24,
    ctx.viewport.scrollY,
    getHeight
  );
}

/** Get the total width of a range of columns (inclusive). */
export function overlayGetColumnsWidth(ctx: OverlayRenderContext, startCol: number, endCol: number): number {
  return getColumnsWidth(
    startCol,
    endCol,
    ctx.config.defaultCellWidth ?? 100,
    ctx.dimensions.columnWidths
  );
}

/** Get the total height of a range of rows (inclusive). Accounts for hidden rows. */
export function overlayGetRowsHeight(ctx: OverlayRenderContext, startRow: number, endRow: number): number {
  const defaultHeight = ctx.config.defaultCellHeight ?? 20;
  const hiddenRows = ctx.dimensions.hiddenRows;
  let height = 0;
  for (let row = startRow; row <= endRow; row++) {
    if (hiddenRows && hiddenRows.has(row)) continue;
    height += ctx.dimensions.rowHeights.get(row) ?? defaultHeight;
  }
  return height;
}

/** Get the row header width from the overlay context. */
export function overlayGetRowHeaderWidth(ctx: OverlayRenderContext): number {
  return ctx.config.rowHeaderWidth ?? 50;
}

/** Get the column header height from the overlay context. */
export function overlayGetColHeaderHeight(ctx: OverlayRenderContext): number {
  return ctx.config.colHeaderHeight ?? 24;
}

/**
 * Convert sheet pixel coordinates to canvas pixel coordinates.
 * Sheet coordinates: (0,0) = top-left of cell A1.
 * Canvas coordinates: (0,0) = top-left of the canvas element.
 */
export function overlaySheetToCanvas(
  ctx: OverlayRenderContext,
  sheetX: number,
  sheetY: number,
): { canvasX: number; canvasY: number } {
  const rhw = ctx.config.rowHeaderWidth ?? 50;
  const chh = ctx.config.colHeaderHeight ?? 24;
  return {
    canvasX: rhw + sheetX - ctx.viewport.scrollX,
    canvasY: chh + sheetY - ctx.viewport.scrollY,
  };
}

// ============================================================================
// Post-Header Overlay Registry
// ============================================================================
// These renderers are called AFTER all headers (row, column, corner) are drawn.
// Used by the Grouping extension to render the outline bar on top of headers.

import type { GlobalOverlayRendererFn } from "../core/lib/gridRenderer";
export type { GlobalOverlayRendererFn };

const postHeaderOverlayRegistry = new Map<string, GlobalOverlayRendererFn>();

/**
 * Register a renderer that runs after all headers are drawn.
 * Used for features like the outline/grouping bar that overlay the row header area.
 * @returns A cleanup function that unregisters the renderer.
 */
export function registerPostHeaderOverlay(
  id: string,
  fn: GlobalOverlayRendererFn,
): () => void {
  postHeaderOverlayRegistry.set(id, fn);
  return () => {
    postHeaderOverlayRegistry.delete(id);
  };
}

/**
 * Get all registered post-header overlay renderers in insertion order.
 */
export function getPostHeaderOverlayRenderers(): GlobalOverlayRendererFn[] {
  return Array.from(postHeaderOverlayRegistry.values());
}