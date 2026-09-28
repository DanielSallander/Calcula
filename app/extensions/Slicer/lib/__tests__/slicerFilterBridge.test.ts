//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerFilterBridge.test.ts
// PURPOSE: The slicer filter bridge for a MODEL slicer (owner finding 4,
//          2026-09-27) and the Report Connections pivots it shares code with.
//
//          - A model slicer filters EXACTLY the BI pivots of its model whose
//            destination is its own sheet (the page rule): never another
//            sheet's pivot of the same model, never a table.
//          - The source-type switch is exhaustive: an unknown type is an error,
//            not the old silent fall-through to the TABLE path.
//          - Every model column is named to the backend by its "Table.Column"
//            key; the bridge NEVER rebuilds a pivot (no update_bi_pivot_fields
//            -- the Pivot owner adds a missing column server-side), and a
//            CLEAR never adds a column (no apply before, or instead of, the
//            clear).
//          - The reconcile's re-apply (masksOnly) writes pivot masks only --
//            never a table's AutoFilter, whose write the undone click recorded.
//          - A table target is filtered through the AutoFilter OWNER
//            (@api/autoFilterService), never by the raw backend commands: the
//            owner pushes the hidden rows into the grid; the raw commands
//            filtered the workbook and left the rows on screen.
//          - A pivot slicer whose column left its BI pivot is LISTED from the
//            model: reads only, never an apply (a sheet switch must not write).
//
// The backend is a double of the Tauri shape: every invoke returns a Promise.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Slicer } from "../slicerTypes";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface Call {
  cmd: string;
  args: Record<string, unknown> | undefined;
}
const calls: Call[] = [];
let pivotsForConnection: Array<{ id: string; name: string; sheetIndex: number }> = [];
let hierarchiesById: Record<string, unknown> = {};
let columnValues: string[] = [];
/** What an apply/clear on a pivot reports it grew over (its response). */
let overwriteById: Record<string, { overwrittenCellCount: number; overwriteToken?: number }> = {};

vi.mock("../slicerBackend", () => ({
  slicerBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      switch (cmd) {
        case "get_pivots_for_bi_connection":
          return Promise.resolve(pivotsForConnection);
        case "get_pivot_hierarchies":
          return Promise.resolve(hierarchiesById[(args as { pivotId: string }).pivotId]);
        case "apply_pivot_filter":
        case "clear_pivot_filter": {
          const pivotId = (args as { request: { pivotId: string } }).request.pivotId;
          return Promise.resolve({ pivotId, ...(overwriteById[pivotId] ?? {}) });
        }
        case "get_tables_for_sheet":
          return Promise.resolve([
            {
              id: "t1",
              startCol: 0,
              autoFilterId: "af1",
              columns: [{ name: "Geo.Region" }, { name: "Amount" }],
              styleOptions: { headerRow: true, showFilterButton: true },
            },
          ]);
        case "bi_get_column_values":
          return Promise.resolve(columnValues);
        default:
          return Promise.resolve(undefined);
      }
    },
  },
}));

/** The AutoFilter owner's controller (the seam), recording what it is asked. */
const autoFilterCalls: Array<{ op: string; column?: number; criteria?: unknown }> = [];
vi.mock("@api/autoFilterService", () => ({
  requireAutoFilterController: () => ({
    get: async () => {
      autoFilterCalls.push({ op: "get" });
      return { id: "af1", startRow: 0, startCol: 0, endRow: 9, endCol: 1, enabled: true, isDataFiltered: false, columns: [], hiddenRows: [] };
    },
    setColumn: async (column: number, criteria: unknown) => {
      autoFilterCalls.push({ op: "setColumn", column, criteria });
      return null;
    },
    clear: async (column: number | null) => {
      autoFilterCalls.push({ op: "clear", column: column ?? undefined });
      return null;
    },
  }),
}));

