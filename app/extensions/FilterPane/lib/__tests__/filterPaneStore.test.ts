//! FILENAME: app/extensions/FilterPane/lib/__tests__/filterPaneStore.test.ts
// PURPOSE: Tests for FilterPane store cache management and accessors.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockCreateRibbonFilter = vi.fn();
const mockDeleteRibbonFilter = vi.fn();
const mockUpdateRibbonFilter = vi.fn();
const mockUpdateRibbonFilterSelection = vi.fn();
const mockGetAllRibbonFilters = vi.fn();
const mockGetRibbonFilterItems = vi.fn();
const mockGetBiColumnValues = vi.fn();
const mockGetBiColumnAvailableValues = vi.fn();

vi.mock("../filterPaneApi", () => ({
  createRibbonFilter: (...args: unknown[]) => mockCreateRibbonFilter(...args),
  deleteRibbonFilter: (...args: unknown[]) => mockDeleteRibbonFilter(...args),
  updateRibbonFilter: (...args: unknown[]) => mockUpdateRibbonFilter(...args),
  updateRibbonFilterSelection: (...args: unknown[]) => mockUpdateRibbonFilterSelection(...args),
  getAllRibbonFilters: (...args: unknown[]) => mockGetAllRibbonFilters(...args),
  getRibbonFilterItems: (...args: unknown[]) => mockGetRibbonFilterItems(...args),
  getBiColumnValues: (...args: unknown[]) => mockGetBiColumnValues(...args),
  getBiColumnAvailableValues: (...args: unknown[]) => mockGetBiColumnAvailableValues(...args),
}));

const mockApplyRibbonFilter = vi.fn();
const mockClearRibbonFilter = vi.fn();

vi.mock("../filterPaneFilterBridge", () => ({
  applyRibbonFilter: (...args: unknown[]) => mockApplyRibbonFilter(...args),
  clearRibbonFilter: (...args: unknown[]) => mockClearRibbonFilter(...args),
}));

vi.mock("../filterPaneEvents", () => ({
  FilterPaneEvents: {
    FILTER_CREATED: "filterpane:filter-created",
    FILTER_DELETED: "filterpane:filter-deleted",
    FILTER_UPDATED: "filterpane:filter-updated",
    FILTER_SELECTION_CHANGED: "filterpane:filter-selection-changed",
    FILTERS_REFRESHED: "filterpane:filters-refreshed",
  },
}));

import type { RibbonFilter } from "../filterPaneTypes";
import {
  getAllFilters,
  getFilterById,
  getCachedItems,
  createFilterAsync,
  deleteFilterAsync,
  updateFilterAsync,
  updateFilterSelectionAsync,
  refreshFilterItems,
  refreshCache,
  clearCache,
} from "../filterPaneStore";

// ============================================================================
// Test Helpers
// ============================================================================

function makeFilter(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: 1,
    name: "Test Filter",
    sourceType: "table",
    cacheSourceId: 100,
    fieldName: "Category",
    fieldDataType: "text",
    connectionMode: "manual",
    connectedSources: [],
    connectedSheets: [],
    displayMode: "checklist",
    selectedItems: null,
    crossFilterTargets: [],
    crossFilterSlicerTargets: [],
    advancedFilter: null,
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: false,
    showSelectAll: true,
    singleSelect: false,
    order: 0,
    buttonColumns: 1,
    buttonRows: 1,
    ...overrides,
  };
}

// ============================================================================
// Accessors
// ============================================================================

describe("filterPaneStore accessors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("getAllFilters returns empty array initially", () => {
    expect(getAllFilters()).toEqual([]);
  });

  it("getFilterById returns undefined when cache is empty", () => {
    expect(getFilterById(1)).toBeUndefined();
  });

  it("getCachedItems returns undefined for unknown filter", () => {
    expect(getCachedItems(999)).toBeUndefined();
  });
});

// ============================================================================
// getAllFilters sorting
// ============================================================================

describe("getAllFilters sorting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("returns filters sorted by order", async () => {
    const filters = [
      makeFilter({ id: 1, name: "C", order: 2 }),
      makeFilter({ id: 2, name: "A", order: 0 }),
      makeFilter({ id: 3, name: "B", order: 1 }),
    ];
    mockGetAllRibbonFilters.mockResolvedValue(filters);
    await refreshCache();

    const result = getAllFilters();
    expect(result.map((f) => f.name)).toEqual(["A", "B", "C"]);
  });
});

// ============================================================================
// CRUD operations
// ============================================================================

