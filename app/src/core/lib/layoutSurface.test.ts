//! FILENAME: app/src/core/lib/layoutSurface.test.ts
// PURPOSE: The layout-surface seam's pure geometry and its provider registry.
//          The handlers that call these are covered end to end in
//          hooks/useMouseSelection/layout/__tests__/overlaySnap.test.ts; this
//          file pins the edge cases that are awkward to reach through a drag.

import { describe, it, expect, vi } from "vitest";
import {
  applySurfaceToMove,
  applySurfaceToResize,
  clampMoveToPage,
  clampResizeToPage,
  getLayoutSurface,
  LAYOUT_PAGE_MARGIN,
  notifyLayoutSurfaceChanged,
  onLayoutSurfaceChanged,
  pageScrollExtent,
  registerLayoutSurfaceProvider,
  snapRectEdges,
  snapValue,
  type DraggedEdges,
  type LayoutSurface,
} from "./layoutSurface";

/** The sides a bottom-right / bottom-left corner handle drags (literal: the geometry owns handles now). */
const BOTTOM_RIGHT: DraggedEdges = { left: false, right: true, top: false, bottom: true };
const BOTTOM_LEFT: DraggedEdges = { left: true, right: false, top: false, bottom: true };

const SURFACE: LayoutSurface = {
  snapToGrid: true,
  gridSize: 16,
  showGrid: true,
  page: { width: 1280, height: 720 },
  editable: true,
};

describe("snapValue", () => {
  it("rounds to the NEAREST multiple, not down", () => {
    expect(snapValue(7, 16)).toBe(0);
    expect(snapValue(8, 16)).toBe(16);
    expect(snapValue(23, 16)).toBe(16);
    expect(snapValue(25, 16)).toBe(32);
  });

  it("works for a pitch that does not divide the value's scale", () => {
    expect(snapValue(108, 25)).toBe(100);
    expect(snapValue(113, 25)).toBe(125);
  });

  it("leaves the value alone for a non-positive pitch", () => {
    expect(snapValue(13, 0)).toBe(13);
    expect(snapValue(13, -4)).toBe(13);
  });
});

describe("snapRectEdges", () => {
  it("moves only the dragged edges", () => {
    const r = snapRectEdges(
      { x: 10, y: 10, width: 55, height: 38 },
      { left: false, top: false, right: true, bottom: true },
      16,
      8,
    );
    expect(r).toEqual({ x: 10, y: 10, width: 54, height: 38 });
  });

  it("keeps the minimum size from the FIXED edge when a snap would collapse it", () => {
    const r = snapRectEdges(
      { x: 100, y: 100, width: 6, height: 6 },
      { left: false, top: false, right: true, bottom: true },
      16,
      20,
    );
    // Right 106 snaps to 112 but 12 < 20, so the right edge is pushed to 120.
    expect(r.x).toBe(100);
    expect(r.width).toBe(20);
  });

  it("a top-left drag keeps the minimum by moving the dragged edge, not the fixed one", () => {
    const r = snapRectEdges(
      { x: 100, y: 100, width: 6, height: 6 },
      { left: true, top: true, right: false, bottom: false },
      16,
      20,
    );
    expect(r.x + r.width).toBe(106);
    expect(r.width).toBe(20);
  });
});

