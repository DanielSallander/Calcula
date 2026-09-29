//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frScroll.test.ts
// PURPOSE: The floating range's session scroll (M7) and what it hangs off:
//          - the scroll is an id-keyed SIDE MAP: it survives the store's
//            rebuilds (loadFloatingRangesFromBackend, upsertFromInfo -- a move
//            or a resize comes back as one), and is cleared by
//            removeFloatingRange and resetFloatingRangeStore (the File > New /
//            Open and deactivate path); toInfo never carries it;
//          - the content extent = min(cap, max(window, used range + 1)), read
//            through the EXISTING get_used_range on the backing sheet's index;
//            a stale extent stays in force until the re-read lands;
//          - the wheel target: no answer before the extent is known, overflow
//            scrolls and clamps, and a range with NO overflow lets the wheel
//            through to the page (through the real shared helper);
//          - ensureFrCellVisible brings a row past the window into view.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

const listed: { infos: FloatingRangeInfo[] } = { infos: [] };

vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => listed.infos),
  updateFloatingRange: vi.fn(async () => ({})),
  getFloatingRangeCells: vi.fn(async () => []),
}));

const getUsedRange = vi.fn();
vi.mock("@api/lib", () => ({
  getUsedRange: (...args: unknown[]) => getUsedRange(...args),
}));

// The shared wheel helper reads the grid geometry; a worksheet with 50x24
// headings, unscrolled, zoom 1.
vi.mock("@api/grid", async () => {
  const header = await vi.importActual<typeof import("../../../../src/core/lib/gridRenderer/layout/headerVisibility")>(
    "../../../../src/core/lib/gridRenderer/layout/headerVisibility",
  );
  return {
    getGridStateSnapshot: () => ({
      surface: "grid",
      displayHeadings: true,
      zoom: 1,
      config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
      viewport: { scrollX: 0, scrollY: 0 },
    }),
    resolveHeaderSizes: header.resolveHeaderSizes,
  };
});

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  getFrScroll,
  setFrScroll,
  pruneFrScrolls,
  frScrollCount,
  resetFrScrolls,
} from "../frScroll";
import {
  upsertFromInfo,
  loadFloatingRangesFromBackend,
  removeFloatingRange,
  resetFloatingRangeStore,
  getFloatingRangeById,
  toInfo,
  FLOATING_RANGE_REGION_TYPE,
} from "../floatingRangeStore";
import {
  frContentExtent,
  ensureFrExtent,
  isFrExtentKnown,
  recordFrUsedExtent,
  invalidateFrExtent,
  resetFrExtents,
} from "../frExtent";
import { getFrView, commitFrViewClamp, ensureFrCellVisible, createFrWheelTarget } from "../frView";
import { FR_DEFAULT_ROW_H, frameWidth, frameHeight, contentWidth, contentHeight } from "../frDimensions";
import { registerObjectWheelTarget, handleObjectWheel } from "../../../_shared/lib/objectWheelScroll";

function info(id: string, overrides: Partial<FloatingRangeInfo> = {}): FloatingRangeInfo {
  return {
    id,
    backingSheetId: `backing-${id}`,
    hostSheetId: "host",
    x: 100,
    y: 50,
    rotation: 0,
    pinToGrid: false,
    rowCount: 4,
    colCount: 3,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 7,
    hostSheetIndex: 0,
    ...overrides,
  } as FloatingRangeInfo;
}

