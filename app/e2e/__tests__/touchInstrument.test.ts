//! FILENAME: app/e2e/__tests__/touchInstrument.test.ts
// PURPOSE: Unit tier for the touch and pen instrument (e2e/helpers/touch.ts),
//          the harness behind journeys/touch-pen-measure.spec.ts (plan_M8 S10).
//
// WHY AN INSTRUMENT NEEDS ITS OWN TESTS. That journey asserts almost nothing
// about the product: its value is the TABLE it records. Its one product check
// is "after the lift, nothing holds the pointer", and that check reads two
// harness answers: the recorder's pointer-capture balance and the product's
// press-session probes. If either quietly answered "nothing" -- a probe whose
// module lacks the function, a capture count that never decrements -- the
// stuck-pointer check would pass on every run without measuring anything. The
// same goes for the driver: a gesture that throws half-way and leaves a finger
// down would make the NEXT measurement's "stuck pointer" the harness's own.
// None of that is visible to a type checker, or to a live run that happens to
// be green, so it is pinned here:
//   - the exact CDP calls of each gesture, including the lift that must happen
//     even when the gesture throws;
//   - the recorder, run against jsdom's real DOM events: what it counts, that
//     it reads `defaultPrevented` AFTER every listener ran, that unmatched
//     capture and an element still holding capture are reported, and that it
//     never cancels an event;
//   - a probe that cannot answer THROWS instead of reading false;
//   - the table: escaping, STUCK / NOT MEASURED, TP-10 after TP-2, STALE files.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import {
  PointerDriver,
  composeMeasurementTable,
  heldPointers,
  markPage,
  pageAlive,
  readInputLog,
  readProbes,
  renderMeasureTable,
  startInputLog,
  stopInputLog,
  summariseEvents,
  writeMeasurement,
  type InputLog,
  type MeasureRow,
} from "../helpers/touch";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Call = { method: string; params: Record<string, unknown> } | { mark: string };

/** A page whose CDP session records every call (and can refuse some), and whose waits are instant. */
function fakeCdpPage(refuse?: (params: Record<string, unknown>) => boolean): { page: Page; calls: Call[]; detached: () => boolean } {
  const calls: Call[] = [];
  let detached = false;
  const cdp = {
    send: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (refuse?.(params)) throw new Error(`refused ${String(params.type)}`);
      return {};
    },
    detach: async () => {
      detached = true;
    },
  };
  const page = {
    context: () => ({ newCDPSession: async () => cdp }),
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  return { page, calls, detached: () => detached };
}

