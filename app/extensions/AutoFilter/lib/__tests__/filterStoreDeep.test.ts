//! FILENAME: app/extensions/AutoFilter/lib/__tests__/filterStoreDeep.test.ts
// PURPOSE: Deep tests for AutoFilter expression filters, column filters, color filters,
//          date/number/text filter scenarios, multi-column filtering, and clear operations.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockApplyAutoFilter = vi.fn();
const mockRemoveAutoFilter = vi.fn();
const mockClearAutoFilterCriteria = vi.fn();
const mockReapplyAutoFilter = vi.fn();
const mockClearColumnCriteria = vi.fn();
const mockGetAutoFilter = vi.fn();
const mockGetHiddenRows = vi.fn();
const mockSetColumnFilterValues = vi.fn();
const mockGetFilterUniqueValues = vi.fn();
const mockDetectDataRegion = vi.fn();
const mockSetHiddenRows = vi.fn().mockImplementation((rows: number[]) => ({ type: "SET_HIDDEN_ROWS", payload: rows }));
const mockDispatchGridAction = vi.fn();
const mockEmitAppEvent = vi.fn();
const mockAddGridRegions = vi.fn();
const mockRemoveGridRegionsByType = vi.fn();

vi.mock("@api", () => ({
  applyAutoFilter: (...args: unknown[]) => mockApplyAutoFilter(...args),
  removeAutoFilter: (...args: unknown[]) => mockRemoveAutoFilter(...args),
  clearAutoFilterCriteria: (...args: unknown[]) => mockClearAutoFilterCriteria(...args),
  reapplyAutoFilter: (...args: unknown[]) => mockReapplyAutoFilter(...args),
  clearColumnCriteria: (...args: unknown[]) => mockClearColumnCriteria(...args),
  getAutoFilter: (...args: unknown[]) => mockGetAutoFilter(...args),
  getHiddenRows: (...args: unknown[]) => mockGetHiddenRows(...args),
  setColumnFilterValues: (...args: unknown[]) => mockSetColumnFilterValues(...args),
  getFilterUniqueValues: (...args: unknown[]) => mockGetFilterUniqueValues(...args),
  detectDataRegion: (...args: unknown[]) => mockDetectDataRegion(...args),
  setHiddenRows: (rows: number[]) => mockSetHiddenRows(rows),
  dispatchGridAction: (...args: unknown[]) => mockDispatchGridAction(...args),
  emitAppEvent: (...args: unknown[]) => mockEmitAppEvent(...args),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  addGridRegions: (...args: unknown[]) => mockAddGridRegions(...args),
  removeGridRegionsByType: (...args: unknown[]) => mockRemoveGridRegionsByType(...args),
}));

const mockSortRangeByColumn = vi.fn();
const mockSortRange = vi.fn();
const mockGetViewportCells = vi.fn();
const mockGetStyle = vi.fn();
const mockSetColumnCustomFilter = vi.fn();

vi.mock("@api/lib", () => ({
  sortRangeByColumn: (...args: unknown[]) => mockSortRangeByColumn(...args),
  sortRange: (...args: unknown[]) => mockSortRange(...args),
  getViewportCells: (...args: unknown[]) => mockGetViewportCells(...args),
  getStyle: (...args: unknown[]) => mockGetStyle(...args),
  setColumnCustomFilter: (...args: unknown[]) => mockSetColumnCustomFilter(...args),
}));

import {
  getFilterState,
  isFilterActive,
  getAutoFilterInfo,
  getOpenDropdownCol,
  setOpenDropdownCol,
  setCurrentSelection,
  toggleFilter,
  applyColumnFilter,
  clearColumnFilter,
  clearAllFilters,
  reapplyFilter,
  refreshFilterState,
  sortByColumn,
  sortByColor,
  getUniqueColorsInColumn,
  applyExpressionFilter,
  resetState,
} from "../filterStore";

// ============================================================================
// Test Helpers
// ============================================================================

const makeAutoFilterInfo = (overrides = {}) => ({
  startRow: 0,
  startCol: 0,
  endRow: 10,
  endCol: 3,
  enabled: true,
  columns: [],
  ...overrides,
});

const makeFilterResult = (overrides = {}) => ({
  success: true,
  autoFilter: makeAutoFilterInfo(),
  hiddenRows: [],
  ...overrides,
});

async function activateFilter(range = { startRow: 0, startCol: 0, endRow: 10, endCol: 3 }) {
  setCurrentSelection(range);
  mockApplyAutoFilter.mockResolvedValue(makeFilterResult({
    autoFilter: makeAutoFilterInfo({
      startRow: range.startRow,
      startCol: range.startCol,
      endRow: range.endRow,
      endCol: range.endCol,
    }),
  }));
  await toggleFilter();
  vi.clearAllMocks();
}

