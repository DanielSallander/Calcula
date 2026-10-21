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

/** bi_get_column_values answers MEMBERS (P2): key = label for plain text. */
const members = (keys: string[]) => keys.map((key) => ({ key, label: key }));
const mockGetBiColumnAvailableValues = vi.fn();
// The model behind every connection: its table names decide how a field key
// splits. The implementation reads `modelTables`, so it survives
// vi.clearAllMocks(); a test that needs other tables sets the variable (reset
// to the default before every test) or queues a one-off result.
const DEFAULT_MODEL_TABLES = ["Products", "Employees"];
let modelTables: string[] | null = DEFAULT_MODEL_TABLES;
const mockGetBiModelInfo = vi.fn(async (_connectionId: string) =>
  modelTables === null
    ? null
    : {
        tables: modelTables.map((name) => ({ name, columns: [] })),
        measures: [],
        relationships: [],
      },
);
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

import { CONTROL_VALUE_CHANGED } from "@api/controlValues";
import type { ControlValueChangedDetail } from "@api/controlValues";
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
  getFilterItemsError,
  getFilterNarrowingError,
  getFilterLoadAttempts,
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

beforeEach(() => {
  modelTables = DEFAULT_MODEL_TABLES;
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

  it("triggers GET.CONTROLVALUE recalc for the new filter's name", async () => {
    const newFilter = makeFilter({ id: "f-5", name: "Region" });
    mockCreateRibbonFilter.mockResolvedValue(newFilter);
    mockGetAllRibbonFilters.mockResolvedValue([newFilter]);

    await createFilterAsync({
      name: "Region",
      connectionId: CONN_A,
      fieldName: "Products.Category",
    });

    expect(mockRecalcControlDependents).toHaveBeenCalledWith(["Region"]);
  });

  it("returns null on error", async () => {
    mockCreateRibbonFilter.mockRejectedValue(new Error("fail"));

    const result = await createFilterAsync({
      name: "Test",
      connectionId: CONN_A,
      fieldName: "Products.X",
    });

    expect(result).toBeNull();
    expect(mockRecalcControlDependents).not.toHaveBeenCalled();
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

  it("triggers GET.CONTROLVALUE recalc for the deleted filter's name", async () => {
    mockDeleteRibbonFilter.mockResolvedValue(undefined);
    mockGetAllRibbonFilters.mockResolvedValue([]);
    mockClearRibbonFilter.mockResolvedValue(undefined);

    await deleteFilterAsync("f-10");

    // Name captured before the cache refresh dropped the filter
    expect(mockRecalcControlDependents).toHaveBeenCalledWith(["Test Filter"]);
  });

  it("returns false on error", async () => {
    mockDeleteRibbonFilter.mockRejectedValue(new Error("fail"));
    mockClearRibbonFilter.mockResolvedValue(undefined);

    const result = await deleteFilterAsync("f-10");

    expect(result).toBe(false);
    expect(mockRecalcControlDependents).not.toHaveBeenCalled();
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

  // --- @api/controlValues facade completion (ribbon-filter targeting) --------
  // A ribbon-filter selection change must fire the app-wide CONTROL_VALUE_CHANGED
  // so onControlValueChange consumers (e.g. a grid report bound via @Name) react
  // the same way they do for a pane control.

  /** Pull the CONTROL_VALUE_CHANGED detail out of a dispatchEvent spy. */
  function controlValueDetail(
    spy: ReturnType<typeof vi.spyOn>,
  ): ControlValueChangedDetail | undefined {
    for (const call of spy.mock.calls) {
      const ev = call[0] as CustomEvent<ControlValueChangedDetail>;
      if (ev?.type === CONTROL_VALUE_CHANGED) return ev.detail;
    }
    return undefined;
  }

  it("fires CONTROL_VALUE_CHANGED with a single-select value (text)", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await updateFilterSelectionAsync("f-1", ["X"]);

    expect(controlValueDetail(dispatchSpy)).toEqual({
      id: "f-1",
      name: "Test Filter",
      value: { kind: "text", value: "X" },
      transient: false,
    });
    dispatchSpy.mockRestore();
  });

  it("fires CONTROL_VALUE_CHANGED with a multi-select value (textList)", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockApplyRibbonFilter.mockResolvedValue(undefined);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await updateFilterSelectionAsync("f-1", ["Apple", "Banana"]);

    expect(controlValueDetail(dispatchSpy)?.value).toEqual({
      kind: "textList",
      value: ["Apple", "Banana"],
    });
    dispatchSpy.mockRestore();
  });

  it("fires CONTROL_VALUE_CHANGED with (All) when the selection is cleared", async () => {
    mockUpdateRibbonFilterSelection.mockResolvedValue(undefined);
    mockClearRibbonFilter.mockResolvedValue(undefined);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await updateFilterSelectionAsync("f-1", null);

    expect(controlValueDetail(dispatchSpy)?.value).toEqual({
      kind: "text",
      value: "(All)",
    });
    dispatchSpy.mockRestore();
  });

  it("on backend failure: no CONTROL_VALUE_CHANGED, optimistic update rolled back", async () => {
    mockUpdateRibbonFilterSelection.mockRejectedValue(new Error("backend down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await updateFilterSelectionAsync("f-1", ["X"]);

    expect(controlValueDetail(dispatchSpy)).toBeUndefined();
    // The cache must not keep a selection the backend never persisted —
    // getControlValue/@Name substitution reads it.
    expect(getFilterById("f-1")?.selectedItems).toBeNull();
    expect(mockApplyRibbonFilter).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
    err.mockRestore();
  });
});

// ============================================================================
// refreshCache value-diff dispatch (undo/redo, rename, delete, external change)
// ============================================================================

describe("refreshCache CONTROL_VALUE_CHANGED diff", () => {
  /** All CONTROL_VALUE_CHANGED details captured by a dispatchEvent spy. */
  function controlValueDetails(
    spy: ReturnType<typeof vi.spyOn>,
  ): ControlValueChangedDetail[] {
    const out: ControlValueChangedDetail[] = [];
    for (const call of spy.mock.calls) {
      const ev = call[0] as CustomEvent<ControlValueChangedDetail>;
      if (ev?.type === CONTROL_VALUE_CHANGED) out.push(ev.detail);
    }
    return out;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    clearCache();
    // Seed: one filter, selection ["A"] — this initial populate must NOT dispatch.
    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: "f-1", name: "Region", selectedItems: ["A"] }),
    ]);
    await refreshCache();
  });

  it("does not dispatch on the first populate after clearCache (file open)", async () => {
    clearCache();
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await refreshCache();
    expect(controlValueDetails(dispatchSpy)).toEqual([]);
    dispatchSpy.mockRestore();
  });

  it("dispatches when a selection changed backend-side (undo/redo path)", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: "f-1", name: "Region", selectedItems: ["B", "C"] }),
    ]);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await refreshCache();
    expect(controlValueDetails(dispatchSpy)).toEqual([
      {
        id: "f-1",
        name: "Region",
        value: { kind: "textList", value: ["B", "C"] },
        transient: false,
      },
    ]);
    dispatchSpy.mockRestore();
  });

  it("dispatches old-name-undefined + new-name-value on rename", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: "f-1", name: "Area", selectedItems: ["A"] }),
    ]);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await refreshCache();
    expect(controlValueDetails(dispatchSpy)).toEqual([
      { id: "f-1", name: "Region", value: undefined, transient: false },
      { id: "f-1", name: "Area", value: { kind: "text", value: "A" }, transient: false },
    ]);
    dispatchSpy.mockRestore();
  });

  it("dispatches name-undefined when a filter is deleted", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([]);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await refreshCache();
    expect(controlValueDetails(dispatchSpy)).toEqual([
      { id: "f-1", name: "Region", value: undefined, transient: false },
    ]);
    dispatchSpy.mockRestore();
  });

  it("dispatches for a filter appearing in the cache (redo of create)", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: "f-1", name: "Region", selectedItems: ["A"] }),
      makeFilter({ id: "f-2", name: "Category", selectedItems: null }),
    ]);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await refreshCache();
    expect(controlValueDetails(dispatchSpy)).toEqual([
      {
        id: "f-2",
        name: "Category",
        value: { kind: "text", value: "(All)" },
        transient: false,
      },
    ]);
    dispatchSpy.mockRestore();
  });

  it("does not dispatch when nothing changed", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await refreshCache();
    expect(controlValueDetails(dispatchSpy)).toEqual([]);
    dispatchSpy.mockRestore();
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
    mockGetBiColumnValues.mockResolvedValue(members(["A", "B"]));

    await refreshFilterItems("f-1");

    expect(mockGetBiColumnValues).toHaveBeenCalledWith(CONN_A, "Products", "Category");
    expect(getCachedItems("f-1")).toEqual([
      { key: "A", label: "A", selected: true, hasData: true },
      { key: "B", label: "B", selected: false, hasData: true },
    ]);
  });

  it("only narrows by dependent-filter siblings on the same connection", async () => {
    // Seed: f-1 (CONN_A) is targeted by f-2 (CONN_A) and f-3 (CONN_B, other model)
    mockGetAllRibbonFilters.mockResolvedValue([
      makeFilter({ id: "f-1", selectedItems: null }),
      makeFilter({
        id: "f-2",
        connectionId: CONN_A,
        fieldName: "Products.Color",
        selectedItems: ["Red"],
        dependentFilters: ["f-1"],
      }),
      makeFilter({
        id: "f-3",
        connectionId: CONN_B,
        fieldName: "Employees.Dept",
        selectedItems: ["IT"],
        dependentFilters: ["f-1"],
      }),
    ]);
    await refreshCache();

    mockGetBiColumnValues.mockResolvedValue(members(["A", "B"]));
    mockGetBiColumnAvailableValues.mockResolvedValue(["A"]);

    await refreshFilterItems("f-1");

    // Only the same-connection sibling contributes a value constraint
    expect(mockGetBiColumnAvailableValues).toHaveBeenCalledWith(
      CONN_A,
      "Products",
      "Category",
      [{ table: "Products", column: "Color", values: ["Red"] }],
    );
    expect(getCachedItems("f-1")).toEqual([
      { key: "A", label: "A", selected: true, hasData: true },
      { key: "B", label: "B", selected: true, hasData: false },
    ]);
  });
});

