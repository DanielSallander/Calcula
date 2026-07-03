//! FILENAME: app/extensions/ControlsPane/lib/__tests__/filterPaneStore.test.ts
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
const mockGetBiConnections = vi.fn();
const mockGetBiColumnValues = vi.fn();
const mockGetBiColumnAvailableValues = vi.fn();

vi.mock("../filterPaneApi", () => ({
  createRibbonFilter: (...args: unknown[]) => mockCreateRibbonFilter(...args),
  deleteRibbonFilter: (...args: unknown[]) => mockDeleteRibbonFilter(...args),
  updateRibbonFilter: (...args: unknown[]) => mockUpdateRibbonFilter(...args),
  updateRibbonFilterSelection: (...args: unknown[]) => mockUpdateRibbonFilterSelection(...args),
  getAllRibbonFilters: (...args: unknown[]) => mockGetAllRibbonFilters(...args),
  getBiConnections: (...args: unknown[]) => mockGetBiConnections(...args),
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
  getConnectionName,
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

const CONN_A = "0197a001-0000-7000-8000-00000000000a";
const CONN_B = "0197a001-0000-7000-8000-00000000000b";

function makeFilter(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: "0197f001-0000-7000-8000-000000000001",
    name: "Test Filter",
    connectionId: CONN_A,
    fieldName: "Products.Category",
    fieldDataType: "text",
    connectionMode: "workbook",
    connectedPivots: [],
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

beforeEach(() => {
  mockGetBiConnections.mockResolvedValue([
    { id: CONN_A, name: "Sales Model", description: "", isConnected: true, modelPath: null },
    { id: CONN_B, name: "HR Model", description: "", isConnected: true, modelPath: null },
  ]);
});

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
    expect(getFilterById("nope")).toBeUndefined();
  });

  it("getCachedItems returns undefined for unknown filter", () => {
    expect(getCachedItems("nope")).toBeUndefined();
  });

  it("getConnectionName returns undefined before refresh", () => {
    expect(getConnectionName(CONN_A)).toBeUndefined();
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
      makeFilter({ id: "f-1", name: "C", order: 2 }),
      makeFilter({ id: "f-2", name: "A", order: 0 }),
      makeFilter({ id: "f-3", name: "B", order: 1 }),
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
    const newFilter = makeFilter({ id: "f-5" });
    mockCreateRibbonFilter.mockResolvedValue(newFilter);
    mockGetAllRibbonFilters.mockResolvedValue([newFilter]);

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const result = await createFilterAsync({
      name: "Test",
      connectionId: CONN_A,
      fieldName: "Products.Category",
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
      connectionId: CONN_A,
      fieldName: "Products.X",
    });

    expect(result).toBeNull();
  });
});

describe("deleteFilterAsync", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    // Seed cache with a filter
    mockGetAllRibbonFilters.mockResolvedValue([makeFilter({ id: "f-10" })]);
    await refreshCache();
    vi.clearAllMocks();
  });

  it("deletes filter, clears applied filter, and refreshes cache", async () => {
    mockDeleteRibbonFilter.mockResolvedValue(undefined);
    mockGetAllRibbonFilters.mockResolvedValue([]);
    mockClearRibbonFilter.mockResolvedValue(undefined);

    const result = await deleteFilterAsync("f-10");

    expect(result).toBe(true);
    expect(mockClearRibbonFilter).toHaveBeenCalled();
    expect(mockDeleteRibbonFilter).toHaveBeenCalledWith("f-10");
    expect(getAllFilters()).toEqual([]);
  });

  it("returns false on error", async () => {
    mockDeleteRibbonFilter.mockRejectedValue(new Error("fail"));
    mockClearRibbonFilter.mockResolvedValue(undefined);

    const result = await deleteFilterAsync("f-10");

    expect(result).toBe(false);
  });
});

describe("updateFilterAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("updates filter and refreshes cache", async () => {
    const updated = makeFilter({ id: "f-1", name: "Updated" });
    mockUpdateRibbonFilter.mockResolvedValue(updated);
    mockGetAllRibbonFilters.mockResolvedValue([updated]);

    const result = await updateFilterAsync("f-1", { name: "Updated" });

    expect(result).toEqual(updated);
    expect(mockUpdateRibbonFilter).toHaveBeenCalledWith("f-1", { name: "Updated" });
  });
});

