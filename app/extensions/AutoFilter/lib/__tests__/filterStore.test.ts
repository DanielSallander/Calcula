//! FILENAME: app/extensions/AutoFilter/lib/__tests__/filterStore.test.ts
// PURPOSE: Tests for AutoFilter store state management and operations.

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
  getCurrentSelection,
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

// ============================================================================
// State Accessors
// ============================================================================

describe("filterStore state accessors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("returns initial state with no filter active", () => {
    const state = getFilterState();
    expect(state.autoFilterInfo).toBeNull();
    expect(state.isActive).toBe(false);
    expect(state.openDropdownCol).toBeNull();
  });

  it("isFilterActive returns false initially", () => {
    expect(isFilterActive()).toBe(false);
  });

  it("getAutoFilterInfo returns null initially", () => {
    expect(getAutoFilterInfo()).toBeNull();
  });

  it("getOpenDropdownCol returns null initially", () => {
    expect(getOpenDropdownCol()).toBeNull();
  });

  it("setOpenDropdownCol updates the open column", () => {
    setOpenDropdownCol(2);
    expect(getOpenDropdownCol()).toBe(2);
    setOpenDropdownCol(null);
    expect(getOpenDropdownCol()).toBeNull();
  });

  it("setCurrentSelection / getCurrentSelection round-trips", () => {
    expect(getCurrentSelection()).toBeNull();
    const sel = { startRow: 1, startCol: 0, endRow: 5, endCol: 3 };
    setCurrentSelection(sel);
    expect(getCurrentSelection()).toBe(sel);
    setCurrentSelection(null);
    expect(getCurrentSelection()).toBeNull();
  });
});

// ============================================================================
// toggleFilter
// ============================================================================

describe("toggleFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("creates a filter from detected data region when single cell selected", async () => {
    setCurrentSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 });
    mockDetectDataRegion.mockResolvedValue([0, 0, 10, 3]);
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());

    await toggleFilter();

    expect(mockDetectDataRegion).toHaveBeenCalledWith(2, 1);
    expect(mockApplyAutoFilter).toHaveBeenCalledWith(0, 0, 10, 3);
    expect(isFilterActive()).toBe(true);
    expect(getAutoFilterInfo()).not.toBeNull();
  });

  it("creates a filter from multi-cell selection directly", async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());

    await toggleFilter();

    expect(mockDetectDataRegion).not.toHaveBeenCalled();
    expect(mockApplyAutoFilter).toHaveBeenCalledWith(0, 0, 5, 2);
    expect(isFilterActive()).toBe(true);
  });

  it("removes filter when already active", async () => {
    // First activate
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());
    await toggleFilter();
    expect(isFilterActive()).toBe(true);

    // Now toggle off
    mockRemoveAutoFilter.mockResolvedValue(undefined);
    await toggleFilter();

    expect(mockRemoveAutoFilter).toHaveBeenCalled();
    expect(isFilterActive()).toBe(false);
    expect(getAutoFilterInfo()).toBeNull();
  });

  it("detects data region from row 0,0 when no selection", async () => {
    setCurrentSelection(null);
    mockDetectDataRegion.mockResolvedValue([0, 0, 20, 5]);
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());

    await toggleFilter();

    expect(mockDetectDataRegion).toHaveBeenCalledWith(0, 0);
    expect(mockApplyAutoFilter).toHaveBeenCalledWith(0, 0, 20, 5);
  });

  it("does nothing if no data region found and no selection", async () => {
    setCurrentSelection(null);
    mockDetectDataRegion.mockResolvedValue(null);

    await toggleFilter();

    expect(mockApplyAutoFilter).not.toHaveBeenCalled();
    expect(isFilterActive()).toBe(false);
  });

  it("handles row selection type by detecting data region", async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 10, type: "rows" });
    mockDetectDataRegion.mockResolvedValue([0, 0, 5, 4]);
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());

    await toggleFilter();

    expect(mockDetectDataRegion).toHaveBeenCalledWith(0, 0);
  });

  it("does not activate if applyAutoFilter fails", async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    mockApplyAutoFilter.mockResolvedValue({ success: false, autoFilter: null, hiddenRows: [] });

    await toggleFilter();

    expect(isFilterActive()).toBe(false);
  });

  it("emits FILTER_TOGGLED event on activation", async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());

    await toggleFilter();

    expect(mockEmitAppEvent).toHaveBeenCalledWith(
      expect.stringContaining("filter"),
      expect.objectContaining({ active: true }),
    );
  });
});

// ============================================================================
// Column filter operations
// ============================================================================

describe("applyColumnFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("updates state on successful column filter", async () => {
    const result = makeFilterResult({ hiddenRows: [2, 4, 6] });
    mockSetColumnFilterValues.mockResolvedValue(result);

    await applyColumnFilter(1, ["Apple", "Banana"], true);

    expect(mockSetColumnFilterValues).toHaveBeenCalledWith(1, ["Apple", "Banana"], true);
    expect(getAutoFilterInfo()).not.toBeNull();
  });

  it("does not update state on failure", async () => {
    mockSetColumnFilterValues.mockResolvedValue({ success: false, autoFilter: null, hiddenRows: [] });

    await applyColumnFilter(0, ["X"], false);

    expect(getAutoFilterInfo()).toBeNull();
  });
});

describe("clearColumnFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("clears criteria for a specific column", async () => {
    mockClearColumnCriteria.mockResolvedValue(makeFilterResult());

    await clearColumnFilter(2);

    expect(mockClearColumnCriteria).toHaveBeenCalledWith(2);
  });
});

