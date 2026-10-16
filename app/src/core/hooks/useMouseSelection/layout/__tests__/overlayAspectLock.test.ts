//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayAspectLock.test.ts
// PURPOSE: LOCK ASPECT RATIO through Core's REAL resize handler (D-FORMAT
//          `container.lockAspect`, WP-C S3): with the published container's
//          lock on, EVERY preview and the complete keep the original ratio,
//          the fixed edges stay put, and a page clamp that cuts one dimension
//          shrinks the other -- including the side an EDGE handle drags along
//          (a right-edge drag must not push the following bottom past the
//          page). Without the lock the resize is exactly the free one.
// CONTEXT: The overlaySnap.test.ts harness: a mocked grid-state snapshot for
//          the active canvas, a registered layout surface, a stand-in selection
//          provider so the handles are live.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const snapshot = { sheetContext: { activeSheetIndex: 2 } };
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

import { createOverlayResizeHandlers } from "../overlayResizeHandlers";
import { setGridRegions, type GridRegion } from "../../../../../api/gridOverlays";
import { BASE_CONTAINER_DEFAULTS } from "../../../../../api/visualContainer";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../../../../lib/layoutSurface";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";
import { selectForHandles } from "./helpers/selectForHandles";

const ACTIVE = 2;
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24;

/** A 2:1 chart, 200 x 100 at sheet (100, 100), its container's lock on or off. */
function region(lockAspect: boolean): GridRegion {
  return {
    id: "chart-1",
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data: {},
    floating: { x: 100, y: 100, width: 200, height: 100 },
    container: { ...BASE_CONTAINER_DEFAULTS, lockAspect },
  };
}

function surface(over: Partial<LayoutSurface> = {}): LayoutSurface {
  return {
    snapToGrid: false,
    gridSize: 25,
    showGrid: false,
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

type Bounds = { x: number; y: number; width: number; height: number };
let unregister: (() => void) | null = null;
let unselect: (() => void) | null = null;
let completes: Bounds[];
let previews: Bounds[];
const onComplete = (e: Event) => completes.push(pick((e as CustomEvent).detail));
const onPreview = (e: Event) => previews.push(pick((e as CustomEvent).detail));
const pick = (d: Bounds): Bounds => ({ x: d.x, y: d.y, width: d.width, height: d.height });

beforeEach(() => {
  snapshot.sheetContext.activeSheetIndex = ACTIVE;
  completes = [];
  previews = [];
  unselect = selectForHandles(["chart"]);
  window.addEventListener("floatingObject:resizeComplete", onComplete);
  window.addEventListener("floatingObject:resizePreview", onPreview);
});

afterEach(() => {
  window.removeEventListener("floatingObject:resizeComplete", onComplete);
  window.removeEventListener("floatingObject:resizePreview", onPreview);
  unregister?.();
  unregister = null;
  unselect?.();
  unselect = null;
  setGridRegions([]);
});

function useSurface(s: LayoutSurface): void {
  unregister = registerLayoutSurfaceProvider({ get: (i) => (i === ACTIVE ? s : null) });
}

/** The handle points of the 100/100 200 x 100 box, in canvas px. */
const HANDLE = {
  br: { x: RHW + 300, y: CHH + 200 },
  tl: { x: RHW + 100, y: CHH + 100 },
  r: { x: RHW + 300, y: CHH + 150 },
  b: { x: RHW + 200, y: CHH + 200 },
};

/** Grab a handle, move through `steps` (each a delta from the press), release. */
function resize(handle: keyof typeof HANDLE, steps: Array<[number, number]>): void {
  const h = createOverlayResizeHandlers({
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
  const p = HANDLE[handle];
  expect(h.handleOverlayResizeMouseDown(p.x, p.y, press())).toBe(true);
  for (const [dx, dy] of steps) h.handleOverlayResizeMouseMove(p.x + dx, p.y + dy);
  h.handleOverlayResizeMouseUp();
}

const ratioOf = (b: Bounds) => b.width / b.height;

describe("lockAspect ON: every preview and the complete keep the ratio", () => {
  it("worksheet (no surface), bottom-right corner: the dominant change drives, the top-left stays", () => {
    setGridRegions([region(true)]);
    resize("br", [[20, 5], [60, 10], [60, 80]]);
    expect(previews).toHaveLength(3);
    for (const p of previews) {
      expect(ratioOf(p), JSON.stringify(p)).toBeCloseTo(2, 1);
      expect([p.x, p.y]).toEqual([100, 100]);
    }
    // +60 x +10: the width (+30%) drives -> 260 x 130; then +60 x +80: the height (+80%) -> 360 x 180.
    expect(previews[1]).toEqual({ x: 100, y: 100, width: 260, height: 130 });
    expect(previews[2]).toEqual({ x: 100, y: 100, width: 360, height: 180 });
    // The complete is the last preview: what the user saw is what is saved.
    expect(completes).toEqual([previews[2]]);
  });

  it("top-left corner: anchored at the bottom-right corner (300, 200)", () => {
    setGridRegions([region(true)]);
    resize("tl", [[-40, -5]]);
    expect(completes).toEqual([{ x: 60, y: 80, width: 240, height: 120 }]);
  });

  it("right edge: the height follows the width, the top edge stays", () => {
    setGridRegions([region(true)]);
    resize("r", [[100, 37]]);
    expect(completes).toEqual([{ x: 100, y: 100, width: 300, height: 150 }]);
  });

  it("bottom edge: the width follows the height, the left edge stays", () => {
    setGridRegions([region(true)]);
    resize("b", [[13, 50]]);
    expect(completes).toEqual([{ x: 100, y: 100, width: 300, height: 150 }]);
  });

  it("a page clamp that cut the WIDTH shrinks the height to match (canvas page 400 wide)", () => {
    setGridRegions([region(true)]);
    useSurface(surface({ page: { width: 400, height: 720 } }));
    resize("br", [[300, 300]]);
    expect(completes).toEqual([{ x: 100, y: 100, width: 300, height: 150 }]);
  });

  it("a right-edge drag whose FOLLOWING bottom would pass the page (height 250): the width shrinks to match", () => {
    setGridRegions([region(true)]);
    useSurface(surface({ page: { width: 1280, height: 250 } }));
    resize("r", [[200, 0]]);
    // Free: 400 wide -> 200 high, bottom 300 > 250: the bottom stops at 250 and the width follows to 300.
    expect(completes).toEqual([{ x: 100, y: 100, width: 300, height: 150 }]);
  });

  it("snap ON: the ratio still wins over the grid", () => {
    setGridRegions([region(true)]);
    useSurface(surface({ snapToGrid: true }));
    resize("br", [[38, 38]]);
    expect(ratioOf(completes[0])).toBeCloseTo(2, 1);
    expect([completes[0].x, completes[0].y]).toEqual([100, 100]);
  });
});

describe("lockAspect OFF: the free resize, exactly as before", () => {
  it("bottom-right +60 x +10 is 260 x 110; the right edge changes the width only", () => {
    setGridRegions([region(false)]);
    resize("br", [[60, 10]]);
    expect(completes).toEqual([{ x: 100, y: 100, width: 260, height: 110 }]);
    completes.length = 0;
    resize("r", [[100, 37]]);
    expect(completes).toEqual([{ x: 100, y: 100, width: 300, height: 100 }]);
  });
});
