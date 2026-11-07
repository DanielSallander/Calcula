//! FILENAME: app/src/core/lib/__tests__/touchBridge.test.ts
// PURPOSE: TOUCH on the grid works like Excel's (BUG-0276): a tap selects (the
//          mouse click at that point), a drag on a cell pans, a drag on an
//          object / handle / header drags it (the mouse drag), a long press is
//          the context menu, a double tap a double-click -- and the browser's
//          own compatibility mouse events are cancelled so nothing is pressed
//          twice.
// CONTEXT: Measured live 2026-10-02 (touch-pen-measure.spec.ts): every touch
//          drag ended in pointercancel (no touch-action) and no touch reached a
//          mouse handler, so touch could not select a cell or drag anything.
//          jsdom cannot paint or pan; these tests drive the bridge's state
//          machine and its DOM routing, and the press classification with the
//          mouse door's own hit tests.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TouchGestureBridge,
  installTouchBridge,
  isNativeTouchTarget,
  LONG_PRESS_MS,
  TOUCH_SLOP_PX,
  TOUCH_GHOST_MS,
  TOUCH_GHOST_PX,
  type TouchBridgeDeps,
  type TouchPointerLike,
  type TouchPressKind,
} from "../touchBridge";
import { classifyTouchPress, type GridTouchState } from "../../components/Spreadsheet/useGridTouch";
import { addGridRegions, removeGridRegionsByType } from "../../../api/gridOverlays";
import { DEFAULT_GRID_CONFIG, type GridConfig } from "../../types";

// ============================================================================
// The state machine
// ============================================================================

interface Harness {
  bridge: TouchGestureBridge;
  calls: string[];
  pans: Array<[number, number]>;
  fireTimer: () => void;
  prevented: number;
  ev: (type: string, x: number, y: number, extra?: Partial<TouchPointerLike>) => TouchPointerLike;
}

function harness(kind: TouchPressKind, native = false): Harness {
  const calls: string[] = [];
  const pans: Array<[number, number]> = [];
  let timer: (() => void) | null = null;
  const h: Harness = {
    bridge: null as unknown as TouchGestureBridge,
    calls,
    pans,
    fireTimer: () => timer?.(),
    prevented: 0,
    ev: (_type, x, y, extra = {}) => ({
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
      timeStamp: 1000,
      target: TARGET,
      preventDefault: () => {
        h.prevented++;
      },
      ...extra,
    }),
  };
  const deps: TouchBridgeDeps = {
    classify: () => kind,
    isNative: () => native,
    mouse: (type, _t, x, y, init) => calls.push(`${type}@${x},${y} b${init.button}/${init.buttons} d${init.detail}`),
    pan: (dx, dy) => pans.push([dx, dy]),
    setTimer: (fn) => {
      timer = fn;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
  };
  h.bridge = new TouchGestureBridge(deps);
  return h;
}

const TARGET = {} as EventTarget;

describe("a TAP", () => {
  it("on a cell is the mouse click at the press point -- it selects", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 100, 50));
    h.bridge.up(h.ev("up", 102, 51));
    expect(h.calls).toEqual([
      "mousedown@100,50 b0/1 d1",
      "mouseup@100,50 b0/0 d1",
      "click@100,50 b0/0 d1",
    ]);
    expect(h.pans).toEqual([]);
  });

  it("cancels the browser's compatibility mouse events (preventDefault on pointerdown)", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 100, 50));
    expect(h.prevented).toBeGreaterThan(0);
  });

  it("twice in quick succession is a double-click (Excel: double-tap edits)", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 100, 50, { timeStamp: 1000 }));
    h.bridge.up(h.ev("up", 100, 50, { timeStamp: 1050 }));
    h.calls.length = 0;
    h.bridge.down(h.ev("down", 102, 50, { timeStamp: 1200 }));
    h.bridge.up(h.ev("up", 102, 50, { timeStamp: 1250 }));
    expect(h.calls).toContain("dblclick@102,50 b0/0 d2");
    expect(h.calls[0]).toBe("mousedown@102,50 b0/1 d2");
  });

  it("two taps far apart in time are two single clicks", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 100, 50, { timeStamp: 1000 }));
    h.bridge.up(h.ev("up", 100, 50, { timeStamp: 1050 }));
    h.bridge.down(h.ev("down", 100, 50, { timeStamp: 3000 }));
    h.bridge.up(h.ev("up", 100, 50, { timeStamp: 3050 }));
    expect(h.calls.some((c) => c.startsWith("dblclick"))).toBe(false);
  });
});

