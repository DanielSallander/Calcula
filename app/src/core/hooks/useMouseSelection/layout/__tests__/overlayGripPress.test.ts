//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayGripPress.test.ts
// PURPOSE: A press on a floating object's visible GRIP through Core's REAL
//          move handlers (BUG-0258 design phase 5; overlayMoveHandlers
//          `handleGripMouseDown`):
//            - it is a FRAME press on the grip's object: `floatingObject:selected`
//              with zone 'frame', part 'grip', the point and the RAW modifiers,
//              NO bodyDragStart -- whatever the object's own zoneAt says (the
//              grip lies OUTSIDE the object);
//            - a drag moves the object (movePreview, moveComplete) and is NOT a
//              click; a release within the 3px threshold dispatches exactly
//              ONE `floatingObject:gripClick`, anchored at the grip's hit
//              square in CLIENT px, and moves nothing;
//            - a secondary press is consumed and dispatches nothing (the
//              contextmenu decides); a press on an editable DOM control is left
//              alone; a point off every visible grip is not a grip press;
//            - on a canvas `noteObjectPress` gets the RAW modifiers (the grip is
//              frame: Ctrl/Shift are object selection there);
//            - the move is a Core GESTURE from its threshold to its release,
//              and a Core RESIZE from its handle's press to its release (no
//              grip shows meanwhile; overlayResizeHandlers sets the flag);
//            - a flag LEFT OVER by a move whose release never came is cleared
//              by the next frame press (armMove's backstop), so the grips come
//              back (BUG-0258 M7 review: it had no test).
// CONTEXT: The press ORDER against the handles and the neighbours' bodies is the
//          hook's (hooks/useMouseSelection/__tests__/gripHoverWiring.test.tsx);
//          the geometry and the visibility rule are core/lib/__tests__/floatingGrip.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const h = vi.hoisted(() => ({
  snapshot: {
    surface: "grid" as "grid" | "canvas",
    zoom: 1,
    sheetContext: { activeSheetIndex: 0 },
    editing: null,
  },
  note: vi.fn(),
}));
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => h.snapshot,
}));
vi.mock("../../../../../api/objectSelection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../api/objectSelection")>();
  return {
    ...actual,
    noteObjectPress: (...args: Parameters<typeof actual.noteObjectPress>) => {
      h.note(...args);
      return actual.noteObjectPress(...args);
    },
  };
});

import { createOverlayMoveHandlers, type OverlayMoveState } from "../overlayMoveHandlers";
import { createOverlayResizeHandlers } from "../overlayResizeHandlers";
import { selectForHandles } from "./helpers/selectForHandles";
import {
  registerGridOverlay,
  setGridRegions,
  unregisterGridOverlay,
  type GridRegion,
} from "../../../../../api/gridOverlays";
import { registerObjectSelectionProvider, resetObjectSelectionProviders } from "../../../../../api/objectSelection";
import { floatingGripOf, FLOATING_GRIP_CLICK_EVENT, type FloatingGripClickDetail } from "../../../../lib/floatingGrip";
import {
  isFloatingGestureActive,
  resetObjectHoverForTests,
  setFloatingGestureActive,
  setHoveredFloatingRegion,
} from "../../../../lib/objectHover";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 22;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 20;
const TYPE = "grip-press-test";
const CONTAINER = { left: 30, top: 140 };

/** 200 x 100 at sheet (60, 60), header-less: grip "hover". Its zoneAt says CONTENT everywhere. */
function region(id = "s1", data: Record<string, unknown> = { grip: "hover" }): GridRegion {
  return {
    id,
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data,
    floating: { x: 60, y: 60, width: 200, height: 100 },
  };
}

function gripCentre(r: GridRegion): { x: number; y: number; hit: { x: number; y: number; width: number; height: number } } {
  const g = floatingGripOf(r, { rowHeaderWidth: RHW, colHeaderHeight: CHH }, { scrollX: 0, scrollY: 0 }, h.snapshot.zoom, null)!;
  return { x: g.hit.x + g.hit.width / 2, y: g.hit.y + g.hit.height / 2, hit: g.hit };
}