const mockEmit = vi.fn();
vi.mock("@api", () => ({
  emitAppEvent: (...a: unknown[]) => mockEmit(...a),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
}));

const mockSurface = vi.fn();
vi.mock("@api/pivotNotices", () => ({
  surfacePivotNotices: (...a: unknown[]) => mockSurface(...a),
}));

import {
  applySlicerFilter,
  listPivotSlicerItemsFromModel,
  pageTargets,
  rangePivotField,
  resolveFilterTargets,
  syncReportConnections,
} from "../slicerFilterBridge";
import { createPivotOverwriteTally } from "@api/pivotOverwrite";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function slicer(overrides: Partial<Slicer> = {}): Slicer {
  return {
    id: "s-1",
    name: "Region",
    headerText: null,
    sheetIndex: 2,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    sourceType: "biConnection",
    cacheSourceId: "c1",
    fieldName: "Geo.Region",
    selectedItems: ["East"],
    showHeader: true,
    columns: 1,
    stylePreset: "slicer-light-1",
    selectionMode: "standard",
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: true,
    forceSelection: false,
    showSelectAll: false,
    arrangement: "vertical",
    rows: 0,
    itemGap: 4,
    autogrid: false,
    itemPadding: 4,
    buttonRadius: 2,
    connectedSources: [{ sourceType: "biConnection", sourceId: "c1" }],
    filterLevel: 1,
    ...overrides,
  };
}

const writes = () => calls.filter((c) => c.cmd === "apply_pivot_filter" || c.cmd === "clear_pivot_filter");
/** Every table write, by either door: the owner's controller, or (the
 *  defect) the raw backend commands. */
const RAW_TABLE_COMMANDS = new Set(["set_column_filter_values", "clear_column_criteria", "get_auto_filter"]);
const tableWrites = () => [
  ...autoFilterCalls.filter((c) => c.op !== "get").map((c) => c.op),
  ...calls.filter((c) => RAW_TABLE_COMMANDS.has(c.cmd)).map((c) => c.cmd),
];
const requestOf = (c: Call) => (c.args as { request: Record<string, unknown> }).request;

beforeEach(() => {
  calls.length = 0;
  mockEmit.mockClear();
  mockSurface.mockClear();
  pivotsForConnection = [
    { id: "p-canvas-a", name: "Canvas A", sheetIndex: 2 },
    { id: "p-sheet1", name: "Sheet1 pivot", sheetIndex: 0 },
    { id: "p-canvas-b", name: "Canvas B", sheetIndex: 2 },
  ];
  hierarchiesById = {};
  columnValues = [];
  overwriteById = {};
  autoFilterCalls.length = 0;
});

// ---------------------------------------------------------------------------
// The page rule
// ---------------------------------------------------------------------------

describe("pageTargets (pure)", () => {
  it("keeps the model's pivots on the slicer's sheet and only those", () => {
    expect(pageTargets(pivotsForConnection, 2).map((p) => p.id)).toEqual(["p-canvas-a", "p-canvas-b"]);
    expect(pageTargets(pivotsForConnection, 0).map((p) => p.id)).toEqual(["p-sheet1"]);
    expect(pageTargets(pivotsForConnection, 5)).toEqual([]);
  });
});

