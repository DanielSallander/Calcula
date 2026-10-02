//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayHandles.test.ts
// PURPOSE: BUG-0258 design phase 3, "handles only where they work", driven
//          through Core's REAL resize and move handlers:
//            - every one of the eight handles RESIZES, dragging only its own
//              sides: a right-edge drag changes the width alone, a top-edge
//              drag the top and the height with the bottom fixed (before, only
//              the four corners were live and an edge-midpoint press MOVED a
//              shape or a picture);
//            - snap applies to the DRAGGED edge only;
//            - each handle shows and holds its own pointer;
//            - a press 5px inside the corner of an UNSELECTED object is not a
//              resize: it falls to the body and selects the object (the old
//              10px corner boxes were live on every object, selected or not);
//            - a region publishing `handles: "corners"` (the floating grid) has
//              no Core midpoint: a press there reaches its own content zone
//              (the yellow edge ball).
// CONTEXT: The geometry itself is pinned in core/lib/__tests__/floatingHandles.test.ts;
//          the stacking rules in overlayStacking.test.ts; the hover pointer
//          through the real hook in ../../__tests__/overlayHandleHover.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const snapshot = { sheetContext: { activeSheetIndex: 0 } };
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

import { createOverlayMoveHandlers, type OverlayMoveState } from "../overlayMoveHandlers";
import { createOverlayResizeHandlers } from "../overlayResizeHandlers";
import {
  registerGridOverlay,
  setGridRegions,
  unregisterGridOverlay,
  type GridRegion,
} from "../../../../../api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../../../../lib/layoutSurface";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";
import { selectForHandles } from "./helpers/selectForHandles";

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24;
const TYPE = "handles-test";

/** 200 x 120 at sheet (70, 70): every edge carries a midpoint handle. */
const BOX = { x: 70, y: 70, width: 200, height: 120 };
function region(data: Record<string, unknown> = {}, box = BOX): GridRegion {
  return { id: "obj-1", type: TYPE, startRow: 0, startCol: 0, endRow: 0, endCol: 0, data, floating: { ...box } };
}

/** Canvas point of a sheet point. */
const at = (sx: number, sy: number) => ({ x: RHW + sx, y: CHH + sy });
const RIGHT_MID = at(BOX.x + BOX.width, BOX.y + BOX.height / 2);
const TOP_MID = at(BOX.x + BOX.width / 2, BOX.y);
const TOP_RIGHT = at(BOX.x + BOX.width, BOX.y);

let selected = true;
let unselect: (() => void) | null = null;
let unregisterSurface: (() => void) | null = null;
let completes: CustomEvent[];
let events: string[];
const onComplete = (e: Event) => completes.push(e as CustomEvent);
const record = (e: Event) => events.push(e.type);
const EVENTS = ["floatingObject:selected", "floatingObject:bodyDragStart", "floatingObject:moveComplete"];

beforeEach(() => {
  selected = true;
  completes = [];
  events = [];
  unselect = selectForHandles([TYPE], () => selected);
  window.addEventListener("floatingObject:resizeComplete", onComplete);
  for (const t of EVENTS) window.addEventListener(t, record);
});

afterEach(() => {
  window.removeEventListener("floatingObject:resizeComplete", onComplete);
  for (const t of EVENTS) window.removeEventListener(t, record);
  unselect?.();
  unselect = null;
  unregisterSurface?.();
  unregisterSurface = null;
  unregisterGridOverlay(TYPE);
  setGridRegions([]);
});

function press(): React.MouseEvent<HTMLElement> {
  return {
    button: 0,
    ctrlKey: false,
    shiftKey: false,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

function resizeHandlers() {
  const setCursorStyle = vi.fn();
  const h = createOverlayResizeHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    dimensions: undefined,
    freezeConfig: null,
    splitBarSize: 0,
    splitViewport: null,
    containerRef: { current: null },
    setIsOverlayResizing: vi.fn(),
    setCursorStyle,
    overlayResizeStateRef: { current: null },
  } as unknown as Parameters<typeof createOverlayResizeHandlers>[0]);
  return { h, setCursorStyle };
}

function moveHandlers() {
  return createOverlayMoveHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: null },
    setIsOverlayMoving: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayMoveStateRef: { current: null } as React.MutableRefObject<OverlayMoveState | null>,
  });
}