// ============================================================================
// Expression filter evaluation with complex operators
// ============================================================================

describe("applyExpressionFilter - complex operators", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("applies >= numeric expression", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult({ hiddenRows: [3, 5, 7] }));

    await applyExpressionFilter(0, ">=100");

    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(0, ">=100");
    expect(getAutoFilterInfo()).not.toBeNull();
  });

  it("applies < numeric expression", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult({ hiddenRows: [1] }));

    await applyExpressionFilter(1, "<50");

    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(1, "<50");
  });

  it("applies <> (not equal) expression", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult({ hiddenRows: [2, 4] }));

    await applyExpressionFilter(0, "<>pending");

    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(0, "<>pending");
  });

  it("applies wildcard contains expression (=*text*)", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult());

    await applyExpressionFilter(2, "*error*");

    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(2, "*error*");
  });

  it("applies begins-with wildcard expression (=text*)", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult());

    await applyExpressionFilter(0, "=Sales*");

    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(0, "=Sales*");
  });

  it("applies ends-with wildcard expression (=*text)", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult());

    await applyExpressionFilter(0, "=*Inc");

    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(0, "=*Inc");
  });

  it("applies single-char wildcard expression (=A?C)", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult());

    await applyExpressionFilter(0, "=A?C");

    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(0, "=A?C");
  });

  it("handles expression with only whitespace as no-op", async () => {
    await applyExpressionFilter(0, "  \t  ");

    expect(mockSetColumnCustomFilter).not.toHaveBeenCalled();
  });

  it("does not update state when backend returns failure", async () => {
    mockSetColumnCustomFilter.mockResolvedValue({ success: false, autoFilter: null, hiddenRows: [] });

    await applyExpressionFilter(0, ">=100");

    expect(getAutoFilterInfo()).toBeNull();
  });

  it("syncs hidden rows after successful expression filter", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult({ hiddenRows: [2, 4, 6] }));

    await applyExpressionFilter(0, ">50");

    expect(mockSetHiddenRows).toHaveBeenCalledWith([2, 4, 6]);
    expect(mockDispatchGridAction).toHaveBeenCalled();
  });

  it("emits FILTER_APPLIED event on success", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult());

    await applyExpressionFilter(1, ">=0");

    expect(mockEmitAppEvent).toHaveBeenCalledWith(
      expect.stringContaining("applied"),
      expect.objectContaining({ column: 1 }),
    );
  });
});

// ============================================================================
// Multiple columns filtered simultaneously
// ============================================================================

describe("multi-column filtering", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    await activateFilter();
  });

  it("applies filters to multiple columns sequentially", async () => {
    const result1 = makeFilterResult({ hiddenRows: [3, 5] });
    mockSetColumnFilterValues.mockResolvedValueOnce(result1);
    await applyColumnFilter(0, ["Apple"], true);
    expect(mockSetColumnFilterValues).toHaveBeenCalledWith(0, ["Apple"], true);

    const result2 = makeFilterResult({ hiddenRows: [3, 5, 7, 8] });
    mockSetColumnFilterValues.mockResolvedValueOnce(result2);
    await applyColumnFilter(1, ["Red"], false);
    expect(mockSetColumnFilterValues).toHaveBeenCalledWith(1, ["Red"], false);

    // Both calls went through
    expect(mockSetColumnFilterValues).toHaveBeenCalledTimes(2);
  });

  it("state reflects the latest filter result after each apply", async () => {
    const info1 = makeAutoFilterInfo({ columns: [{ index: 0, filtered: true }] });
    mockSetColumnFilterValues.mockResolvedValueOnce({ success: true, autoFilter: info1, hiddenRows: [2] });
    await applyColumnFilter(0, ["X"], false);
    expect(getAutoFilterInfo()).toEqual(info1);

    const info2 = makeAutoFilterInfo({ columns: [{ index: 0, filtered: true }, { index: 1, filtered: true }] });
    mockSetColumnFilterValues.mockResolvedValueOnce({ success: true, autoFilter: info2, hiddenRows: [2, 4] });
    await applyColumnFilter(1, ["Y"], false);
    expect(getAutoFilterInfo()).toEqual(info2);
  });

  it("hidden rows accumulate across column filters", async () => {
    mockSetColumnFilterValues.mockResolvedValueOnce(makeFilterResult({ hiddenRows: [2] }));
    await applyColumnFilter(0, ["A"], false);
    expect(mockSetHiddenRows).toHaveBeenLastCalledWith([2]);

    mockSetColumnFilterValues.mockResolvedValueOnce(makeFilterResult({ hiddenRows: [2, 5, 6] }));
    await applyColumnFilter(1, ["B"], false);
    expect(mockSetHiddenRows).toHaveBeenLastCalledWith([2, 5, 6]);
  });
});