describe("createFilterAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("creates filter and refreshes cache", async () => {
    const newFilter = makeFilter({ id: 5 });
    mockCreateRibbonFilter.mockResolvedValue(newFilter);
    mockGetAllRibbonFilters.mockResolvedValue([newFilter]);

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const result = await createFilterAsync({
      name: "Test",
      sourceType: "table",
      cacheSourceId: 100,
      fieldName: "Category",
    });

    expect(result).toEqual(newFilter);
    expect(mockCreateRibbonFilter).toHaveBeenCalled();
    expect(mockGetAllRibbonFilters).toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "filterpane:filter-created" }),
    );

    dispatchSpy.mockRestore();
  });

  it("returns null on error", async () => {
    mockCreateRibbonFilter.mockRejectedValue(new Error("fail"));

    const result = await createFilterAsync({
      name: "Test",
      sourceType: "table",
      cacheSourceId: 100,
      fieldName: "X",
    });

    expect(result).toBeNull();
  });
});

describe("deleteFilterAsync", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    // Seed cache with a filter
    mockGetAllRibbonFilters.mockResolvedValue([makeFilter({ id: 10 })]);
    await refreshCache();
    vi.clearAllMocks();
  });

  it("deletes filter, clears applied filter, and refreshes cache", async () => {
    mockDeleteRibbonFilter.mockResolvedValue(undefined);
    mockGetAllRibbonFilters.mockResolvedValue([]);
    mockClearRibbonFilter.mockResolvedValue(undefined);

    const result = await deleteFilterAsync(10);

    expect(result).toBe(true);
    expect(mockClearRibbonFilter).toHaveBeenCalled();
    expect(mockDeleteRibbonFilter).toHaveBeenCalledWith(10);
    expect(getAllFilters()).toEqual([]);
  });

  it("returns false on error", async () => {
    mockDeleteRibbonFilter.mockRejectedValue(new Error("fail"));
    mockClearRibbonFilter.mockResolvedValue(undefined);

    const result = await deleteFilterAsync(10);

    expect(result).toBe(false);
  });
});

describe("updateFilterAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("updates filter and refreshes cache", async () => {
    const updated = makeFilter({ id: 1, name: "Updated" });
    mockUpdateRibbonFilter.mockResolvedValue(updated);
    mockGetAllRibbonFilters.mockResolvedValue([updated]);

    const result = await updateFilterAsync(1, { name: "Updated" });

    expect(result).toEqual(updated);
    expect(mockUpdateRibbonFilter).toHaveBeenCalledWith(1, { name: "Updated" });
  });
});

// ============================================================================
// updateFilterSelectionAsync
// ============================================================================

describe("updateFilterSelectionAsync", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    mockGetAllRibbonFilters.mockResolvedValue([makeFilter({ id: 1 })]);
    await refreshCache();
    vi.clearAllMocks();
  });

  it("applies filter when items are selected", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync(1, ["Apple", "Banana"]);

    expect(mockUpdateRibbonFilterSelection).toHaveBeenCalledWith(1, ["Apple", "Banana"]);
    expect(mockApplyRibbonFilter).toHaveBeenCalled();
  });

  it("clears filter when selection is null (select all)", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockClearRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync(1, null);

    expect(mockClearRibbonFilter).toHaveBeenCalled();
    expect(mockApplyRibbonFilter).not.toHaveBeenCalled();
  });

  it("performs optimistic local update", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync(1, ["X"]);

    const filter = getFilterById(1);
    expect(filter?.selectedItems).toEqual(["X"]);
  });
});

// ============================================================================
// refreshFilterItems
// ============================================================================

describe("refreshFilterItems", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    mockGetAllRibbonFilters.mockResolvedValue([makeFilter({ id: 1 })]);
    await refreshCache();
    vi.clearAllMocks();
  });

  it("fetches items from backend for table source", async () => {
    const items = [
      { value: "A", selected: true, hasData: true },
      { value: "B", selected: false, hasData: true },
    ];
    mockGetRibbonFilterItems.mockResolvedValue(items);

    await refreshFilterItems(1);

    expect(getCachedItems(1)).toEqual(items);
  });
});

// ============================================================================
// refreshCache
// ============================================================================

describe("refreshCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("loads all filters from backend", async () => {
    const filters = [makeFilter({ id: 1 }), makeFilter({ id: 2 })];
    mockGetAllRibbonFilters.mockResolvedValue(filters);

    await refreshCache();

    expect(getAllFilters()).toHaveLength(2);
  });

  it("dispatches FILTERS_REFRESHED event", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([]);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await refreshCache();

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "filterpane:filters-refreshed" }),
    );
    dispatchSpy.mockRestore();
  });
});

// ============================================================================
// clearCache
// ============================================================================

describe("clearCache", () => {
  it("clears all cached data", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([makeFilter({ id: 1 })]);
    await refreshCache();
    mockGetRibbonFilterItems.mockResolvedValue([{ value: "X", selected: true, hasData: true }]);
    await refreshFilterItems(1);

    clearCache();

    expect(getAllFilters()).toEqual([]);
    expect(getCachedItems(1)).toBeUndefined();
  });
});