describe("a DRAG", () => {
  it("on a cell PANS the sheet with the finger -- no mouse press at all", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 100, 100));
    h.bridge.move(h.ev("move", 100, 100 - TOUCH_SLOP_PX - 5));
    h.bridge.move(h.ev("move", 90, 60));
    h.bridge.up(h.ev("up", 90, 60));
    expect(h.calls).toEqual([]);
    // The movement in full: 15 up, then 10 left and 25 up.
    expect(h.pans).toEqual([
      [0, -(TOUCH_SLOP_PX + 5)],
      [-10, 60 - (100 - TOUCH_SLOP_PX - 5)],
    ]);
  });

  it("within the slop is still a tap", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 100, 100));
    h.bridge.move(h.ev("move", 104, 103));
    h.bridge.up(h.ev("up", 104, 103));
    expect(h.calls[2]).toBe("click@100,100 b0/0 d1");
    expect(h.pans).toEqual([]);
  });

  it("on an OBJECT is the mouse drag of it: press at once, moves with the button held, release", () => {
    const h = harness("drag");
    h.bridge.down(h.ev("down", 200, 80));
    expect(h.calls).toEqual(["mousedown@200,80 b0/1 d1"]);
    h.bridge.move(h.ev("move", 230, 90));
    h.bridge.move(h.ev("move", 260, 100));
    h.bridge.up(h.ev("up", 260, 100));
    expect(h.calls).toEqual([
      "mousedown@200,80 b0/1 d1",
      "mousemove@230,90 b0/1 d0",
      "mousemove@260,100 b0/1 d0",
      "mouseup@260,100 b0/0 d1",
    ]);
    expect(h.pans).toEqual([]);
  });

  it("a cancelled object drag still releases (whoever started the gesture ends it)", () => {
    const h = harness("drag");
    h.bridge.down(h.ev("down", 200, 80));
    h.bridge.move(h.ev("move", 230, 90));
    h.bridge.cancel(h.ev("cancel", 230, 90));
    expect(h.calls.at(-1)).toBe("mouseup@230,90 b0/0 d1");
    expect(h.bridge.active).toBe(false);
  });

  it("a tap on an object is its click", () => {
    const h = harness("drag");
    h.bridge.down(h.ev("down", 200, 80));
    h.bridge.up(h.ev("up", 200, 80));
    expect(h.calls).toEqual(["mousedown@200,80 b0/1 d1", "mouseup@200,80 b0/0 d1", "click@200,80 b0/0 d1"]);
  });
});

describe("a LONG PRESS", () => {
  it("on a cell is the right click: press, release, contextmenu -- and the lift does nothing more", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 100, 50));
    h.fireTimer();
    expect(h.calls).toEqual([
      "mousedown@100,50 b2/2 d1",
      "mouseup@100,50 b2/0 d1",
      "contextmenu@100,50 b2/0 d0",
    ]);
    h.bridge.up(h.ev("up", 100, 50));
    expect(h.calls).toHaveLength(3);
  });

  it("is cancelled by a pan", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 100, 100));
    h.bridge.move(h.ev("move", 100, 60));
    h.fireTimer();
    expect(h.calls).toEqual([]);
  });

  it("the timer is the documented half second", () => {
    expect(LONG_PRESS_MS).toBe(500);
  });
});

