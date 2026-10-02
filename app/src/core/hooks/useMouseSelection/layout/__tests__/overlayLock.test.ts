//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayLock.test.ts
// PURPOSE: A LOCKED floating object (the layout surface's `isLocked`, answered
//          on a canvas from the layout's `locked` refs) is still SELECTED by a
//          press, but no drag moves it and no corner handle resizes it -- in
//          both of Core's resize scans (the historical forward scan, and the
//          stacked scan a canvas's z-order switches on).
// CONTEXT: Driven through the REAL move and resize handlers, the one point
//          every family's geometry passes through (the overlaySnap harness).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const snapshot = { sheetContext: { activeSheetIndex: 2 } };
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

import { createOverlayMoveHandlers, type OverlayMoveState } from "../overlayMoveHandlers";
import { createOverlayResizeHandlers } from "../overlayResizeHandlers";
import { setGridRegions, type GridRegion } from "../../../../../api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../../../../lib/layoutSurface";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";
import { selectForHandles } from "./helpers/selectForHandles";

const ACTIVE = 2;
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24;

function region(z?: number): GridRegion {
  return {
    id: "chart-1",
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data: {},
    floating: { x: 70, y: 70, width: 100, height: 60 },
    ...(z === undefined ? {} : { z }),
  };
}

let lockedIds = new Set<string>();

function surface(over: Partial<LayoutSurface> = {}): LayoutSurface {
  return {
    snapToGrid: false,
    gridSize: 25,
    showGrid: true,
    page: { width: 1280, height: 720 },
    editable: true,
    isLocked: (r) => lockedIds.has(r.id),
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
let events: string[];
const record = (e: Event) => events.push(e.type);

beforeEach(() => {
  lockedIds = new Set();
  events = [];
  // SELECTED: only a selected object has live resize handles (BUG-0258 phase
  // 3), so the lock is the one thing that turns them off in the cases below.
  unselect = selectForHandles(["chart"]);
  for (const t of ["floatingObject:selected", "floatingObject:movePreview", "floatingObject:moveComplete", "floatingObject:resizeComplete"]) {
    window.addEventListener(t, record);
  }
});

afterEach(() => {
  for (const t of ["floatingObject:selected", "floatingObject:movePreview", "floatingObject:moveComplete", "floatingObject:resizeComplete"]) {
    window.removeEventListener(t, record);
  }
  unregister?.();
  unregister = null;
  unselect?.();
  unselect = null;
  setGridRegions([]);
});

function useSurface(s: LayoutSurface): void {
  unregister = registerLayoutSurfaceProvider({ get: (i) => (i === ACTIVE ? s : null) });
}

function drag(): boolean {
  const ref: { current: OverlayMoveState | null } = { current: null };
  const h = createOverlayMoveHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: null },
    setIsOverlayMoving: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayMoveStateRef: ref as React.MutableRefObject<OverlayMoveState | null>,
  });
  const x = RHW + 80;
  const y = CHH + 80;
  const consumed = h.handleOverlayMoveMouseDown(x, y, press());
  h.handleOverlayMoveMouseMove(x + 40, y + 40);
  h.handleOverlayMoveMouseUp();
  return consumed;
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

/** The bottom-right corner of the 70/70 100x60 region, in canvas px. */
const CORNER = { x: RHW + 170, y: CHH + 130 };

describe("a LOCKED object on the layout surface", () => {
  it("a press still SELECTS it, but a drag moves nothing", () => {
    setGridRegions([region()]);
    lockedIds.add("chart-1");
    useSurface(surface());
    expect(drag()).toBe(true);
    expect(events).toEqual(["floatingObject:selected"]);
  });

  it("control: the same object UNLOCKED moves", () => {
    setGridRegions([region()]);
    useSurface(surface());
    drag();
    expect(events).toEqual(["floatingObject:selected", "floatingObject:movePreview", "floatingObject:moveComplete"]);
  });

  it("no corner handle is live (the historical forward scan)", () => {
    setGridRegions([region()]);
    lockedIds.add("chart-1");
    useSurface(surface());
    const h = resizeHandlers();
    expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)).toBeNull();
    expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(false);
  });

  it("no corner handle is live (the STACKED scan a z-order switches on)", () => {
    setGridRegions([region(3)]);
    lockedIds.add("chart-1");
    useSurface(surface());
    const h = resizeHandlers();
    expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)).toBeNull();
    expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(false);
  });

  it("control: unlocked, the corner handle is live in both scans", () => {
    for (const z of [undefined, 3]) {
      setGridRegions([region(z)]);
      unregister?.();
      useSurface(surface());
      const h = resizeHandlers();
      expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)?.region.id).toBe("chart-1");
      expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(true);
    }
  });

  it("a lock answer that THROWS counts as unlocked (a broken provider cannot freeze the page)", () => {
    setGridRegions([region()]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    useSurface(
      surface({
        isLocked: () => {
          throw new Error("boom");
        },
      }),
    );
    drag();
    expect(events).toContain("floatingObject:moveComplete");
    errors.mockRestore();
  });
});
