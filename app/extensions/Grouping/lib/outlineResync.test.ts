//! FILENAME: app/extensions/Grouping/lib/outlineResync.test.ts
// PURPOSE: Cover the outline resync path — the thing that makes a backend
//          outline change visible at all, and the coalescing that keeps one
//          mutation costing one backend round-trip.
// CONTEXT: Two defects live here.
//
//          (1) A backend-only outline change changed 0 pixels. Only this store
//          pushes group-hidden rows/cols into grid state and sizes the outline
//          bar, and nothing told it to. AppEvents.OUTLINE_CHANGED (announced by
//          the IPC wrapper, so every route announces) now drives
//          resyncOutlineFromBackend.
//
//          (2) The recovery could not depend on the renderer, because
//          renderOutlineBar returns immediately while the bar is zero-sized.
//          Reset the state — as the sheet-change handler does — and the only
//          code that would re-fetch stops running. Sizing the bar from a
//          viewport-independent read is what restarts that loop.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCoalescedRefresh as actualCoalescedRefresh } from "../../../src/api/coalescedRefresh";

const outlineInfo = {
  rowSymbols: [],
  colSymbols: [],
  maxRowLevel: 0,
  maxColLevel: 0,
  settings: {
    summaryRowPosition: "belowRight",
    summaryColPosition: "belowRight",
    showOutlineSymbols: true,
    autoStyles: false,
  },
};

vi.mock("@api", () => ({
  groupRows: vi.fn(),
  ungroupRows: vi.fn(),
  groupColumns: vi.fn(),
  ungroupColumns: vi.fn(),
  collapseRowGroup: vi.fn(),
  expandRowGroup: vi.fn(),
  collapseColumnGroup: vi.fn(),
  expandColumnGroup: vi.fn(),
  showOutlineLevel: vi.fn(),
  getOutlineInfo: vi.fn(),
  getHiddenRowsByGroup: vi.fn(),
  getHiddenColsByGroup: vi.fn(),
  clearOutline: vi.fn(),
  setOutlineSettings: vi.fn(),
  setGroupHiddenRows: vi.fn((rows: number[]) => ({ type: "setGroupHiddenRows", rows })),
  setGroupHiddenCols: vi.fn((cols: number[]) => ({ type: "setGroupHiddenCols", cols })),
  updateConfig: vi.fn((cfg: Record<string, number>) => ({ type: "updateConfig", cfg })),
  dispatchGridAction: vi.fn(),
  requestOverlayRedraw: vi.fn(),
  // The coalescer under test is @api's own primitive — use the real one.
  createCoalescedRefresh: actualCoalescedRefresh,
}));

import {
  groupRows,
  getOutlineInfo,
  getHiddenRowsByGroup,
  getHiddenColsByGroup,
  dispatchGridAction,
} from "@api";
import {
  performGroupRows,
  resyncOutlineFromBackend,
  resetGroupingState,
  refreshOutlineState,
} from "./groupingStore";

const mockGroupRows = vi.mocked(groupRows);
const mockOutlineInfo = vi.mocked(getOutlineInfo);
const mockHiddenRows = vi.mocked(getHiddenRowsByGroup);
const mockHiddenCols = vi.mocked(getHiddenColsByGroup);
const mockDispatch = vi.mocked(dispatchGridAction);

const OK = { success: true, hiddenRowsChanged: [], hiddenColsChanged: [] } as never;

function infoWith(maxRowLevel: number, maxColLevel = 0) {
  return { ...outlineInfo, maxRowLevel, maxColLevel } as never;
}