/** Let pending promise continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  resetFloatingRangeStore();
  resetFrExtents();
  resetFrScrolls();
  getUsedRange.mockReset();
  listed.infos = [];
});

afterEach(() => {
  resetFloatingRangeStore();
  resetFrExtents();
  vi.restoreAllMocks();
});

// ============================================================================
// The side map's lifetime
// ============================================================================

describe("the scroll is a side map, not a field on the entry", () => {
  it("survives the store REBUILDING its entries from the backend", async () => {
    upsertFromInfo(info("a"));
    setFrScroll("a", 0, 60);
    const before = getFloatingRangeById("a");

    listed.infos = [info("a", { x: 300 })]; // e.g. a move came back as FLOATING_RANGES_CHANGED
    await loadFloatingRangesFromBackend();

    expect(getFloatingRangeById("a")).not.toBe(before); // the entry really was rebuilt
    expect(getFrScroll("a")).toEqual({ left: 0, top: 60 });
  });

  it("survives upsertFromInfo (a resize / rename replaces the entry)", () => {
    upsertFromInfo(info("a"));
    setFrScroll("a", 10, 40);
    upsertFromInfo(info("a", { rowCount: 2 }));
    expect(getFrScroll("a")).toEqual({ left: 10, top: 40 });
  });

  it("is cleared by removeFloatingRange, for that id only", () => {
    upsertFromInfo(info("a"));
    upsertFromInfo(info("b"));
    setFrScroll("a", 0, 20);
    setFrScroll("b", 0, 40);
    removeFloatingRange("a");
    expect(getFrScroll("a")).toEqual({ left: 0, top: 0 });
    expect(getFrScroll("b")).toEqual({ left: 0, top: 40 });
  });

  it("is cleared by resetFloatingRangeStore (File > New / Open, deactivate)", () => {
    upsertFromInfo(info("a"));
    setFrScroll("a", 5, 20);
    resetFloatingRangeStore();
    expect(frScrollCount()).toBe(0);
  });

  it("is pruned for ids a reload no longer lists, kept for the rest", () => {
    setFrScroll("a", 0, 20);
    setFrScroll("gone", 0, 40);
    pruneFrScrolls(new Set(["a"]));
    expect(getFrScroll("a").top).toBe(20);
    expect(getFrScroll("gone").top).toBe(0);
  });

  it("never travels in toInfo (the wire / persisted shape)", () => {
    const e = upsertFromInfo(info("a"));
    setFrScroll("a", 12, 80);
    const wire = toInfo(e);
    expect(Object.keys(wire).sort()).toEqual(Object.keys(info("a")).sort());
    expect(JSON.stringify(wire)).not.toMatch(/scroll/i);
  });

  it("forgets an unscrolled range instead of storing zeros", () => {
    setFrScroll("a", 0, 20);
    setFrScroll("a", 0, 0);
    expect(frScrollCount()).toBe(0);
  });
});

// ============================================================================
// Content extent
// ============================================================================

describe("the content extent", () => {
  it("is the window until the used range is known", () => {
    const e = upsertFromInfo(info("a"));
    expect(isFrExtentKnown("a")).toBe(false);
    expect(frContentExtent(e)).toEqual({ rows: 4, cols: 3 });
  });

  it("reads get_used_range on the BACKING sheet's index and grows to used + 1", async () => {
    const e = upsertFromInfo(info("a"));
    getUsedRange.mockResolvedValueOnce({ startRow: 0, startCol: 0, endRow: 11, endCol: 1, empty: false });
    ensureFrExtent(e);
    await flush();
    expect(getUsedRange).toHaveBeenCalledWith(7);
    // Rows grow to 12; columns stay at the window's 3 (used is only 2 wide).
    expect(frContentExtent(e)).toEqual({ rows: 12, cols: 3 });
  });

  it("is capped at the backend's window bounds", () => {
    const e = upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 5000, 900);
    expect(frContentExtent(e)).toEqual({ rows: 1000, cols: 256 });
  });

  it("an empty backing sheet leaves the window", async () => {
    const e = upsertFromInfo(info("a"));
    getUsedRange.mockResolvedValueOnce({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true });
    ensureFrExtent(e);
    await flush();
    expect(isFrExtentKnown("a")).toBe(true);
    expect(frContentExtent(e)).toEqual({ rows: 4, cols: 3 });
  });

  it("keeps a STALE extent in force until the re-read lands", async () => {
    const e = upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 20, 3);
    invalidateFrExtent("a");
    let land!: (v: unknown) => void;
    getUsedRange.mockReturnValueOnce(new Promise((res) => (land = res)));
    ensureFrExtent(e);
    expect(frContentExtent(e).rows).toBe(20); // no collapse to the window meanwhile
    land({ startRow: 0, startCol: 0, endRow: 29, endCol: 0, empty: false });
    await flush();
    expect(frContentExtent(e).rows).toBe(30);
  });

  it("does not re-read a fresh extent on every paint", async () => {
    const e = upsertFromInfo(info("a"));
    getUsedRange.mockResolvedValue({ startRow: 0, startCol: 0, endRow: 9, endCol: 2, empty: false });
    ensureFrExtent(e);
    await flush();
    ensureFrExtent(e);
    ensureFrExtent(e);
    expect(getUsedRange).toHaveBeenCalledTimes(1);
  });

  it("a failed read degrades to the window, warns ONCE and does not retry every paint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = upsertFromInfo(info("a"));
    getUsedRange.mockRejectedValue(new Error("sheet index out of range: 7"));
    ensureFrExtent(e);
    await flush();
    ensureFrExtent(e);
    await flush();
    expect(getUsedRange).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(frContentExtent(e)).toEqual({ rows: 4, cols: 3 });
  });
});

// ============================================================================
// The live view
// ============================================================================

describe("getFrView / commitFrViewClamp", () => {
  it("clamps the stored scroll into the extent without rewriting it", () => {
    const e = upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 10, 3); // 6 rows past the window = 120px
    setFrScroll("a", 0, 5000);
    expect(getFrView(e)).toEqual({ scrollLeft: 0, scrollTop: 6 * FR_DEFAULT_ROW_H, rows: 10, cols: 3 });
    expect(getFrScroll("a").top).toBe(5000);
  });

  it("writes the clamp back once the extent is known -- not before", () => {
    const e = upsertFromInfo(info("a"));
    setFrScroll("a", 0, 100); // e.g. kept across a sheet switch; extent not read yet
    commitFrViewClamp(e, getFrView(e));
    expect(getFrScroll("a").top).toBe(100);

    recordFrUsedExtent("a", 7, 3); // 3 rows past the window = 60px
    commitFrViewClamp(e, getFrView(e));
    expect(getFrScroll("a").top).toBe(60);
  });

  it("a window resize keeps the scroll and re-clamps it against the new max", () => {
    upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 10, 3);
    setFrScroll("a", 0, 100);
    const grown = upsertFromInfo(info("a", { rowCount: 8 })); // 2 rows past the window now
    expect(getFrView(grown).scrollTop).toBe(2 * FR_DEFAULT_ROW_H);
  });
});

describe("ensureFrCellVisible", () => {
  it("scrolls a row past the window into view, by the minimum", () => {
    const e = upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 20, 3);
    expect(ensureFrCellVisible(e, 5, 0)).toBe(true);
    expect(getFrScroll("a")).toEqual({ left: 0, top: 2 * FR_DEFAULT_ROW_H });
  });

  it("does nothing for a cell already in view", () => {
    const e = upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 20, 3);
    expect(ensureFrCellVisible(e, 3, 2)).toBe(false);
    expect(frScrollCount()).toBe(0);
  });
});

// ============================================================================
// The wheel target, through the real shared helper
// ============================================================================

describe("the wheel", () => {
  let area: HTMLElement;
  let cleanup: (() => void) | null = null;

  function region(id: string): GridRegion {
    const e = getFloatingRangeById(id)!;
    return {
      id: `fr-${id}`,
      type: FLOATING_RANGE_REGION_TYPE,
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: e.x, y: e.y, width: frameWidth(e), height: frameHeight(e) },
      data: { frId: id },
    };
  }

  /** A wheel over the middle of the frame (grid area at client 0,0; 50x24 headings). */
  function wheelOver(id: string, init: WheelEventInit): WheelEvent {
    const e = getFloatingRangeById(id)!;
    const ev = new WheelEvent("wheel", {
      clientX: 50 + e.x + frameWidth(e) / 2,
      clientY: 24 + e.y + frameHeight(e) / 2,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    Object.defineProperty(ev, "target", { value: area });
    return ev;
  }

  beforeEach(() => {
    area = document.createElement("div");
    area.setAttribute("data-grid-area", "");
    area.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 2000, height: 2000, right: 2000, bottom: 2000, x: 0, y: 0, toJSON() {} }) as DOMRect;
    document.body.appendChild(area);
    cleanup = registerObjectWheelTarget(createFrWheelTarget());
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    area.remove();
    setGridRegions([]);
  });

  it("answers nothing until the extent is known (not painted yet)", () => {
    upsertFromInfo(info("a"));
    expect(createFrWheelTarget().getScroll(region("a"))).toBeNull();
  });

  it("reports the overflow of the content past the window", () => {
    upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 24, 3);
    expect(createFrWheelTarget().getScroll(region("a"))).toEqual({
      left: 0,
      top: 0,
      maxLeft: 0,
      maxTop: 20 * FR_DEFAULT_ROW_H,
    });
  });

  it("a wheel over an overflowing range scrolls it (and is consumed)", () => {
    upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 24, 3);
    setGridRegions([region("a")]);
    const ev = wheelOver("a", { deltaY: 3, deltaMode: 1 }); // three lines
    expect(handleObjectWheel(ev)).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    expect(getFrScroll("a")).toEqual({ left: 0, top: 3 * FR_DEFAULT_ROW_H });
  });

  it("clamps at the end of the content and still consumes the wheel", () => {
    upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 6, 3); // 2 rows = 40px of overflow
    setGridRegions([region("a")]);
    const ev = wheelOver("a", { deltaY: 1000 });
    expect(handleObjectWheel(ev)).toBe(true);
    expect(getFrScroll("a").top).toBe(40);
  });

  // W16 (wave C; E10c): a PAGE-mode wheel (deltaMode 2) moved by the whole
  // frame -- title bar and column header included -- so one page skipped the
  // rows under the chrome. A page is the CELL AREA (the window's cells).
  it("a page-mode wheel moves by one page of CELLS, not by the frame with its chrome", () => {
    upsertFromInfo(info("a")); // a 4-row window of 20px rows = an 80px cell area
    recordFrUsedExtent("a", 40, 3);
    setGridRegions([region("a")]);
    const e = getFloatingRangeById("a")!;
    expect(frameHeight(e)).toBeGreaterThan(4 * FR_DEFAULT_ROW_H); // the chrome is real
    const ev = wheelOver("a", { deltaY: 1, deltaMode: 2 });
    expect(handleObjectWheel(ev)).toBe(true);
    expect(getFrScroll("a")).toEqual({ left: 0, top: 4 * FR_DEFAULT_ROW_H });
  });

  it("a horizontal page moves by the cell area's width (the row header is chrome)", () => {
    upsertFromInfo(info("a", { colWidths: {} })); // 3 columns
    recordFrUsedExtent("a", 4, 30);
    setGridRegions([region("a")]);
    const e = getFloatingRangeById("a")!;
    expect(contentWidth(e)).toBeLessThan(frameWidth(e)); // the row header is real
    const ev = wheelOver("a", { deltaX: 1, deltaMode: 2 });
    expect(handleObjectWheel(ev)).toBe(true);
    expect(getFrScroll("a").left).toBe(contentWidth(e));
  });

  // Review C: Shift turns a vertical wheel sideways -- and the helper scaled
  // the page BEFORE it turned it, so a Shift page moved sideways by the cell
  // area's HEIGHT (80px here) instead of one page across.
  it("a Shift page-mode wheel moves sideways by the cell area's WIDTH, not its height", () => {
    upsertFromInfo(info("a", { colWidths: {} })); // 3 columns, 4 rows
    recordFrUsedExtent("a", 4, 30);
    setGridRegions([region("a")]);
    const e = getFloatingRangeById("a")!;
    expect(contentWidth(e)).not.toBe(contentHeight(e)); // the two axes differ, or this proves nothing
    const ev = wheelOver("a", { deltaY: 1, deltaMode: 2, shiftKey: true });
    expect(handleObjectWheel(ev)).toBe(true);
    expect(getFrScroll("a")).toEqual({ left: contentWidth(e), top: 0 });
  });

  it("a range with NO overflow lets the wheel through to the page", () => {
    upsertFromInfo(info("a"));
    recordFrUsedExtent("a", 2, 2); // content fits the 4x3 window
    setGridRegions([region("a")]);
    const ev = wheelOver("a", { deltaY: 120 });
    expect(handleObjectWheel(ev)).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
    expect(frScrollCount()).toBe(0);
  });
});
