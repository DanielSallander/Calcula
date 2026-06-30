//! FILENAME: app/extensions/AdvancedFilter/lib/__tests__/advancedFilterEngineDeep.test.ts
// PURPOSE: Tests for the Advanced Filter ORCHESTRATOR (executeAdvancedFilter /
//          clearAdvancedFilter) + the A1 range helpers.
// NOTE: Criteria parsing + row matching (operators, wildcards, AND/OR, unique,
//       numeric coercion) now run SERVER-SIDE in Rust and are covered by
//       autofilter.rs `mod advanced_filter_tests`. Here we mock `runAdvancedFilter`
//       and verify the orchestrator applies its result correctly (reflect hidden
//       rows for filterInPlace; copy headers + matched rows for copyToLocation;
//       propagate errors).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockGetViewportCells = vi.fn();
const mockUpdateCellsBatch = vi.fn();
const mockSetHiddenRows = vi.fn().mockImplementation((rows: number[]) => ({ type: "SET_HIDDEN_ROWS", payload: rows }));
const mockDispatchGridAction = vi.fn();
const mockEmitAppEvent = vi.fn();
const mockClearAdvancedFilterHiddenRows = vi.fn();
const mockRunAdvancedFilter = vi.fn();

vi.mock("@api", () => ({
  getViewportCells: (...args: unknown[]) => mockGetViewportCells(...args),
  updateCellsBatch: (...args: unknown[]) => mockUpdateCellsBatch(...args),
  setHiddenRows: (rows: number[]) => mockSetHiddenRows(rows),
  dispatchGridAction: (...args: unknown[]) => mockDispatchGridAction(...args),
  emitAppEvent: (...args: unknown[]) => mockEmitAppEvent(...args),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  indexToCol: (idx: number) => {
    let result = "";
    let n = idx;
    do {
      result = String.fromCharCode(65 + (n % 26)) + result;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return result;
  },
  colToIndex: (col: string) => {
    let result = 0;
    for (let i = 0; i < col.length; i++) {
      result = result * 26 + (col.charCodeAt(i) - 64);
    }
    return result - 1;
  },
  clearAdvancedFilterHiddenRows: (...args: unknown[]) => mockClearAdvancedFilterHiddenRows(...args),
  runAdvancedFilter: (...args: unknown[]) => mockRunAdvancedFilter(...args),
}));

import {
  parseRangeRef,
  formatRangeRef,
  formatCellRef,
  executeAdvancedFilter,
  clearAdvancedFilter,
} from "../advancedFilterEngine";

/** Build a mock cell data array from a 2D grid. */
function buildCellData(grid: string[][], startRow: number, startCol: number) {
  const cells: Array<{ row: number; col: number; display: string; styleIndex: number }> = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      cells.push({ row: startRow + r, col: startCol + c, display: grid[r][c], styleIndex: 0 });
    }
  }
  return cells;
}

// ============================================================================
// Range helpers (additional edge cases)
// ============================================================================