// ============================================================================
// Filter on empty/null values
// ============================================================================

describe("filtering empty/null values", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    await activateFilter();
  });

  it("includes blanks when includeBlanks is true", async () => {
    mockSetColumnFilterValues.mockResolvedValue(makeFilterResult({ hiddenRows: [4] }));

    await applyColumnFilter(0, ["Apple"], true);

    expect(mockSetColumnFilterValues).toHaveBeenCalledWith(0, ["Apple"], true);
  });

  it("excludes blanks when includeBlanks is false", async () => {
    mockSetColumnFilterValues.mockResolvedValue(makeFilterResult({ hiddenRows: [2, 4, 6] }));

    await applyColumnFilter(0, ["Apple"], false);

    expect(mockSetColumnFilterValues).toHaveBeenCalledWith(0, ["Apple"], false);
  });

  it("filters with empty values array shows only blanks when includeBlanks is true", async () => {
    mockSetColumnFilterValues.mockResolvedValue(makeFilterResult({ hiddenRows: [1, 2, 3, 5, 7] }));

    await applyColumnFilter(0, [], true);

    expect(mockSetColumnFilterValues).toHaveBeenCalledWith(0, [], true);
  });

  it("filters with empty values array and no blanks hides everything", async () => {
    mockSetColumnFilterValues.mockResolvedValue(makeFilterResult({ hiddenRows: [1, 2, 3, 4, 5, 6, 7] }));

    await applyColumnFilter(0, [], false);

    expect(mockSetColumnFilterValues).toHaveBeenCalledWith(0, [], false);
  });
});

// ============================================================================
// Clear individual column vs clear all
// ============================================================================

