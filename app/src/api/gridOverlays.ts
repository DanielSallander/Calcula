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
 * A function that returns a CSS cursor string for a given position within an overlay.
 * Return null to use the default cursor logic.
 */
export type OverlayCursorFn = (context: OverlayHitTestContext) => string | null;

/**
 * A function deciding whether an overlay claims an in-body click-drag (e.g. a
 * chart brush) instead of letting Core convert the drag into a move. Consulted at
 * mousedown after the overlay is selected; returning true makes Core dispatch a
 * generic "floatingObject:bodyDragStart" event and NOT start a move — the overlay
 * then owns the drag via its own window listeners.
 */
export type OverlayClaimsBodyDragFn = (context: OverlayHitTestContext) => boolean;

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
   * Optional callback to provide a CSS cursor string when the mouse hovers
   * over this overlay. Return null to use the default cursor logic.
   */
  getCursor?: OverlayCursorFn;
  /**
   * Optional: claim an in-body click-drag instead of letting Core start a move.
   * Consulted at mousedown after selection; if it returns true Core dispatches a
   * generic "floatingObject:bodyDragStart" event and does NOT begin a move — the
   * overlay tracks the drag (move/up) via its own window listeners. Default: no
   * claim, so the existing move/select behavior is unchanged.
   */
  claimsBodyDrag?: OverlayClaimsBodyDragFn;
  /**
   * Optional: handle a DOUBLE-CLICK on this overlay. Consulted only when the
   * double-click lands on the overlay (the same body/extended-hit test the
   * cursor and the body-drag claim use) and only when the registration opts in.
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
 */
export function topFloatingRegionAt(
  canvasX: number,
  canvasY: number,
  geo: FloatingHitGeometry | null = currentFloatingHitGeometry(),
  regions: readonly GridRegion[] = getLiveGridRegions(),
): GridRegion | null {
  if (!geo) return null;
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