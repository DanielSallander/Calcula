//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotChromePress.test.ts
// PURPOSE: A canvas pivot box's CHROME acts on RELEASE over the same piece of
//          chrome (lib/pivotChromePress.ts; BUG-0258 design phase 4, D5):
//            - a press on a +/- does nothing yet; its release on the same +/-
//              toggles it once;
//            - sliding off, releasing on ANOTHER +/-, Escape, a window blur, a
//              move with the primary button up (a release never heard) and the
//              next press all end it with no action;
//            - the double-click guard (REPEAT_PRESS_MS, 450 ms) is measured
//              between RELEASES: a double-click toggles once, a click past the
//              window toggles again;
//            - a report-filter combo, a Row/Column Labels button and the
//              loading indicator's Cancel act at the release, not the press;
//            - the window listeners live only as long as the press;
//            - a release over the same chrome where ANOTHER object covers the
//              box acts on nothing (Core's occlusion question, asked with the
//              box's region and the release's client point);
//            - a release of another button ends the press with no action when
//              the primary one is up (a middle press), and not while it is held;
//            - the press holds Core's pointer over the box (no grip, no resize
//              handle under it) and lets go on every end path (BUG-0258 M7
//              review).
// CONTEXT: The record is the one the box painted (pivotVisualHits.ts); the
//          chrome's actions are mocked at their module (pivotChromeActions.ts),
//          so what is observed is WHEN and HOW OFTEN they run.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const api = vi.hoisted(() => ({
  togglePivotHeaderAt: vi.fn(async () => true),
  openPivotReportFilterAt: vi.fn(async () => true),
  openPivotHeaderFilter: vi.fn(),
  cancelPivotLoading: vi.fn(),
  getPivotViewCell: vi.fn(),
  /** Core's occlusion answer: another object covers this region at this client point. */
  covered: vi.fn((_regionId: string, _x: number, _y: number) => false),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  isFloatingRegionCoveredAtClient: (regionId: string, x: number, y: number) => api.covered(regionId, x, y),
}));

vi.mock("@api", () => ({
  showToast: vi.fn(),
  isPointerClaimed: () => false,
}));

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({
    zoom: 1,
    surface: "canvas",
    displayHeadings: false,
    config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
    viewport: { scrollX: 0, scrollY: 0 },
    sheetContext: { activeSheetIndex: 2 },
  }),
  resolveHeaderSizes: () => ({ rowHeaderWidth: 0, colHeaderHeight: 0 }),
}));

vi.mock("@api/pivot", () => ({ pivot: { getAtCell: vi.fn() } }));

vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));

vi.mock("../pivot-api", () => ({
  updatePivotProperties: vi.fn(),
  getPivotCellWindow: vi.fn(),
  getCellDisplayValue: (v: unknown) => (v == null ? "" : String(v)),
}));

vi.mock("../pivotChromeActions", () => ({
  togglePivotHeaderAt: api.togglePivotHeaderAt,
  openPivotReportFilterAt: api.openPivotReportFilterAt,
  openPivotHeaderFilter: api.openPivotHeaderFilter,
  cancelPivotLoading: api.cancelPivotLoading,
  getPivotViewCell: api.getPivotViewCell,
}));

vi.mock("../pivotCellDoubleClick", () => ({ runPivotCellDoubleClick: vi.fn(() => true) }));

import { clearContentGestureCursor, contentGestureCursorFor, isContentGestureHeld } from "@api/gridOverlays";
import { beginPivotChromePress, cancelPivotChromePress, isPivotChromePressActive } from "../pivotChromePress";
import { resetPivotVisualHits, setPivotVisualRecord } from "../pivotVisualHits";

