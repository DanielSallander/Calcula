//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlaySnap.test.ts
// PURPOSE: SNAP TO GRID, driven through the REAL move and resize handlers --
//          the only point every floating-object family's geometry passes
//          through. What is pinned is the COMPLETE event (the value a family
//          persists), not the preview: a snap applied to the preview alone
//          would show the object on the grid and save it off the grid.
// CONTEXT: The layout surface comes from the one provider seam
//          (core/lib/layoutSurface.ts); with no provider answer, nothing snaps.
//          The handlers ask the provider for the ACTIVE sheet's index, read
//          from the grid state snapshot. That snapshot is mocked here to a
//          canvas at index 2, and the provider answers ONLY for index 2: a
//          handler that asked for any other index (say, a hard-coded 0) would
//          get no surface and every snap case below would fail.
//          The chart is SELECTED (helpers/selectForHandles.ts): since BUG-0258
//          design phase 3 only a selected object has live resize handles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const snapshot = { sheetContext: { activeSheetIndex: 2 } };
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

import { createOverlayMoveHandlers, type OverlayMoveState } from "../overlayMoveHandlers";
import { createOverlayResizeHandlers } from "../overlayResizeHandlers";
import { setGridRegions } from "../../../../../api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../../../../lib/layoutSurface";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";
import { selectForHandles } from "./helpers/selectForHandles";

const ACTIVE = 2;
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24;

function region(extra: Record<string, unknown> = {}, floating = { x: 70, y: 70, width: 100, height: 60 }) {
  return {
    id: "chart-1",
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data: { ...extra },
    floating,
  };
}

function surface(over: Partial<LayoutSurface> = {}): LayoutSurface {
  return {
    snapToGrid: true,
    gridSize: 25,
    showGrid: true,
    page: { width: 1280, height: 720 },
    editable: true,
    ...over,
  };
}

function press(): React.MouseEvent<HTMLElement> {
  return {
    button: 0,
    ctrlKey: false,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

let unregister: (() => void) | null = null;
let unselect: (() => void) | null = null;
let completes: CustomEvent[];
let previews: CustomEvent[];
const onComplete = (e: Event) => completes.push(e as CustomEvent);
const onPreview = (e: Event) => previews.push(e as CustomEvent);

beforeEach(() => {
  snapshot.sheetContext.activeSheetIndex = ACTIVE;
  completes = [];
  previews = [];
  unselect = selectForHandles(["chart"]);
  window.addEventListener("floatingObject:moveComplete", onComplete);
  window.addEventListener("floatingObject:resizeComplete", onComplete);
  window.addEventListener("floatingObject:movePreview", onPreview);
  window.addEventListener("floatingObject:resizePreview", onPreview);
});

afterEach(() => {
  window.removeEventListener("floatingObject:moveComplete", onComplete);
  window.removeEventListener("floatingObject:resizeComplete", onComplete);
  window.removeEventListener("floatingObject:movePreview", onPreview);
  window.removeEventListener("floatingObject:resizePreview", onPreview);
  unregister?.();
  unregister = null;
  unselect?.();
  unselect = null;
  setGridRegions([]);
});

/** The provider answers `s` for the ACTIVE canvas only. */
function useSurface(s: LayoutSurface | null, forIndex = ACTIVE): void {
  unregister = registerLayoutSurfaceProvider({ get: (i) => (i === forIndex ? s : null) });
}

/** Press inside the object, drag by (dx, dy), release. */
function drag(dx: number, dy: number, altKey = false): void {
  const ref: { current: OverlayMoveState | null } = { current: null };
  const h = createOverlayMoveHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: null },
    setIsOverlayMoving: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayMoveStateRef: ref as React.MutableRefObject<OverlayMoveState | null>,
  });
  const startX = RHW + 70 + 10;
  const startY = CHH + 70 + 10;
  expect(h.handleOverlayMoveMouseDown(startX, startY, press())).toBe(true);
  h.handleOverlayMoveMouseMove(startX + dx, startY + dy, altKey);
  h.handleOverlayMoveMouseUp();
}

function resizeHandlers() {
  return createOverlayResizeHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    dimensions: undefined,
    freezeConfig: null,
    splitBarSize: 0,
    splitViewport: null,
    containerRef: { current: null },
    setIsOverlayResizing: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayResizeStateRef: { current: null },
  } as unknown as Parameters<typeof createOverlayResizeHandlers>[0]);
}

/** Grab a corner of the 70/70 100x60 region and drag it by (dx, dy). */
function resize(corner: "bottom-right" | "top-left", dx: number, dy: number, altKey = false): void {
  const h = resizeHandlers();
  const x = corner === "bottom-right" ? RHW + 170 : RHW + 70;
  const y = corner === "bottom-right" ? CHH + 130 : CHH + 70;
  expect(h.handleOverlayResizeMouseDown(x, y, press())).toBe(true);
  h.handleOverlayResizeMouseMove(x + dx, y + dy, altKey);
  h.handleOverlayResizeMouseUp();
}

