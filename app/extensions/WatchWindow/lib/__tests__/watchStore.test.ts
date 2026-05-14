//! FILENAME: app/extensions/WatchWindow/lib/__tests__/watchStore.test.ts
// PURPOSE: Tests for WatchWindow store - CRUD, subscriptions, dedup, formatting.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @api
vi.mock("@api", () => ({
  getWatchCells: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({ sheets: [] })),
  columnToLetter: (col: number) => {
    // Simple A-Z conversion for test purposes
    let result = "";
    let c = col;
    while (c >= 0) {
      result = String.fromCharCode(65 + (c % 26)) + result;
      c = Math.floor(c / 26) - 1;
    }
    return result;
  },
}));

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

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  reset();
});

// ============================================================================
// addWatch Tests
// ============================================================================

describe("addWatch", () => {
  it("adds a new watch item", () => {
    const item = addWatch(0, "Sheet1", 2, 3);
    expect(item.sheetIndex).toBe(0);
    expect(item.sheetName).toBe("Sheet1");
    expect(item.row).toBe(2);
    expect(item.col).toBe(3);
    expect(item.id).toMatch(/^watch-/);
    expect(item.value).toBe("");
    expect(item.formula).toBeNull();
  });

  it("assigns unique IDs to each watch", () => {
    const a = addWatch(0, "Sheet1", 0, 0);
    const b = addWatch(0, "Sheet1", 1, 0);
    expect(a.id).not.toBe(b.id);
  });

  it("prevents duplicate watches on the same cell", () => {
    const first = addWatch(0, "Sheet1", 5, 5);
    const duplicate = addWatch(0, "Sheet1", 5, 5);
    expect(duplicate).toBe(first);
    expect(getItems()).toHaveLength(1);
  });

  it("allows same row/col on different sheets", () => {
    addWatch(0, "Sheet1", 0, 0);
    addWatch(1, "Sheet2", 0, 0);
    expect(getItems()).toHaveLength(2);
  });

  it("stores optional name parameter", () => {
    const item = addWatch(0, "Sheet1", 0, 0, "MyRange");
    expect(item.name).toBe("MyRange");
  });

  it("defaults name to null when not provided", () => {
    const item = addWatch(0, "Sheet1", 1, 1);
    expect(item.name).toBeNull();
  });
});

// ============================================================================
// removeWatch Tests
// ============================================================================

describe("removeWatch", () => {
  it("removes a watch by ID", () => {
    const item = addWatch(0, "Sheet1", 0, 0);
    removeWatch(item.id);
    expect(getItems()).toHaveLength(0);
  });

  it("does nothing for a non-existent ID", () => {
    addWatch(0, "Sheet1", 0, 0);
    removeWatch("watch-nonexistent");
    expect(getItems()).toHaveLength(1);
  });

  it("only removes the targeted watch", () => {
    const a = addWatch(0, "Sheet1", 0, 0);
    addWatch(0, "Sheet1", 1, 1);
    removeWatch(a.id);
    expect(getItems()).toHaveLength(1);
    expect(getItems()[0].row).toBe(1);
  });
});

// ============================================================================
// removeAllWatches Tests
// ============================================================================

describe("removeAllWatches", () => {
  it("clears all watches", () => {
    addWatch(0, "Sheet1", 0, 0);
    addWatch(0, "Sheet1", 1, 1);
    addWatch(1, "Sheet2", 2, 2);
    removeAllWatches();
    expect(getItems()).toHaveLength(0);
  });

  it("does nothing when already empty", () => {
    removeAllWatches();
    expect(getItems()).toHaveLength(0);
  });
});

// ============================================================================
// subscribe Tests
// ============================================================================

describe("subscribe", () => {
  it("calls listener on addWatch", () => {
    const listener = vi.fn();
    subscribe(listener);
    addWatch(0, "Sheet1", 0, 0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("calls listener on removeWatch", () => {
    const item = addWatch(0, "Sheet1", 0, 0);
    const listener = vi.fn();
    subscribe(listener);
    removeWatch(item.id);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("calls listener on removeAllWatches", () => {
    addWatch(0, "Sheet1", 0, 0);
    const listener = vi.fn();
    subscribe(listener);
    removeAllWatches();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("returns an unsubscribe function", () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    unsub();
    addWatch(0, "Sheet1", 0, 0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple listeners", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribe(a);
    subscribe(b);
    addWatch(0, "Sheet1", 0, 0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// formatCellRef Tests
// ============================================================================

describe("formatCellRef", () => {
  it("formats a simple cell reference", () => {
    expect(formatCellRef("Sheet1", 0, 0)).toBe("Sheet1!A1");
  });

  it("converts 0-based row to 1-based display", () => {
    expect(formatCellRef("Data", 9, 0)).toBe("Data!A10");
  });

  it("handles multi-letter columns", () => {
    // col 26 = AA
    expect(formatCellRef("Sheet1", 0, 26)).toBe("Sheet1!AA1");
  });
});

// ============================================================================
// refreshWatches Tests
// ============================================================================

describe("refreshWatches", () => {
  it("does nothing when no watches exist", async () => {
    const { getWatchCells } = await import("@api");
    await refreshWatches();
    expect(getWatchCells).not.toHaveBeenCalled();
  });

  it("updates watch values from backend results", async () => {
    const { getWatchCells, getSheets } = await import("@api");
    const mockGetWatchCells = getWatchCells as ReturnType<typeof vi.fn>;
    const mockGetSheets = getSheets as ReturnType<typeof vi.fn>;

    mockGetSheets.mockResolvedValueOnce({ sheets: [{ name: "Sheet1" }] });
    mockGetWatchCells.mockResolvedValueOnce([
      { display: "42", formula: "SUM(A1:A10)" },
    ]);

    addWatch(0, "Sheet1", 0, 0);
    await refreshWatches();

    const items = getItems();
    expect(items[0].value).toBe("42");
    expect(items[0].formula).toBe("SUM(A1:A10)");
  });

  it("updates sheet names if sheets were renamed", async () => {
    const { getWatchCells, getSheets } = await import("@api");
    const mockGetWatchCells = getWatchCells as ReturnType<typeof vi.fn>;
    const mockGetSheets = getSheets as ReturnType<typeof vi.fn>;

    addWatch(0, "OldName", 0, 0);

    mockGetSheets.mockResolvedValueOnce({ sheets: [{ name: "NewName" }] });
    mockGetWatchCells.mockResolvedValueOnce([{ display: "hello", formula: null }]);

    await refreshWatches();
    expect(getItems()[0].sheetName).toBe("NewName");
  });
});

// ============================================================================
// reset Tests
// ============================================================================

describe("reset", () => {
  it("clears all items and listeners", () => {
    const listener = vi.fn();
    subscribe(listener);
    addWatch(0, "Sheet1", 0, 0);
    listener.mockClear();

    reset();
    expect(getItems()).toHaveLength(0);

    // Listener should have been cleared by reset, so adding a watch
    // after reset should not trigger the old listener
    addWatch(0, "Sheet1", 0, 0);
    expect(listener).not.toHaveBeenCalled();
  });
});
