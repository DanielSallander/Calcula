//! FILENAME: app/src/api/gridOverlays.ts
// PURPOSE: Generic overlay lifecycle system for grid canvas.
// CONTEXT: Allows extensions to register rectangular region overlays on the grid,
// with rendering, hit-testing, and lifecycle events. The Core renderer calls
// this generic API without knowing about any specific extension (e.g., pivot).

import type { GridConfig, Viewport, DimensionOverrides } from "./types";
import {
  getColumnWidth,
  getRowHeight,
  getColumnsWidth,
  calculateColumnX,
  calculateRowY,
  createDimensionGetterFromMap,
} from "./dimensions";

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

/** Get all current grid regions. */
export function getGridRegions(): GridRegion[] {
  return gridRegions;
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

  for (const renderer of renderers) {
    if (!renderer.hitTest) continue;

    const matchingRegions = gridRegions.filter((r) => r.type === renderer.type);
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
    ctx.config.defaultCellHeight ?? 24,
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
    ctx.config.defaultCellHeight ?? 24,
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
  const defaultHeight = ctx.config.defaultCellHeight ?? 24;
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

export type { GlobalOverlayRendererFn } from "../core/lib/gridRenderer";

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