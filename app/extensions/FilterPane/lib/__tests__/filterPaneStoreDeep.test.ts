//! FILENAME: app/extensions/FilterPane/lib/__tests__/filterPaneStoreDeep.test.ts
// PURPOSE: Deep tests for FilterPane store: multiple active filters interaction,
//          filter ordering, cache invalidation, cross-filtering, BI filter items,
//          and concurrent operations.

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
  refreshAllItems,
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

async function seedFilters(filters: RibbonFilter[]) {
  mockGetAllRibbonFilters.mockResolvedValue(filters);
  await refreshCache();
  vi.clearAllMocks();
}

// ============================================================================
// Multiple active filters interaction
// ============================================================================

describe("multiple active filters interaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("maintains independent selections across multiple filters", async () => {
    const filters = [
      makeFilter({ id: 1, name: "Category", fieldName: "Category", order: 0 }),
      makeFilter({ id: 2, name: "Region", fieldName: "Region", order: 1 }),
      makeFilter({ id: 3, name: "Status", fieldName: "Status", order: 2 }),
    ];
    await seedFilters(filters);

    // Apply selection to filter 1
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    await updateFilterSelectionAsync(1, ["Electronics"]);

    expect(getFilterById(1)?.selectedItems).toEqual(["Electronics"]);
    expect(getFilterById(2)?.selectedItems).toBeNull();
    expect(getFilterById(3)?.selectedItems).toBeNull();
  });

  it("applies filter for each selection change independently", async () => {
    const filters = [
      makeFilter({ id: 1, name: "A", order: 0 }),
      makeFilter({ id: 2, name: "B", order: 1 }),
    ];
    await seedFilters(filters);

    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync(1, ["X"]);
    await updateFilterSelectionAsync(2, ["Y"]);

    expect(mockApplyRibbonFilter).toHaveBeenCalledTimes(2);
  });

  it("clearing one filter does not affect others", async () => {
    const filters = [
      makeFilter({ id: 1, name: "A", selectedItems: ["X"], order: 0 }),
      makeFilter({ id: 2, name: "B", selectedItems: ["Y"], order: 1 }),
    ];
    await seedFilters(filters);

    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockClearRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync(1, null); // clear filter 1

    expect(getFilterById(1)?.selectedItems).toBeNull();
    expect(getFilterById(2)?.selectedItems).toEqual(["Y"]);
    expect(mockClearRibbonFilter).toHaveBeenCalledTimes(1);
    expect(mockApplyRibbonFilter).not.toHaveBeenCalled();
  });

  it("deleting a filter clears it before removal", async () => {
    const filters = [
      makeFilter({ id: 1, name: "A", selectedItems: ["X"], order: 0 }),
      makeFilter({ id: 2, name: "B", selectedItems: ["Y"], order: 1 }),
    ];
    await seedFilters(filters);

    mockClearRibbonFilter.mockResolvedValue(undefined);
    mockDeleteRibbonFilter.mockResolvedValue(undefined);
    mockGetAllRibbonFilters.mockResolvedValue([filters[1]]);

    await deleteFilterAsync(1);

    expect(mockClearRibbonFilter).toHaveBeenCalled();
    expect(mockDeleteRibbonFilter).toHaveBeenCalledWith(1);
    expect(getAllFilters()).toHaveLength(1);
    expect(getFilterById(1)).toBeUndefined();
    expect(getFilterById(2)).toBeDefined();
  });
});

// ============================================================================
// Filter ordering effects
// ============================================================================

describe("filter ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("getAllFilters returns filters sorted by order field", async () => {
    const filters = [
      makeFilter({ id: 3, name: "Third", order: 2 }),
      makeFilter({ id: 1, name: "First", order: 0 }),
      makeFilter({ id: 2, name: "Second", order: 1 }),
    ];
    await seedFilters(filters);

    const result = getAllFilters();
    expect(result.map((f) => f.name)).toEqual(["First", "Second", "Third"]);
  });

  it("filters with same order are stable-ish (no guaranteed order)", async () => {
    const filters = [
      makeFilter({ id: 1, name: "A", order: 0 }),
      makeFilter({ id: 2, name: "B", order: 0 }),
    ];
    await seedFilters(filters);

    const result = getAllFilters();
    expect(result).toHaveLength(2);
    // Both exist, order among ties is implementation-defined
    expect(result.map((f) => f.id).sort()).toEqual([1, 2]);
  });

  it("updating order re-sorts on next getAllFilters call", async () => {
    const filters = [
      makeFilter({ id: 1, name: "A", order: 0 }),
      makeFilter({ id: 2, name: "B", order: 1 }),
    ];
    await seedFilters(filters);

    // Simulate backend returning updated order
    const updated = makeFilter({ id: 1, name: "A", order: 5 });
    mockUpdateRibbonFilter.mockResolvedValue(updated);
    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: 2, name: "B", order: 1 }),
      makeFilter({ id: 1, name: "A", order: 5 }),
    ]);

    await updateFilterAsync(1, { order: 5 });

    const result = getAllFilters();
    expect(result.map((f) => f.name)).toEqual(["B", "A"]);
  });
});

