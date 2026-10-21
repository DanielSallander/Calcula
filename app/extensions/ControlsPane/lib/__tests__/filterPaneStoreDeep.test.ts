//! FILENAME: app/extensions/ControlsPane/lib/__tests__/filterPaneStoreDeep.test.ts
// PURPOSE: Deep tests for FilterPane store: multiple active filters interaction,
//          filter ordering, cache invalidation, dependent filters, BI filter items,
//          multi-connection isolation, and concurrent operations.

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

/** bi_get_column_values answers MEMBERS (P2): key = label for plain text. */
const members = (keys: string[]) => keys.map((key) => ({ key, label: key }));
const mockGetBiColumnAvailableValues = vi.fn();
// The model behind every connection: the store splits field keys against its
// table names. Every table these fixtures name (a vi.fn implementation, so it
// survives vi.clearAllMocks()).
const mockGetBiModelInfo = vi.fn(async (_connectionId: string) => ({
  tables: ["Products", "Sales", "Other", "T"].map((name) => ({ name, columns: [] })),
  measures: [],
  relationships: [],
}));
// Fire-and-forget GET.CONTROLVALUE recalc: must return a promise (the store
// chains .then/.catch on it). Implementation survives vi.clearAllMocks().
const mockRecalcControlDependents = vi.fn(() => Promise.resolve([]));

vi.mock("../filterPaneApi", () => ({
  createRibbonFilter: (...args: unknown[]) => mockCreateRibbonFilter(...args),
  deleteRibbonFilter: (...args: unknown[]) => mockDeleteRibbonFilter(...args),
  updateRibbonFilter: (...args: unknown[]) => mockUpdateRibbonFilter(...args),
  updateRibbonFilterSelection: (...args: unknown[]) => mockUpdateRibbonFilterSelection(...args),
  getAllRibbonFilters: (...args: unknown[]) => mockGetAllRibbonFilters(...args),
  getBiConnections: (...args: unknown[]) => mockGetBiConnections(...args),
  getBiModelInfo: (connectionId: string) => mockGetBiModelInfo(connectionId),
  getBiColumnValues: (...args: unknown[]) => mockGetBiColumnValues(...args),
  getBiColumnAvailableValues: (...args: unknown[]) => mockGetBiColumnAvailableValues(...args),
  recalcControlDependents: (...args: unknown[]) => mockRecalcControlDependents(...args),
}));

const mockApplyRibbonFilter = vi.fn();
const mockClearRibbonFilter = vi.fn();

// The store's change is ONE backend gesture (wave B, BUG-0187): this double
// writes the selection and applies (or clears) the filter the way the real
// gesture's one command does, and reports a step of its own.
const mockGesture = vi.fn(async (f: { id: string; selectedItems: string[] | null }) => {
  await mockUpdateRibbonFilterSelection(f.id, f.selectedItems);
  if (f.selectedItems === null) await mockClearRibbonFilter(f);
  else await mockApplyRibbonFilter(f);
  return {
    step: "pushed",
    overwrites: { note: () => undefined, cellCount: 0, pivotIds: [], tokens: [], unrecorded: false },
  };
});