describe("what the bridge leaves alone", () => {
  it("mouse and pen pointers (they already work through the mouse events)", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 1, 1, { pointerType: "mouse" }));
    h.bridge.down(h.ev("down", 1, 1, { pointerType: "pen" }));
    expect(h.bridge.active).toBe(false);
    expect(h.prevented).toBe(0);
  });

  it("a second finger, when the bridge has no zoom door (no pinch; the grid's pinch is touchPinchAndTargets.test.ts)", () => {
    const h = harness("pan");
    h.bridge.down(h.ev("down", 1, 1));
    h.bridge.down(h.ev("down", 50, 50, { pointerId: 2, isPrimary: false }));
    h.bridge.up(h.ev("up", 50, 50, { pointerId: 2, isPrimary: false }));
    expect(h.calls).toEqual([]);
  });

  it("interactive DOM keeps the browser's own touch handling", () => {
    const h = harness("pan", true);
    h.bridge.down(h.ev("down", 1, 1));
    expect(h.bridge.active).toBe(false);
    expect(h.prevented).toBe(0);
    const input = document.createElement("input");
    const div = document.createElement("div");
    const inner = document.createElement("span");
    div.setAttribute("contenteditable", "true");
    div.appendChild(inner);
    expect(isNativeTouchTarget(input)).toBe(true);
    expect(isNativeTouchTarget(inner)).toBe(true);
    expect(isNativeTouchTarget(document.createElement("canvas"))).toBe(false);
  });
});

// ============================================================================
// The DOM routing: touch pointer events in, the grid's mouse events out
// ============================================================================

function pointer(type: string, x: number, y: number, pointerType = "touch"): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(e, "pointerId", { value: 7 });
  Object.defineProperty(e, "pointerType", { value: pointerType });
  Object.defineProperty(e, "isPrimary", { value: true });
  return e;
}