/** Grab the handle at `p`, drag it by (dx, dy), release: the resizeComplete detail. */
function dragHandle(p: { x: number; y: number }, dx: number, dy: number): Record<string, number> {
  const { h } = resizeHandlers();
  expect(h.handleOverlayResizeMouseDown(p.x, p.y, press()), "the handle did not take the press").toBe(true);
  h.handleOverlayResizeMouseMove(p.x + dx / 2, p.y + dy / 2);
  h.handleOverlayResizeMouseMove(p.x + dx, p.y + dy);
  h.handleOverlayResizeMouseUp();
  expect(completes, "no resizeComplete").toHaveLength(1);
  return completes[0].detail as Record<string, number>;
}

function useSurface(over: Partial<LayoutSurface>): void {
  const s: LayoutSurface = {
    snapToGrid: false,
    gridSize: 25,
    showGrid: false,
    page: { width: 1280, height: 720 },
    editable: true,
    ...over,
  };
  unregisterSurface = registerLayoutSurfaceProvider({ get: (i) => (i === 0 ? s : null) });
}

describe("every handle resizes, dragging only its own sides", () => {
  it("the RIGHT-edge handle changes the width only (x, y and height fixed)", () => {
    setGridRegions([region()]);
    const d = dragHandle(RIGHT_MID, 40, 25);
    expect(d).toMatchObject({ x: 70, y: 70, width: 240, height: 120 });
  });

  it("the TOP-edge handle changes y and height with the bottom fixed (x and width fixed)", () => {
    setGridRegions([region()]);
    const d = dragHandle(TOP_MID, 33, -30);
    expect(d).toMatchObject({ x: 70, y: 40, width: 200, height: 150 });
    expect(d.y + d.height, "the bottom edge moved").toBe(BOX.y + BOX.height);
  });

  it("the LEFT-edge and BOTTOM-edge handles, and a corner, drag exactly their sides", () => {
    setGridRegions([region()]);
    expect(dragHandle(at(BOX.x, BOX.y + BOX.height / 2), -20, 50)).toMatchObject({ x: 50, y: 70, width: 220, height: 120 });
    completes.length = 0;
    setGridRegions([region()]);
    expect(dragHandle(at(BOX.x + BOX.width / 2, BOX.y + BOX.height), 50, 10)).toMatchObject({ x: 70, y: 70, width: 200, height: 130 });
    completes.length = 0;
    setGridRegions([region()]);
    expect(dragHandle(TOP_RIGHT, 10, 10)).toMatchObject({ x: 70, y: 80, width: 210, height: 110 });
  });

  it("an edge drag past the opposite edge stops at the minimum size from the FIXED side", () => {
    setGridRegions([region()]);
    const d = dragHandle(RIGHT_MID, -500, 0);
    expect(d).toMatchObject({ x: 70, width: 16, y: 70, height: 120 });
  });

  it("snap applies to the DRAGGED edge only (right edge 270 + 38 = 308 -> 300; the off-grid top stays at 70)", () => {
    setGridRegions([region()]);
    useSurface({ snapToGrid: true, gridSize: 25 });
    const d = dragHandle(RIGHT_MID, 38, 0);
    expect(d).toMatchObject({ x: 70, y: 70, width: 230, height: 120 });
  });

  it("each handle's drag pointer is its own (the right edge holds 'ew-resize', the top-right corner 'nesw-resize')", () => {
    setGridRegions([region()]);
    const right = resizeHandlers();
    right.h.handleOverlayResizeMouseDown(RIGHT_MID.x, RIGHT_MID.y, press());
    expect(right.setCursorStyle).toHaveBeenCalledWith("ew-resize");
    right.h.handleOverlayResizeMouseUp();
    const corner = resizeHandlers();
    corner.h.handleOverlayResizeMouseDown(TOP_RIGHT.x, TOP_RIGHT.y, press());
    expect(corner.setCursorStyle).toHaveBeenCalledWith("nesw-resize");
    corner.h.handleOverlayResizeMouseUp();
  });

  it("the hover answer carries the handle's pointer: top-right 'nesw-resize', top-left 'nwse-resize', top edge 'ns-resize'", () => {
    setGridRegions([region()]);
    const { h } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(TOP_RIGHT.x, TOP_RIGHT.y)).toMatchObject({ cursor: "nesw-resize" });
    expect(h.checkOverlayResizeHandle(at(BOX.x, BOX.y).x, at(BOX.x, BOX.y).y)).toMatchObject({ cursor: "nwse-resize" });
    expect(h.checkOverlayResizeHandle(TOP_MID.x, TOP_MID.y)).toMatchObject({ cursor: "ns-resize" });
  });
});