/** The box at canvas (100, 80), 300 x 200, scrolled 100px (chrome bounds are box-local after the scroll). */
function paintRecord(opts: { cancel?: boolean } = {}): void {
  setPivotVisualRecord({
    pivotId: "cp1",
    box: { x: 100, y: 80, width: 300, height: 200 },
    bounds: {
      expandCollapseIcons: new Map([
        ["7-0", { x: 6, y: 78, width: 12, height: 12, row: 7, col: 0, isExpanded: true, isRow: true }],
        ["8-0", { x: 6, y: 102, width: 12, height: 12, row: 8, col: 0, isExpanded: true, isRow: true }],
      ]),
      filterButtons: new Map([["filter-2", { x: 150, y: 3, width: 18, height: 18, fieldIndex: 2, row: 0, col: 1 }]]),
      headerFilterButtons: new Map([["hf-row", { x: 60, y: 30, width: 16, height: 16, zone: "row", row: 1, col: 0 }]]),
    },
    cancel: opts.cancel ? { x: 220, y: 200, width: 60, height: 20 } : null,
    geometry: null,
    scroll: { left: 0, top: 100 },
    startRow: 0,
    startCol: 1024,
  } as never);
}

/** Canvas points (the press's clientToCanvas is the identity here). */
const ICON_A = { x: 112, y: 164 }; // view row 7
const ICON_B = { x: 112, y: 188 }; // view row 8
const FILTER = { x: 259, y: 92 };
const HEADER_FILTER = { x: 168, y: 118 };
const CANCEL = { x: 250, y: 210 };
const OFF = { x: 172, y: 164 }; // inside the box, on no chrome

const REGION = "pivot-visual-cp1";

function press(at: { x: number; y: number }, regionId: string | undefined = REGION): boolean {
  return beginPivotChromePress({ pivotId: "cp1", regionId, canvasX: at.x, canvasY: at.y, clientToCanvas: (x, y) => ({ x, y }) });
}

function move(at: { x: number; y: number }, buttons = 1): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: at.x, clientY: at.y, buttons }));
}

/** `buttons`: the buttons still held AFTER this release (bit 1 = the primary). */
function release(at: { x: number; y: number }, button = 0, buttons = 0): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button, buttons }));
}

function click(at: { x: number; y: number }): void {
  press(at);
  release(at);
}

let now = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Far from the previous test's last release: the double-click guard is module state.
  now += 100_000;
  vi.setSystemTime(now);
  cancelPivotChromePress();
  clearContentGestureCursor();
  api.covered.mockImplementation(() => false);
  resetPivotVisualHits();
  paintRecord();
});

afterEach(() => {
  cancelPivotChromePress();
  clearContentGestureCursor();
  vi.useRealTimers();
});

describe("a +/- acts on RELEASE over the same +/-", () => {
  it("the press on the icon toggles nothing yet", () => {
    expect(press(ICON_A)).toBe(true);
    expect(isPivotChromePressActive()).toBe(true);
    expect(api.togglePivotHeaderAt, "the +/- acted on the PRESS").not.toHaveBeenCalled();
  });

  it("released on the same icon: toggled once, for THAT view cell", () => {
    press(ICON_A);
    move({ x: ICON_A.x + 1, y: ICON_A.y + 1 });
    release({ x: ICON_A.x + 2, y: ICON_A.y - 1 });
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledWith("cp1", 7, 0, true);
    expect(isPivotChromePressActive()).toBe(false);
  });

  it("pressed on the icon, slid off and released off it: never toggled", () => {
    press(ICON_A);
    move({ x: ICON_A.x + 30, y: ICON_A.y });
    move({ x: ICON_A.x + 60, y: ICON_A.y });
    release({ x: ICON_A.x + 60, y: ICON_A.y });
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
    expect(isPivotChromePressActive()).toBe(false);
  });

  it("slid off and BACK onto the same icon before the release: toggled (the release decides)", () => {
    press(ICON_A);
    move(OFF);
    move(ICON_A);
    release(ICON_A);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
  });

  it("pressed on icon A, released on icon B: neither is toggled", () => {
    press(ICON_A);
    move(ICON_B);
    release(ICON_B);
    expect(api.togglePivotHeaderAt, "a release on ANOTHER +/- acted").not.toHaveBeenCalled();
  });

  it("the double-click guard runs between RELEASES: two clicks within 450 ms toggle once, a third past it toggles again", () => {
    click(ICON_A);
    vi.setSystemTime(now + 120);
    click(ICON_A);
    expect(api.togglePivotHeaderAt, "a double-click toggled twice (back to where it was)").toHaveBeenCalledTimes(1);
    vi.setSystemTime(now + 120 + 600);
    click(ICON_A);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(2);
  });

  it("a press on no chrome starts nothing and binds nothing", () => {
    expect(press(OFF)).toBe(false);
    expect(isPivotChromePressActive()).toBe(false);
    release(ICON_A);
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });
});