/** A page whose `evaluate` runs the function here, in jsdom's window and document. */
function jsdomPage(): Page {
  return {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;
}

const types = (calls: Call[]): string[] => calls.map((c) => ("mark" in c ? `<${c.mark}>` : String(c.params.type)));
const last = (calls: Call[]): Call => calls[calls.length - 1];

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

describe("PointerDriver: the CDP calls each gesture makes", () => {
  it("a mouse tap hovers in from 3 px away, presses the left button, and releases it", async () => {
    const { page, calls } = fakeCdpPage();
    const d = await PointerDriver.open(page);
    await d.tap("mouse", { x: 100, y: 50 });
    expect(calls).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 97, y: 47, button: "none", buttons: 0, clickCount: 0, pointerType: "mouse", force: 0 } },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 100, y: 50, button: "none", buttons: 0, clickCount: 0, pointerType: "mouse", force: 0 } },
      { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 100, y: 50, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0 } },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 100, y: 50, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse", force: 0 } },
    ]);
    expect(d.isDown()).toBe(false);
  });

  it("a pen is the same gesture with pointerType pen, and has pressure only while in contact", async () => {
    const { page, calls } = fakeCdpPage();
    const d = await PointerDriver.open(page);
    await d.drag("pen", { x: 10, y: 10 }, { x: 34, y: 22 }, { steps: 2 });
    const p = calls.map((c) => ("params" in c ? c.params : {}));
    expect(p.every((x) => x.pointerType === "pen")).toBe(true);
    expect(types(calls)).toEqual(["mouseMoved", "mouseMoved", "mousePressed", "mouseMoved", "mouseMoved", "mouseReleased"]);
    // hover, hover: no contact, no pressure; press and the held moves: pressure; release: none.
    expect(p.map((x) => x.force)).toEqual([0, 0, 0.5, 0.5, 0.5, 0]);
    expect(p.map((x) => x.buttons)).toEqual([0, 0, 1, 1, 1, 0]);
    expect(p[4]).toMatchObject({ x: 34, y: 22, button: "left" });
  });

  it("a finger has no hover: a touch drag is one touchStart, the moves, a sample, then a touchEnd with no points", async () => {
    const { page, calls } = fakeCdpPage();
    const d = await PointerDriver.open(page);
    await d.drag("touch", { x: 0, y: 0 }, { x: 120, y: 60 }, {
      whileHeld: async () => {
        calls.push({ mark: "sampled" });
      },
    });
    expect(types(calls)).toEqual(["touchStart", ...Array(12).fill("touchMove"), "<sampled>", "touchEnd"]);
    const first = calls[0] as { method: string; params: Record<string, unknown> };
    expect(first.method).toBe("Input.dispatchTouchEvent");
    expect(first.params.touchPoints).toEqual([{ x: 0, y: 0, id: 1, radiusX: 1, radiusY: 1, force: 1 }]);
    const lastMove = calls[12] as { params: Record<string, unknown> };
    expect(lastMove.params.touchPoints).toEqual([{ x: 120, y: 60, id: 1, radiusX: 1, radiusY: 1, force: 1 }]);
    expect((last(calls) as { params: Record<string, unknown> }).params).toEqual({ type: "touchEnd", touchPoints: [] });
  });

  it("a gesture whose sample throws still LIFTS the pointer, and the error still reaches the caller", async () => {
    for (const input of ["touch", "mouse"] as const) {
      const { page, calls } = fakeCdpPage();
      const d = await PointerDriver.open(page);
      await expect(
        d.longPress(input, { x: 5, y: 5 }, {
          whileHeld: async () => {
            throw new Error("the probe broke");
          },
        }),
      ).rejects.toThrow("the probe broke");
      expect(String((last(calls) as { params: Record<string, unknown> }).params.type), `${input}: the last call must lift`).toBe(
        input === "touch" ? "touchEnd" : "mouseReleased",
      );
      expect(d.isDown()).toBe(false);
    }
  });

  it("a lift the browser refuses becomes a touchCancel, so no finger is left down for the next test", async () => {
    const { page, calls } = fakeCdpPage((p) => p.type === "touchEnd");
    const d = await PointerDriver.open(page);
    await d.tap("touch", { x: 1, y: 1 });
    expect(types(calls)).toEqual(["touchStart", "touchEnd", "touchCancel"]);
  });

  it("releaseAll cancels a finger, releases a button, and sends nothing when nothing is down; close detaches", async () => {
    const { page, calls, detached } = fakeCdpPage();
    const d = await PointerDriver.open(page);
    await d.press("touch", { x: 3, y: 4 });
    await d.releaseAll();
    await d.press("pen", { x: 6, y: 7 });
    await d.moveTo({ x: 8, y: 9 });
    await d.releaseAll();
    await d.releaseAll();
    expect(types(calls)).toEqual(["touchStart", "touchCancel", "mousePressed", "mouseMoved", "mouseReleased"]);
    expect((last(calls) as { params: Record<string, unknown> }).params).toMatchObject({ x: 8, y: 9, pointerType: "pen", buttons: 0 });
    await d.close();
    expect(detached()).toBe(true);
  });

  it("refuses a second contact while one is down, and refuses to park the mouse mid-gesture", async () => {
    const { page } = fakeCdpPage();
    const d = await PointerDriver.open(page);
    await d.press("mouse", { x: 1, y: 1 });
    await expect(d.press("touch", { x: 2, y: 2 })).rejects.toThrow(/already down/);
    await expect(d.park({ x: 0, y: 0 })).rejects.toThrow(/cannot park/);
    await d.lift();
  });
});