// ============================================================================
// updateFilterSelectionAsync
// ============================================================================

describe("updateFilterSelectionAsync", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    mockGetAllRibbonFilters.mockResolvedValue([makeFilter({ id: "f-1" })]);
    await refreshCache();
    vi.clearAllMocks();
  });

  it("applies filter when items are selected", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync("f-1", ["Apple", "Banana"]);

    expect(mockUpdateRibbonFilterSelection).toHaveBeenCalledWith("f-1", ["Apple", "Banana"]);
    expect(mockApplyRibbonFilter).toHaveBeenCalled();
  });

  it("clears filter when selection is null (select all)", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockClearRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync("f-1", null);

    expect(mockClearRibbonFilter).toHaveBeenCalled();
    expect(mockApplyRibbonFilter).not.toHaveBeenCalled();
  });

  it("performs optimistic local update", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync("f-1", ["X"]);

    const filter = getFilterById("f-1");
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
    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: "f-1", selectedItems: ["A"] }),
    ]);
    await refreshCache();
    vi.clearAllMocks();
  });

  it("fetches values from the BI engine and marks selection", async () => {
    mockGetBiColumnValues.mockResolvedValue(["A", "B"]);

    await refreshFilterItems("f-1");

    expect(mockGetBiColumnValues).toHaveBeenCalledWith(CONN_A, "Products", "Category");
    expect(getCachedItems("f-1")).toEqual([
      { value: "A", selected: true, hasData: true },
      { value: "B", selected: false, hasData: true },
    ]);
  });

  it("only cross-filters against siblings on the same connection", async () => {
    // Seed: f-1 (CONN_A) is targeted by f-2 (CONN_A) and f-3 (CONN_B, other model)
    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: "f-1", selectedItems: null }),
      makeFilter({
        id: "f-2",
        connectionId: CONN_A,
        fieldName: "Products.Color",
        selectedItems: ["Red"],
        crossFilterTargets: ["f-1"],
      }),
      makeFilter({
        id: "f-3",
        connectionId: CONN_B,
        fieldName: "Employees.Dept",
        selectedItems: ["IT"],
        crossFilterTargets: ["f-1"],
      }),
    ]);
    await refreshCache();

    mockGetBiColumnValues.mockResolvedValue(["A", "B"]);
    mockGetBiColumnAvailableValues.mockResolvedValue(["A"]);

    await refreshFilterItems("f-1");

    // Only the same-connection sibling contributes a cross-filter constraint
    expect(mockGetBiColumnAvailableValues).toHaveBeenCalledWith(
      CONN_A,
      "Products",
      "Category",
      [{ table: "Products", column: "Color", values: ["Red"] }],
    );
    expect(getCachedItems("f-1")).toEqual([
      { value: "A", selected: true, hasData: true },
      { value: "B", selected: true, hasData: false },
    ]);
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
    const filters = [makeFilter({ id: "f-1" }), makeFilter({ id: "f-2" })];
    mockGetAllRibbonFilters.mockResolvedValue(filters);

    await refreshCache();

    expect(getAllFilters()).toHaveLength(2);
  });

  it("caches connection names for attribution", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([makeFilter()]);

    await refreshCache();

    expect(getConnectionName(CONN_A)).toBe("Sales Model");
    expect(getConnectionName(CONN_B)).toBe("HR Model");
    expect(getConnectionName("unknown")).toBeUndefined();
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
    mockGetAllRibbonFilters.mockResolvedValue([makeFilter({ id: "f-1" })]);
    await refreshCache();
    mockGetBiColumnValues.mockResolvedValue(["X"]);
    await refreshFilterItems("f-1");

    clearCache();

    expect(getAllFilters()).toEqual([]);
    expect(getCachedItems("f-1")).toBeUndefined();
    expect(getConnectionName(CONN_A)).toBeUndefined();
  });
});