describe("the other chrome acts at the release too", () => {
  it("a report-filter combo opens its menu at the RELEASE, for the hidden-grid cell of that combo", () => {
    press(FILTER);
    expect(api.openPivotReportFilterAt, "the filter menu opened on the PRESS").not.toHaveBeenCalled();
    release({ x: FILTER.x + 2, y: FILTER.y + 1 });
    expect(api.openPivotReportFilterAt).toHaveBeenCalledTimes(1);
    const [gridRow, gridCol, fieldIndex] = api.openPivotReportFilterAt.mock.calls[0] as unknown as number[];
    expect([gridRow, gridCol, fieldIndex]).toEqual([0, 1025, 2]);
  });

  it("a filter press released off the combo opens nothing", () => {
    press(FILTER);
    release({ x: FILTER.x, y: FILTER.y + 60 });
    expect(api.openPivotReportFilterAt).not.toHaveBeenCalled();
  });

  it("a Row Labels button opens its menu at the release", () => {
    press(HEADER_FILTER);
    expect(api.openPivotHeaderFilter).not.toHaveBeenCalled();
    release(HEADER_FILTER);
    expect(api.openPivotHeaderFilter).toHaveBeenCalledTimes(1);
    expect(api.openPivotHeaderFilter.mock.calls[0][0]).toBe("cp1");
    expect(api.openPivotHeaderFilter.mock.calls[0][1]).toBe("row");
  });

  it("the loading indicator's Cancel cancels at the release, and not when released off it", () => {
    paintRecord({ cancel: true });
    press(CANCEL);
    expect(api.cancelPivotLoading).not.toHaveBeenCalled();
    release({ x: CANCEL.x, y: CANCEL.y + 80 });
    expect(api.cancelPivotLoading).not.toHaveBeenCalled();
    press(CANCEL);
    release(CANCEL);
    expect(api.cancelPivotLoading).toHaveBeenCalledWith("cp1");
  });
});

