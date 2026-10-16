//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotCellPress.test.ts
// PURPOSE: A press on a canvas pivot box's CELLS (D-CELLS, WP-A S5):
//          - the press anchors the cell under it; Shift extends the box's own
//            selection (and anchors when this box has none);
//          - the drag extends to the cell under the (clamped) pointer;
//          - a primary release, a lost release, Escape and a window blur END
//            the drag and KEEP the cells; Escape is stopped (the drag's);
//          - past the box's body edge the box auto-scrolls 16 px per frame,
//            re-extending to the edge cell, and stops when the pointer comes
//            back or the content ends;
//          - the press holds Core's pointer over the box ("cell") and lets go
//            on every end path.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { contentGestureCursorFor, clearContentGestureCursor } from "@api/gridOverlays";
import {
  beginPivotCellPress,
  cancelPivotCellPress,
  isPivotCellPressLive,
  PIVOT_CELL_AUTOSCROLL_STEP,
} from "../pivotCellPress";
import { setPivotVisualRecord, resetPivotVisualHits } from "../pivotVisualHits";
import { getPivotVisualScroll, setPivotVisualScroll, resetPivotVisualScrolls } from "../pivotVisualScroll";
import {
  getPivotCellSelection,
  resetPivotCellSelection,
  setPivotCellAnchor,
} from "../pivotVisualCellSelection";
import { buildPivotVisualGeometry } from "../../rendering/pivotVisualRenderer";
import type { PivotViewResponse } from "../pivot-api";

const REGION_ID = "pivot-visual-cp1";

/** 50 rows x 3 columns of 24 x 100 px; header row and row-label column frozen. */
function view(rowCount = 50): PivotViewResponse {
  return {
    pivotId: "cp1",
    version: 1,
    rowCount,
    colCount: 3,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: Array.from({ length: rowCount }, (_, i) => ({ viewRow: i, rowType: "Data", depth: 0, visible: true, cells: [] })),
    columns: [],
  } as unknown as PivotViewResponse;
}

/** The box at canvas (100, 80), 300 x 200, painted at `scroll`. */
function paint(scroll = { left: 0, top: 0 }): void {
  setPivotVisualRecord({
    pivotId: "cp1",
    box: { x: 100, y: 80, width: 300, height: 200 },
    bounds: { expandCollapseIcons: new Map(), filterButtons: new Map(), headerFilterButtons: new Map() },
    cancel: null,
    geometry: buildPivotVisualGeometry(view(), true, { columnWidth: () => 100, rowHeight: () => 24 }),
    scroll,
    startRow: 0,
    startCol: 1024,
  });
  setPivotVisualScroll("cp1", scroll);
}

/** Client px = canvas px in these tests. */
const identity = (x: number, y: number) => ({ x, y });

function press(canvasX: number, canvasY: number, shiftKey = false): boolean {
  return beginPivotCellPress({ pivotId: "cp1", regionId: REGION_ID, canvasX, canvasY, shiftKey, clientToCanvas: identity });
}

function move(x: number, y: number, buttons = 1): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons }));
}

function up(x: number, y: number, button = 0, buttons = 0): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, button, buttons }));
}

/** The animation frames the auto-scroll asked for, run by hand. */
let frames: Array<FrameRequestCallback | null> = [];
function runFrame(): boolean {
  const i = frames.findIndex((f) => f !== null);
  if (i < 0) return false;
  const cb = frames[i]!;
  frames[i] = null;
  cb(0);
  return true;
}
const pendingFrames = () => frames.filter((f) => f !== null).length;

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    if (id >= 1 && id <= frames.length) frames[id - 1] = null;
  });
  cancelPivotCellPress();
  resetPivotCellSelection();
  resetPivotVisualHits();
  resetPivotVisualScrolls();
  clearContentGestureCursor();
  paint();
});

afterEach(() => {
  cancelPivotCellPress();
  vi.unstubAllGlobals();
});

describe("the press", () => {
  it("anchors the cell under it (box-local (150, 30) -> view row 1, column 1)", () => {
    expect(press(250, 110)).toBe(true);
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 });
    expect(isPivotCellPressLive()).toBe(true);
  });

  it("Shift extends this box's selection; with none in THIS box it anchors", () => {
    setPivotCellAnchor("cp1", 1, 1);
    press(350, 160, true); // box-local (250, 80): row 3, column 2
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 1, anchorCol: 1, endRow: 3, endCol: 2 });
    up(350, 160);

    setPivotCellAnchor("other", 0, 0);
    press(350, 160, true);
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 3, anchorCol: 2, endRow: 3, endCol: 2 });
  });

  it("a plain press re-anchors (it does not extend)", () => {
    setPivotCellAnchor("cp1", 1, 1);
    press(350, 160);
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 3, anchorCol: 2, endRow: 3, endCol: 2 });
  });

  it("binds nothing when no cell is under it: no record, no geometry, outside the box", () => {
    resetPivotVisualHits();
    expect(press(250, 110)).toBe(false);
    expect(isPivotCellPressLive()).toBe(false);
    paint();
    expect(press(50, 50)).toBe(false);
    expect(isPivotCellPressLive()).toBe(false);
    expect(getPivotCellSelection()).toBeNull();
  });

  it("the press reads the box's LIVE scroll (the scrolled cell, not the window cell)", () => {
    paint({ left: 0, top: 120 });
    press(250, 110); // body: 30 + 120 = 150 -> row 6
    expect(getPivotCellSelection()).toMatchObject({ anchorRow: 6, anchorCol: 1 });
  });
});