// ============================================================================
// Cache invalidation scenarios
// ============================================================================

describe("cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("refreshCache replaces entire filter list", async () => {
    await seedFilters([makeFilter({ id: 1, name: "Old" })]);
    expect(getAllFilters()).toHaveLength(1);

    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: 2, name: "New1" }),
      makeFilter({ id: 3, name: "New2" }),
    ]);
    await refreshCache();

    expect(getAllFilters()).toHaveLength(2);
    expect(getFilterById(1)).toBeUndefined();
    expect(getFilterById(2)).toBeDefined();
  });

  it("clearCache removes all filters and items", async () => {
    await seedFilters([makeFilter({ id: 1 })]);
    mockGetRibbonFilterItems.mockResolvedValue([
      { value: "A", selected: true, hasData: true },
    ]);
    await refreshFilterItems(1);

    expect(getAllFilters()).toHaveLength(1);
    expect(getCachedItems(1)).toBeDefined();

    clearCache();

    expect(getAllFilters()).toEqual([]);
    expect(getCachedItems(1)).toBeUndefined();
  });

  it("deleteFilterAsync removes items from cache", async () => {
    await seedFilters([makeFilter({ id: 5 })]);
    mockGetRibbonFilterItems.mockResolvedValue([
      { value: "X", selected: true, hasData: true },
    ]);
    await refreshFilterItems(5);
    expect(getCachedItems(5)).toBeDefined();

    mockClearRibbonFilter.mockResolvedValue(undefined);
    mockDeleteRibbonFilter.mockResolvedValue(undefined);
    mockGetAllRibbonFilters.mockResolvedValue([]);

    await deleteFilterAsync(5);

    expect(getCachedItems(5)).toBeUndefined();
  });

  it("createFilterAsync refreshes cache from backend", async () => {
    const newFilter = makeFilter({ id: 10 });
    mockCreateRibbonFilter.mockResolvedValue(newFilter);
    mockGetAllRibbonFilters.mockResolvedValue([newFilter]);

    await createFilterAsync({
      name: "New",
      sourceType: "table",
      cacheSourceId: 1,
      fieldName: "F",
    });

    expect(getAllFilters()).toHaveLength(1);
    expect(getFilterById(10)).toBeDefined();
  });

  it("refreshAllItems refreshes items for every cached filter", async () => {
    const filters = [
      makeFilter({ id: 1, name: "A" }),
      makeFilter({ id: 2, name: "B" }),
      makeFilter({ id: 3, name: "C" }),
    ];
    await seedFilters(filters);

    mockGetRibbonFilterItems
      .mockResolvedValueOnce([{ value: "A1", selected: true, hasData: true }])
      .mockResolvedValueOnce([{ value: "B1", selected: true, hasData: true }])
      .mockResolvedValueOnce([{ value: "C1", selected: true, hasData: true }]);

    await refreshAllItems();

    expect(mockGetRibbonFilterItems).toHaveBeenCalledTimes(3);
    expect(getCachedItems(1)).toEqual([{ value: "A1", selected: true, hasData: true }]);
    expect(getCachedItems(2)).toEqual([{ value: "B1", selected: true, hasData: true }]);
    expect(getCachedItems(3)).toEqual([{ value: "C1", selected: true, hasData: true }]);
  });

  it("refreshCache dispatches FILTERS_REFRESHED event", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([]);
    const spy = vi.spyOn(window, "dispatchEvent");

    await refreshCache();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "filterpane:filters-refreshed" }),
    );
    spy.mockRestore();
  });

  it("refreshCache handles backend error gracefully", async () => {
    mockGetAllRibbonFilters.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(refreshCache()).resolves.toBeUndefined();
  });
});

// ============================================================================
// BI filter items with cross-filtering
// ============================================================================