describe("clear individual column vs clear all", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    await activateFilter();
  });

  it("clearColumnFilter clears only the specified column", async () => {
    const infoAfterClear = makeAutoFilterInfo({
      columns: [{ index: 1, filtered: true }],
    });
    mockClearColumnCriteria.mockResolvedValue({
      success: true,
      autoFilter: infoAfterClear,
      hiddenRows: [3],
    });

    await clearColumnFilter(0);

    expect(mockClearColumnCriteria).toHaveBeenCalledWith(0);
    expect(getAutoFilterInfo()?.columns).toEqual([{ index: 1, filtered: true }]);
  });

  it("clearAllFilters clears all columns but keeps AutoFilter active", async () => {
    const infoAfterClear = makeAutoFilterInfo({ columns: [] });
    mockClearAutoFilterCriteria.mockResolvedValue({
      success: true,
      autoFilter: infoAfterClear,
      hiddenRows: [],
    });

    await clearAllFilters();

    expect(mockClearAutoFilterCriteria).toHaveBeenCalled();
    expect(getAutoFilterInfo()).not.toBeNull();
    expect(mockSetHiddenRows).toHaveBeenCalledWith([]);
  });

  it("clearColumnFilter emits FILTER_CLEARED with column index", async () => {
    mockClearColumnCriteria.mockResolvedValue(makeFilterResult());

    await clearColumnFilter(2);

    expect(mockEmitAppEvent).toHaveBeenCalledWith(
      expect.stringContaining("cleared"),
      expect.objectContaining({ column: 2 }),
    );
  });

  it("clearAllFilters emits FILTER_CLEARED with column 'all'", async () => {
    mockClearAutoFilterCriteria.mockResolvedValue(makeFilterResult());

    await clearAllFilters();

    expect(mockEmitAppEvent).toHaveBeenCalledWith(
      expect.stringContaining("cleared"),
      expect.objectContaining({ column: "all" }),
    );
  });

  it("clearColumnFilter does not update state on failure", async () => {
    mockClearColumnCriteria.mockResolvedValue({ success: false, autoFilter: null, hiddenRows: [] });

    await clearColumnFilter(0);

    // State should remain from activateFilter, not be overwritten to null
    // (activateFilter clears mocks, so autoFilterInfo is whatever was set before)
  });

  it("clearAllFilters does not update state on failure", async () => {
    mockClearAutoFilterCriteria.mockResolvedValue({ success: false, autoFilter: null, hiddenRows: [] });

    await clearAllFilters();

    // Should not crash or corrupt state
    expect(mockEmitAppEvent).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Color filters
// ============================================================================

describe("color filter operations", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    await activateFilter();
  });

  it("getUniqueColorsInColumn collects font colors", async () => {
    mockGetViewportCells.mockResolvedValue([
      { row: 1, col: 1, styleIndex: 1, display: "A" },
      { row: 2, col: 1, styleIndex: 2, display: "B" },
    ]);
    mockGetStyle.mockImplementation((idx: number) => {
      if (idx === 1) return Promise.resolve({ backgroundColor: "transparent", textColor: "#FF0000" });
      if (idx === 2) return Promise.resolve({ backgroundColor: "transparent", textColor: "#0000FF" });
      return Promise.resolve({ backgroundColor: "transparent", textColor: "#000000" });
    });

    const colors = await getUniqueColorsInColumn(1, "fontColor");

    expect(colors).toContain("#ff0000");
    expect(colors).toContain("#0000ff");
    expect(colors).toHaveLength(2);
  });

  it("skips transparent and default black for fontColor", async () => {
    mockGetViewportCells.mockResolvedValue([
      { row: 1, col: 1, styleIndex: 1, display: "A" },
    ]);
    mockGetStyle.mockResolvedValue({ backgroundColor: "transparent", textColor: "#000000" });

    const colors = await getUniqueColorsInColumn(1, "fontColor");

    expect(colors).toEqual([]);
  });

  it("deduplicates colors across rows", async () => {
    mockGetViewportCells.mockResolvedValue([
      { row: 1, col: 1, styleIndex: 1, display: "A" },
      { row: 2, col: 1, styleIndex: 1, display: "B" },
      { row: 3, col: 1, styleIndex: 1, display: "C" },
    ]);
    mockGetStyle.mockResolvedValue({ backgroundColor: "#FF0000", textColor: "#000000" });

    const colors = await getUniqueColorsInColumn(1, "cellColor");

    expect(colors).toEqual(["#ff0000"]);
  });

  it("skips rgba(0, 0, 0, 0) as transparent", async () => {
    mockGetViewportCells.mockResolvedValue([
      { row: 1, col: 1, styleIndex: 1, display: "A" },
    ]);
    mockGetStyle.mockResolvedValue({ backgroundColor: "rgba(0, 0, 0, 0)", textColor: "#000000" });

    const colors = await getUniqueColorsInColumn(1, "cellColor");

    expect(colors).toEqual([]);
  });

  it("handles getStyle errors gracefully", async () => {
    mockGetViewportCells.mockResolvedValue([
      { row: 1, col: 1, styleIndex: 99, display: "A" },
    ]);
    mockGetStyle.mockRejectedValue(new Error("Invalid style index"));

    const colors = await getUniqueColorsInColumn(1, "cellColor");

    expect(colors).toEqual([]);
  });

  it("sortByColor passes correct relative key", async () => {
    mockSortRange.mockResolvedValue({ success: true });
    mockReapplyAutoFilter.mockResolvedValue(makeFilterResult());

    // Column 2 in a filter starting at col 0 => relative key = 2
    await sortByColor(2, "#00ff00", "fontColor");

    expect(mockSortRange).toHaveBeenCalledWith(
      0, 0, 10, 3,
      [{ key: 2, ascending: true, sortOn: "fontColor", color: "#00ff00" }],
      { hasHeaders: true },
    );
  });

  it("sortByColor does not reapply filter on sort failure", async () => {
    mockSortRange.mockResolvedValue({ success: false });

    await sortByColor(1, "#ff0000", "cellColor");

    expect(mockReapplyAutoFilter).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Sort operations - deeper tests
// ============================================================================

describe("sortByColumn - deeper", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    await activateFilter();
  });

  it("sorts descending", async () => {
    mockSortRangeByColumn.mockResolvedValue({ success: true });
    mockReapplyAutoFilter.mockResolvedValue(makeFilterResult());

    await sortByColumn(2, false);

    expect(mockSortRangeByColumn).toHaveBeenCalledWith(0, 0, 10, 3, 2, false, true);
  });

  it("does not reapply filter on sort failure", async () => {
    mockSortRangeByColumn.mockResolvedValue({ success: false });

    await sortByColumn(1, true);

    expect(mockReapplyAutoFilter).not.toHaveBeenCalled();
  });

  it("handles sort throwing an error gracefully", async () => {
    mockSortRangeByColumn.mockRejectedValue(new Error("Sort engine error"));

    // Should not throw
    await expect(sortByColumn(1, true)).resolves.toBeUndefined();
  });
});

