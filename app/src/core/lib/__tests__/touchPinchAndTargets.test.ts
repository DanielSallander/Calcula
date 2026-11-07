//! FILENAME: app/src/core/lib/__tests__/touchPinchAndTargets.test.ts
// PURPOSE: BUG-0729, the touch remainder of BUG-0276:
//          - PINCH ZOOM: two fingers zoom the sheet 10%..400% through the zoom
//            slider's own state (Excel for Windows pinch-zooms its grid);
//          - 44 px TOUCH TARGETS: a finger or a pen grabs a floating object's
//            handle, its grip, the fill handle, a header's resize border and a
//            cell-anchored object's corner handle within a 44 x 44 screen px
//            square; a mouse keeps the small targets.
// CONTEXT: Synthetic pointer events and the real hit tests (jsdom has no touch
//          hardware). The live re-run on a touch screen (touch-pen-measure
//          spec TP-2/3/4/8/9) is still owed.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  TouchGestureBridge,
  PINCH_ZOOM_MIN,
  PINCH_ZOOM_MAX,
  type TouchBridgeDeps,
  type TouchPointerLike,
  type TouchPressKind,
} from "../touchBridge";
import {
  notePointerType,
  isCoarsePointer,
  touchTarget,
  lineTargetHalf,
  installPointerPrecision,
  resetPointerPrecisionForTests,
  TOUCH_TARGET_SCREEN_PX,
} from "../pointerPrecision";
import { floatingHandleHits, type FloatingHandle } from "../floatingHandles";
import { createFillHandleCursorChecker } from "../../hooks/useMouseSelection/utils/fillHandleUtils";
import { getColumnResizeHandle } from "../gridRenderer/interaction/hitTesting";
import { DEFAULT_GRID_CONFIG, type GridConfig } from "../../types";

afterEach(() => resetPointerPrecisionForTests());

const TARGET = {} as EventTarget;

function pinchHarness(kind: TouchPressKind, startZoom = 1) {
  const calls: string[] = [];
  const pans: Array<[number, number]> = [];
  const zooms: number[] = [];
  let zoom = startZoom;
  const deps: TouchBridgeDeps = {
    classify: () => kind,
    isNative: () => false,
    mouse: (type, _t, x, y) => calls.push(`${type}@${x},${y}`),
    pan: (dx, dy) => pans.push([dx, dy]),
    setTimer: () => 1,
    clearTimer: () => {},
    zoom: {
      get: () => zoom,
      set: (z) => {
        zoom = z;
        zooms.push(z);
      },
    },
  };
  const ev = (id: number, x: number, y: number, primary = id === 1): TouchPointerLike => ({
    pointerId: id,
    pointerType: "touch",
    isPrimary: primary,
    clientX: x,
    clientY: y,
    timeStamp: 1000,
    target: TARGET,
    preventDefault: () => {},
  });
  return { bridge: new TouchGestureBridge(deps), calls, pans, zooms, ev };
}