describe("clearAllFilters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("clears all column criteria", async () => {
    mockClearAutoFilterCriteria.mockResolvedValue(makeFilterResult());

    await clearAllFilters();

    expect(mockClearAutoFilterCriteria).toHaveBeenCalled();
  });
});

describe("reapplyFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("refreshes filter results", async () => {
    mockReapplyAutoFilter.mockResolvedValue(makeFilterResult({ hiddenRows: [1, 3] }));

    await reapplyFilter();

    expect(mockReapplyAutoFilter).toHaveBeenCalled();
    expect(getAutoFilterInfo()).not.toBeNull();
  });
});

// ============================================================================
// refreshFilterState
// ============================================================================

describe("refreshFilterState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("restores active filter from backend", async () => {
    const info = makeAutoFilterInfo();
    mockGetAutoFilter.mockResolvedValue(info);
    mockGetHiddenRows.mockResolvedValue([2, 5]);

    await refreshFilterState();

    expect(isFilterActive()).toBe(true);
    expect(getAutoFilterInfo()).toEqual(info);
    expect(mockDispatchGridAction).toHaveBeenCalled();
  });

  it("clears state when backend has no filter", async () => {
    mockGetAutoFilter.mockResolvedValue(null);

    await refreshFilterState();

    expect(isFilterActive()).toBe(false);
    expect(getAutoFilterInfo()).toBeNull();
  });
});

// ============================================================================
// Sort operations
// ============================================================================

describe("sortByColumn", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    // Activate a filter first
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 10, endCol: 3 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());
    await toggleFilter();
    vi.clearAllMocks();
  });

  it("sorts by column ascending and reapplies filter", async () => {
    mockSortRangeByColumn.mockResolvedValue({ success: true });
    mockReapplyAutoFilter.mockResolvedValue(makeFilterResult());

    await sortByColumn(1, true);

    expect(mockSortRangeByColumn).toHaveBeenCalledWith(0, 0, 10, 3, 1, true, true);
    expect(mockReapplyAutoFilter).toHaveBeenCalled();
  });

  it("does nothing when no filter is active", async () => {
    resetState();

    await sortByColumn(1, true);

    expect(mockSortRangeByColumn).not.toHaveBeenCalled();
  });
});

describe("sortByColor", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 10, endCol: 3 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());
    await toggleFilter();
    vi.clearAllMocks();
  });

  it("sorts by cell color", async () => {
    mockSortRange.mockResolvedValue({ success: true });
    mockReapplyAutoFilter.mockResolvedValue(makeFilterResult());

    await sortByColor(2, "#ff0000", "cellColor");

    expect(mockSortRange).toHaveBeenCalledWith(
      0, 0, 10, 3,
      [{ key: 2, ascending: true, sortOn: "cellColor", color: "#ff0000" }],
      { hasHeaders: true },
    );
  });
});

// ============================================================================
// getUniqueColorsInColumn
// ============================================================================

describe("getUniqueColorsInColumn", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 10, endCol: 3 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());
    await toggleFilter();
    vi.clearAllMocks();
  });

  it("returns empty array when no filter active", async () => {
    resetState();
    const colors = await getUniqueColorsInColumn(1, "cellColor");
    expect(colors).toEqual([]);
  });

  it("collects unique background colors from column cells", async () => {
    mockGetViewportCells.mockResolvedValue([
      { row: 1, col: 1, styleIndex: 1, display: "A" },
      { row: 2, col: 1, styleIndex: 2, display: "B" },
      { row: 3, col: 1, styleIndex: 1, display: "C" },
    ]);
    mockGetStyle.mockImplementation((idx: number) => {
      if (idx === 1) return Promise.resolve({ backgroundColor: "#FF0000", textColor: "#000000" });
      if (idx === 2) return Promise.resolve({ backgroundColor: "#00FF00", textColor: "#000000" });
      return Promise.resolve({ backgroundColor: "transparent", textColor: "#000000" });
    });

    const colors = await getUniqueColorsInColumn(1, "cellColor");

    expect(colors).toContain("#ff0000");
    expect(colors).toContain("#00ff00");
    expect(colors).toHaveLength(2);
  });

  it("skips default style (index 0) for cellColor", async () => {
    mockGetViewportCells.mockResolvedValue([
      { row: 1, col: 1, styleIndex: 0, display: "A" },
    ]);

    const colors = await getUniqueColorsInColumn(1, "cellColor");

    expect(colors).toEqual([]);
    expect(mockGetStyle).not.toHaveBeenCalled();
  });
});

// ============================================================================
// applyExpressionFilter
// ============================================================================

describe("applyExpressionFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("applies custom filter expression", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult());

    await applyExpressionFilter(0, ">=100");

    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(0, ">=100");
  });

  it("trims whitespace from expression", async () => {
    mockSetColumnCustomFilter.mockResolvedValue(makeFilterResult());

    await applyExpressionFilter(0, "  <>done  ");

    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(0, "<>done");
  });

  it("does nothing for empty expression", async () => {
    await applyExpressionFilter(0, "   ");

    expect(mockSetColumnCustomFilter).not.toHaveBeenCalled();
  });
});

// ============================================================================
// resetState
// ============================================================================

describe("resetState", () => {
  it("clears all state back to initial", async () => {
    // Set up some state first
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    mockApplyAutoFilter.mockResolvedValue(makeFilterResult());
    await toggleFilter();
    setOpenDropdownCol(3);

    resetState();

    expect(isFilterActive()).toBe(false);
    expect(getAutoFilterInfo()).toBeNull();
    expect(getOpenDropdownCol()).toBeNull();
    expect(getCurrentSelection()).toBeNull();
    expect(mockRemoveGridRegionsByType).toHaveBeenCalledWith("autofilter");
  });
});