describe("a model slicer's apply", () => {
  it("filters every pivot of its model on ITS sheet by model key -- not the other sheet's, never a table", async () => {
    await applySlicerFilter(slicer());

    const list = calls.find((c) => c.cmd === "get_pivots_for_bi_connection");
    expect(list?.args).toEqual({ connectionId: "c1" });

    const applied = writes();
    expect(applied.map((c) => c.cmd)).toEqual(["apply_pivot_filter", "apply_pivot_filter"]);
    expect(applied.map((c) => requestOf(c).pivotId)).toEqual(["p-canvas-a", "p-canvas-b"]);
    for (const c of applied) {
      expect(requestOf(c)).toEqual({
        pivotId: requestOf(c).pivotId,
        biFieldKey: "Geo.Region",
        filters: { manualFilter: { selectedItems: ["East"] } },
        filterLevel: 1,
        slicerId: "s-1",
      });
    }
    // The negative controls: no table path, no frontend pivot rebuild.
    expect(calls.some((c) => c.cmd === "get_tables_for_sheet")).toBe(false);
    expect(calls.some((c) => c.cmd === "update_bi_pivot_fields")).toBe(false);
    expect(calls.some((c) => c.cmd === "get_pivot_hierarchies")).toBe(false);
    expect(mockEmit).toHaveBeenCalledWith("app:grid-refresh");
  });

  it("a pinned model slicer carries its level into the request", async () => {
    await applySlicerFilter(slicer({ filterLevel: 3 }));
    expect(writes().map((c) => requestOf(c).filterLevel)).toEqual([3, 3]);
  });

  it("clearing CLEARS by model key and never applies (a clear never adds the column)", async () => {
    await applySlicerFilter(slicer({ selectedItems: null }));
    const w = writes();
    expect(w.map((c) => c.cmd)).toEqual(["clear_pivot_filter", "clear_pivot_filter"]);
    expect(w.map((c) => requestOf(c))).toEqual([
      { pivotId: "p-canvas-a", biFieldKey: "Geo.Region" },
      { pivotId: "p-canvas-b", biFieldKey: "Geo.Region" },
    ]);
  });

  it("a page with no pivot of the model writes nothing (a pivot added later is folded in by the backend)", async () => {
    await applySlicerFilter(slicer({ sheetIndex: 7 }));
    expect(writes()).toEqual([]);
  });
});

describe("the source-type switch is exhaustive", () => {
  it("an unknown connection type is an ERROR, never the table path", async () => {
    const bogus = slicer({
      connectedSources: [{ sourceType: "chart" as unknown as "table", sourceId: "x" }],
    });
    await expect(resolveFilterTargets(bogus, bogus.connectedSources)).rejects.toThrow(/Unhandled slicer source type/);
    expect(calls.some((c) => c.cmd === "get_tables_for_sheet")).toBe(false);
  });

  it("a table connection still goes to the table path", async () => {
    const t = slicer({ sourceType: "table", connectedSources: [{ sourceType: "table", sourceId: "t1" }] });
    expect(await resolveFilterTargets(t, t.connectedSources)).toEqual([{ kind: "table", tableId: "t1" }]);
  });
});

// ---------------------------------------------------------------------------
// Report Connections pivots
// ---------------------------------------------------------------------------

describe("a pivot slicer's Report Connections pivot", () => {
  const pivotSlicer = (overrides: Partial<Slicer> = {}) =>
    slicer({
      sourceType: "pivot",
      cacheSourceId: "p-bi",
      connectedSources: [{ sourceType: "pivot", sourceId: "p-bi" }],
      ...overrides,
    });

  it("a BI pivot is filtered by model key -- the backend adds a missing column, the bridge rebuilds nothing", async () => {
    hierarchiesById["p-bi"] = { hierarchies: [{ index: 0, name: "Year" }], biModel: { tables: [] } };
    await applySlicerFilter(pivotSlicer());
    const w = writes();
    expect(w).toHaveLength(1);
    expect(requestOf(w[0])).toMatchObject({ pivotId: "p-bi", biFieldKey: "Geo.Region" });
    expect(requestOf(w[0])).not.toHaveProperty("fieldIndex");
    expect(calls.some((c) => c.cmd === "update_bi_pivot_fields")).toBe(false);
  });

  it("a range pivot is filtered by the field's index, found by name", async () => {
    hierarchiesById["p-range"] = { hierarchies: [{ index: 0, name: "Amount" }, { index: 1, name: "No. of items" }] };
    await applySlicerFilter(
      pivotSlicer({ cacheSourceId: "p-range", fieldName: "No. of items", connectedSources: [{ sourceType: "pivot", sourceId: "p-range" }] }),
    );
    expect(requestOf(writes()[0])).toMatchObject({ pivotId: "p-range", fieldIndex: 1 });
    expect(requestOf(writes()[0])).not.toHaveProperty("biFieldKey");
  });

  it("syncReportConnections clears a removed pivot and applies to an added one", async () => {
    hierarchiesById["p-old"] = { hierarchies: [], biModel: {} };
    hierarchiesById["p-new"] = { hierarchies: [], biModel: {} };
    const s = pivotSlicer();
    await syncReportConnections(
      s,
      [{ sourceType: "pivot", sourceId: "p-old" }],
      [{ sourceType: "pivot", sourceId: "p-new" }],
    );
    expect(writes().map((c) => [c.cmd, requestOf(c).pivotId])).toEqual([
      ["clear_pivot_filter", "p-old"],
      ["apply_pivot_filter", "p-new"],
    ]);
  });
});

