//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayReferencePick.test.ts
// PURPOSE: D-PICK (owner finding F3) through Core's REAL press handler: while a
//          formula is picking a reference, a press on a floating object is
//          decided ONCE, before anything selects. Where the object's
//          `referenceAt` answers, the press -- or a drag across the object --
//          inserts a reference at its release; everywhere else it is inert. A
//          pick press never reaches the object-selection press hook, never
//          dispatches `floatingObject:selected` / `bodyDragStart` and never arms
//          a move; the second press and the dblclick of a double-click that
//          started as a pick are swallowed (its ECHO), even while an async
//          insertion keeps the pick predicate true.
// CONTEXT: Before this, the press went through `pressZone`: the edited floating
//          grid was deselected and the clicked pivot box selected (F3).
//          SABOTAGE (run once, 2026-10-15): deleting the pick branch in
//          handleOverlayMoveMouseDown makes (a) fail on `noteObjectPress`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const snapshot: { surface: "grid" | "canvas"; zoom: number; sheetContext: { activeSheetIndex: number } } = {
  surface: "canvas",
  zoom: 1,
  sheetContext: { activeSheetIndex: 0 },
};
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

const pressHooks = vi.hoisted(() => ({
  noteObjectPress: vi.fn(),
  noteWorksheetObjectPress: vi.fn(),
}));
vi.mock("../../../../../api/objectSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../api/objectSelection")>()),
  noteObjectPress: pressHooks.noteObjectPress,
  noteWorksheetObjectPress: pressHooks.noteWorksheetObjectPress,
}));

import { createOverlayMoveHandlers, type OverlayMoveState, type OverlayMoveHandlers } from "../overlayMoveHandlers";
import { isFloatingReferencePickLive, cancelFloatingReferencePick } from "../floatingReferencePickSession";
import {
  registerGridOverlay,
  unregisterGridOverlay,
  setGridRegions,
  getFloatingReferencePickPreview,
  type GridRegion,
  type FloatingReferencePickRange,
  type OverlayHitTestContext,
  type OverlayReferencePick,
} from "../../../../../api/gridOverlays";
import {
  registerGridReferencePickProbe,
  __resetReferencePickStateForTests,
} from "../../../../lib/referencePickState";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24;

const TYPE = "pick-test";
const INERT_TYPE = "pick-test-inert";

/** A floating grid double: 20x20 px cells under a 20 px title strip that names nothing. */
const REGION: GridRegion = {
  id: "fr-2",
  type: TYPE,
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: { frId: "fr-2" },
  floating: { x: 100, y: 100, width: 200, height: 150 },
};
/** An object of a family without referenceAt (a chart), beside it. */
const INERT: GridRegion = {
  id: "chart-1",
  type: INERT_TYPE,
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: {},
  floating: { x: 400, y: 100, width: 100, height: 100 },
};

/** Canvas origin of REGION's bounds. */
const BX = RHW + 100;
const BY = CHH + 100;
const TITLE_H = 20;
const CELL = 20;

/** The canvas point at the middle of local cell (row, col). */
function cellPoint(row: number, col: number): { x: number; y: number } {
  return { x: BX + col * CELL + CELL / 2, y: BY + TITLE_H + row * CELL + CELL / 2 };
}

let referenceAtImpl: (ctx: OverlayHitTestContext) => OverlayReferencePick | null;
function floatTwoReferenceAt(ctx: OverlayHitTestContext): OverlayReferencePick | null {
  const b = ctx.floatingCanvasBounds!;
  const dy = ctx.canvasY - b.y;
  if (dy < TITLE_H) return null;
  return {
    space: "object",
    name: "Float2",
    row: Math.floor((dy - TITLE_H) / CELL),
    col: Math.floor((ctx.canvasX - b.x) / CELL),
  };
}

let picking = false;
let picks: FloatingReferencePickRange[];
let events: string[];
const onSelected = () => events.push("selected");
const onBodyDragStart = () => events.push("bodyDragStart");
let onDoubleClick: ReturnType<typeof vi.fn>;
let moveRef: { current: OverlayMoveState | null };
let setIsOverlayMoving: ReturnType<typeof vi.fn>;
const cleanups: Array<() => void> = [];