// ---------------------------------------------------------------------------
// The recorder, against jsdom's real DOM events
// ---------------------------------------------------------------------------

describe("the input recorder (passive, listen-only)", () => {
  const page = jsdomPage();
  let host: HTMLElement | null = null;

  afterEach(async () => {
    await stopInputLog(page);
    host?.remove();
    host = null;
  });

  /** <div data-grid-area><canvas/></div> in the document; returns the canvas. */
  function gridCanvas(): HTMLCanvasElement {
    host = document.createElement("div");
    host.setAttribute("data-grid-area", "");
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    document.body.appendChild(host);
    return canvas;
  }

  function fromTouch<E extends Event>(e: E): E {
    Object.defineProperty(e, "sourceCapabilities", { value: { firesTouchEvents: true } });
    return e;
  }

  it("counts what reached the page, by type and pointerType, and marks the mouse events that came from touch", async () => {
    const el = gridCanvas();
    await startInputLog(page);
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 3, button: 0, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "touch", pointerId: 3 }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", pointerId: 3 }));
    el.dispatchEvent(new Event("touchstart", { bubbles: true }));
    el.dispatchEvent(new Event("touchend", { bubbles: true }));
    el.dispatchEvent(fromTouch(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    el.dispatchEvent(fromTouch(new MouseEvent("mouseup", { bubbles: true })));
    el.dispatchEvent(fromTouch(new MouseEvent("click", { bubbles: true })));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    const log = await readInputLog(page);
    expect(log.counts).toMatchObject({ pointerdown: 1, pointermove: 1, pointerup: 1, touchstart: 1, touchend: 1, mousedown: 1, mouseup: 1, click: 1, mousemove: 1, contextmenu: 0 });
    expect(log.pointerTypes).toEqual(["touch"]);
    expect(log.mouseFromTouch, "three mouse events came from touch, one did not").toBe(3);
    expect(log.firstDown).toEqual({ target: "canvas in [data-grid-area]", pointerType: "touch", button: 0, buttons: 1 });
    expect(summariseEvents(log)).toBe(
      "pointer(touch): down 1, move 1, up 1 | touch: start 1, end 1 | mouse: move 1, down 1, up 1, click 1 (3 from touch)",
    );
  });

  it("reads whether each contextmenu was prevented AFTER every listener ran, not when the recorder saw it", async () => {
    const el = gridCanvas();
    await startInputLog(page);
    const prevent = (e: Event): void => e.preventDefault();
    el.addEventListener("contextmenu", prevent);
    el.dispatchEvent(fromTouch(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 0 })));
    el.removeEventListener("contextmenu", prevent);
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    const log = await readInputLog(page);
    expect(log.contextMenus).toEqual([
      { button: 0, fromTouch: true, target: "canvas in [data-grid-area]", prevented: true },
      { button: 2, fromTouch: false, target: "canvas in [data-grid-area]", prevented: false },
    ]);
    expect(summariseEvents(log)).toContain("contextmenu 2 (button 0, prevented; button 2, NOT prevented)");
  });

  it("reports an unmatched gotpointercapture, and any element that still has capture of a pointer the gesture used", async () => {
    const el = gridCanvas();
    await startInputLog(page);
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 7 }));
    el.dispatchEvent(new PointerEvent("gotpointercapture", { bubbles: true, pointerType: "touch", pointerId: 7 }));
    let log: InputLog = await readInputLog(page);
    expect(log.capture.got).toBe(1);
    expect(log.capture.lost).toBe(0);
    expect(log.capture.stillCaptured).toEqual(["pointer 7: gotpointercapture 1, lostpointercapture 0"]);

    el.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerType: "touch", pointerId: 7 }));
    log = await readInputLog(page);
    expect(log.capture.stillCaptured, "a matched got/lost pair is balanced").toEqual([]);

    // The elements are asked too: capture the recorder never saw an event for.
    (el as unknown as { hasPointerCapture: (id: number) => boolean }).hasPointerCapture = (id: number) => id === 7;
    log = await readInputLog(page);
    expect(log.capture.stillCaptured).toEqual(["canvas in [data-grid-area] still has pointer capture of pointer 7"]);
  });

  it("never cancels an event, records native scrolls by target, and starts from zero after a restart", async () => {
    const el = gridCanvas();
    await startInputLog(page);
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", pointerId: 1 });
    el.dispatchEvent(down);
    expect(down.defaultPrevented, "the recorder cancelled an event it only had to watch").toBe(false);
    host!.dispatchEvent(new Event("scroll"));
    let log = await readInputLog(page);
    expect(log.scrolled).toEqual(["div[data-grid-area]"]);

    await startInputLog(page);
    log = await readInputLog(page);
    expect(log.counts.pointerdown, "a restarted log still counted the old events").toBe(0);

    await stopInputLog(page);
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", pointerId: 1 }));
    await expect(readInputLog(page)).rejects.toThrow(/never started/);
  });

  it("says so when nothing reached the page", () => {
    const empty: InputLog = {
      counts: {},
      pointerTypes: [],
      mouseFromTouch: 0,
      firstDown: null,
      contextMenus: [],
      scrolled: [],
      capture: { got: 0, lost: 0, stillCaptured: [] },
    };
    expect(summariseEvents(empty)).toBe("no event reached the page");
  });
});