describe("parseRangeRef - additional", () => {
  it("parses triple-letter column (AAA1)", () => {
    const result = parseRangeRef("AAA1");
    expect(result).not.toBeNull();
    expect(result![1]).toBe(702);
  });

  it("parses large row numbers", () => {
    expect(parseRangeRef("A1:A1000000")).toEqual([0, 0, 999999, 0]);
  });

  it("returns null for range with only letters", () => {
    expect(parseRangeRef("ABC")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(parseRangeRef("A1:B2")).toEqual(parseRangeRef("a1:b2"));
  });
});

describe("formatRangeRef / formatCellRef - additional", () => {
  it("formats multi-letter column range", () => {
    expect(formatRangeRef(0, 26, 4, 27)).toBe("AA1:AB5");
  });

  it("formats single-row range", () => {
    expect(formatRangeRef(0, 0, 0, 5)).toBe("A1:F1");
  });

  it("formats column Z and AA", () => {
    expect(formatCellRef(0, 25)).toBe("Z1");
    expect(formatCellRef(0, 26)).toBe("AA1");
  });
});

// ============================================================================
// executeAdvancedFilter - orchestration (matching is server-side)
// ============================================================================

describe("executeAdvancedFilter - filterInPlace orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reflects the server-computed hidden rows in the grid view + emits refresh", async () => {
    mockRunAdvancedFilter.mockResolvedValue({
      success: true,
      matchCount: 2,
      affectedRows: 2,
      matchedRows: [1, 3],
      hiddenRows: [2, 4],
    });

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 4, 2],
      criteriaRange: [10, 0, 11, 1],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result).toEqual({ success: true, matchCount: 2, affectedRows: 2 });
    // Backend already stored the hidden set; orchestrator forwards the SAME params.
    expect(mockRunAdvancedFilter).toHaveBeenCalledWith({
      listRange: [0, 0, 4, 2],
      criteriaRange: [10, 0, 11, 1],
      action: "filterInPlace",
      copyTo: undefined,
      uniqueRecordsOnly: false,
    });
    // Grid view reflects the hidden rows.
    expect(mockSetHiddenRows).toHaveBeenCalledWith([2, 4]);
    expect(mockDispatchGridAction).toHaveBeenCalled();
    expect(mockEmitAppEvent).toHaveBeenCalledWith("app:grid-refresh");
  });

  it("propagates a backend failure (e.g. no headers) without touching the grid", async () => {
    mockRunAdvancedFilter.mockResolvedValue({
      success: false,
      matchCount: 0,
      affectedRows: 0,
      matchedRows: [],
      hiddenRows: [],
      error: "No headers found in list range.",
    });

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 0, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "filterInPlace",
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("No headers found in list range.");
    expect(mockSetHiddenRows).not.toHaveBeenCalled();
    expect(mockEmitAppEvent).not.toHaveBeenCalled();
  });
});

describe("executeAdvancedFilter - copyToLocation orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUpdateCellsBatch.mockResolvedValue(undefined);
  });

  it("copies headers + matched rows (by absolute index) to the destination", async () => {
    // Matched rows 1 (Alice) and 3 (Charlie) per the backend.
    mockRunAdvancedFilter.mockResolvedValue({
      success: true,
      matchCount: 2,
      affectedRows: 2,
      matchedRows: [1, 3],
      hiddenRows: [],
    });
    mockGetViewportCells.mockResolvedValue(
      buildCellData(
        [
          ["Name", "Score"],
          ["Alice", "90"],
          ["Bob", "40"],
          ["Charlie", "80"],
        ],
        0,
        0,
      ),
    );

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 3, 1],
      criteriaRange: [10, 0, 11, 0],
      action: "copyToLocation",
      copyTo: [20, 0],
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(2);

    const batchCall = mockUpdateCellsBatch.mock.calls[0][0];
    // Headers.
    expect(batchCall).toContainEqual({ row: 20, col: 0, value: "Name" });
    expect(batchCall).toContainEqual({ row: 20, col: 1, value: "Score" });
    // Alice (source row 1) -> dest row 21.
    expect(batchCall).toContainEqual({ row: 21, col: 0, value: "Alice" });
    expect(batchCall).toContainEqual({ row: 21, col: 1, value: "90" });
    // Charlie (source row 3) -> dest row 22.
    expect(batchCall).toContainEqual({ row: 22, col: 0, value: "Charlie" });
    expect(batchCall).toContainEqual({ row: 22, col: 1, value: "80" });
  });

  it("propagates the backend error when copyToLocation has no copyTo", async () => {
    mockRunAdvancedFilter.mockResolvedValue({
      success: false,
      matchCount: 0,
      affectedRows: 0,
      matchedRows: [],
      hiddenRows: [],
      error: "Invalid action or missing copy-to location.",
    });

    const result = await executeAdvancedFilter({
      listRange: [0, 0, 1, 0],
      criteriaRange: [10, 0, 11, 0],
      action: "copyToLocation",
      uniqueRecordsOnly: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockUpdateCellsBatch).not.toHaveBeenCalled();
  });
});

// ============================================================================
// clearAdvancedFilter
// ============================================================================

describe("clearAdvancedFilter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("clears hidden rows and emits refresh event", () => {
    clearAdvancedFilter();
    expect(mockSetHiddenRows).toHaveBeenCalledWith([]);
    expect(mockDispatchGridAction).toHaveBeenCalled();
    expect(mockClearAdvancedFilterHiddenRows).toHaveBeenCalled();
    expect(mockEmitAppEvent).toHaveBeenCalledWith("app:grid-refresh");
  });
});