function press(opts: { button?: number; ctrlKey?: boolean; shiftKey?: boolean; target?: HTMLElement } = {}): React.MouseEvent<HTMLElement> {
  return {
    button: opts.button ?? 0,
    ctrlKey: opts.ctrlKey === true,
    shiftKey: opts.shiftKey === true,
    target: opts.target ?? document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

const EVENTS = [
  "floatingObject:selected",
  "floatingObject:bodyDragStart",
  "floatingObject:movePreview",
  "floatingObject:moveComplete",
  FLOATING_GRIP_CLICK_EVENT,
];
let log: Array<{ type: string; detail: Record<string, unknown> }>;
const record = (e: Event) => log.push({ type: e.type, detail: (e as CustomEvent).detail });
const types = () => log.map((e) => e.type);

let ref: { current: OverlayMoveState | null };
let moving: boolean[];
function handlers() {
  const container = document.createElement("div");
  container.getBoundingClientRect = () => ({ ...CONTAINER, x: CONTAINER.left, y: CONTAINER.top, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  return createOverlayMoveHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: container },
    setIsOverlayMoving: (v) => moving.push(v),
    setCursorStyle: vi.fn(),
    overlayMoveStateRef: ref,
  });
}

beforeEach(() => {
  h.snapshot = { surface: "grid", zoom: 1, sheetContext: { activeSheetIndex: 0 }, editing: null };
  h.note.mockReset();
  log = [];
  ref = { current: null };
  moving = [];
  resetObjectHoverForTests();
  for (const t of EVENTS) window.addEventListener(t, record);
  registerGridOverlay({
    type: TYPE,
    render: () => {},
    zoneAt: () => ({ kind: "content", cursor: "pointer", part: "item" }),
  });
});

afterEach(() => {
  // End any move a test left armed (its capture mouseup is bound on window).
  window.dispatchEvent(new MouseEvent("mouseup"));
  for (const t of EVENTS) window.removeEventListener(t, record);
  unregisterGridOverlay(TYPE);
  resetObjectSelectionProviders();
  resetObjectHoverForTests();
  setGridRegions([]);
  vi.restoreAllMocks();
});

describe("a press on a visible grip is a FRAME press on its object", () => {
  it("drag: selected{zone:'frame', part:'grip'} and NO bodyDragStart, then movePreview/moveComplete -- and NO gripClick", () => {
    const r = region();
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    const hd = handlers();
    expect(hd.handleGripMouseDown(c.x, c.y, press())).toBe(true);
    expect(types()).toEqual(["floatingObject:selected"]);
    expect(log[0].detail).toMatchObject({
      regionId: "s1",
      regionType: TYPE,
      zone: "frame",
      part: "grip",
      canvasX: c.x,
      canvasY: c.y,
      ctrlKey: false,
      shiftKey: false,
    });
    expect(moving).toEqual([true]);

    hd.handleOverlayMoveMouseMove(c.x + 40, c.y + 20);
    hd.handleOverlayMoveMouseUp();
    expect(types()).toEqual(["floatingObject:selected", "floatingObject:movePreview", "floatingObject:moveComplete"]);
    expect(log[2].detail).toMatchObject({ regionId: "s1", x: 100, y: 80 });
    expect(types(), "a DRAG of the grip opened its menu").not.toContain(FLOATING_GRIP_CLICK_EVENT);
  });

  it("click: a release within 3px dispatches exactly ONE gripClick, anchored at the grip in CLIENT px, and moves nothing", () => {
    const r = region();
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    const hd = handlers();
    hd.handleGripMouseDown(c.x, c.y, press());
    hd.handleOverlayMoveMouseMove(c.x + 2, c.y + 1);
    // Core's three release paths all run: the capture listener, the grid area's onMouseUp, the hook's window mouseup.
    window.dispatchEvent(new MouseEvent("mouseup"));
    hd.handleOverlayMoveMouseUp();
    hd.handleOverlayMoveMouseUp();
    const clicks = log.filter((e) => e.type === FLOATING_GRIP_CLICK_EVENT);
    expect(clicks).toHaveLength(1);
    const d = clicks[0].detail as unknown as FloatingGripClickDetail;
    expect(d).toMatchObject({ regionId: "s1", regionType: TYPE, button: 0 });
    expect(d.anchor).toEqual({
      x: CONTAINER.left + c.hit.x,
      y: CONTAINER.top + c.hit.y,
      width: c.hit.width,
      height: c.hit.height,
    });
    expect(types()).not.toContain("floatingObject:moveComplete");
    expect(ref.current).toBeNull();
  });

  it("the anchor scales with the zoom (the canvas point times the zoom, from the grid area's origin)", () => {
    h.snapshot.zoom = 2;
    const r = region();
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    const hd = handlers();
    hd.handleGripMouseDown(c.x, c.y, press());
    hd.handleOverlayMoveMouseUp();
    const d = log.find((e) => e.type === FLOATING_GRIP_CLICK_EVENT)!.detail as unknown as FloatingGripClickDetail;
    expect(d.anchor).toEqual({ x: CONTAINER.left + c.hit.x * 2, y: CONTAINER.top + c.hit.y * 2, width: 24, height: 24 });
  });

  it("a SECONDARY press on the grip is consumed and dispatches nothing (the contextmenu decides)", () => {
    const r = region();
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    const hd = handlers();
    expect(hd.handleGripMouseDown(c.x, c.y, press({ button: 2 }))).toBe(true);
    expect(log).toEqual([]);
    expect(ref.current).toBeNull();
  });

  it("a press on an editable DOM control stacked there is left alone (consumed, nothing dispatched, no preventDefault)", () => {
    const r = region();
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    const ev = press({ target: document.createElement("textarea") });
    expect(handlers().handleGripMouseDown(c.x, c.y, ev)).toBe(true);
    expect(log).toEqual([]);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("no VISIBLE grip there -- the object is neither hovered nor selected -- is not a grip press", () => {
    const r = region();
    setGridRegions([r]);
    const c = gripCentre(r);
    const hd = handlers();
    expect(hd.checkGrip(c.x, c.y)).toBeNull();
    expect(hd.handleGripMouseDown(c.x, c.y, press())).toBe(false);
    expect(log).toEqual([]);
  });

  it("on a CANVAS, noteObjectPress gets the RAW modifiers (the grip is frame), before the press is announced", () => {
    h.snapshot.surface = "canvas";
    const r = region();
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    const order: string[] = [];
    h.note.mockImplementation(() => order.push("note"));
    window.addEventListener("floatingObject:selected", () => order.push("selected"), { once: true });
    handlers().handleGripMouseDown(c.x, c.y, press({ ctrlKey: true, shiftKey: true }));
    expect(h.note).toHaveBeenCalledTimes(1);
    expect(h.note.mock.calls[0][0]).toMatchObject({ id: "s1" });
    expect(h.note.mock.calls[0][1]).toEqual({ ctrlKey: true, shiftKey: true });
    expect(order).toEqual(["note", "selected"]);
    expect(log[0].detail).toMatchObject({ ctrlKey: true, shiftKey: true, part: "grip" });
  });

  it("on a worksheet, noteObjectPress is not called", () => {
    const r = region();
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    handlers().handleGripMouseDown(c.x, c.y, press({ ctrlKey: true }));
    expect(h.note).not.toHaveBeenCalled();
  });

  it("on a worksheet a PLAIN grip press deselects every other family first (worksheet press parity, BUG-0270 review); Ctrl keeps them", () => {
    const r = region();
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    const order: string[] = [];
    const off = registerObjectSelectionProvider({
      types: ["other-family"],
      isSelected: () => true,
      select: () => {},
      deselectAll: () => {
        order.push("other deselected");
      },
    });
    const onSelected = () => order.push("selected");
    window.addEventListener("floatingObject:selected", onSelected);
    try {
      handlers().handleGripMouseDown(c.x, c.y, press({ ctrlKey: true }));
      window.dispatchEvent(new MouseEvent("mouseup"));
      expect(order, "a Ctrl grip press dropped the other family's object").toEqual(["selected"]);
      order.length = 0;
      handlers().handleGripMouseDown(c.x, c.y, press());
      expect(order, "a chart selected before this object stayed selected beside it").toEqual(["other deselected", "selected"]);
    } finally {
      window.removeEventListener("floatingObject:selected", onSelected);
      off();
    }
  });
});

describe("the move is a Core GESTURE from its threshold to its release", () => {
  it("the flag turns on when the drag passes 3px, off at the release; the grip is hidden meanwhile", () => {
    const r = region();
    setGridRegions([r]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    const hd = handlers();
    hd.handleGripMouseDown(c.x, c.y, press());
    hd.handleOverlayMoveMouseMove(c.x + 2, c.y);
    expect(isFloatingGestureActive(), "a 2px wobble is not a gesture").toBe(false);
    hd.handleOverlayMoveMouseMove(c.x + 30, c.y);
    expect(isFloatingGestureActive()).toBe(true);
    expect(hd.checkGrip(c.x + 30, c.y), "a grip showed during the move").toBeNull();
    hd.handleOverlayMoveMouseUp();
    expect(isFloatingGestureActive()).toBe(false);
  });

  it("a Core RESIZE is one too: on from a live handle's press to its release, and the resized object's grip hides meanwhile", () => {
    const r = region();
    setGridRegions([r]);
    const offSelection = selectForHandles([TYPE]);
    try {
      const c = gripCentre(r);
      const hd = handlers();
      expect(hd.checkGrip(c.x, c.y)?.region.id, "control: a SELECTED grip:'hover' object shows its grip").toBe("s1");
      const rh = createOverlayResizeHandlers({
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
      // The right-edge midpoint handle of the 200 x 100 object at sheet (60, 60).
      const rightMid = { x: RHW + 260, y: CHH + 110 };
      expect(rh.handleOverlayResizeMouseDown(rightMid.x, rightMid.y, press()), "the handle did not take the press").toBe(true);
      expect(isFloatingGestureActive(), "a resize is not a Core gesture").toBe(true);
      expect(hd.checkGrip(c.x, c.y), "a grip showed during a resize").toBeNull();
      rh.handleOverlayResizeMouseMove(rightMid.x + 30, rightMid.y);
      rh.handleOverlayResizeMouseUp();
      expect(isFloatingGestureActive(), "the gesture outlived the resize's release").toBe(false);
      expect(hd.checkGrip(c.x, c.y)?.region.id, "the grip did not come back after the resize").toBe("s1");
    } finally {
      offSelection();
    }
  });
});

describe("armMove's backstop: a gesture flag left over from a lost release", () => {
  const FRAME_TYPE = "grip-press-frame-test";

  afterEach(() => {
    unregisterGridOverlay(FRAME_TYPE);
  });

  it("the next FRAME press clears it, and the grips that it hid show again", () => {
    // A frame-only family (no zoneAt: every point of it is frame) beside the
    // header-less object whose grip the stuck flag hides.
    registerGridOverlay({ type: FRAME_TYPE, render: () => {} });
    const r = region();
    const frame: GridRegion = { ...region("f1", {}), type: FRAME_TYPE, floating: { x: 400, y: 300, width: 100, height: 80 } };
    setGridRegions([r, frame]);
    setHoveredFloatingRegion("s1");
    const c = gripCentre(r);
    const hd = handlers();
    expect(hd.checkGrip(c.x, c.y)?.region.id, "control: the hovered object's grip shows").toBe("s1");

    // A move whose release this page never heard left the flag ON.
    setFloatingGestureActive(true);
    expect(hd.checkGrip(c.x, c.y), "precondition: a stuck flag hides every grip").toBeNull();

    // The next press: on the frame-only object's body, which arms Core's move.
    expect(hd.handleOverlayMoveMouseDown(RHW + 450, CHH + 340, press())).toBe(true);
    expect(ref.current?.region.id, "precondition: the frame press armed a move").toBe("f1");
    expect(isFloatingGestureActive(), "the next press left the stale gesture flag on").toBe(false);
    expect(hd.checkGrip(c.x, c.y)?.region.id, "the grip stayed hidden after the next press").toBe("s1");
    hd.handleOverlayMoveMouseUp();
  });
});