describe("handles respond only on a SELECTED object", () => {
  /** 5px inside the bottom-left corner. */
  const NEAR_CORNER = at(BOX.x + 5, BOX.y + BOX.height - 5);

  it("a press 5px inside the corner of an UNSELECTED object is not a resize: it falls to the body and selects it", () => {
    selected = false;
    setGridRegions([region()]);
    const { h } = resizeHandlers();
    const e = press();
    expect(h.checkOverlayResizeHandle(NEAR_CORNER.x, NEAR_CORNER.y), "an unselected corner promises a resize").toBeNull();
    expect(h.handleOverlayResizeMouseDown(NEAR_CORNER.x, NEAR_CORNER.y, e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    // Core's next door, the body press, takes it: the object is selected.
    const m = moveHandlers();
    expect(m.handleOverlayMoveMouseDown(NEAR_CORNER.x, NEAR_CORNER.y, press())).toBe(true);
    m.handleOverlayMoveMouseUp();
    expect(events[0]).toBe("floatingObject:selected");
    expect(completes).toHaveLength(0);
  });

  it("control: the same press on the SELECTED object is a resize", () => {
    setGridRegions([region()]);
    const { h } = resizeHandlers();
    expect(h.handleOverlayResizeMouseDown(NEAR_CORNER.x, NEAR_CORNER.y, press())).toBe(true);
  });

  it("an unselected object's edge midpoint is not a handle either", () => {
    selected = false;
    setGridRegions([region()]);
    expect(resizeHandlers().h.checkOverlayResizeHandle(RIGHT_MID.x, RIGHT_MID.y)).toBeNull();
  });
});

describe("a region asking for the CORNERS only (the floating grid)", () => {
  it("has no Core midpoint: a press on its edge midpoint reaches its own content zone (the yellow ball)", () => {
    registerGridOverlay({
      type: TYPE,
      render: () => {},
      // Stand-in for frZoneAt's ball: within 7px of the right edge's midpoint.
      zoneAt: (ctx) =>
        Math.abs(ctx.canvasX - RIGHT_MID.x) <= 7 && Math.abs(ctx.canvasY - RIGHT_MID.y) <= 7
          ? { kind: "content", cursor: "ew-resize", part: "edgeHandle" }
          : null,
      // The ball straddles the border: its outer half is claimed as an extended hit.
      hitTest: (ctx) => Math.abs(ctx.canvasX - RIGHT_MID.x) <= 7 && Math.abs(ctx.canvasY - RIGHT_MID.y) <= 7,
    });
    setGridRegions([region({ handles: "corners" })]);
    const { h } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(RIGHT_MID.x, RIGHT_MID.y), "a Core midpoint pre-empts the ball").toBeNull();
    expect(h.handleOverlayResizeMouseDown(RIGHT_MID.x, RIGHT_MID.y, press())).toBe(false);
    const m = moveHandlers();
    m.handleOverlayMoveMouseDown(RIGHT_MID.x, RIGHT_MID.y, press());
    expect(events).toEqual(["floatingObject:selected", "floatingObject:bodyDragStart"]);
    // ...and its corners are still Core's.
    expect(h.checkOverlayResizeHandle(TOP_RIGHT.x, TOP_RIGHT.y)?.cursor).toBe("nesw-resize");
  });

  it("control: the same region WITHOUT the flag loses that press to Core's right-edge handle", () => {
    setGridRegions([region()]);
    expect(resizeHandlers().h.checkOverlayResizeHandle(RIGHT_MID.x, RIGHT_MID.y)?.cursor).toBe("ew-resize");
  });
});

describe("the chart's quick-access buttons stay clear", () => {
  it("no handle reaches 8px right of the right edge (where the buttons start)", () => {
    setGridRegions([region()]);
    const { h } = resizeHandlers();
    for (let y = TOP_RIGHT.y - 10; y <= TOP_RIGHT.y + BOX.height + 10; y++) {
      expect(h.checkOverlayResizeHandle(TOP_RIGHT.x + 8, y), `y=${y}`).toBeNull();
    }
    expect(h.checkOverlayResizeHandle(TOP_RIGHT.x + 6, RIGHT_MID.y), "control: the edge handle reaches 6px out").not.toBeNull();
  });
});