describe("installTouchBridge", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
    document.body.innerHTML = "";
  });

  it("a touch tap on the area arrives at the canvas as mousedown / mouseup / click, and the pointerdown is cancelled", () => {
    const area = document.createElement("div");
    const canvas = document.createElement("canvas");
    area.appendChild(canvas);
    document.body.appendChild(area);
    const seen: string[] = [];
    for (const t of ["mousedown", "mouseup", "click"]) {
      area.addEventListener(t, (e) => seen.push(`${t}:${(e as MouseEvent).clientX},${(e as MouseEvent).clientY}`));
    }
    cleanup = installTouchBridge(area, { classify: () => "pan", pan: () => undefined });
    const down = pointer("pointerdown", 40, 30);
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented, "the browser's compatibility mouse events are suppressed").toBe(true);
    canvas.dispatchEvent(pointer("pointerup", 40, 30));
    expect(seen).toEqual(["mousedown:40,30", "mouseup:40,30", "click:40,30"]);
  });

  it("a MOUSE pointer is not touched (it brings its own mouse events)", () => {
    const area = document.createElement("div");
    document.body.appendChild(area);
    const seen: string[] = [];
    area.addEventListener("mousedown", () => seen.push("mousedown"));
    cleanup = installTouchBridge(area, { classify: () => "pan", pan: () => undefined });
    const down = pointer("pointerdown", 1, 1, "mouse");
    area.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });

  // rev-ui-6: preventDefault on pointerdown cancels only the COMPATIBILITY mouse
  // events. The browser still sends its own click after the lift, Chromium a
  // dblclick for a double tap and a contextmenu for a long press -- each a
  // second copy of what the bridge already dispatched. jsdom cannot make a
  // trusted event, so the browser's copy is played by an UNSTAMPED event of
  // the same type at the touch point (it is exactly what the guard keys on: not
  // one of the bridge's own). Touch hardware was not available for this.
  function nativeCopy(type: string, x: number, y: number, extra: Record<string, unknown> = {}): MouseEvent {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: type === "dblclick" ? 2 : 1 });
    for (const [k, v] of Object.entries(extra)) Object.defineProperty(e, k, { value: v });
    return e;
  }

  function mountArea(): { area: HTMLDivElement; canvas: HTMLCanvasElement; heard: string[] } {
    const area = document.createElement("div");
    const canvas = document.createElement("canvas");
    area.appendChild(canvas);
    document.body.appendChild(area);
    const heard: string[] = [];
    // The grid's handlers: on the area itself (Spreadsheet.tsx's onDoubleClick /
    // onContextMenu) and at the document, where React's root listener sits.
    for (const t of ["click", "dblclick", "contextmenu"]) {
      area.addEventListener(t, () => heard.push(`area:${t}`));
      document.addEventListener(t, () => heard.push(`doc:${t}`));
    }
    return { area, canvas, heard };
  }

  it("a tap's own native click is swallowed: the grid hears ONE click", () => {
    const { area, canvas, heard } = mountArea();
    cleanup = installTouchBridge(area, { classify: () => "pan", pan: () => undefined });
    canvas.dispatchEvent(pointer("pointerdown", 40, 30));
    canvas.dispatchEvent(pointer("pointerup", 40, 30));
    canvas.dispatchEvent(nativeCopy("click", 40, 30));
    expect(heard.filter((h) => h === "area:click")).toEqual(["area:click"]);
    expect(heard.filter((h) => h === "doc:click")).toEqual(["doc:click"]);
  });

  it("a double tap runs the grid's double-click ONCE (Chromium's own dblclick is swallowed)", () => {
    const { area, canvas, heard } = mountArea();
    cleanup = installTouchBridge(area, { classify: () => "pan", pan: () => undefined });
    for (let i = 0; i < 2; i++) {
      canvas.dispatchEvent(pointer("pointerdown", 40, 30));
      canvas.dispatchEvent(pointer("pointerup", 40, 30));
      canvas.dispatchEvent(nativeCopy("click", 40, 30));
    }
    canvas.dispatchEvent(nativeCopy("dblclick", 40, 30));
    expect(heard.filter((h) => h === "area:dblclick")).toEqual(["area:dblclick"]);
    expect(heard.filter((h) => h === "doc:dblclick")).toEqual(["doc:dblclick"]);
    expect(heard.filter((h) => h === "area:click").length).toBe(2);
  });

  it("a long press opens the context menu ONCE, whether the browser's own comes at the press or at the lift", () => {
    vi.useFakeTimers();
    try {
      const { area, canvas, heard } = mountArea();
      cleanup = installTouchBridge(area, { classify: () => "pan", pan: () => undefined });
      canvas.dispatchEvent(pointer("pointerdown", 40, 30));
      canvas.dispatchEvent(nativeCopy("contextmenu", 40, 30)); // a browser that raises it while held
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(heard.filter((h) => h === "area:contextmenu")).toEqual(["area:contextmenu"]);
      canvas.dispatchEvent(pointer("pointerup", 40, 30));
      canvas.dispatchEvent(nativeCopy("contextmenu", 40, 30)); // ... or at the lift
      canvas.dispatchEvent(nativeCopy("click", 40, 30));
      expect(heard.filter((h) => h === "area:contextmenu")).toEqual(["area:contextmenu"]);
      expect(heard.filter((h) => h === "doc:contextmenu")).toEqual(["doc:contextmenu"]);
      expect(heard.filter((h) => h === "area:click")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows nothing once the short window has passed, and never a mouse's, a pen's or a far-away click", () => {
    vi.useFakeTimers();
    try {
      const { area, canvas, heard } = mountArea();
      cleanup = installTouchBridge(area, { classify: () => "pan", pan: () => undefined });
      canvas.dispatchEvent(pointer("pointerdown", 40, 30));
      canvas.dispatchEvent(pointer("pointerup", 40, 30));
      heard.length = 0;
      canvas.dispatchEvent(nativeCopy("click", 40, 30, { pointerType: "mouse" }));
      canvas.dispatchEvent(nativeCopy("dblclick", 40, 30, { sourceCapabilities: { firesTouchEvents: false } }));
      canvas.dispatchEvent(nativeCopy("click", 40 + TOUCH_GHOST_PX + 5, 30));
      expect(heard.filter((h) => h.startsWith("area:"))).toEqual(["area:click", "area:dblclick", "area:click"]);
      heard.length = 0;
      vi.advanceTimersByTime(TOUCH_GHOST_MS + 1);
      canvas.dispatchEvent(nativeCopy("click", 40, 30));
      expect(heard.filter((h) => h.startsWith("area:"))).toEqual(["area:click"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a touch the bridge leaves alone (an input) keeps its own native click", () => {
    const { area, heard } = mountArea();
    const input = document.createElement("input");
    area.appendChild(input);
    cleanup = installTouchBridge(area, { classify: () => "pan", pan: () => undefined });
    input.dispatchEvent(pointer("pointerdown", 40, 30));
    input.dispatchEvent(pointer("pointerup", 40, 30));
    input.dispatchEvent(nativeCopy("click", 40, 30));
    expect(heard.filter((h) => h === "area:click")).toEqual(["area:click"]);
  });

  it("cleanup removes the guard with the bridge", () => {
    const { area, canvas, heard } = mountArea();
    cleanup = installTouchBridge(area, { classify: () => "pan", pan: () => undefined });
    canvas.dispatchEvent(pointer("pointerdown", 40, 30));
    canvas.dispatchEvent(pointer("pointerup", 40, 30));
    cleanup();
    cleanup = null;
    heard.length = 0;
    canvas.dispatchEvent(nativeCopy("click", 40, 30));
    expect(heard.filter((h) => h === "area:click")).toEqual(["area:click"]);
  });

  it("a touch drag on a cell pans through the caller, with the finger's movement", () => {
    const area = document.createElement("div");
    document.body.appendChild(area);
    const pan = vi.fn();
    cleanup = installTouchBridge(area, { classify: () => "pan", pan });
    area.dispatchEvent(pointer("pointerdown", 100, 100));
    area.dispatchEvent(pointer("pointermove", 100, 70));
    expect(pan).toHaveBeenCalledWith(0, -30, 100, 70);
  });
});

// ============================================================================
// Which presses drag and which pan: the mouse door's own hit tests
// ============================================================================

describe("classifyTouchPress", () => {
  const CONFIG: GridConfig = { ...DEFAULT_GRID_CONFIG, rowHeaderWidth: 50, colHeaderHeight: 24, defaultCellWidth: 100, defaultCellHeight: 20 };
  const STATE: GridTouchState = {
    config: CONFIG,
    viewport: { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 20, colCount: 10 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
    selection: null,
    zoom: 1,
    canvas: null,
  };
  afterEach(() => removeGridRegionsByType("touch-test"));

  it("a plain cell pans", () => {
    expect(classifyTouchPress(300, 200, true, STATE)).toBe("pan");
  });

  it("a column or row header drags (select / resize, as the mouse does there)", () => {
    expect(classifyTouchPress(300, 10, true, STATE)).toBe("drag");
    expect(classifyTouchPress(20, 200, true, STATE)).toBe("drag");
  });

  it("a floating object drags (it moves under the finger)", () => {
    addGridRegions([
      { id: "obj", type: "touch-test", startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x: 200, y: 100, width: 150, height: 80 } },
    ]);
    // Canvas point = gutters + sheet point.
    expect(classifyTouchPress(50 + 250, 24 + 140, true, STATE)).toBe("drag");
    expect(classifyTouchPress(50 + 600, 24 + 400, true, STATE), "beside it is still a cell").toBe("pan");
  });

  it("the fill handle drags", () => {
    const sel = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };
    // A1's bottom-right corner: x = 50 + 100, y = 24 + 20.
    expect(classifyTouchPress(150, 44, true, { ...STATE, selection: sel })).toBe("drag");
  });

  it("DOM stacked over the canvas (a scrollbar) gets the mouse drag", () => {
    expect(classifyTouchPress(300, 200, false, STATE)).toBe("drag");
  });
});

// ============================================================================
// The grid area is wired: it owns every touch
// ============================================================================

describe("the grid area installs the bridge and sets touch-action: none", () => {
  it("Spreadsheet.tsx (without touch-action the browser cancels every touch drag)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../components/Spreadsheet/Spreadsheet.tsx"),
      "utf8",
    );
    expect(src).toMatch(/useGridTouch\(containerRef,/);
    const area = src.slice(src.indexOf("<S.GridArea"), src.indexOf("<S.CanvasLayer"));
    expect(area).toContain("TOUCH_ACTION_NONE");
    expect(area).toMatch(/touchAction: "none"/);
    expect(src).toMatch(/const TOUCH_ACTION_NONE: React\.CSSProperties = \{ touchAction: "none" \}/);
  });
});