describe("every other end of the press acts on nothing", () => {
  it("Escape cancels (and is the press's: default prevented), so the later release acts on nothing", () => {
    press(ICON_A);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(isPivotChromePressActive()).toBe(false);
    release(ICON_A);
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });

  it("another key does not end the press", () => {
    press(ICON_A);
    const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(isPivotChromePressActive()).toBe(true);
    release(ICON_A);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
  });

  it("a move with the primary button UP (a release never heard) ends it with no action", () => {
    press(ICON_A);
    move(ICON_A, 0);
    expect(isPivotChromePressActive()).toBe(false);
    release(ICON_A);
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });

  it("a window blur ends it with no action", () => {
    press(ICON_A);
    window.dispatchEvent(new Event("blur"));
    expect(isPivotChromePressActive()).toBe(false);
    release(ICON_A);
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });

  it("the next press replaces a press whose release was never heard", () => {
    press(ICON_A);
    press(ICON_B);
    release(ICON_A);
    expect(api.togglePivotHeaderAt, "the stale press on A acted").not.toHaveBeenCalled();
  });

  it("a secondary-button release WITH THE PRIMARY HELD does not end the press; the primary release does", () => {
    press(ICON_A);
    release(ICON_A, 2, 1);
    expect(isPivotChromePressActive()).toBe(true);
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
    release(ICON_A);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
  });

  it("the window listeners live only as long as the press", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      press(ICON_A);
      const bound = add.mock.calls.map((c) => String(c[0])).sort();
      expect(bound).toEqual(["blur", "keydown", "mousemove", "mouseup"]);
      release(ICON_A);
      const unbound = remove.mock.calls.map((c) => String(c[0])).sort();
      expect(unbound).toEqual(["blur", "keydown", "mousemove", "mouseup"]);
      // Each removal names the very handler that was bound.
      for (const [type, fn, opts] of add.mock.calls) {
        expect(remove.mock.calls.some((r) => r[0] === type && r[1] === fn && Boolean(r[2]) === Boolean(opts))).toBe(true);
      }
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

describe("the release over the same chrome where ANOTHER object covers the box acts on nothing", () => {
  it("covered there: no toggle (the question names the box's region and the release point); uncovered: the control toggles", () => {
    api.covered.mockImplementation((regionId, x, y) => regionId === REGION && x === ICON_A.x && y === ICON_A.y);
    press(ICON_A);
    release(ICON_A);
    expect(api.covered).toHaveBeenCalledWith(REGION, ICON_A.x, ICON_A.y);
    expect(api.togglePivotHeaderAt, "a release over an object covering the +/- toggled it").not.toHaveBeenCalled();
    vi.setSystemTime(now + 1000);
    press(ICON_A);
    release({ x: ICON_A.x + 1, y: ICON_A.y });
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
  });
});

describe("a MIDDLE press", () => {
  it("its release (the primary never held) ends the press, acting on nothing -- it does not wait for the pointer to move", () => {
    press(ICON_A);
    release(ICON_A, 1, 0);
    expect(isPivotChromePressActive(), "a middle click left the press (and its listeners) live").toBe(false);
    release(ICON_A);
    expect(api.togglePivotHeaderAt, "a later primary release acted on a press that had ended").not.toHaveBeenCalled();
  });
});

describe("the press holds Core's pointer over the box, and lets go on every end path", () => {
  const ends: Array<[string, () => void]> = [
    ["a release on the same chrome", () => release(ICON_A)],
    ["a release off it", () => release(OFF)],
    ["Escape", () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))],
    ["a window blur", () => window.dispatchEvent(new Event("blur"))],
    ["a move with the primary button up", () => move(ICON_A, 0)],
    ["a middle release", () => release(ICON_A, 1, 0)],
    ["cancelPivotChromePress (teardown)", () => cancelPivotChromePress()],
  ];
  for (const [name, end] of ends) {
    it(`held while pressed ('pointer': no grip, no handle answers under it); let go after ${name}`, () => {
      press(ICON_A);
      expect(contentGestureCursorFor(REGION), "the press does not hold Core's pointer").toBe("pointer");
      expect(isContentGestureHeld()).toBe(true);
      end();
      expect(contentGestureCursorFor(REGION), `the hold outlived ${name}`).toBeNull();
      expect(isContentGestureHeld()).toBe(false);
    });
  }

  it("the next press takes it over; a press with no region to name holds nothing", () => {
    press(ICON_A);
    press(ICON_B, "pivot-visual-other");
    expect(contentGestureCursorFor(REGION)).toBeNull();
    expect(contentGestureCursorFor("pivot-visual-other")).toBe("pointer");
    cancelPivotChromePress();
    beginPivotChromePress({ pivotId: "cp1", canvasX: ICON_A.x, canvasY: ICON_A.y, clientToCanvas: (x, y) => ({ x, y }) });
    expect(isPivotChromePressActive()).toBe(true);
    expect(isContentGestureHeld()).toBe(false);
  });
});