describe("snap to grid on MOVE (start 70, drag 38, pitch 25)", () => {
  it("ON: the persisted position lands on the nearest multiple (108 -> 100)", () => {
    setGridRegions([region()]);
    useSurface(surface());
    drag(38, 38);
    expect(completes).toHaveLength(1);
    expect(completes[0].detail).toMatchObject({ x: 100, y: 100 });
    // Preview and complete agree: what the user saw is what is saved.
    expect(previews.at(-1)?.detail).toMatchObject({ x: 100, y: 100 });
  });

  it("the handler asks for the ACTIVE sheet's surface: another sheet's snapping surface does not apply", () => {
    setGridRegions([region()]);
    useSurface(surface(), 0);
    drag(38, 38);
    expect(completes[0].detail).toMatchObject({ x: 108, y: 108 });
  });

  it("OFF: the object lands exactly where it was dropped (108)", () => {
    setGridRegions([region()]);
    useSurface(surface({ snapToGrid: false }));
    drag(38, 38);
    expect(completes[0].detail).toMatchObject({ x: 108, y: 108 });
  });

  it("Alt held: snap is bypassed for this drag (108)", () => {
    setGridRegions([region()]);
    useSurface(surface());
    drag(38, 38, true);
    expect(completes[0].detail).toMatchObject({ x: 108, y: 108 });
  });

  it("a family that opts out with data.snap=false keeps its own position (108)", () => {
    setGridRegions([region({ snap: false })]);
    useSurface(surface());
    drag(38, 38);
    expect(completes[0].detail).toMatchObject({ x: 108, y: 108 });
  });

  it("no provider answer (a worksheet): nothing snaps", () => {
    setGridRegions([region()]);
    drag(38, 38);
    expect(completes[0].detail).toMatchObject({ x: 108, y: 108 });
  });

  it("CONSUME MODE (editable=false): the press selects, but no drag moves anything", () => {
    setGridRegions([region()]);
    useSurface(surface({ editable: false }));
    drag(38, 38);
    expect(previews).toHaveLength(0);
    expect(completes).toHaveLength(0);
  });

  it("the page keeps the object inside it", () => {
    setGridRegions([region()]);
    useSurface(surface({ snapToGrid: false, page: { width: 200, height: 150 } }));
    drag(500, 500);
    // 100 x 60 object on a 200 x 150 page: its origin stops at (100, 90).
    expect(completes[0].detail).toMatchObject({ x: 100, y: 90 });
  });

  it("jitter inside the click threshold moves nothing, even off the grid (a plain click is a click)", () => {
    setGridRegions([region()]);
    useSurface(surface({ gridSize: 16 }));
    drag(1, 1);
    expect(previews).toHaveLength(0);
    expect(completes).toHaveLength(0);
  });
});

describe("snap to grid on RESIZE", () => {
  it("bottom-right: only the DRAGGED edges snap; the fixed top-left corner does not move", () => {
    setGridRegions([region()]);
    useSurface(surface());
    // Right edge 170 + 38 = 208 -> 200; bottom 130 + 38 = 168 -> 175.
    resize("bottom-right", 38, 38);
    expect(completes).toHaveLength(1);
    expect(completes[0].detail).toMatchObject({ x: 70, y: 70, width: 130, height: 105 });
  });

  it("Alt held: the resize is not snapped (138 x 98)", () => {
    setGridRegions([region()]);
    useSurface(surface());
    resize("bottom-right", 38, 38, true);
    expect(completes[0].detail).toMatchObject({ x: 70, y: 70, width: 138, height: 98 });
  });

  it("an object whose fixed edge is past a shrunken page never gets a negative size", () => {
    setGridRegions([region({}, { x: 1000, y: 100, width: 100, height: 60 })]);
    useSurface(surface({ gridSize: 16, page: { width: 960, height: 720 } }));
    const h = resizeHandlers();
    const x = RHW + 1100;
    const y = CHH + 160;
    expect(h.handleOverlayResizeMouseDown(x, y, press())).toBe(true);
    h.handleOverlayResizeMouseMove(x + 10, y + 10);
    h.handleOverlayResizeMouseUp();
    const d = completes[0].detail;
    expect(d.x).toBe(1000);
    expect(d.width).toBeGreaterThanOrEqual(16);
    expect(d.height).toBeGreaterThanOrEqual(16);
  });

  it("a top-left drag past the origin keeps the right and bottom edges still", () => {
    setGridRegions([region()]);
    useSurface(surface({ snapToGrid: false }));
    // Left edge 70 dragged 100 left -> clamped at 0; right edge stays at 170.
    resize("top-left", -100, -100);
    const d = completes[0].detail;
    expect(d.x).toBe(0);
    expect(d.x + d.width).toBe(170);
    expect(d.y).toBe(0);
    expect(d.y + d.height).toBe(130);
  });

  it("snapResize=false opts out of RESIZE snapping only (a floating range sizes by rows/columns)", () => {
    setGridRegions([region({ snapResize: false })]);
    useSurface(surface());
    resize("bottom-right", 38, 38);
    expect(completes[0].detail).toMatchObject({ width: 138, height: 98 });
    completes.length = 0;
    drag(38, 38);
    expect(completes[0].detail).toMatchObject({ x: 100, y: 100 });
  });

  it("CONSUME MODE: no resize handle is live", () => {
    setGridRegions([region()]);
    useSurface(surface({ editable: false }));
    expect(resizeHandlers().handleOverlayResizeMouseDown(RHW + 170, CHH + 130, press())).toBe(false);
  });
});