describe("page clamps", () => {
  it("a MOVE keeps the object's size and pins an oversize object to the origin", () => {
    expect(clampMoveToPage({ x: 1250, y: -5, width: 100, height: 50 }, SURFACE.page)).toEqual({
      x: 1180,
      y: 0,
      width: 100,
      height: 50,
    });
    expect(clampMoveToPage({ x: 40, y: 40, width: 2000, height: 50 }, SURFACE.page).x).toBe(0);
  });

  it("a RESIZE stops only the dragged edges at the page border", () => {
    const r = clampResizeToPage(
      { x: 1200, y: 10, width: 300, height: 50 },
      BOTTOM_RIGHT,
      SURFACE.page,
      20,
    );
    expect(r).toEqual({ x: 1200, y: 10, width: 80, height: 50 });
  });

  it("a RESIZE of an object whose fixed edge is already past the page keeps a positive size", () => {
    // A chart at x=1000 on a page shrunk to 960 wide: the dragged right edge
    // cannot be pulled back to 960 (that is left of its own left edge).
    const r = clampResizeToPage(
      { x: 1000, y: 100, width: 110, height: 70 },
      BOTTOM_RIGHT,
      { width: 960, height: 720 },
      16,
    );
    expect(r.x).toBe(1000);
    expect(r.width).toBeGreaterThanOrEqual(16);
    const b = clampResizeToPage(
      { x: 10, y: 800, width: 50, height: 40 },
      BOTTOM_LEFT,
      { width: 960, height: 720 },
      16,
    );
    expect(b.y).toBe(800);
    expect(b.height).toBeGreaterThanOrEqual(16);
  });

  it("no page means no clamp (a worksheet)", () => {
    const rect = { x: 5000, y: 5000, width: 10, height: 10 };
    expect(clampMoveToPage(rect, null)).toEqual(rect);
  });
});

describe("applying a surface", () => {
  it("move: snap then clamp; bypass and opt-out both skip the snap", () => {
    const rect = { x: 108, y: 9, width: 50, height: 50 };
    expect(applySurfaceToMove({ ...SURFACE, gridSize: 25 }, rect)).toMatchObject({ x: 100, y: 0 });
    expect(applySurfaceToMove({ ...SURFACE, gridSize: 25 }, rect, { bypassSnap: true })).toMatchObject({ x: 108, y: 9 });
    expect(applySurfaceToMove({ ...SURFACE, gridSize: 25 }, rect, { optOutSnap: true })).toMatchObject({ x: 108, y: 9 });
    expect(applySurfaceToMove(null, rect)).toEqual(rect);
  });

  it("resize: snap disabled on the surface leaves the edges where they were dragged", () => {
    const rect = { x: 0, y: 0, width: 101, height: 57 };
    expect(
      applySurfaceToResize({ ...SURFACE, snapToGrid: false }, rect, BOTTOM_RIGHT, 20),
    ).toEqual(rect);
    expect(applySurfaceToResize(SURFACE, rect, BOTTOM_RIGHT, 20)).toEqual({
      x: 0,
      y: 0,
      width: 96,
      height: 64,
    });
  });
});

describe("the provider registry", () => {
  it("the last registration wins, and a stale cleanup cannot remove a newer provider", () => {
    const first = registerLayoutSurfaceProvider({ get: () => ({ ...SURFACE, gridSize: 8 }) });
    const second = registerLayoutSurfaceProvider({ get: () => ({ ...SURFACE, gridSize: 32 }) });
    expect(getLayoutSurface(0)?.gridSize).toBe(32);
    first();
    expect(getLayoutSurface(0)?.gridSize).toBe(32);
    second();
    expect(getLayoutSurface(0)).toBeNull();
  });

  it("a provider that throws answers null instead of breaking the gesture", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const off = registerLayoutSurfaceProvider({
      get: () => {
        throw new Error("boom");
      },
    });
    expect(getLayoutSurface(0)).toBeNull();
    off();
    spy.mockRestore();
  });

  it("registering, unregistering and notifying all reach subscribers", () => {
    const seen = vi.fn();
    const unsubscribe = onLayoutSurfaceChanged(seen);
    const off = registerLayoutSurfaceProvider({ get: () => null });
    notifyLayoutSurfaceChanged();
    off();
    unsubscribe();
    notifyLayoutSurfaceChanged();
    expect(seen).toHaveBeenCalledTimes(3);
  });
});

describe("pageScrollExtent", () => {
  it("is the page plus the one shared margin, right and below", () => {
    expect(pageScrollExtent({ width: 1280, height: 720 })).toEqual({
      width: 1280 + LAYOUT_PAGE_MARGIN,
      height: 720 + LAYOUT_PAGE_MARGIN,
    });
  });
});