describe("BI filter items", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("refreshFilterItems fetches BI column values for biConnection source", async () => {
    const filter = makeFilter({
      id: 1,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "Sales.Region",
    });
    await seedFilters([filter]);

    mockGetBiColumnValues.mockResolvedValue(["North", "South", "East", "West"]);

    await refreshFilterItems(1);

    expect(mockGetBiColumnValues).toHaveBeenCalledWith(42, "Sales", "Region");
    const items = getCachedItems(1);
    expect(items).toHaveLength(4);
    expect(items!.map((i) => i.value)).toEqual(["North", "South", "East", "West"]);
    // All selected (selectedItems is null)
    expect(items!.every((i) => i.selected)).toBe(true);
    // All have data (no cross-filters)
    expect(items!.every((i) => i.hasData)).toBe(true);
  });

  it("marks items as not selected when filter has selectedItems", async () => {
    const filter = makeFilter({
      id: 1,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "Sales.Region",
      selectedItems: ["North", "South"],
    });
    await seedFilters([filter]);

    mockGetBiColumnValues.mockResolvedValue(["North", "South", "East", "West"]);

    await refreshFilterItems(1);

    const items = getCachedItems(1)!;
    expect(items.find((i) => i.value === "North")?.selected).toBe(true);
    expect(items.find((i) => i.value === "South")?.selected).toBe(true);
    expect(items.find((i) => i.value === "East")?.selected).toBe(false);
    expect(items.find((i) => i.value === "West")?.selected).toBe(false);
  });

  it("applies cross-filter hasData from sibling filters", async () => {
    const filterA = makeFilter({
      id: 1,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "Sales.Category",
      selectedItems: ["Electronics"],
      crossFilterTargets: [2], // targets filter B
    });
    const filterB = makeFilter({
      id: 2,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "Sales.Region",
      selectedItems: null,
    });
    await seedFilters([filterA, filterB]);

    mockGetBiColumnValues.mockResolvedValue(["North", "South", "East", "West"]);
    // When cross-filtered by Category=Electronics, only North and East have data
    mockGetBiColumnAvailableValues.mockResolvedValue(["North", "East"]);

    await refreshFilterItems(2);

    const items = getCachedItems(2)!;
    expect(items.find((i) => i.value === "North")?.hasData).toBe(true);
    expect(items.find((i) => i.value === "South")?.hasData).toBe(false);
    expect(items.find((i) => i.value === "East")?.hasData).toBe(true);
    expect(items.find((i) => i.value === "West")?.hasData).toBe(false);
  });

  it("does not cross-filter from sibling with null selection", async () => {
    const filterA = makeFilter({
      id: 1,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "Sales.Category",
      selectedItems: null, // all selected = no filter
      crossFilterTargets: [2],
    });
    const filterB = makeFilter({
      id: 2,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "Sales.Region",
    });
    await seedFilters([filterA, filterB]);

    mockGetBiColumnValues.mockResolvedValue(["North", "South"]);

    await refreshFilterItems(2);

    // Should NOT call getBiColumnAvailableValues since sibling has no active filter
    expect(mockGetBiColumnAvailableValues).not.toHaveBeenCalled();
    expect(getCachedItems(2)!.every((i) => i.hasData)).toBe(true);
  });

  it("does not cross-filter from sibling on different connection", async () => {
    const filterA = makeFilter({
      id: 1,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "Sales.Category",
      selectedItems: ["X"],
      crossFilterTargets: [2],
    });
    const filterB = makeFilter({
      id: 2,
      sourceType: "biConnection",
      cacheSourceId: 99, // different connection
      fieldName: "Other.Region",
    });
    await seedFilters([filterA, filterB]);

    mockGetBiColumnValues.mockResolvedValue(["A", "B"]);

    await refreshFilterItems(2);

    expect(mockGetBiColumnAvailableValues).not.toHaveBeenCalled();
  });

  it("parses field name without dot as empty table", async () => {
    const filter = makeFilter({
      id: 1,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "SimpleColumn", // no dot
    });
    await seedFilters([filter]);

    mockGetBiColumnValues.mockResolvedValue(["val"]);

    await refreshFilterItems(1);

    expect(mockGetBiColumnValues).toHaveBeenCalledWith(42, "", "SimpleColumn");
  });
});

// ============================================================================
// Sibling filter refresh (cross-filtering cascade)
// ============================================================================