function makeHandlers(withPick = true): OverlayMoveHandlers {
  moveRef = { current: null };
  setIsOverlayMoving = vi.fn();
  // The grid area at the client origin: client px == canvas px (zoom 1).
  const container = document.createElement("div");
  return createOverlayMoveHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: container },
    setIsOverlayMoving,
    setCursorStyle: vi.fn(),
    overlayMoveStateRef: moveRef as React.MutableRefObject<OverlayMoveState | null>,
    ...(withPick ? { onFloatingReferencePick: (r: FloatingReferencePickRange) => picks.push(r) } : {}),
  });
}

function press(p: { x: number; y: number }): React.MouseEvent<HTMLElement> {
  return {
    clientX: p.x,
    clientY: p.y,
    button: 0,
    buttons: 1,
    ctrlKey: false,
    shiftKey: false,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

function moveTo(p: { x: number; y: number }, buttons = 1): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: p.x, clientY: p.y, buttons }));
}

function releaseAt(p: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: p.x, clientY: p.y, button: 0, buttons: 0 }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  snapshot.surface = "canvas";
  picking = true;
  picks = [];
  events = [];
  pressHooks.noteObjectPress.mockClear();
  pressHooks.noteWorksheetObjectPress.mockClear();
  __resetReferencePickStateForTests();
  referenceAtImpl = floatTwoReferenceAt;
  onDoubleClick = vi.fn(() => true);
  cleanups.push(
    registerGridReferencePickProbe(() => picking),
    registerGridOverlay({
      type: TYPE,
      render: () => {},
      zoneAt: () => ({ kind: "content", cursor: "cell", part: "cells" }),
      referenceAt: (ctx) => referenceAtImpl(ctx),
      onDoubleClick: (ctx) => onDoubleClick(ctx) as boolean,
    }),
    registerGridOverlay({ type: INERT_TYPE, render: () => {} }),
  );
  window.addEventListener("floatingObject:selected", onSelected);
  window.addEventListener("floatingObject:bodyDragStart", onBodyDragStart);
  setGridRegions([REGION, INERT]);
});

