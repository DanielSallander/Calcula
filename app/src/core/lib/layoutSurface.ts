//! FILENAME: app/src/core/lib/layoutSurface.ts
// PURPOSE: The LAYOUT SURFACE seam -- how Core learns, for the sheet being
//          edited, whether floating objects snap to a grid, how big that grid
//          is, where the page ends, and whether objects may be moved at all.
// CONTEXT: Core owns the pointer GESTURE for every floating object (the move
//          and resize handlers in hooks/useMouseSelection/layout); families own
//          the RESULT (they persist what `moveComplete`/`resizeComplete` hand
//          them). Snapping therefore happens once, here, at the only point every
//          family's geometry passes through -- not five times in five families.
//
//          Core never imports an extension: the canvas extension REGISTERS a
//          provider through `@api/layoutSurface` (which re-exports this module,
//          the pointerClaims precedent), and Core asks it. With no provider, or
//          a provider that answers null for a sheet, nothing changes: ordinary
//          worksheets keep the free movement they always had.
//
//          Units: every number is LOGICAL px, the units of GridRegion.floating,
//          so the grid and the objects it positions can never disagree about
//          scale (zoom and devicePixelRatio are applied later, by the painter).
//
//          LOCK. A surface may lock individual objects (a canvas's
//          `layout.locked`). Core treats a locked object exactly like one whose
//          family set `movable: false` and `resizable: false`: a press still
//          SELECTS it, no drag moves it and no handle resizes it.

import type { GridRegion } from "../../api/gridOverlays";

/** What Core needs to know about the layout of one sheet's floating objects. */
export interface LayoutSurface {
  /** Snap dragged/resized object edges to the grid. */
  snapToGrid: boolean;
  /** Grid pitch in logical px (> 0). */
  gridSize: number;
  /** Whether the grid is painted (informational for Core; the provider paints). */
  showGrid: boolean;
  /**
   * The page, anchored top-left at the sheet origin. Objects are clamped
   * inside it and the scrollable extent is the page plus a margin. `null` =
   * unbounded (a worksheet).
   */
  page: { width: number; height: number } | null;
  /**
   * Whether objects may be moved/resized at all. `false` is consume mode (a
   * subscribed canvas): objects stay clickable -- a click still selects -- but
   * no drag changes their geometry. Design Mode is never part of this answer
   * (docs/design/canvas-sheets.md section 2); it only decides, per family,
   * what a press on an object's WORKING area means.
   */
  editable: boolean;
  /**
   * Whether the object behind `region` is LOCKED on this surface: selectable,
   * but neither movable nor resizable. Optional; absent = nothing is locked.
   * Asked from inside a press, so it must be cheap and synchronous.
   */
  isLocked?(region: GridRegion): boolean;
}

/**
 * Whether `surface` locks the object behind `region`. A lock answer that
 * throws counts as "not locked" (logged): a broken provider must not be able
 * to freeze every object on the page.
 */
export function isRegionLocked(surface: LayoutSurface | null, region: GridRegion): boolean {
  if (!surface?.isLocked) return false;
  try {
    return surface.isLocked(region) === true;
  } catch (err) {
    console.error("[layoutSurface] isLocked threw; treating the object as unlocked:", err);
    return false;
  }
}

/**
 * Whether a family may publish `movable`/`resizable` TRUE for `region` on the
 * sheet at `sheetIndex` -- THE one answer for "may this object's position and
 * size change", so every family and every geometry door (Core's drag, a
 * family's own gesture, a menu item, a script) reads the same rule.
 *
 * On a layout surface the SURFACE decides: editable (not subscribed) AND the
 * object is not locked there. Design Mode is never part of it. Off a surface
 * (a worksheet) the family's own rule stands, passed in as `offSurface`.
 */
export function objectGeometryEditable(
  sheetIndex: number,
  region: GridRegion,
  offSurface: boolean,
): boolean {
  const surface = getLayoutSurface(sheetIndex);
  if (!surface) return offSurface;
  return surface.editable && !isRegionLocked(surface, region);
}

/**
 * The scrollbar gutter the grid area reserves on its right and bottom edge,
 * in SCREEN px. ONE number: the scrollbar metrics, the Spreadsheet layout and
 * a provider's fit-to-page zoom all read it, so the page's far edge can never
 * land under the scrollbar because two copies drifted.
 */
export const GRID_SCROLLBAR_GUTTER_PX = 14;

/**
 * The margin, in logical px, that the scrollable extent of a page-bounded
 * surface adds to the right of and below its page, so the page's far edges
 * can be scrolled fully into view with air around them. ONE number, shared by
 * the scrollbar extent and a provider's fit-to-page zoom, so the two can never
 * disagree about where "the whole page" ends.
 */
export const LAYOUT_PAGE_MARGIN = 40;

/**
 * The scrollable content size of a page-bounded surface: the page plus
 * {@link LAYOUT_PAGE_MARGIN} on the right and below. The page is anchored at
 * the sheet origin and scroll never goes below 0, so there is no left/top
 * margin to add.
 */
export function pageScrollExtent(page: { width: number; height: number }): { width: number; height: number } {
  return { width: page.width + LAYOUT_PAGE_MARGIN, height: page.height + LAYOUT_PAGE_MARGIN };
}

/** Answers the layout surface of a sheet, by TRUE sheet index. */
export interface LayoutSurfaceProvider {
  get(sheetIndex: number): LayoutSurface | null;
}

let provider: LayoutSurfaceProvider | null = null;
const listeners = new Set<() => void>();

/**
 * Register THE layout-surface provider. Last registration wins; the returned
 * cleanup unregisters only if this provider is still the registered one (the
 * controlsService precedent), so a stale cleanup cannot remove a newer one.
 */