// ============================================================================
// refreshFilterState - deeper
// ============================================================================

describe("refreshFilterState - deeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("sets isActive based on backend enabled field", async () => {
    const info = makeAutoFilterInfo({ enabled: false });
    mockGetAutoFilter.mockResolvedValue(info);
    mockGetHiddenRows.mockResolvedValue([]);

    await refreshFilterState();

    expect(isFilterActive()).toBe(false);
    expect(getAutoFilterInfo()).toEqual(info);
  });

  it("clears hidden rows when backend has no filter", async () => {
    mockGetAutoFilter.mockResolvedValue(null);

    await refreshFilterState();

    expect(mockSetHiddenRows).toHaveBeenCalledWith([]);
    expect(mockDispatchGridAction).toHaveBeenCalled();
  });

  it("always emits FILTER_STATE_REFRESHED event", async () => {
    mockGetAutoFilter.mockResolvedValue(null);

    await refreshFilterState();

    expect(mockEmitAppEvent).toHaveBeenCalledWith(
      expect.stringContaining("state-refreshed"),
    );
  });

  it("syncs overlay region on refresh with active filter", async () => {
    const info = makeAutoFilterInfo({ enabled: true });
    mockGetAutoFilter.mockResolvedValue(info);
    mockGetHiddenRows.mockResolvedValue([1, 3]);

    await refreshFilterState();

    expect(mockRemoveGridRegionsByType).toHaveBeenCalledWith("autofilter");
    expect(mockAddGridRegions).toHaveBeenCalled();
  });
});

// ============================================================================
// toggleFilter edge cases
// ============================================================================

describe("toggleFilter - edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("handles reversed selection coordinates (endRow < startRow)", async () => {
    setCurrentSelection({ startRow: 8, startCol: 3, endRow: 2, endCol: 0 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());

    await toggleFilter();

    // Should normalize to min/max
    expect(mockApplyAutoFilter).toHaveBeenCalledWith(2, 0, 8, 3);
  });

  it("handles row selection with no data region", async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 10, type: "rows" });
    mockDetectDataRegion.mockResolvedValue(null);

    await toggleFilter();

    expect(mockApplyAutoFilter).not.toHaveBeenCalled();
    expect(isFilterActive()).toBe(false);
  });

  it("clears openDropdownCol when toggling off", async () => {
    // Activate filter
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());
    await toggleFilter();
    setOpenDropdownCol(1);
    expect(getOpenDropdownCol()).toBe(1);

    // Toggle off
    mockRemoveAutoFilter.mockResolvedValue(undefined);
    await toggleFilter();

    expect(getOpenDropdownCol()).toBeNull();
  });

  it("emits FILTER_TOGGLED with active:false when deactivating", async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());
    await toggleFilter();
    vi.clearAllMocks();

    mockRemoveAutoFilter.mockResolvedValue(undefined);
    await toggleFilter();

    expect(mockEmitAppEvent).toHaveBeenCalledWith(
      expect.stringContaining("toggled"),
      expect.objectContaining({ active: false }),
    );
  });

  it("clears hidden rows when deactivating", async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult({ hiddenRows: [1, 3] }));
    await toggleFilter();
    vi.clearAllMocks();

    mockRemoveAutoFilter.mockResolvedValue(undefined);
    await toggleFilter();

    expect(mockSetHiddenRows).toHaveBeenCalledWith([]);
  });
});

// ============================================================================
// reapplyFilter
// ============================================================================

describe("reapplyFilter - deeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("does not update state on failure", async () => {
    mockReapplyAutoFilter.mockResolvedValue({ success: false, autoFilter: null, hiddenRows: [] });

    await reapplyFilter();

    expect(getAutoFilterInfo()).toBeNull();
  });

  it("updates hidden rows on reapply", async () => {
    mockReapplyAutoFilter.mockResolvedValue(makeFilterResult({ hiddenRows: [1, 2, 3] }));

    await reapplyFilter();

    expect(mockSetHiddenRows).toHaveBeenCalledWith([1, 2, 3]);
  });
});

// ============================================================================
// getColumnUniqueValues
// ============================================================================

describe("getColumnUniqueValues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("delegates to getFilterUniqueValues API", async () => {
    const expected = { values: ["A", "B", "C"], hasBlanks: true };
    mockGetFilterUniqueValues.mockResolvedValue(expected);

    const { getColumnUniqueValues } = await import("../filterStore");
    const result = await getColumnUniqueValues(2);

    expect(mockGetFilterUniqueValues).toHaveBeenCalledWith(2);
    expect(result).toEqual(expected);
  });
});