describe("sibling filter refresh on selection change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("refreshes sibling items when selection changes on connected source", async () => {
    const conn = { sourceType: "table" as const, sourceId: 100 };
    const filterA = makeFilter({
      id: 1,
      name: "A",
      connectedSources: [conn],
      order: 0,
    });
    const filterB = makeFilter({
      id: 2,
      name: "B",
      connectedSources: [conn],
      order: 1,
    });
    await seedFilters([filterA, filterB]);

    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    mockGetRibbonFilterItems.mockResolvedValue([
      { value: "V", selected: true, hasData: true },
    ]);

    await updateFilterSelectionAsync(1, ["X"]);

    // Filter B should have its items refreshed
    expect(mockGetRibbonFilterItems).toHaveBeenCalledWith(2);
  });

  it("refreshes BI cross-filter targets", async () => {
    const filterA = makeFilter({
      id: 1,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "T.Col1",
      crossFilterTargets: [2],
      order: 0,
    });
    const filterB = makeFilter({
      id: 2,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "T.Col2",
      order: 1,
    });
    await seedFilters([filterA, filterB]);

    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    mockGetBiColumnValues.mockResolvedValue(["A", "B"]);

    await updateFilterSelectionAsync(1, ["val1"]);

    // Filter B should be refreshed as a cross-filter target
    expect(mockGetBiColumnValues).toHaveBeenCalled();
  });

  it("refreshes reverse cross-filter direction", async () => {
    // Filter B targets filter A in its crossFilterTargets
    const filterA = makeFilter({
      id: 1,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "T.Col1",
      order: 0,
    });
    const filterB = makeFilter({
      id: 2,
      sourceType: "biConnection",
      cacheSourceId: 42,
      fieldName: "T.Col2",
      crossFilterTargets: [1], // B targets A
      order: 1,
    });
    await seedFilters([filterA, filterB]);

    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    mockGetBiColumnValues.mockResolvedValue(["X"]);

    // Changing filter A's selection should also refresh B (reverse target)
    await updateFilterSelectionAsync(1, ["val"]);

    // B should be refreshed because it targets A
    expect(mockGetBiColumnValues).toHaveBeenCalled();
  });
});

// ============================================================================
// Optimistic updates
// ============================================================================

describe("optimistic local updates", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    await seedFilters([makeFilter({ id: 1, selectedItems: null })]);
  });

  it("updates selectedItems immediately before backend call completes", async () => {
    let resolveBackend: () => void;
    const backendPromise = new Promise<void>((r) => { resolveBackend = r; });
    mockUpdateRibbonFilterSelection.mockReturnValue(backendPromise);
    mockApplyRibbonFilter.mockResolvedValue(undefined);

    const promise = updateFilterSelectionAsync(1, ["Immediate"]);

    // Before backend resolves, local state should already be updated
    expect(getFilterById(1)?.selectedItems).toEqual(["Immediate"]);

    resolveBackend!();
    await promise;
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe("error handling", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    await seedFilters([makeFilter({ id: 1 })]);
  });

  it("updateFilterAsync returns null on error", async () => {
    mockUpdateRibbonFilter.mockRejectedValue(new Error("fail"));

    const result = await updateFilterAsync(1, { name: "X" });

    expect(result).toBeNull();
  });

  it("deleteFilterAsync returns false on error after clearing", async () => {
    mockClearRibbonFilter.mockResolvedValue(undefined);
    mockDeleteRibbonFilter.mockRejectedValue(new Error("fail"));

    const result = await deleteFilterAsync(1);

    expect(result).toBe(false);
  });

  it("refreshFilterItems handles backend error without crashing", async () => {
    mockGetRibbonFilterItems.mockRejectedValue(new Error("Network error"));

    await expect(refreshFilterItems(1)).resolves.toBeUndefined();
  });

  it("updateFilterSelectionAsync handles backend error without crashing", async () => {
    mockUpdateRibbonFilterSelection.mockRejectedValue(new Error("fail"));

    await expect(updateFilterSelectionAsync(1, ["X"])).resolves.toBeUndefined();
  });
});

// ============================================================================
// Events dispatched
// ============================================================================

describe("event dispatching", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    await seedFilters([makeFilter({ id: 1 })]);
  });

  it("createFilterAsync dispatches FILTER_CREATED", async () => {
    const newFilter = makeFilter({ id: 5 });
    mockCreateRibbonFilter.mockResolvedValue(newFilter);
    mockGetAllRibbonFilters.mockResolvedValue([newFilter]);
    const spy = vi.spyOn(window, "dispatchEvent");

    await createFilterAsync({
      name: "New",
      sourceType: "table",
      cacheSourceId: 1,
      fieldName: "F",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "filterpane:filter-created" }),
    );
    spy.mockRestore();
  });

  it("deleteFilterAsync dispatches FILTER_DELETED", async () => {
    mockClearRibbonFilter.mockResolvedValue(undefined);
    mockDeleteRibbonFilter.mockResolvedValue(undefined);
    mockGetAllRibbonFilters.mockResolvedValue([]);
    const spy = vi.spyOn(window, "dispatchEvent");

    await deleteFilterAsync(1);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "filterpane:filter-deleted" }),
    );
    spy.mockRestore();
  });

  it("updateFilterSelectionAsync dispatches FILTER_SELECTION_CHANGED", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    const spy = vi.spyOn(window, "dispatchEvent");

    await updateFilterSelectionAsync(1, ["A"]);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "filterpane:filter-selection-changed" }),
    );
    spy.mockRestore();
  });
});