/** Let queued microtasks run without resolving anything of our own. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.clearAllMocks();
  mockHiddenRows.mockResolvedValue([]);
  mockHiddenCols.mockResolvedValue([]);
  mockOutlineInfo.mockResolvedValue(infoWith(0));
  // Drain anything a previous test left chained, then start counting.
  await resyncOutlineFromBackend();
  vi.clearAllMocks();
  mockHiddenRows.mockResolvedValue([]);
  mockHiddenCols.mockResolvedValue([]);
  mockOutlineInfo.mockResolvedValue(infoWith(0));
});

describe("resyncOutlineFromBackend coalescing", () => {
  it("folds requests that have not started into one backend pass", async () => {
    const a = resyncOutlineFromBackend();
    const b = resyncOutlineFromBackend();
    const c = resyncOutlineFromBackend();
    expect(b).toBe(a);
    expect(c).toBe(a);
    await a;
    expect(mockOutlineInfo).toHaveBeenCalledTimes(1);
    expect(mockHiddenRows).toHaveBeenCalledTimes(1);
  });

  // A request arriving while a pass is RUNNING was caused by a LATER mutation,
  // so folding it in would answer with pre-mutation state. It gets its own pass.
  it("gives a request that arrives mid-pass its own pass, chained after", async () => {
    let releaseFirst: (v: unknown) => void = () => {};
    mockOutlineInfo.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = resolve; }) as never,
    );

    const first = resyncOutlineFromBackend();
    await tick();                       // first pass is now running
    const second = resyncOutlineFromBackend();
    expect(second).not.toBe(first);

    releaseFirst(infoWith(0));
    await first;
    await second;
    expect(mockOutlineInfo).toHaveBeenCalledTimes(2);
  });
});

describe("one mutation, one round-trip", () => {
  // The IPC wrapper announces OUTLINE_CHANGED, and the extension's listener
  // resyncs on it. The store ALSO resyncs, because the GroupingController
  // contract says the grid must agree with the backend before the operation
  // resolves. Both must land on the same pass.
  it("a grouping operation costs one resync even with the announcement listener attached", async () => {
    const onOutlineChanged = () => { void resyncOutlineFromBackend(); };
    window.addEventListener("app:outline-changed", onOutlineChanged);
    try {
      mockGroupRows.mockImplementation(async () => {
        // What the real wrapper does: announce, then answer.
        window.dispatchEvent(new CustomEvent("app:outline-changed"));
        return OK;
      });

      await performGroupRows(0, 4);
      await tick();

      expect(mockOutlineInfo).toHaveBeenCalledTimes(1);
      expect(mockHiddenRows).toHaveBeenCalledTimes(1);
      expect(mockHiddenCols).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("app:outline-changed", onOutlineChanged);
    }
  });

  it("a refused operation resyncs nothing", async () => {
    mockGroupRows.mockResolvedValue({
      success: false,
      error: "nope",
      hiddenRowsChanged: [],
      hiddenColsChanged: [],
    } as never);
    await performGroupRows(0, 4);
    expect(mockOutlineInfo).not.toHaveBeenCalled();
  });
});

describe("recovery after a reset", () => {
  // resetGroupingState zeroes the outline bar, and renderOutlineBar bails while
  // the bar is zero-sized — so before this, switching to a sheet that already
  // had groups (or opening a workbook with them) showed no outline for the rest
  // of the session.
  it("re-sizes the outline bar from the backend with no viewport rendered yet", async () => {
    resetGroupingState();
    mockDispatch.mockClear();
    mockOutlineInfo.mockResolvedValue(infoWith(2, 1));

    await resyncOutlineFromBackend();

    const configs = mockDispatch.mock.calls
      .map(([action]) => action as { type: string; cfg?: Record<string, number> })
      .filter((a) => a.type === "updateConfig")
      .map((a) => a.cfg!);

    // maxRowLevel 2 -> LEFT_PAD 4 + (2 + 1) * 16 = 52
    expect(configs.some((c) => c.outlineBarWidth === 52)).toBe(true);
    // maxColLevel 1 -> 4 + (1 + 1) * 16 = 36
    expect(configs.some((c) => c.outlineBarHeight === 36)).toBe(true);
  });

  // With no viewport the symbols were fetched for a probe range, so they must
  // not be adopted: leaving the cache empty is what makes the very next render
  // pass fetch the range actually on screen.
  it("does not adopt probe symbols as the render cache", async () => {
    resetGroupingState();
    mockOutlineInfo.mockResolvedValue(infoWith(2));
    await resyncOutlineFromBackend();

    mockOutlineInfo.mockClear();
    await refreshOutlineState({
      startRow: 100,
      startCol: 0,
      rowCount: 30,
      colCount: 10,
    } as never);
    expect(mockOutlineInfo).toHaveBeenCalledWith(100, 135, 0, 15);
  });
});
