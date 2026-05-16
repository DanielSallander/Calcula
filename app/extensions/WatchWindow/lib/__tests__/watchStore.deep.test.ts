//! FILENAME: app/extensions/WatchWindow/lib/__tests__/watchStore.deep.test.ts
// PURPOSE: Deep tests for WatchWindow store - scale, edge cases, persistence.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @api
vi.mock("@api", () => ({
  getWatchCells: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({ sheets: [] })),
  columnToLetter: (col: number) => {
    let result = "";
    let c = col;
    while (c >= 0) {
      result = String.fromCharCode(65 + (c % 26)) + result;
      c = Math.floor(c / 26) - 1;
    }
    return result;
  },
}));

import { getWatchCells, getSheets } from "@api";
import {
  addWatch,
  removeWatch,
  removeAllWatches,
  getItems,
  subscribe,
  formatCellRef,
  refreshWatches,
  reset,
} from "../watchStore";

const mockGetWatchCells = getWatchCells as ReturnType<typeof vi.fn>;
const mockGetSheets = getSheets as ReturnType<typeof vi.fn>;

beforeEach(() => {
  reset();
  vi.clearAllMocks();
  mockGetWatchCells.mockResolvedValue([]);
  mockGetSheets.mockResolvedValue({ sheets: [] });
});

// ============================================================================
// Watch cells across 10+ sheets simultaneously
// ============================================================================

describe("watch cells across many sheets", () => {
  it("supports watches on 15 different sheets", () => {
    for (let i = 0; i < 15; i++) {
      addWatch(i, `Sheet${i + 1}`, 0, 0);
    }
    expect(getItems()).toHaveLength(15);

    const sheetIndices = new Set(getItems().map((w) => w.sheetIndex));
    expect(sheetIndices.size).toBe(15);
  });

  it("refreshes all watches across sheets in a single call", async () => {
    for (let i = 0; i < 10; i++) {
      addWatch(i, `Sheet${i + 1}`, 0, 0);
    }

    const sheets = Array.from({ length: 10 }, (_, i) => ({ name: `Sheet${i + 1}` }));
    mockGetSheets.mockResolvedValueOnce({ sheets });
    mockGetWatchCells.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({ display: `val${i}`, formula: null })),
    );

    await refreshWatches();

    const items = getItems();
    for (let i = 0; i < 10; i++) {
      expect(items[i].value).toBe(`val${i}`);
    }
  });
});

// ============================================================================
// Watch cell that gets deleted/moved (null result from backend)
// ============================================================================

describe("watch cell that gets deleted or returns null", () => {
  it("sets value to empty string when backend returns null for a cell", async () => {
    addWatch(0, "Sheet1", 5, 5);
    addWatch(0, "Sheet1", 6, 6);

    mockGetSheets.mockResolvedValueOnce({ sheets: [{ name: "Sheet1" }] });
    mockGetWatchCells.mockResolvedValueOnce([
      null, // cell was deleted
      { display: "exists", formula: null },
    ]);

    await refreshWatches();

    expect(getItems()[0].value).toBe("");
    expect(getItems()[0].formula).toBeNull();
    expect(getItems()[1].value).toBe("exists");
  });

  it("handles all cells returning null (sheet deleted)", async () => {
    addWatch(0, "Sheet1", 0, 0);
    addWatch(0, "Sheet1", 1, 1);

    mockGetSheets.mockResolvedValueOnce({ sheets: [] });
    mockGetWatchCells.mockResolvedValueOnce([null, null]);

    await refreshWatches();

    // Items still exist but values are empty
    expect(getItems()).toHaveLength(2);
    expect(getItems()[0].value).toBe("");
    expect(getItems()[1].value).toBe("");
  });
});

// ============================================================================
// Watch cell with rapidly changing values (100 refreshes)
// ============================================================================