export function registerLayoutSurfaceProvider(p: LayoutSurfaceProvider): () => void {
  provider = p;
  notifyLayoutSurfaceChanged();
  return () => {
    if (provider === p) {
      provider = null;
      notifyLayoutSurfaceChanged();
    }
  };
}

/** The layout surface of `sheetIndex`, or null when no provider answers. */
export function getLayoutSurface(sheetIndex: number): LayoutSurface | null {
  if (!provider) return null;
  try {
    return provider.get(sheetIndex);
  } catch (err) {
    console.error("[layoutSurface] provider threw; treating the sheet as unconstrained:", err);
    return null;
  }
}

/** Tell subscribers (the scrollbar extent, the painter) that a surface changed. */
export function notifyLayoutSurfaceChanged(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch (err) {
      console.error("[layoutSurface] listener threw:", err);
    }
  }
}

/** Subscribe to layout-surface changes. Returns an unsubscribe. */
export function onLayoutSurfaceChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

/** `v` rounded to the NEAREST multiple of `size` (size <= 0 leaves v alone). */
export function snapValue(v: number, size: number): number {
  if (!(size > 0)) return v;
  return Math.round(v / size) * size;
}

/** A rectangle in logical px. */
export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which edges of a rectangle a resize is dragging. */
export interface DraggedEdges {
  left: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
}

/**
 * Snap only the DRAGGED edges of `rect` to the grid, keeping the opposite
 * edges exactly where they are (a bottom-right drag must never move the
 * top-left corner), then re-apply `minSize` from the fixed edge.
 */
export function snapRectEdges(
  rect: LayoutRect,
  edges: DraggedEdges,
  size: number,
  minSize: number,
): LayoutRect {
  if (!(size > 0)) return { ...rect };
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (edges.left) left = snapValue(left, size);
  if (edges.right) right = snapValue(right, size);
  if (edges.top) top = snapValue(top, size);
  if (edges.bottom) bottom = snapValue(bottom, size);
  if (right - left < minSize) {
    if (edges.left && !edges.right) left = right - minSize;
    else right = left + minSize;
  }
  if (bottom - top < minSize) {
    if (edges.top && !edges.bottom) top = bottom - minSize;
    else bottom = top + minSize;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Keep a MOVED rectangle on the page: its size is preserved and its origin is
 * clamped so it stays inside (an object larger than the page pins to 0,0).
 */
export function clampMoveToPage(
  rect: LayoutRect,
  page: { width: number; height: number } | null,
): LayoutRect {
  if (!page) return { ...rect };
  const x = Math.max(0, Math.min(rect.x, page.width - rect.width));
  const y = Math.max(0, Math.min(rect.y, page.height - rect.height));
  return { x: Math.max(0, x), y: Math.max(0, y), width: rect.width, height: rect.height };
}

/**
 * Keep a RESIZED rectangle on the page: dragged edges stop at the page border;
 * the fixed edges do not move, and the size never drops below `minSize`.
 *
 * An object whose FIXED edge is already past the page (the page was made
 * smaller, or a script placed it there) cannot have its dragged edge pulled
 * back to the border -- that would put the dragged edge on the wrong side of
 * the fixed one and save a negative size. On such an axis the page does not
 * clamp; the minimum size still holds.
 */
export function clampResizeToPage(
  rect: LayoutRect,
  edges: DraggedEdges,
  page: { width: number; height: number } | null,
  minSize: number,
): LayoutRect {
  if (!page) return { ...rect };
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (edges.left) left = Math.max(0, Math.min(left, right - minSize));
  if (edges.top) top = Math.max(0, Math.min(top, bottom - minSize));
  if (edges.right) {
    const cap = left + minSize > page.width ? Infinity : page.width;
    right = Math.max(left + minSize, Math.min(cap, right));
  }
  if (edges.bottom) {
    const cap = top + minSize > page.height ? Infinity : page.height;
    bottom = Math.max(top + minSize, Math.min(cap, bottom));
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Apply a sheet's layout surface to a MOVE: snap the origin to the grid (unless
 * bypassed), then keep the object on the page. `region.data.snap === false`
 * opts a family out of snapping (a family with its own quantisation, like a
 * floating range's whole-row/column frame).
 */
export function applySurfaceToMove(
  surface: LayoutSurface | null,
  rect: LayoutRect,
  opts: { bypassSnap?: boolean; optOutSnap?: boolean } = {},
): LayoutRect {
  if (!surface) return { ...rect };
  let out = { ...rect };
  if (surface.snapToGrid && !opts.bypassSnap && !opts.optOutSnap) {
    out = { ...out, x: snapValue(out.x, surface.gridSize), y: snapValue(out.y, surface.gridSize) };
  }
  return clampMoveToPage(out, surface.page);
}

/** Apply a sheet's layout surface to a RESIZE (see `applySurfaceToMove`). */
export function applySurfaceToResize(
  surface: LayoutSurface | null,
  rect: LayoutRect,
  edges: DraggedEdges,
  minSize: number,
  opts: { bypassSnap?: boolean; optOutSnap?: boolean } = {},
): LayoutRect {
  if (!surface) return { ...rect };
  let out = { ...rect };
  if (surface.snapToGrid && !opts.bypassSnap && !opts.optOutSnap) {
    out = snapRectEdges(out, edges, surface.gridSize, minSize);
  }
  return clampResizeToPage(out, edges, surface.page, minSize);
}

/** The dragged edges of a corner resize. */
export function edgesOfCorner(
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right",
): DraggedEdges {
  return {
    left: corner === "top-left" || corner === "bottom-left",
    right: corner === "top-right" || corner === "bottom-right",
    top: corner === "top-left" || corner === "top-right",
    bottom: corner === "bottom-left" || corner === "bottom-right",
  };
}