describe("BUG-0729 PINCH ZOOM", () => {
  it("two fingers spreading and closing scale the zoom the pinch began at", () => {
    const h = pinchHarness("pan");
    h.bridge.down(h.ev(1, 100, 100));
    h.bridge.down(h.ev(2, 200, 100)); // 100 px apart
    h.bridge.move(h.ev(2, 300, 100)); // 200 px: twice the zoom
    h.bridge.move(h.ev(2, 150, 100)); // 50 px: half
    expect(h.zooms).toEqual([2, 0.5]);
    expect(h.pans, "a pinch is not a pan").toEqual([]);
    expect(h.calls, "a pinch is not a tap or a drag").toEqual([]);
  });

  it("stays within Excel's 10%..400%, in whole percents", () => {
    const h = pinchHarness("pan");
    h.bridge.down(h.ev(1, 100, 100));
    h.bridge.down(h.ev(2, 110, 100));
    h.bridge.move(h.ev(2, 1100, 100)); // x100
    h.bridge.move(h.ev(2, 100.5, 100)); // x0.05
    h.bridge.move(h.ev(2, 113.33, 100)); // x1.333
    expect(h.zooms).toEqual([PINCH_ZOOM_MAX, PINCH_ZOOM_MIN, 1.33]);
    expect([PINCH_ZOOM_MIN, PINCH_ZOOM_MAX]).toEqual([0.1, 4]);
  });

  it("once one finger lifts, the other neither pans nor taps until it lifts too", () => {
    const h = pinchHarness("pan");
    h.bridge.down(h.ev(1, 100, 100));
    h.bridge.down(h.ev(2, 200, 100));
    h.bridge.move(h.ev(2, 300, 100));
    h.bridge.up(h.ev(2, 300, 100));
    h.bridge.move(h.ev(1, 160, 160));
    h.bridge.up(h.ev(1, 160, 160));
    expect(h.pans).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.bridge.active).toBe(false);
    // And the next touch is an ordinary one again.
    h.bridge.down(h.ev(1, 5, 5));
    h.bridge.up(h.ev(1, 5, 5));
    expect(h.calls.some((c) => c.startsWith("click@5,5"))).toBe(true);
  });

  it("a second finger during an object press RELEASES the press where it was, then pinches", () => {
    const h = pinchHarness("drag");
    h.bridge.down(h.ev(1, 100, 100));
    h.bridge.down(h.ev(2, 200, 100));
    expect(h.calls).toEqual(["mousedown@100,100", "mouseup@100,100"]);
    h.bridge.move(h.ev(2, 250, 100));
    expect(h.zooms).toEqual([1.5]);
  });

  it("a pinch starts from the zoom the sheet has now", () => {
    const h = pinchHarness("pan", 2);
    h.bridge.down(h.ev(1, 0, 0));
    h.bridge.down(h.ev(2, 100, 0));
    h.bridge.move(h.ev(2, 50, 0));
    expect(h.zooms).toEqual([1]);
  });

  it("the grid wires the pinch to the zoom slider's own state", () => {
    const touch = fs.readFileSync(path.resolve(__dirname, "../../components/Spreadsheet/useGridTouch.ts"), "utf8");
    expect(touch).toMatch(/zoom: \{\s*get: \(\) => stateRef\.current\(\)\.zoom/);
    expect(touch).toContain("installPointerPrecision(area");
    const grid = fs.readFileSync(path.resolve(__dirname, "../../components/Spreadsheet/Spreadsheet.tsx"), "utf8");
    expect(grid).toMatch(/setZoom: \(zoom: number\) => dispatch\(setZoom\(/);
  });
});

describe("BUG-0729 44 px targets for a finger or a pen", () => {
  it("touchTarget: the rect itself for a mouse; at least 44 SCREEN px a side for touch and pen", () => {
    const r = { x: 94, y: 94, width: 12, height: 12 };
    expect(touchTarget(r, 1)).toEqual(r);
    notePointerType("touch");
    expect(isCoarsePointer()).toBe(true);
    expect(touchTarget(r, 1)).toEqual({ x: 78, y: 78, width: 44, height: 44 });
    expect(touchTarget(r, 2), "logical px: 44 screen px at 200% is 22").toEqual({ x: 89, y: 89, width: 22, height: 22 });
    notePointerType("pen");
    expect(touchTarget(r, 1).width).toBe(TOUCH_TARGET_SCREEN_PX);
    notePointerType("mouse");
    expect(touchTarget(r, 1)).toEqual(r);
  });

  it("a floating object's handle: 15 px off it is a miss for the mouse, a grab for a finger", () => {
    const handle = { hit: { x: 94, y: 94, width: 12, height: 12 } } as FloatingHandle;
    expect(floatingHandleHits(handle, 115, 100)).toBe(false);
    notePointerType("touch");
    expect(floatingHandleHits(handle, 115, 100)).toBe(true);
    expect(floatingHandleHits(handle, 125, 100), "past the 44 px square").toBe(false);
  });

  it("the fill handle: 14 px off the corner grabs it with a finger only", () => {
    const config: GridConfig = { ...DEFAULT_GRID_CONFIG, rowHeaderWidth: 50, colHeaderHeight: 24, defaultCellWidth: 100, defaultCellHeight: 20 };
    const overFill = createFillHandleCursorChecker({
      config,
      viewport: { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 20, colCount: 10 },
      dimensions: { columnWidths: new Map(), rowHeights: new Map() },
      selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
    });
    // A1's corner is at (150, 44); the handle is centred 1px + 4px inside it.
    expect(overFill(145 + 14, 39)).toBe(false);
    notePointerType("touch");
    expect(overFill(145 + 14, 39)).toBe(true);
  });

  it("a header's resize border: a 44 px band for a finger, never more than half the column", () => {
    const config: GridConfig = { ...DEFAULT_GRID_CONFIG, rowHeaderWidth: 50, colHeaderHeight: 24, defaultCellWidth: 100, defaultCellHeight: 20 };
    const viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 20, colCount: 10 };
    const dims = { columnWidths: new Map<number, number>(), rowHeights: new Map<number, number>() };
    // The border between A and B is at x = 150.
    expect(getColumnResizeHandle(162, 10, config, viewport, dims)).toBeNull();
    notePointerType("touch");
    expect(getColumnResizeHandle(162, 10, config, viewport, dims)).toBe(0);
    expect(lineTargetHalf(3, 10, 1), "a 20 px column keeps its middle").toBe(10);
  });

  it("the grid follows the pointer's kind from its pointerdown / pointermove", () => {
    const el = document.createElement("div");
    const off = installPointerPrecision(el, () => 1);
    const fire = (type: string, pointerType: string) => {
      const e = new Event(type, { bubbles: true });
      Object.defineProperty(e, "pointerType", { value: pointerType });
      el.dispatchEvent(e);
    };
    fire("pointerdown", "pen");
    expect(isCoarsePointer()).toBe(true);
    fire("pointermove", "mouse");
    expect(isCoarsePointer()).toBe(false);
    fire("pointerdown", "touch");
    expect(isCoarsePointer()).toBe(true);
    off();
    fire("pointermove", "mouse");
    expect(isCoarsePointer(), "uninstalled: no longer followed").toBe(true);
  });
});

// Ledger programme 2, wave 3 (W2 uimisc new defect): the 22 px half-target of a
// selected chart's RIGHT-edge handles covered its quick-access buttons, which
// start 8 px right of the edge, and the resize scan runs before the chart's own
// hit test -- so a tap on a button resized the chart. A right-edge handle now
// grows left, up and down for a finger, and stops 7 px past the edge.
// SABOTAGE: drop the `edges.right` clamp in `floatingHandleHits` -- fails at
// "COVERS THE BUTTONS".
describe("a right-edge handle's touch target stops short of the quick-access buttons", () => {
  it("ne / e / se: 8 px right of the edge is never the handle; inward the 44 px square stands", async () => {
    const { floatingHandleGeometry } = await import("../floatingHandles");
    const rect = { x: 100, y: 100, width: 200, height: 150 };
    const handles = floatingHandleGeometry(rect, "all");
    const right = handles.filter((h) => h.edges.right);
    expect(right.map((h) => h.id).sort()).toEqual(["e", "ne", "se"]);
    notePointerType("touch");
    for (const h of right) {
      expect(floatingHandleHits(h, h.cx + 8, h.cy), `COVERS THE BUTTONS: ${h.id} at 8 px past the edge`).toBe(false);
      expect(floatingHandleHits(h, h.cx + 7, h.cy), `${h.id} 7 px past the edge`).toBe(true);
      expect(floatingHandleHits(h, h.cx - 20, h.cy), `${h.id} 20 px inward, a finger's reach`).toBe(true);
    }
    // The left handles keep the whole square.
    const nw = handles.find((h) => h.id === "nw")!;
    expect(floatingHandleHits(nw, nw.cx - 20, nw.cy)).toBe(true);
    notePointerType("mouse");
    for (const h of right) expect(floatingHandleHits(h, h.cx + 6, h.cy), "the mouse's own square").toBe(true);
  });
});