// ============================================================================
// refreshFilterItems -- dotted table names and reported failures (P1 S5)
// ============================================================================

describe("refreshFilterItems splits against the model's tables and reports failures", () => {
  const DATE_YEAR = makeFilter({
    id: "f-year",
    fieldName: "BI.dim_date.year",
    selectedItems: null,
  });

  async function seed(filters: RibbonFilter[]): Promise<void> {
    mockGetAllRibbonFilters.mockResolvedValue(filters);
    await refreshCache();
    vi.clearAllMocks();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    modelTables = ["BI.dim_date", "BI.fact_sales", "BI.dim_territory"];
  });

  it("a dotted table name reaches the engine whole (never the first-dot split 'BI')", async () => {
    await seed([DATE_YEAR]);
    mockGetBiColumnValues.mockResolvedValue(members(["2023", "2024"]));

    const outcome = await refreshFilterItems("f-year");

    expect(outcome).toEqual({ ok: true, narrowingError: null });
    expect(mockGetBiModelInfo).toHaveBeenCalledWith(CONN_A);
    expect(mockGetBiColumnValues).toHaveBeenCalledWith(CONN_A, "BI.dim_date", "year");
    expect(getCachedItems("f-year")?.map((i) => i.key)).toEqual(["2023", "2024"]);
    expect(getFilterItemsError("f-year")).toBeNull();
  });

  it("the longest table prefix wins when one table name prefixes another", async () => {
    modelTables = ["BI.dim", "BI.dim_date"];
    await seed([DATE_YEAR]);
    mockGetBiColumnValues.mockResolvedValue(members(["2024"]));

    await refreshFilterItems("f-year");

    expect(mockGetBiColumnValues).toHaveBeenCalledWith(CONN_A, "BI.dim_date", "year");
  });

  it("a dependent-filter sibling's constraint is split the same way", async () => {
    await seed([
      DATE_YEAR,
      makeFilter({
        id: "f-territory",
        fieldName: "BI.dim_territory.territorygroup",
        selectedItems: ["Europe"],
        dependentFilters: ["f-year"],
      }),
    ]);
    mockGetBiColumnValues.mockResolvedValue(members(["2023", "2024"]));
    mockGetBiColumnAvailableValues.mockResolvedValue(["2024"]);

    const outcome = await refreshFilterItems("f-year");

    expect(outcome).toEqual({ ok: true, narrowingError: null });
    expect(mockGetBiColumnAvailableValues).toHaveBeenCalledWith(CONN_A, "BI.dim_date", "year", [
      { table: "BI.dim_territory", column: "territorygroup", values: ["Europe"] },
    ]);
    expect(getCachedItems("f-year")).toEqual([
      { key: "2023", label: "2023", selected: true, hasData: false },
      { key: "2024", label: "2024", selected: true, hasData: true },
    ]);
  });

  it("a failed value load is REPORTED: outcome, sentence, and no cached list", async () => {
    await seed([DATE_YEAR]);
    // A first load succeeds, so a stale list would be there to keep.
    mockGetBiColumnValues.mockResolvedValueOnce(members(["2024"]));
    await refreshFilterItems("f-year");
    expect(getCachedItems("f-year")).toHaveLength(1);

    mockGetBiColumnValues.mockRejectedValueOnce("Table 'BI' not found");
    const outcome = await refreshFilterItems("f-year");

    expect(outcome).toEqual({ ok: false, error: "Table 'BI' not found" });
    expect(getFilterItemsError("f-year")).toBe("Table 'BI' not found");
    expect(getCachedItems("f-year")).toBeUndefined();
  });

  it("a success after a failure clears the reported sentence", async () => {
    await seed([DATE_YEAR]);
    mockGetBiColumnValues.mockRejectedValueOnce(new Error("timeout"));
    await refreshFilterItems("f-year");
    expect(getFilterItemsError("f-year")).toBe("timeout");

    mockGetBiColumnValues.mockResolvedValueOnce(members(["2024"]));
    const outcome = await refreshFilterItems("f-year");

    expect(outcome.ok).toBe(true);
    expect(getFilterItemsError("f-year")).toBeNull();
    expect(getCachedItems("f-year")).toHaveLength(1);
  });

  it("a connection with no model loaded fails with the 'not loaded' sentence", async () => {
    modelTables = null;
    await seed([DATE_YEAR]);

    const outcome = await refreshFilterItems("f-year");

    expect(outcome).toEqual({
      ok: false,
      error: "The model of this filter's connection is not loaded.",
    });
    expect(getFilterItemsError("f-year")).toBe(
      "The model of this filter's connection is not loaded.",
    );
    expect(mockGetBiColumnValues).not.toHaveBeenCalled();
  });

  it("a dotted key whose table is NOT in the model is refused, never sent as table 'BI'", async () => {
    modelTables = ["BI.dim_date"];
    await seed([makeFilter({ id: "f-gone", fieldName: "BI.dim_dat.year" })]);

    const outcome = await refreshFilterItems("f-gone");

    expect(outcome).toEqual({
      ok: false,
      error: '"BI.dim_dat.year" names no table of this model.',
    });
    expect(mockGetBiColumnValues).not.toHaveBeenCalled();
    expect(getCachedItems("f-gone")).toBeUndefined();
  });

  it("a failed narrowing keeps the values, un-narrowed, and says why", async () => {
    await seed([
      DATE_YEAR,
      makeFilter({
        id: "f-territory",
        fieldName: "BI.dim_territory.territorygroup",
        selectedItems: ["Europe"],
        dependentFilters: ["f-year"],
      }),
    ]);
    mockGetBiColumnValues.mockResolvedValue(members(["2023", "2024"]));
    mockGetBiColumnAvailableValues.mockRejectedValueOnce("relationship is ambiguous");

    const outcome = await refreshFilterItems("f-year");

    expect(outcome).toEqual({ ok: true, narrowingError: "relationship is ambiguous" });
    expect(getFilterNarrowingError("f-year")).toBe("relationship is ambiguous");
    expect(getFilterItemsError("f-year")).toBeNull();
    const items = getCachedItems("f-year")!;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.hasData)).toBe(true);
  });

  it("a dependent sibling whose table is not in the model is skipped and named", async () => {
    await seed([
      DATE_YEAR,
      makeFilter({
        id: "f-old",
        fieldName: "BI.dim_region.name",
        selectedItems: ["North"],
        dependentFilters: ["f-year"],
      }),
    ]);
    mockGetBiColumnValues.mockResolvedValue(members(["2023", "2024"]));

    const outcome = await refreshFilterItems("f-year");

    expect(outcome).toEqual({
      ok: true,
      narrowingError: '"BI.dim_region.name" names no table of this model.',
    });
    expect(mockGetBiColumnAvailableValues).not.toHaveBeenCalled();
    expect(getCachedItems("f-year")!.every((i) => i.hasData)).toBe(true);
  });

  it("counts every load it starts, and clearCache resets the count", async () => {
    await seed([DATE_YEAR]);
    mockGetBiColumnValues.mockResolvedValue(members(["2024"]));

    expect(getFilterLoadAttempts("f-year")).toBe(0);
    await refreshFilterItems("f-year");
    await refreshFilterItems("f-year");
    expect(getFilterLoadAttempts("f-year")).toBe(2);

    clearCache();
    expect(getFilterLoadAttempts("f-year")).toBe(0);
  });

  it("a filter that is not in the store is a reported failure, not a silent no-op", async () => {
    await seed([DATE_YEAR]);

    const outcome = await refreshFilterItems("f-missing");

    expect(outcome.ok).toBe(false);
    expect(getFilterItemsError("f-missing")).toBe("This filter is no longer in the workbook.");
    expect(mockGetBiModelInfo).not.toHaveBeenCalled();
  });

  it("deleting a filter drops its error and its load count", async () => {
    await seed([DATE_YEAR]);
    mockGetBiColumnValues.mockRejectedValueOnce("engine down");
    await refreshFilterItems("f-year");
    expect(getFilterItemsError("f-year")).toBe("engine down");

    mockClearRibbonFilter.mockResolvedValue(undefined);
    mockDeleteRibbonFilter.mockResolvedValue(undefined);
    mockGetAllRibbonFilters.mockResolvedValue([]);
    await deleteFilterAsync("f-year");

    expect(getFilterItemsError("f-year")).toBeNull();
    expect(getFilterLoadAttempts("f-year")).toBe(0);
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
    mockGetBiColumnValues.mockResolvedValue(members(["X"]));
    await refreshFilterItems("f-1");

    clearCache();

    expect(getAllFilters()).toEqual([]);
    expect(getCachedItems("f-1")).toBeUndefined();
    expect(getConnectionName(CONN_A)).toBeUndefined();
  });

  it("clears the item errors, the narrowing errors and the load counter", async () => {
    mockGetAllRibbonFilters.mockResolvedValue([makeFilter({ id: "f-1" })]);
    await refreshCache();
    mockGetBiColumnValues.mockRejectedValueOnce("engine down");
    await refreshFilterItems("f-1");
    expect(getFilterItemsError("f-1")).toBe("engine down");
    expect(getFilterLoadAttempts("f-1")).toBe(1);

    clearCache();

    expect(getFilterItemsError("f-1")).toBeNull();
    expect(getFilterNarrowingError("f-1")).toBeNull();
    expect(getFilterLoadAttempts("f-1")).toBe(0);
  });
});