afterEach(() => {
  cancelFloatingReferencePick();
  window.removeEventListener("floatingObject:selected", onSelected);
  window.removeEventListener("floatingObject:bodyDragStart", onBodyDragStart);
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
  __resetReferencePickStateForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Nothing selected, moved or announced by the press. */
function expectInvisiblePress(): void {
  expect(pressHooks.noteObjectPress).not.toHaveBeenCalled();
  expect(pressHooks.noteWorksheetObjectPress).not.toHaveBeenCalled();
  expect(events).toEqual([]);
  expect(moveRef.current).toBeNull();
  expect(setIsOverlayMoving).not.toHaveBeenCalled();
}

describe("(a) a press on a cell while a formula picks: one cell at the release, nothing selected", () => {
  it("inserts Float2!C2 (local row 1, col 2) at the release, and the press is invisible to every family", () => {
    const h = makeHandlers();
    const at = cellPoint(1, 2);
    const ev = press(at);
    expect(h.handleOverlayMoveMouseDown(at.x, at.y, ev)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(isFloatingReferencePickLive()).toBe(true);
    expect(picks).toEqual([]); // nothing inserted before the release

    releaseAt(at);
    expect(picks).toEqual([{ space: "object", name: "Float2", startRow: 1, startCol: 2, endRow: 1, endCol: 2 }]);
    expect(isFloatingReferencePickLive()).toBe(false);
    expect(getFloatingReferencePickPreview()).toBeNull();
    expectInvisiblePress();
  });

  it("worksheet surface too: the worksheet press hook is not called either", () => {
    snapshot.surface = "grid";
    const h = makeHandlers();
    const at = cellPoint(0, 0);
    h.handleOverlayMoveMouseDown(at.x, at.y, press(at));
    releaseAt(at);
    expect(picks).toHaveLength(1);
    expectInvisiblePress();
  });

  it("the hover pointer says what a press would do: 'cell' over a cell, 'default' where nothing is named", () => {
    const h = makeHandlers();
    const cell = cellPoint(0, 0);
    expect(h.checkOverlayBody(cell.x, cell.y)?.cursor).toBe("cell");
    expect(h.checkOverlayBody(BX + 10, BY + 5)?.cursor).toBe("default"); // the title strip
    expect(h.checkOverlayBody(RHW + 450, CHH + 150)?.cursor).toBe("default"); // the inert family
    picking = false;
    expect(h.checkOverlayBody(RHW + 450, CHH + 150)?.cursor).toBe("move"); // control: all frame
  });

  it("the body hit carries the context its zone was resolved with", () => {
    const h = makeHandlers();
    const at = cellPoint(2, 3);
    const hit = h.checkOverlayBody(at.x, at.y)!;
    expect(hit.ctx).toMatchObject({ region: REGION, canvasX: at.x, canvasY: at.y });
    expect(hit.ctx.floatingCanvasBounds).toEqual({ x: BX, y: BY, width: 200, height: 150 });
  });
});

describe("(b) a drag inserts the spanned range", () => {
  it("from (0,0) to (2,3): Float2!A1:D3, and the preview follows the drag", () => {
    const h = makeHandlers();
    const from = cellPoint(0, 0);
    h.handleOverlayMoveMouseDown(from.x, from.y, press(from));
    expect(getFloatingReferencePickPreview()).toEqual({
      regionId: "fr-2",
      range: { space: "object", name: "Float2", startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    });
    moveTo(cellPoint(1, 1));
    moveTo(cellPoint(2, 3));
    expect(getFloatingReferencePickPreview()?.range).toEqual({
      space: "object", name: "Float2", startRow: 0, startCol: 0, endRow: 2, endCol: 3,
    });
    releaseAt(cellPoint(2, 3));
    expect(picks).toEqual([{ space: "object", name: "Float2", startRow: 0, startCol: 0, endRow: 2, endCol: 3 }]);
    expectInvisiblePress();
  });

  it("a drag UP-LEFT is normalized (start <= end)", () => {
    const h = makeHandlers();
    const from = cellPoint(3, 4);
    h.handleOverlayMoveMouseDown(from.x, from.y, press(from));
    moveTo(cellPoint(1, 2));
    releaseAt(cellPoint(1, 2));
    expect(picks).toEqual([{ space: "object", name: "Float2", startRow: 1, startCol: 2, endRow: 3, endCol: 4 }]);
  });

  it("a point that names nothing keeps the last cell; leaving the box is clamped to its edge", () => {
    const h = makeHandlers();
    const from = cellPoint(1, 1);
    h.handleOverlayMoveMouseDown(from.x, from.y, press(from));
    moveTo(cellPoint(2, 2));
    // Into the title strip (referenceAt answers null): the pick keeps (2,2).
    moveTo({ x: BX + 50, y: BY + 5 });
    expect(getFloatingReferencePickPreview()?.range).toMatchObject({ endRow: 2, endCol: 2 });
    // Far below the box, at column 2's x: clamped to the last row of the box.
    moveTo({ x: cellPoint(0, 2).x, y: BY + 1000 });
    const lastRow = Math.floor((150 - TITLE_H - 0.02) / CELL);
    releaseAt({ x: cellPoint(0, 2).x, y: BY + 1000 });
    expect(picks).toEqual([{ space: "object", name: "Float2", startRow: 1, startCol: 1, endRow: lastRow, endCol: 2 }]);
  });

  it("an answer that cannot be spanned (another space or name) is ignored like a null one: the range keeps its extent", () => {
    const h = makeHandlers();
    const from = cellPoint(0, 0);
    h.handleOverlayMoveMouseDown(from.x, from.y, press(from));
    moveTo(cellPoint(2, 2));
    // The family now names a cell of ANOTHER space (and then another object):
    // neither may extend -- nor collapse -- the Float2 range.
    referenceAtImpl = () => ({ space: "sheet", row: 7, col: 7 });
    moveTo(cellPoint(3, 3));
    expect(getFloatingReferencePickPreview()?.range).toEqual({
      space: "object", name: "Float2", startRow: 0, startCol: 0, endRow: 2, endCol: 2,
    });
    referenceAtImpl = () => ({ space: "object", name: "Float9", row: 4, col: 4 });
    moveTo(cellPoint(4, 4));
    releaseAt(cellPoint(4, 4));
    expect(picks).toEqual([{ space: "object", name: "Float2", startRow: 0, startCol: 0, endRow: 2, endCol: 2 }]);
  });

  it("a move with the primary button UP is a lost release: the pick finishes there", () => {
    const h = makeHandlers();
    const from = cellPoint(0, 0);
    h.handleOverlayMoveMouseDown(from.x, from.y, press(from));
    moveTo(cellPoint(1, 1));
    moveTo(cellPoint(4, 4), 0);
    expect(picks).toEqual([{ space: "object", name: "Float2", startRow: 0, startCol: 0, endRow: 1, endCol: 1 }]);
    expect(isFloatingReferencePickLive()).toBe(false);
  });

  it("a non-primary release with the primary still held is ignored", () => {
    const h = makeHandlers();
    const from = cellPoint(0, 0);
    h.handleOverlayMoveMouseDown(from.x, from.y, press(from));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: from.x, clientY: from.y, button: 2, buttons: 1 }));
    expect(picks).toEqual([]);
    expect(isFloatingReferencePickLive()).toBe(true);
    releaseAt(from);
    expect(picks).toHaveLength(1);
  });

  it("the object unpublished mid-drag: the pick ends with its first cell", () => {
    const h = makeHandlers();
    const from = cellPoint(2, 2);
    h.handleOverlayMoveMouseDown(from.x, from.y, press(from));
    setGridRegions([INERT]);
    moveTo(cellPoint(3, 3));
    expect(picks).toEqual([{ space: "object", name: "Float2", startRow: 2, startCol: 2, endRow: 2, endCol: 2 }]);
  });
});

describe("(c) and (d): where nothing can be referenced the press is inert", () => {
  it("(c) an object whose family registers no referenceAt: inert, preventDefault, nothing dispatched", () => {
    const h = makeHandlers();
    const ev = press({ x: RHW + 450, y: CHH + 150 });
    expect(h.handleOverlayMoveMouseDown(RHW + 450, CHH + 150, ev)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(isFloatingReferencePickLive()).toBe(false);
    releaseAt({ x: RHW + 450, y: CHH + 150 });
    expect(picks).toEqual([]);
    expectInvisiblePress();
  });

  it("(c) referenceAt answering null (the title strip): inert", () => {
    const h = makeHandlers();
    const ev = press({ x: BX + 10, y: BY + 5 });
    expect(h.handleOverlayMoveMouseDown(BX + 10, BY + 5, ev)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    releaseAt({ x: BX + 10, y: BY + 5 });
    expect(picks).toEqual([]);
    expectInvisiblePress();
  });

  it("(d) referenceAt that THROWS: logged, inert", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    referenceAtImpl = () => {
      throw new Error("boom");
    };
    const h = makeHandlers();
    const at = cellPoint(0, 0);
    expect(h.handleOverlayMoveMouseDown(at.x, at.y, press(at))).toBe(true);
    releaseAt(at);
    expect(picks).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("referenceAt threw"), expect.any(Error));
    expectInvisiblePress();
  });

  it("no router wired (onFloatingReferencePick absent): still decided as a pick, inserts nothing", () => {
    const h = makeHandlers(false);
    const at = cellPoint(0, 0);
    expect(h.handleOverlayMoveMouseDown(at.x, at.y, press(at))).toBe(true);
    expect(isFloatingReferencePickLive()).toBe(false);
    expectInvisiblePress();
  });

  it("a SECONDARY press during a pick is still the menu's, never a pick", () => {
    const h = makeHandlers();
    const at = cellPoint(0, 0);
    const ev = { ...press(at), button: 2 } as React.MouseEvent<HTMLElement>;
    expect(h.handleOverlayMoveMouseDown(at.x, at.y, ev)).toBe(true);
    expect(isFloatingReferencePickLive()).toBe(false);
    expectInvisiblePress();
  });
});

describe("(e) the echo of a finished pick", () => {
  function clickPick(h: OverlayMoveHandlers, at: { x: number; y: number }): void {
    h.handleOverlayMoveMouseDown(at.x, at.y, press(at));
    releaseAt(at);
  }

  it("the second press of a double-click is inert once the insertion ended the pick (probe now false)", () => {
    const h = makeHandlers();
    const at = cellPoint(1, 1);
    clickPick(h, at);
    expect(picks).toHaveLength(1);
    picking = false; // the insertion: "=SUM(" became "=SUM(Float2!B2"
    vi.advanceTimersByTime(120);
    const second = press({ x: at.x + 2, y: at.y + 1 });
    expect(h.handleOverlayMoveMouseDown(at.x + 2, at.y + 1, second)).toBe(true);
    expect(second.preventDefault).toHaveBeenCalled();
    expectInvisiblePress();
  });

  it("...and inert while the probe is STILL true (an async GETPIVOTDATA insertion pending): no second pick", () => {
    const h = makeHandlers();
    const at = cellPoint(1, 1);
    clickPick(h, at);
    vi.advanceTimersByTime(120);
    expect(h.handleOverlayMoveMouseDown(at.x, at.y, press(at))).toBe(true);
    expect(isFloatingReferencePickLive()).toBe(false);
    expect(getFloatingReferencePickPreview()).toBeNull();
    releaseAt(at);
    expect(picks).toHaveLength(1);
    expectInvisiblePress();
  });

  it("the dblclick is swallowed without reaching the owner (pick ended, or still pending)", () => {
    const h = makeHandlers();
    const at = cellPoint(1, 1);
    clickPick(h, at);
    picking = false;
    vi.advanceTimersByTime(200);
    const dbl = { ...press(at) } as React.MouseEvent<HTMLElement>;
    expect(h.handleOverlayDoubleClick(REGION, at.x, at.y, dbl)).toBe(true);
    picking = true;
    expect(h.handleOverlayDoubleClick(REGION, at.x, at.y, dbl)).toBe(true);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("at 600 ms the press selects normally (the echo window is over)", () => {
    const h = makeHandlers();
    const at = cellPoint(1, 1);
    clickPick(h, at);
    picking = false;
    vi.advanceTimersByTime(600);
    h.handleOverlayMoveMouseDown(at.x, at.y, press(at));
    expect(pressHooks.noteObjectPress).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["selected", "bodyDragStart"]);
    // ...and a double-click then reaches the owner again.
    expect(h.handleOverlayDoubleClick(REGION, at.x, at.y, press(at))).toBe(true);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("a press FAR from the pick (5 px away) inside the window is not an echo", () => {
    const h = makeHandlers();
    const at = cellPoint(1, 1);
    clickPick(h, at);
    picking = false;
    vi.advanceTimersByTime(100);
    h.handleOverlayMoveMouseDown(at.x + 5, at.y, press({ x: at.x + 5, y: at.y }));
    expect(events).toEqual(["selected", "bodyDragStart"]);
  });
});

describe("(f) control: no pick in progress -> the zone press, exactly as before", () => {
  it("selects, dispatches selected + bodyDragStart on content, and the double-click reaches the owner", () => {
    picking = false;
    const h = makeHandlers();
    const at = cellPoint(1, 1);
    expect(h.handleOverlayMoveMouseDown(at.x, at.y, press(at))).toBe(true);
    expect(pressHooks.noteObjectPress).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["selected", "bodyDragStart"]);
    expect(isFloatingReferencePickLive()).toBe(false);
    expect(h.handleOverlayDoubleClick(REGION, at.x, at.y, press(at))).toBe(true);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("a frame object arms Core's move", () => {
    picking = false;
    const h = makeHandlers();
    h.handleOverlayMoveMouseDown(RHW + 450, CHH + 150, press({ x: RHW + 450, y: CHH + 150 }));
    expect(moveRef.current?.region.id).toBe("chart-1");
    h.handleOverlayMoveMouseUp();
  });

  it("a double-click DURING a pick never reaches the owner", () => {
    const h = makeHandlers();
    const at = cellPoint(1, 1);
    expect(h.handleOverlayDoubleClick(REGION, at.x, at.y, press(at))).toBe(true);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });
});