describe("rapid value changes", () => {
  it("handles 100 sequential refreshes correctly", async () => {
    addWatch(0, "Sheet1", 0, 0);

    for (let i = 0; i < 100; i++) {
      mockGetSheets.mockResolvedValueOnce({ sheets: [{ name: "Sheet1" }] });
      mockGetWatchCells.mockResolvedValueOnce([
        { display: `v${i}`, formula: `=A1+${i}` },
      ]);
      await refreshWatches();
    }

    expect(getItems()[0].value).toBe("v99");
    expect(getItems()[0].formula).toBe("=A1+99");
  });

  it("only notifies listeners when values actually change", async () => {
    addWatch(0, "Sheet1", 0, 0);

    // First refresh to set initial value
    mockGetSheets.mockResolvedValueOnce({ sheets: [{ name: "Sheet1" }] });
    mockGetWatchCells.mockResolvedValueOnce([{ display: "42", formula: null }]);
    await refreshWatches();

    const listener = vi.fn();
    subscribe(listener);

    // Refresh with same value -- should NOT notify
    mockGetSheets.mockResolvedValueOnce({ sheets: [{ name: "Sheet1" }] });
    mockGetWatchCells.mockResolvedValueOnce([{ display: "42", formula: null }]);
    await refreshWatches();

    expect(listener).not.toHaveBeenCalled();

    // Refresh with different value -- should notify
    mockGetSheets.mockResolvedValueOnce({ sheets: [{ name: "Sheet1" }] });
    mockGetWatchCells.mockResolvedValueOnce([{ display: "43", formula: null }]);
    await refreshWatches();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Watch window with 50+ watches
// ============================================================================

describe("scale: 50+ watches", () => {
  it("adds and tracks 60 watches", () => {
    for (let i = 0; i < 60; i++) {
      addWatch(i % 5, `Sheet${(i % 5) + 1}`, Math.floor(i / 5), i % 20);
    }
    expect(getItems()).toHaveLength(60);
  });

  it("removes individual watches from a large set", () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const item = addWatch(0, "Sheet1", i, 0);
      ids.push(item.id);
    }
    expect(getItems()).toHaveLength(50);

    // Remove every other watch
    for (let i = 0; i < 50; i += 2) {
      removeWatch(ids[i]);
    }
    expect(getItems()).toHaveLength(25);
  });

  it("removeAllWatches clears a large set", () => {
    for (let i = 0; i < 100; i++) {
      addWatch(i % 10, `Sheet${(i % 10) + 1}`, Math.floor(i / 10), 0);
    }
    expect(getItems()).toHaveLength(100);

    removeAllWatches();
    expect(getItems()).toHaveLength(0);
  });
});

// ============================================================================
// Duplicate watch prevention across sessions
// ============================================================================

describe("duplicate watch prevention", () => {
  it("prevents adding same cell twice even with different name", () => {
    addWatch(0, "Sheet1", 5, 5, "RangeA");
    addWatch(0, "Sheet1", 5, 5, "RangeB");
    expect(getItems()).toHaveLength(1);
    // First one wins
    expect(getItems()[0].name).toBe("RangeA");
  });

  it("prevents duplicate after remove and re-add (fresh ID)", () => {
    const first = addWatch(0, "Sheet1", 3, 3);
    const firstId = first.id;
    removeWatch(firstId);

    const second = addWatch(0, "Sheet1", 3, 3);
    expect(second.id).not.toBe(firstId);
    expect(getItems()).toHaveLength(1);
  });

  it("allows same row/col on different sheets (no false duplicate)", () => {
    addWatch(0, "Sheet1", 0, 0);
    addWatch(1, "Sheet2", 0, 0);
    addWatch(2, "Sheet3", 0, 0);
    expect(getItems()).toHaveLength(3);
  });
});

// ============================================================================
// formatCellRef for edge columns (XFD) and max rows
// ============================================================================

describe("formatCellRef edge cases", () => {
  it("formats column Z (index 25)", () => {
    expect(formatCellRef("Sheet1", 0, 25)).toBe("Sheet1!Z1");
  });

  it("formats column AA (index 26)", () => {
    expect(formatCellRef("Sheet1", 0, 26)).toBe("Sheet1!AA1");
  });

  it("formats column AZ (index 51)", () => {
    expect(formatCellRef("Sheet1", 0, 51)).toBe("Sheet1!AZ1");
  });

  it("formats column XFD (index 16383) - Excel max column", () => {
    expect(formatCellRef("Sheet1", 0, 16383)).toBe("Sheet1!XFD1");
  });

  it("formats max row 1048576 (index 1048575)", () => {
    expect(formatCellRef("Sheet1", 1048575, 0)).toBe("Sheet1!A1048576");
  });

  it("formats XFD1048576 - absolute max cell", () => {
    expect(formatCellRef("Sheet1", 1048575, 16383)).toBe("Sheet1!XFD1048576");
  });

  it("formats column A (index 0)", () => {
    expect(formatCellRef("S", 0, 0)).toBe("S!A1");
  });

  it("handles sheet name with spaces", () => {
    expect(formatCellRef("My Sheet", 0, 0)).toBe("My Sheet!A1");
  });
});

// ============================================================================
// Refresh error handling
// ============================================================================

describe("refresh error handling", () => {
  it("keeps existing values when getWatchCells fails", async () => {
    addWatch(0, "Sheet1", 0, 0);

    mockGetSheets.mockResolvedValueOnce({ sheets: [{ name: "Sheet1" }] });
    mockGetWatchCells.mockResolvedValueOnce([{ display: "100", formula: null }]);
    await refreshWatches();
    expect(getItems()[0].value).toBe("100");

    // Next refresh fails
    mockGetSheets.mockResolvedValueOnce({ sheets: [{ name: "Sheet1" }] });
    mockGetWatchCells.mockRejectedValueOnce(new Error("backend down"));
    await refreshWatches();

    // Value should remain from last successful refresh
    expect(getItems()[0].value).toBe("100");
  });

  it("keeps existing sheet names when getSheets fails", async () => {
    addWatch(0, "Sheet1", 0, 0);

    mockGetSheets.mockRejectedValueOnce(new Error("fail"));
    mockGetWatchCells.mockResolvedValueOnce([{ display: "val", formula: null }]);
    await refreshWatches();

    expect(getItems()[0].sheetName).toBe("Sheet1");
    expect(getItems()[0].value).toBe("val");
  });
});

// ============================================================================
// Listener error isolation
// ============================================================================

describe("listener error isolation", () => {
  it("one failing listener does not prevent others from firing", () => {
    const good1 = vi.fn();
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good2 = vi.fn();

    subscribe(good1);
    subscribe(bad);
    subscribe(good2);

    addWatch(0, "Sheet1", 0, 0);

    expect(good1).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good2).toHaveBeenCalledTimes(1);
  });
});