vi.mock("../filterPaneFilterBridge", () => ({
  applyRibbonFilter: (...args: unknown[]) => mockApplyRibbonFilter(...args),
  clearRibbonFilter: (...args: unknown[]) => mockClearRibbonFilter(...args),
  clearModelColumnOnPivots: vi.fn(),
  reportRibbonFilterFailures: vi.fn(),
  resolveTargetPivots: vi.fn(async () => []),
  runRibbonFilterSelectionGesture: (f: { id: string; selectedItems: string[] | null }) => mockGesture(f),
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
  refreshAllItems,
  clearCache,
} from "../filterPaneStore";

// ============================================================================
// Test Helpers
// ============================================================================

const CONN_A = "0197a001-0000-7000-8000-00000000000a";
const CONN_B = "0197a001-0000-7000-8000-00000000000b";

function makeFilter(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: "f-1",
    name: "Test Filter",
    connectionId: CONN_A,
    fieldName: "Products.Category",
    fieldDataType: "text",
    connectionMode: "workbook",
    connectedPivots: [],
    connectedSheets: [],
    displayMode: "checklist",
    selectedItems: null,
    dependentFilters: [],
    dependentSlicers: [],
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
  mockGetBiConnections.mockResolvedValue([
    { id: CONN_A, name: "Sales Model", description: "", isConnected: true, modelPath: null },
    { id: CONN_B, name: "HR Model", description: "", isConnected: true, modelPath: null },
  ]);
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
      makeFilter({ id: "f-1", name: "Category", fieldName: "T.Category", order: 0 }),
      makeFilter({ id: "f-2", name: "Region", fieldName: "T.Region", order: 1 }),
      makeFilter({ id: "f-3", name: "Status", fieldName: "T.Status", order: 2 }),
    ];
    await seedFilters(filters);

    // Apply selection to filter 1
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    await updateFilterSelectionAsync("f-1", ["Electronics"]);

    expect(getFilterById("f-1")?.selectedItems).toEqual(["Electronics"]);
    expect(getFilterById("f-2")?.selectedItems).toBeNull();
    expect(getFilterById("f-3")?.selectedItems).toBeNull();
  });

  it("applies filter for each selection change independently", async () => {
    const filters = [
      makeFilter({ id: "f-1", name: "A", order: 0 }),
      makeFilter({ id: "f-2", name: "B", order: 1 }),
    ];
    await seedFilters(filters);

    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync("f-1", ["X"]);
    await updateFilterSelectionAsync("f-2", ["Y"]);

    expect(mockApplyRibbonFilter).toHaveBeenCalledTimes(2);
  });

  it("clearing one filter does not affect others", async () => {
    const filters = [
      makeFilter({ id: "f-1", name: "A", selectedItems: ["X"], order: 0 }),
      makeFilter({ id: "f-2", name: "B", selectedItems: ["Y"], order: 1 }),
    ];
    await seedFilters(filters);

    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockClearRibbonFilter.mockResolvedValue(undefined);

    await updateFilterSelectionAsync("f-1", null); // clear filter 1

    expect(getFilterById("f-1")?.selectedItems).toBeNull();
    expect(getFilterById("f-2")?.selectedItems).toEqual(["Y"]);
    expect(mockClearRibbonFilter).toHaveBeenCalledTimes(1);
    expect(mockApplyRibbonFilter).not.toHaveBeenCalled();
  });

  it("deleting a filter clears it before removal", async () => {
    const filters = [
      makeFilter({ id: "f-1", name: "A", selectedItems: ["X"], order: 0 }),
      makeFilter({ id: "f-2", name: "B", selectedItems: ["Y"], order: 1 }),
    ];
    await seedFilters(filters);

    mockClearRibbonFilter.mockResolvedValue(undefined);
    mockDeleteRibbonFilter.mockResolvedValue(undefined);
    mockGetAllRibbonFilters.mockResolvedValue([filters[1]]);

    await deleteFilterAsync("f-1");

    expect(mockClearRibbonFilter).toHaveBeenCalled();
    expect(mockDeleteRibbonFilter).toHaveBeenCalledWith("f-1");
    expect(getAllFilters()).toHaveLength(1);
    expect(getFilterById("f-1")).toBeUndefined();
    expect(getFilterById("f-2")).toBeDefined();
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
      makeFilter({ id: "f-3", name: "Third", order: 2 }),
      makeFilter({ id: "f-1", name: "First", order: 0 }),
      makeFilter({ id: "f-2", name: "Second", order: 1 }),
    ];
    await seedFilters(filters);

    const result = getAllFilters();
    expect(result.map((f) => f.name)).toEqual(["First", "Second", "Third"]);
  });

  it("filters with same order are stable-ish (no guaranteed order)", async () => {
    const filters = [
      makeFilter({ id: "f-1", name: "A", order: 0 }),
      makeFilter({ id: "f-2", name: "B", order: 0 }),
    ];
    await seedFilters(filters);

    const result = getAllFilters();
    expect(result).toHaveLength(2);
    // Both exist, order among ties is implementation-defined
    expect(result.map((f) => f.id).sort()).toEqual(["f-1", "f-2"]);
  });

  it("updating order re-sorts on next getAllFilters call", async () => {
    const filters = [
      makeFilter({ id: "f-1", name: "A", order: 0 }),
      makeFilter({ id: "f-2", name: "B", order: 1 }),
    ];
    await seedFilters(filters);

    // Simulate backend returning updated order
    const updated = makeFilter({ id: "f-1", name: "A", order: 5 });
    mockUpdateRibbonFilter.mockResolvedValue(updated);
    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: "f-2", name: "B", order: 1 }),
      makeFilter({ id: "f-1", name: "A", order: 5 }),
    ]);

    await updateFilterAsync("f-1", { order: 5 });

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
    await seedFilters([makeFilter({ id: "f-1", name: "Old" })]);
    expect(getAllFilters()).toHaveLength(1);

    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: "f-2", name: "New1" }),
      makeFilter({ id: "f-3", name: "New2" }),
    ]);
    await refreshCache();

    expect(getAllFilters()).toHaveLength(2);
    expect(getFilterById("f-1")).toBeUndefined();
    expect(getFilterById("f-2")).toBeDefined();
  });

  it("clearCache removes all filters, items, and connection names", async () => {
    await seedFilters([makeFilter({ id: "f-1" })]);
    mockGetBiColumnValues.mockResolvedValue(members(["A"]));
    await refreshFilterItems("f-1");

    expect(getAllFilters()).toHaveLength(1);
    expect(getCachedItems("f-1")).toBeDefined();

    clearCache();

    expect(getAllFilters()).toEqual([]);
    expect(getCachedItems("f-1")).toBeUndefined();
    expect(getConnectionName(CONN_A)).toBeUndefined();
  });

  it("deleteFilterAsync removes items from cache", async () => {
    await seedFilters([makeFilter({ id: "f-5" })]);
    mockGetBiColumnValues.mockResolvedValue(members(["X"]));
    await refreshFilterItems("f-5");
    expect(getCachedItems("f-5")).toBeDefined();

    mockClearRibbonFilter.mockResolvedValue(undefined);
    mockDeleteRibbonFilter.mockResolvedValue(undefined);
    mockGetAllRibbonFilters.mockResolvedValue([]);

    await deleteFilterAsync("f-5");

    expect(getCachedItems("f-5")).toBeUndefined();
  });

  it("createFilterAsync refreshes cache from backend", async () => {
    const newFilter = makeFilter({ id: "f-10" });
    mockCreateRibbonFilter.mockResolvedValue(newFilter);
    mockGetAllRibbonFilters.mockResolvedValue([newFilter]);
    mockGetBiConnections.mockResolvedValue([]);

    await createFilterAsync({
      name: "New",
      connectionId: CONN_A,
      fieldName: "T.F",
    });

    expect(getAllFilters()).toHaveLength(1);
    expect(getFilterById("f-10")).toBeDefined();
  });

  it("refreshAllItems refreshes items for every cached filter", async () => {
    const filters = [
      makeFilter({ id: "f-1", name: "A", fieldName: "T.A" }),
      makeFilter({ id: "f-2", name: "B", fieldName: "T.B" }),
      makeFilter({ id: "f-3", name: "C", fieldName: "T.C" }),
    ];
    await seedFilters(filters);

    mockGetBiColumnValues
      .mockResolvedValueOnce(members(["A1"]))
      .mockResolvedValueOnce(members(["B1"]))
      .mockResolvedValueOnce(members(["C1"]));

    await refreshAllItems();

    expect(mockGetBiColumnValues).toHaveBeenCalledTimes(3);
    expect(getCachedItems("f-1")).toEqual([{ key: "A1", label: "A1", selected: true, hasData: true }]);
    expect(getCachedItems("f-2")).toEqual([{ key: "B1", label: "B1", selected: true, hasData: true }]);
    expect(getCachedItems("f-3")).toEqual([{ key: "C1", label: "C1", selected: true, hasData: true }]);
  });

  it("refreshCache dispatches FILTERS_REFRESHED event", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([]);
    mockGetBiConnections.mockResolvedValue([]);
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
// BI filter items with dependent-filter narrowing
// ============================================================================

describe("BI filter items", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("refreshFilterItems fetches BI column values", async () => {
    const filter = makeFilter({
      id: "f-1",
      fieldName: "Sales.Region",
    });
    await seedFilters([filter]);

    mockGetBiColumnValues.mockResolvedValue(members(["North", "South", "East", "West"]));

    await refreshFilterItems("f-1");

    expect(mockGetBiColumnValues).toHaveBeenCalledWith(CONN_A, "Sales", "Region");
    const items = getCachedItems("f-1");
    expect(items).toHaveLength(4);
    expect(items!.map((i) => i.key)).toEqual(["North", "South", "East", "West"]);
    // All selected (selectedItems is null)
    expect(items!.every((i) => i.selected)).toBe(true);
    // All have data (no value constraints)
    expect(items!.every((i) => i.hasData)).toBe(true);
  });

  it("marks items as not selected when filter has selectedItems", async () => {
    const filter = makeFilter({
      id: "f-1",
      fieldName: "Sales.Region",
      selectedItems: ["North", "South"],
    });
    await seedFilters([filter]);

    mockGetBiColumnValues.mockResolvedValue(members(["North", "South", "East", "West"]));

    await refreshFilterItems("f-1");

    const items = getCachedItems("f-1")!;
    expect(items.find((i) => i.key === "North")?.selected).toBe(true);
    expect(items.find((i) => i.key === "South")?.selected).toBe(true);
    expect(items.find((i) => i.key === "East")?.selected).toBe(false);
    expect(items.find((i) => i.key === "West")?.selected).toBe(false);
  });

  it("applies dependent-filter hasData from sibling filters", async () => {
    const filterA = makeFilter({
      id: "f-1",
      fieldName: "Sales.Category",
      selectedItems: ["Electronics"],
      dependentFilters: ["f-2"], // targets filter B
    });
    const filterB = makeFilter({
      id: "f-2",
      fieldName: "Sales.Region",
      selectedItems: null,
    });
    await seedFilters([filterA, filterB]);

    mockGetBiColumnValues.mockResolvedValue(members(["North", "South", "East", "West"]));
    // When narrowed by Category=Electronics, only North and East have data
    mockGetBiColumnAvailableValues.mockResolvedValue(["North", "East"]);

    await refreshFilterItems("f-2");

    const items = getCachedItems("f-2")!;
    expect(items.find((i) => i.key === "North")?.hasData).toBe(true);
    expect(items.find((i) => i.key === "South")?.hasData).toBe(false);
    expect(items.find((i) => i.key === "East")?.hasData).toBe(true);
    expect(items.find((i) => i.key === "West")?.hasData).toBe(false);
  });

  it("does not narrow by a sibling with null selection", async () => {
    const filterA = makeFilter({
      id: "f-1",
      fieldName: "Sales.Category",
      selectedItems: null, // all selected = no filter
      dependentFilters: ["f-2"],
    });
    const filterB = makeFilter({
      id: "f-2",
      fieldName: "Sales.Region",
    });
    await seedFilters([filterA, filterB]);

    mockGetBiColumnValues.mockResolvedValue(members(["North", "South"]));

    await refreshFilterItems("f-2");

    // Should NOT call getBiColumnAvailableValues since sibling has no active filter
    expect(mockGetBiColumnAvailableValues).not.toHaveBeenCalled();
    expect(getCachedItems("f-2")!.every((i) => i.hasData)).toBe(true);
  });

  it("does not narrow by a sibling on a different model connection", async () => {
    const filterA = makeFilter({
      id: "f-1",
      fieldName: "Sales.Category",
      selectedItems: ["X"],
      dependentFilters: ["f-2"],
    });
    const filterB = makeFilter({
      id: "f-2",
      connectionId: CONN_B, // different model connection
      fieldName: "Other.Region",
    });
    await seedFilters([filterA, filterB]);

    mockGetBiColumnValues.mockResolvedValue(members(["A", "B"]));

    await refreshFilterItems("f-2");

    expect(mockGetBiColumnAvailableValues).not.toHaveBeenCalled();
  });

  it("refuses a field name without a table (no dot) instead of sending table \"\"", async () => {
    const filter = makeFilter({
      id: "f-1",
      fieldName: "SimpleColumn", // no dot: names no table of the model
    });
    await seedFilters([filter]);

    mockGetBiColumnValues.mockResolvedValue(members(["val"]));

    await expect(refreshFilterItems("f-1")).resolves.toEqual({
      ok: false,
      error: '"SimpleColumn" names no table of this model.',
    });
    expect(mockGetBiColumnValues).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Multi-connection attribution
// ============================================================================

describe("multi-connection attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("resolves each filter's connection name independently", async () => {
    await seedFilters([
      makeFilter({ id: "f-1", connectionId: CONN_A }),
      makeFilter({ id: "f-2", connectionId: CONN_B }),
    ]);

    expect(getConnectionName(getFilterById("f-1")!.connectionId)).toBe("Sales Model");
    expect(getConnectionName(getFilterById("f-2")!.connectionId)).toBe("HR Model");
  });

  it("returns undefined for a filter whose connection was removed", async () => {
    await seedFilters([
      makeFilter({ id: "f-1", connectionId: "gone-connection" }),
    ]);

    expect(getConnectionName("gone-connection")).toBeUndefined();
  });
});

// ============================================================================
// Sibling filter refresh (dependent-filter cascade)
// ============================================================================

describe("sibling filter refresh on selection change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("refreshes dependent filters", async () => {
    const filterA = makeFilter({
      id: "f-1",
      fieldName: "T.Col1",
      dependentFilters: ["f-2"],
      order: 0,
    });
    const filterB = makeFilter({
      id: "f-2",
      fieldName: "T.Col2",
      order: 1,
    });
    await seedFilters([filterA, filterB]);

    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    mockGetBiColumnValues.mockResolvedValue(members(["A", "B"]));

    await updateFilterSelectionAsync("f-1", ["val1"]);

    // Filter B should be refreshed as a dependent filter
    expect(mockGetBiColumnValues).toHaveBeenCalled();
  });

  it("refreshes the reverse dependent-filter direction", async () => {
    // Filter B targets filter A in its dependentFilters
    const filterA = makeFilter({
      id: "f-1",
      fieldName: "T.Col1",
      order: 0,
    });
    const filterB = makeFilter({
      id: "f-2",
      fieldName: "T.Col2",
      dependentFilters: ["f-1"], // B targets A
      order: 1,
    });
    await seedFilters([filterA, filterB]);

    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    mockGetBiColumnValues.mockResolvedValue(members(["X"]));

    // Changing filter A's selection should also refresh B (reverse target)
    await updateFilterSelectionAsync("f-1", ["val"]);

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
    await seedFilters([makeFilter({ id: "f-1", selectedItems: null })]);
  });

  it("updates selectedItems immediately before backend call completes", async () => {
    let resolveBackend: () => void;
    const backendPromise = new Promise<void>((r) => { resolveBackend = r; });
    mockUpdateRibbonFilterSelection.mockReturnValue(backendPromise);
    mockApplyRibbonFilter.mockResolvedValue(undefined);

    const promise = updateFilterSelectionAsync("f-1", ["Immediate"]);

    // Before backend resolves, local state should already be updated
    expect(getFilterById("f-1")?.selectedItems).toEqual(["Immediate"]);

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
    await seedFilters([makeFilter({ id: "f-1" })]);
  });

  it("updateFilterAsync returns null on error", async () => {
    mockUpdateRibbonFilter.mockRejectedValue(new Error("fail"));

    const result = await updateFilterAsync("f-1", { name: "X" });

    expect(result).toBeNull();
  });

  it("deleteFilterAsync returns false on error after clearing", async () => {
    mockClearRibbonFilter.mockResolvedValue(undefined);
    mockDeleteRibbonFilter.mockRejectedValue(new Error("fail"));

    const result = await deleteFilterAsync("f-1");

    expect(result).toBe(false);
  });

  it("refreshFilterItems handles backend error without crashing", async () => {
    mockGetBiColumnValues.mockRejectedValue(new Error("Network error"));

    await expect(refreshFilterItems("f-1")).resolves.toMatchObject({ ok: false });
  });

  it("updateFilterSelectionAsync handles backend error without crashing", async () => {
    mockUpdateRibbonFilterSelection.mockRejectedValue(new Error("fail"));

    await expect(updateFilterSelectionAsync("f-1", ["X"])).resolves.toBeUndefined();
  });
});

// ============================================================================
// Events dispatched
// ============================================================================

describe("event dispatching", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    await seedFilters([makeFilter({ id: "f-1" })]);
  });

  it("createFilterAsync dispatches FILTER_CREATED", async () => {
    const newFilter = makeFilter({ id: "f-5" });
    mockCreateRibbonFilter.mockResolvedValue(newFilter);
    mockGetAllRibbonFilters.mockResolvedValue([newFilter]);
    mockGetBiConnections.mockResolvedValue([]);
    const spy = vi.spyOn(window, "dispatchEvent");

    await createFilterAsync({
      name: "New",
      connectionId: CONN_A,
      fieldName: "T.F",
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

    await deleteFilterAsync("f-1");

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "filterpane:filter-deleted" }),
    );
    spy.mockRestore();
  });

  it("updateFilterSelectionAsync dispatches FILTER_SELECTION_CHANGED", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    const spy = vi.spyOn(window, "dispatchEvent");

    await updateFilterSelectionAsync("f-1", ["A"]);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "filterpane:filter-selection-changed" }),
    );
    spy.mockRestore();
  });
});