describe("the drag", () => {
  it("extends to the cell under the pointer, and the release ends it with the cells kept", () => {
    press(250, 110);
    move(350, 160);
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 1, anchorCol: 1, endRow: 3, endCol: 2 });
    move(150, 180); // box-local (50, 100): row 4, column 0
    expect(getPivotCellSelection()).toMatchObject({ endRow: 4, endCol: 0 });
    up(150, 180);
    expect(isPivotCellPressLive()).toBe(false);
    expect(getPivotCellSelection()).toMatchObject({ anchorRow: 1, anchorCol: 1, endRow: 4, endCol: 0 });
    move(350, 110);
    expect(getPivotCellSelection(), "a move after the release extended").toMatchObject({ endRow: 4, endCol: 0 });
  });

  it("a pointer past the box is clamped to the edge cell", () => {
    press(250, 110);
    move(900, 110); // far right: the last column
    expect(getPivotCellSelection()).toMatchObject({ endRow: 1, endCol: 2 });
  });

  it("a lost release (a move with the primary button up) ends the drag; the cells stay", () => {
    press(250, 110);
    move(350, 160, 0);
    expect(isPivotCellPressLive()).toBe(false);
    expect(getPivotCellSelection()).toMatchObject({ endRow: 1, endCol: 1 });
  });

  it("another button's release goes on while the primary is held, and ends it when it is not", () => {
    press(250, 110);
    up(250, 110, 2, 1);
    expect(isPivotCellPressLive()).toBe(true);
    up(250, 110, 1, 0);
    expect(isPivotCellPressLive()).toBe(false);
  });

  it("Escape ends the drag, keeps the cells, and is the drag's (stopped, default prevented)", () => {
    press(250, 110);
    move(350, 160);
    const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    const later = vi.fn();
    window.addEventListener("keydown", later);
    window.dispatchEvent(esc);
    window.removeEventListener("keydown", later);
    expect(esc.defaultPrevented).toBe(true);
    expect(later, "Escape reached a later listener").not.toHaveBeenCalled();
    expect(isPivotCellPressLive()).toBe(false);
    expect(getPivotCellSelection()).toMatchObject({ anchorRow: 1, anchorCol: 1, endRow: 3, endCol: 2 });
    // After the drag, Escape is no longer the press's.
    const second = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  it("a window blur ends it", () => {
    press(250, 110);
    window.dispatchEvent(new Event("blur"));
    expect(isPivotCellPressLive()).toBe(false);
  });

  it("holds Core's pointer over the box while it lives ('cell') and lets go on every end path", () => {
    press(250, 110);
    expect(contentGestureCursorFor(REGION_ID)).toBe("cell");
    up(250, 110);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();

    press(250, 110);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();

    press(250, 110);
    move(250, 110, 0);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();

    press(250, 110);
    cancelPivotCellPress();
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("the next press ends the previous one", () => {
    press(250, 110);
    press(350, 160);
    expect(isPivotCellPressLive()).toBe(true);
    up(350, 160);
    expect(isPivotCellPressLive()).toBe(false);
    expect(getPivotCellSelection()).toMatchObject({ anchorRow: 3, anchorCol: 2 });
  });
});

describe("auto-scroll", () => {
  it("below the box: scrolls 16 px per frame and extends to the edge cell; stops when the pointer comes back", () => {
    press(250, 110);
    move(250, 310); // 30 px below the box
    expect(pendingFrames()).toBe(1);
    runFrame();
    expect(getPivotVisualScroll("cp1")).toEqual({ left: 0, top: PIVOT_CELL_AUTOSCROLL_STEP });
    // The box's bottom edge at scroll 16: 199.99 + 16 -> row 8.
    expect(getPivotCellSelection()).toMatchObject({ endRow: 8, endCol: 1 });
    runFrame();
    expect(getPivotVisualScroll("cp1").top).toBe(32);
    expect(getPivotCellSelection()).toMatchObject({ endRow: 9 });

    move(250, 200); // back inside
    runFrame();
    expect(getPivotVisualScroll("cp1").top, "it kept scrolling with the pointer inside").toBe(32);
    expect(pendingFrames()).toBe(0);
  });

  it("above the frozen header band scrolls back up while the body is scrolled; not at the top", () => {
    paint({ left: 0, top: 100 });
    press(250, 150);
    move(250, 90); // inside the frozen header row (80..104): above the body
    runFrame();
    expect(getPivotVisualScroll("cp1").top).toBe(100 - PIVOT_CELL_AUTOSCROLL_STEP);

    cancelPivotCellPress();
    frames = [];
    paint({ left: 0, top: 0 });
    press(250, 150);
    move(250, 90);
    expect(pendingFrames(), "scrolling up from the top").toBe(0);
  });

  it("right of the box scrolls the columns", () => {
    paint({ left: 0, top: 0 });
    // 3 x 100 px of content in a 300 px box: nothing to scroll horizontally.
    press(250, 110);
    move(450, 110);
    runFrame();
    expect(getPivotVisualScroll("cp1").left, "scrolled past the content").toBe(0);
    expect(pendingFrames()).toBe(0);
  });

  it("stops at the end of the content", () => {
    // 50 x 24 = 1200 px of content in a 200 px box: maxTop 1000.
    paint({ left: 0, top: 995 });
    press(250, 150);
    move(250, 400);
    runFrame();
    expect(getPivotVisualScroll("cp1").top).toBe(1000);
    expect(getPivotCellSelection()).toMatchObject({ endRow: 49 });
    runFrame();
    expect(getPivotVisualScroll("cp1").top).toBe(1000);
    expect(pendingFrames()).toBe(0);
  });

  it("the release stops it (no frame left behind)", () => {
    press(250, 110);
    move(250, 310);
    expect(pendingFrames()).toBe(1);
    up(250, 310);
    expect(pendingFrames()).toBe(0);
    expect(getPivotVisualScroll("cp1").top).toBe(0);
  });
});