describe("rangePivotField (pure)", () => {
  const h = [
    { index: 0, name: "Region" },
    { index: 1, name: "B" },
    { index: 2, name: "A.B" },
  ];
  it("exact name first", () => {
    expect(rangePivotField(h, "Region")?.index).toBe(0);
  });
  it("a model key matches the field it ENDS with after a dot, longest first (never a split)", () => {
    expect(rangePivotField(h, "Geo.Region")?.index).toBe(0);
    expect(rangePivotField(h, "T.A.B")?.index).toBe(2);
    expect(rangePivotField(h, "Geo.Country")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The reconcile's re-apply: pivot masks only
// ---------------------------------------------------------------------------

describe("applySlicerFilter with masksOnly (the reconcile after an undo / redo)", () => {
  // One slicer reaching a TABLE and a PIVOT through Report Connections.
  const mixed = (overrides: Partial<Slicer> = {}) =>
    slicer({
      sourceType: "table",
      cacheSourceId: "t1",
      connectedSources: [
        { sourceType: "table", sourceId: "t1" },
        { sourceType: "pivot", sourceId: "p-bi" },
      ],
      ...overrides,
    });

  it("re-masks the pivot and never writes the table's AutoFilter (its write was part of the undone step)", async () => {
    hierarchiesById["p-bi"] = { hierarchies: [], biModel: {} };
    await applySlicerFilter(mixed(), { masksOnly: true });
    expect(tableWrites()).toEqual([]);
    expect(writes().map((c) => [c.cmd, requestOf(c).pivotId])).toEqual([["apply_pivot_filter", "p-bi"]]);

    calls.length = 0;
    await applySlicerFilter(mixed({ selectedItems: null }), { masksOnly: true });
    expect(tableWrites()).toEqual([]);
    expect(writes().map((c) => [c.cmd, requestOf(c).pivotId])).toEqual([["clear_pivot_filter", "p-bi"]]);
  });

  it("a table-only slicer writes nothing at all", async () => {
    await applySlicerFilter(slicer({ sourceType: "table", cacheSourceId: "t1", connectedSources: [{ sourceType: "table", sourceId: "t1" }] }), { masksOnly: true });
    expect(tableWrites()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("the CLICK (no option) still filters the table", async () => {
    hierarchiesById["p-bi"] = { hierarchies: [], biModel: {} };
    await applySlicerFilter(mixed());
    expect(tableWrites()).toEqual(["setColumn"]);
    expect(writes()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A table target goes through the AutoFilter owner
// ---------------------------------------------------------------------------

describe("a table slicer's filter", () => {
  const tableSlicer = (overrides: Partial<Slicer> = {}) =>
    slicer({ sourceType: "table", cacheSourceId: "t1", connectedSources: [{ sourceType: "table", sourceId: "t1" }], ...overrides });

  it("filters the column through the AutoFilter owner, never by the raw backend commands", async () => {
    await applySlicerFilter(tableSlicer({ selectedItems: ["East", "(Blanks)"] }));
    expect(autoFilterCalls).toEqual([
      { op: "get" },
      { op: "setColumn", column: 0, criteria: { kind: "values", values: ["East"], includeBlanks: true } },
    ]);
    expect(calls.filter((c) => RAW_TABLE_COMMANDS.has(c.cmd))).toEqual([]);
  });

  it("clears the column through the owner too", async () => {
    await applySlicerFilter(tableSlicer({ selectedItems: null }));
    expect(autoFilterCalls).toEqual([{ op: "get" }, { op: "clear", column: 0 }]);
    expect(calls.filter((c) => RAW_TABLE_COMMANDS.has(c.cmd))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A pivot slicer whose column left its BI pivot: listed from the model
// ---------------------------------------------------------------------------

describe("listPivotSlicerItemsFromModel", () => {
  const pivotSlicer = (overrides: Partial<Slicer> = {}) =>
    slicer({ sourceType: "pivot", cacheSourceId: "p-bi", connectedSources: [{ sourceType: "pivot", sourceId: "p-bi" }], ...overrides });

  it("lists the column's values from the pivot's model and marks the selection -- READS only", async () => {
    hierarchiesById["p-bi"] = { hierarchies: [], biModel: { connectionId: "c9", tables: [{ name: "Geo", columns: [] }] } };
    columnValues = ["East", "North", "West"];
    const items = await listPivotSlicerItemsFromModel(pivotSlicer());
    expect(items).toEqual([
      { value: "East", selected: true, hasData: true },
      { value: "North", selected: false, hasData: true },
      { value: "West", selected: false, hasData: true },
    ]);
    const values = calls.find((c) => c.cmd === "bi_get_column_values");
    expect(values?.args).toEqual({ connectionId: "c9", table: "Geo", column: "Region" });
    // The whole point: a sheet switch comes through here, and it never writes.
    expect(calls.map((c) => c.cmd)).toEqual(["get_pivot_hierarchies", "bi_get_column_values"]);
    expect(writes()).toEqual([]);
  });

  it("an idle slicer shows every item selected", async () => {
    hierarchiesById["p-bi"] = { hierarchies: [], biModel: { connectionId: "c9", tables: [{ name: "Geo", columns: [] }] } };
    columnValues = ["East", "West"];
    const items = await listPivotSlicerItemsFromModel(pivotSlicer({ selectedItems: null }));
    expect(items?.every((i) => i.selected)).toBe(true);
  });

  it("splits the key against the MODEL's table names (a table name may contain a dot)", async () => {
    hierarchiesById["p-bi"] = {
      hierarchies: [],
      biModel: { connectionId: "c9", tables: [{ name: "BI", columns: [] }, { name: "BI.dim_customer", columns: [] }] },
    };
    await listPivotSlicerItemsFromModel(pivotSlicer({ fieldName: "BI.dim_customer.Name" }));
    expect(calls.find((c) => c.cmd === "bi_get_column_values")?.args).toEqual({
      connectionId: "c9",
      table: "BI.dim_customer",
      column: "Name",
    });
  });

  it("answers null (and reads no model) for a range pivot, a model slicer or a table slicer", async () => {
    hierarchiesById["p-range"] = { hierarchies: [{ index: 0, name: "Region" }] };
    expect(await listPivotSlicerItemsFromModel(pivotSlicer({ cacheSourceId: "p-range" }))).toBeNull();
    expect(await listPivotSlicerItemsFromModel(slicer())).toBeNull();
    expect(await listPivotSlicerItemsFromModel(slicer({ sourceType: "table" }))).toBeNull();
    expect(calls.some((c) => c.cmd === "bi_get_column_values")).toBe(false);
    expect(writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix round 5: the reconcile records nothing; a gesture's overwrites are noted
// ---------------------------------------------------------------------------

describe("what the bridge tells the backend and the gesture about overwrites", () => {
  const reconcileFlags = () => writes().map((c) => requestOf(c).reconcile);

  it("the reconcile's requests carry reconcile: true -- BI and range pivots, applies and clears", async () => {
    hierarchiesById["p-bi"] = { hierarchies: [], biModel: {} };
    hierarchiesById["p-range"] = { hierarchies: [{ index: 3, name: "Geo.Region" }] };
    const reaching = (overrides: Partial<Slicer> = {}) =>
      slicer({
        sourceType: "pivot",
        cacheSourceId: "p-bi",
        connectedSources: [
          { sourceType: "pivot", sourceId: "p-bi" },
          { sourceType: "pivot", sourceId: "p-range" },
        ],
        ...overrides,
      });

    await applySlicerFilter(reaching(), { masksOnly: true });
    expect(writes().map((c) => c.cmd)).toEqual(["apply_pivot_filter", "apply_pivot_filter"]);
    expect(reconcileFlags()).toEqual([true, true]);

    calls.length = 0;
    await applySlicerFilter(reaching({ selectedItems: null }), { masksOnly: true });
    expect(writes().map((c) => c.cmd)).toEqual(["clear_pivot_filter", "clear_pivot_filter"]);
    expect(reconcileFlags()).toEqual([true, true]);

    // A model slicer's page, too.
    calls.length = 0;
    await applySlicerFilter(slicer(), { masksOnly: true });
    expect(reconcileFlags()).toEqual([true, true]);
  });

  it("a click's requests never carry the reconcile flag (the backend records its overwrite)", async () => {
    await applySlicerFilter(slicer());
    expect(writes()).toHaveLength(2);
    expect(reconcileFlags()).toEqual([undefined, undefined]);
  });

  it("every pivot response of the gesture is noted in its tally, BI and range pivots alike", async () => {
    hierarchiesById["p-range"] = { hierarchies: [{ index: 3, name: "Geo.Region" }] };
    overwriteById["p-canvas-a"] = { overwrittenCellCount: 2, overwriteToken: 21 };
    overwriteById["p-range"] = { overwrittenCellCount: 3, overwriteToken: 22 };
    const overwrites = createPivotOverwriteTally();

    await applySlicerFilter(slicer(), { overwrites });
    await applySlicerFilter(
      slicer({
        id: "s-2",
        sourceType: "pivot",
        cacheSourceId: "p-range",
        connectedSources: [{ sourceType: "pivot", sourceId: "p-range" }],
      }),
      { overwrites },
    );
    expect(overwrites.cellCount).toBe(5);
    expect(overwrites.tokens).toEqual([21, 22]);
    expect(overwrites.pivotIds).toEqual(["p-canvas-a", "p-range"]);
  });

  it("a Report Connections Save notes what its clears and applies overwrote", async () => {
    hierarchiesById["p-old"] = { hierarchies: [], biModel: {} };
    hierarchiesById["p-new"] = { hierarchies: [], biModel: {} };
    overwriteById["p-old"] = { overwrittenCellCount: 1, overwriteToken: 31 };
    overwriteById["p-new"] = { overwrittenCellCount: 4, overwriteToken: 32 };
    const overwrites = createPivotOverwriteTally();
    const s = slicer({ sourceType: "pivot", cacheSourceId: "p-old", connectedSources: [] });

    await syncReportConnections(
      s,
      [{ sourceType: "pivot", sourceId: "p-old" }],
      [{ sourceType: "pivot", sourceId: "p-new" }],
      overwrites,
    );
    expect(writes().map((c) => [c.cmd, requestOf(c).pivotId])).toEqual([
      ["clear_pivot_filter", "p-old"],
      ["apply_pivot_filter", "p-new"],
    ]);
    expect(overwrites.cellCount).toBe(5);
    expect(overwrites.tokens).toEqual([31, 32]);
  });
});