// ---------------------------------------------------------------------------
// The product's own answers
// ---------------------------------------------------------------------------

describe("the product probes", () => {
  const page = jsdomPage();
  type W = { __appImport?: (m: string) => Promise<Record<string, unknown>> };

  afterEach(() => {
    delete (window as unknown as W).__appImport;
  });

  function serve(modules: Record<string, Record<string, unknown>>): void {
    (window as unknown as W).__appImport = async (m: string) => modules[m] ?? {};
  }

  it("a probe whose module does not export its function THROWS -- it never reads as 'nothing held'", async () => {
    serve({ "/a.ts": { isHeld: () => false } });
    await expect(
      readProbes(page, [
        { name: "a", mod: "/a.ts", fn: "isHeld" },
        { name: "renamed", mod: "/b.ts", fn: "isHeld" },
      ]),
    ).rejects.toThrow(/"renamed" is blind/);
  });

  it("heldPointers names exactly the press sessions that read true (strictly true)", async () => {
    serve({
      "/src/core/lib/cellPressRelease.ts": { isCellPressHeld: () => false },
      "/src/core/lib/objectHover.ts": { isFloatingGestureActive: () => true },
      "/src/api/gridOverlays.ts": { isContentGestureHeld: () => "yes" },
      "/extensions/Controls/lib/buttonPress.ts": { isFloatingButtonPressActive: () => false },
      "/extensions/Pivot/lib/pivotChromePress.ts": { isPivotChromePressActive: () => false },
      "/extensions/Charts/lib/chartButtonSession.ts": { isChartButtonPressActive: () => false },
      "/extensions/Slicer/lib/slicerItemDrag.ts": { isSlicerContentGestureActive: () => true },
      "/extensions/TimelineSlicer/lib/timelineRangeDrag.ts": { isTimelineContentGestureActive: () => false },
    });
    expect(await heldPointers(page)).toEqual(["Core floating move/resize", "slicer item drag"]);
  });

  it("the page mark tells the same document from a reloaded one, and pageAlive never throws", async () => {
    const token = await markPage(page);
    expect((await pageAlive(page, token)).marked).toBe(true);
    expect((await pageAlive(page, "another-document")).marked).toBe(false);
    const dead = { evaluate: async () => Promise.reject(new Error("Execution context was destroyed")) } as unknown as Page;
    const r = await pageAlive(dead, token);
    expect(r).toMatchObject({ marked: false, mounted: false });
    expect(r.detail).toContain("Execution context was destroyed");
  });
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

function row(over: Partial<MeasureRow>): MeasureRow {
  return {
    id: "TP-1",
    surface: "worksheet",
    gesture: "tap",
    input: "touch",
    target: "canvas in [data-grid-area]; touch-action auto (nothing up to <html> sets touch-action)",
    happened: "nothing",
    events: "no event reached the page",
    heldMidGesture: "(not sampled)",
    heldAfter: [],
    captureAfter: [],
    pageErrors: [],
    notes: [],
    facts: {},
    error: null,
    measuredAt: "2026-10-01T12:00:00.000Z",
    ...over,
  };
}

describe("the measurement table", () => {
  it("escapes pipes and newlines, and says STUCK and NOT MEASURED where they apply", () => {
    const md = renderMeasureTable([
      row({ happened: "filter all -> [a|b]\nsecond line", heldAfter: ["slicer item drag"], captureAfter: ["pointer 3: gotpointercapture 1, lostpointercapture 0"] }),
      row({ input: "pen", error: "precondition: the slicer exists", happened: "should not show", pageErrors: ["TypeError: x"] }),
    ]);
    const lines = md.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("filter all -> [a\\|b] second line");
    expect(lines[2]).toContain("STUCK: slicer item drag; pointer 3: gotpointercapture 1, lostpointercapture 0");
    expect(lines[3]).toContain("| - |");
    expect(lines[3]).not.toContain("should not show");
    expect(lines[3]).toContain("NOT MEASURED: precondition: the slicer exists; page error: TypeError: x");
    // Every line has the same number of cells as the header: no unescaped pipe split a cell.
    const cells = (l: string): number => l.split(/(?<!\\)\|/).length;
    expect(new Set(lines.map(cells)).size).toBe(1);
  });

  describe("composeMeasurementTable", () => {
    let dir = "";
    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = "";
    });

    it("orders the tests by number (TP-10 after TP-2), marks a file from an earlier run STALE, and skips a broken file", () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "touch-pen-"));
      const now = Date.parse("2026-10-01T12:00:00.000Z");
      writeMeasurement(dir, { title: "TP-10 (worksheet): button cell", measuredAt: new Date(now).toISOString(), env: null, rows: [row({ id: "TP-10" })] });
      writeMeasurement(dir, { title: "TP-2 (canvas): drag", measuredAt: new Date(now - 60_000).toISOString(), env: null, rows: [row({ id: "TP-2" })] });
      writeMeasurement(dir, { title: "TP-1 (worksheet): tap", measuredAt: new Date(now - 4 * 60 * 60 * 1000).toISOString(), env: null, rows: [row({})] });
      fs.writeFileSync(path.join(dir, "half-written.json"), "{ not json");

      const table = composeMeasurementTable(dir);
      expect(table).not.toBeNull();
      const headings = table!.split("\n").filter((l) => l.startsWith("## "));
      expect(headings).toEqual([
        "## TP-1 (worksheet): tap -- STALE (an earlier run; this test did not run this time)",
        "## TP-2 (canvas): drag",
        "## TP-10 (worksheet): button cell",
      ]);
      expect(fs.readFileSync(path.join(dir, "TABLE.md"), "utf8")).toBe(table);
    });

    it("answers null for a directory that does not exist or holds no measurement", () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "touch-pen-"));
      expect(composeMeasurementTable(path.join(dir, "missing"))).toBeNull();
      expect(composeMeasurementTable(dir)).toBeNull();
    });
  });
});
