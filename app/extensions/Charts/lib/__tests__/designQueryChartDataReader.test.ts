//! FILENAME: app/extensions/Charts/lib/__tests__/designQueryChartDataReader.test.ts
// PURPOSE: The design-query reader's two Power BI duties (CONTRACT-CANVAS
//          §4.8): a MEASURE-ONLY query is one category (a Card's number), and
//          the page's model filters are merged into the query of a chart on
//          THAT page and no other.
// CONTEXT: The reader dropped grand totals unconditionally, so `VALUES:
//          [Revenue]` -- whose view has nothing BUT a grand total -- came back
//          with no categories: a Card with no number and no error. And a model
//          slicer reached only BI pivots, so a design-query chart beside it
//          showed every region while the slicer said "East".
//          The merge is pinned pure (where a filter lands, how two narrow one
//          column) and through compileDesignQuerySource with a mocked backend
//          (which page's filters a read takes).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PivotViewResponse } from "@api/pivot";
import {
  publishPageInteractions,
  publishReportFilters,
  type ReportFilterInput,
  type ResolvedFieldFilter,
} from "@api/reportFilters";
import type { BiPivotModelInfo } from "../../../_shared/components/types";
import type { DesignQueryRequest } from "../../../_shared/dsl/pivotLayout/designQuery";

const mockInvoke = vi.fn();
vi.mock("../chartsBackend", () => ({
  chartsBackend: { invoke: (...a: unknown[]) => mockInvoke(...a) },
}));

const mockGetAllCharts = vi.fn();
const mockGetChartById = vi.fn();
vi.mock("../chartStore", () => ({
  getAllCharts: (...a: unknown[]) => mockGetAllCharts(...a),
  getChartById: (...a: unknown[]) => mockGetChartById(...a),
}));

// The page list (P4: pages are sheet IDS): sheet 1 is "id-1", sheet 2 "id-2".
vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => ({
    pages: [],
    sheetIdByIndex: new Map([
      [1, "id-1"],
      [2, "id-2"],
    ]),
    activeIndex: 1,
    version: 1,
  }),
}));

import {
  compileDesignQuerySource,
  designQueryChartData,
  designQueryPageOf,
  mergePageFilters,
  readDesignQueryData,
} from "../designQueryChartDataReader";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const col = (name: string) => ({ name, dataType: "string", isNumeric: false });
const MODEL: BiPivotModelInfo = {
  tables: [
    { name: "Geo", columns: [col("Region"), col("City")] },
    { name: "Time", columns: [col("Year")] },
    // A dotted table name: the field key must be split against the model.
    { name: "dbo.Sales", columns: [col("Channel")] },
  ],
  measures: [{ name: "Revenue" } as BiPivotModelInfo["measures"][number]],
  connectionId: "conn-a",
};
const TABLES = MODEL.tables.map((t) => t.name);

function pf(field: string, includedKeys: string[], over: Partial<ResolvedFieldFilter> = {}): ResolvedFieldFilter {
  return {
    field,
    includedKeys,
    level: 1,
    from: `Slicer ${field}`,
    ...over,
  };
}

/** A model slicer's filter on page "id-1", as the Slicer extension publishes it. */
function slicerFilter(over: Partial<ReportFilterInput> = {}): ReportFilterInput {
  return {
    sourceId: "s-1",
    sourceName: "Slicer_Region",
    sourceRef: { kind: "slicer", id: "s-1" },
    scope: { kind: "page", sheetId: "id-1" },
    connectionId: "conn-a",
    field: "Geo.Region",
    includedKeys: ["East"],
    ...over,
  };
}

function request(over: Partial<DesignQueryRequest> = {}): DesignQueryRequest {
  return {
    connectionId: "conn-a",
    rowFields: [{ table: "Time", column: "Year" }],
    columnFields: [],
    valueFields: [{ measureName: "Revenue" }],
    filterFields: [],
    ...over,
  };
}

/** A pivot view: header row, then the given body rows; one value column. */
function view(body: Array<{ type: "Data" | "Subtotal" | "GrandTotal"; label: string; value: number | string; visible?: boolean; formatted?: string }>): PivotViewResponse {
  const header = {
    viewRow: 0,
    rowType: "ColumnHeader" as const,
    depth: 0,
    visible: true,
    cells: [
      { cellType: "Corner" as const, value: "" },
      { cellType: "ColumnHeader" as const, value: "Revenue" },
    ],
  };
  const rows = body.map((r, i) => ({
    viewRow: i + 1,
    rowType: r.type,
    depth: 0,
    visible: r.visible ?? true,
    cells: [
      { cellType: (r.type === "GrandTotal" ? "GrandTotalRow" : "RowHeader") as "RowHeader", value: r.label },
      {
        cellType: (r.type === "GrandTotal" ? "GrandTotal" : "Data") as "Data",
        value: r.value,
        ...(r.formatted ? { formattedValue: r.formatted } : {}),
      },
    ],
  }));
  return {
    pivotId: "dq",
    version: 1,
    rowCount: rows.length + 1,
    colCount: 2,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: [header, ...rows],
    columns: [
      { viewCol: 0, colType: "RowLabel", depth: 0 },
      { viewCol: 1, colType: "Data", depth: 0 },
    ],
  } as unknown as PivotViewResponse;
}

// ---------------------------------------------------------------------------
// The measure-only query
// ---------------------------------------------------------------------------

describe("designQueryChartData: a measure-only query is ONE category", () => {
  it("reads the grand total when there are no row fields (the Card's number)", () => {
    const data = designQueryChartData(view([{ type: "GrandTotal", label: "Grand Total", value: 1234.5 }]), { rowFields: [] });

    expect(data.categories).toEqual(["Grand Total"]);
    expect(data.series).toEqual([{ name: "Revenue", values: [1234.5], color: null }]);
  });

  it("reads ONLY the grand total when the backend also emits a synthetic data row (never the number twice)", () => {
    const data = designQueryChartData(
      view([
        { type: "Data", label: "Total", value: 1234.5 },
        { type: "GrandTotal", label: "Grand Total", value: 1234.5 },
      ]),
      { rowFields: [] },
    );

    expect(data.categories).toEqual(["Grand Total"]);
    expect(data.series[0].values).toEqual([1234.5]);
  });

  it("falls back to the data rows when the layout hides the grand total", () => {
    const data = designQueryChartData(
      view([
        { type: "Data", label: "Total", value: 7 },
        { type: "GrandTotal", label: "Grand Total", value: 7, visible: false },
      ]),
      { rowFields: [] },
    );

    expect(data.categories).toEqual(["Total"]);
    expect(data.series[0].values).toEqual([7]);
  });

  it("still drops the grand total (and subtotals) when the query HAS row fields", () => {
    const data = designQueryChartData(
      view([
        { type: "Data", label: "2023", value: 10 },
        { type: "Subtotal", label: "Sub", value: 10 },
        { type: "Data", label: "2024", value: 20 },
        { type: "GrandTotal", label: "Grand Total", value: 30 },
      ]),
      { rowFields: [{ table: "Time", column: "Year" }] },
    );

    expect(data.categories).toEqual(["2023", "2024"]);
    expect(data.series[0].values).toEqual([10, 20]);
  });
});

describe("designQueryChartData: displayValues (the text a Card shows)", () => {
  it("carries a formatted measure's text for the one total (the Card keeps the model's format)", () => {
    const data = designQueryChartData(
      view([{ type: "GrandTotal", label: "Grand Total", value: 1234.5, formatted: "$1,234.50" }]),
      { rowFields: [] },
    );

    expect(data.displayValues).toEqual([["$1,234.50"]]);
  });

  it("aligns the texts with the categories it kept: no subtotal, no hidden row, no grand total", () => {
    const data = designQueryChartData(
      view([
        { type: "Data", label: "2023", value: 0, formatted: "n/a" },
        { type: "Data", label: "2023b", value: 99, visible: false, formatted: "hidden" },
        { type: "Subtotal", label: "Sub", value: 10, formatted: "sub" },
        { type: "Data", label: "2024", value: 20, formatted: "20.0%" },
        { type: "GrandTotal", label: "Grand Total", value: 30, formatted: "total" },
      ]),
      { rowFields: [{ table: "Time", column: "Year" }] },
    );

    expect(data.categories).toEqual(["2023", "2024"]);
    expect(data.displayValues).toEqual([["n/a", "20.0%"]]);
  });

  it("a text value is its text (never the 0 the number parser wrote)", () => {
    const data = designQueryChartData(view([{ type: "GrandTotal", label: "Grand Total", value: "Pending" }]), { rowFields: [] });

    expect(data.series[0].values).toEqual([0]);
    expect(data.displayValues).toEqual([["Pending"]]);
  });

  it("leaves the field ABSENT when every value is a plain unformatted number (the visual's units write it)", () => {
    const data = designQueryChartData(view([{ type: "GrandTotal", label: "Grand Total", value: 1 / 3 }]), { rowFields: [] });

    expect(data.displayValues).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergePageFilters, pure
// ---------------------------------------------------------------------------

describe("mergePageFilters", () => {
  // THE WIRE CONTRACT (fix-charts, 2026-10-08): the page's filters travel in
  // `pageFilterFields`, apart from the query's own FILTERS, and the backend
  // runs them INSIDE the engine query (headless.rs page_filter_fields) -- never
  // as a GROUP BY column it then rolls back up with SUM, which made an AVERAGE
  // under a slicer keeping two items read avg(East) + avg(West).

  it("sends a page filter as a pageFilterFields entry, leaving the query's own zones alone", () => {
    const out = mergePageFilters(request(), [pf("Geo.Region", ["East"])], TABLES);

    expect(out.pageFilterFields).toEqual([{ table: "Geo", column: "Region", includedItems: ["East"] }]);
    expect(out.filterFields).toEqual([]);
    expect(out.rowFields).toEqual([{ table: "Time", column: "Year" }]);
  });

  it("a column already on ROWS is filtered by the engine too -- the ROWS ref is not touched", () => {
    const rows = [{ table: "Geo", column: "Region", hiddenItems: ["North"] }];
    const out = mergePageFilters(request({ rowFields: rows }), [pf("Geo.Region", ["East", "West"])], TABLES);

    expect(out.rowFields).toEqual(rows);
    expect(out.pageFilterFields).toEqual([{ table: "Geo", column: "Region", includedItems: ["East", "West"] }]);
  });

  it("two slicers on one column are two entries (the engine applies both)", () => {
    const out = mergePageFilters(
      request(),
      [pf("Geo.Region", ["East", "West"]), pf("Geo.Region", ["West", "South"], { from: "Slicer 2" })],
      TABLES,
    );

    expect(out.pageFilterFields).toEqual([
      { table: "Geo", column: "Region", includedItems: ["East", "West"] },
      { table: "Geo", column: "Region", includedItems: ["West", "South"] },
    ]);
  });

  it("a PINNED slicer carries its level, so a CLEAR in a measure treats it as the BI pivot does", () => {
    const out = mergePageFilters(request(), [pf("Geo.Region", ["East"], { level: 3 })], TABLES);

    expect(out.pageFilterFields).toEqual([{ table: "Geo", column: "Region", includedItems: ["East"], level: 3 }]);
  });

  it("splits a dotted table name against the model and keeps the model's column spelling as given", () => {
    const out = mergePageFilters(request(), [pf("dbo.Sales.Channel", ["Web"])], TABLES);

    expect(out.pageFilterFields).toEqual([{ table: "dbo.Sales", column: "Channel", includedItems: ["Web"] }]);
  });

  it("an empty kept list keeps nothing (it is sent, not dropped)", () => {
    const out = mergePageFilters(request(), [pf("Geo.Region", [])], TABLES);

    expect(out.pageFilterFields).toEqual([{ table: "Geo", column: "Region", includedItems: [] }]);
  });

  it("skips a field whose table the model does not have, and leaves the request otherwise intact", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = mergePageFilters(request(), [pf("Gone", ["x"]), pf("Geo.Region", ["East"])], TABLES);

    expect(out.pageFilterFields!.map((f) => `${f.table}.${f.column}`)).toEqual(["Geo.Region"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips a DOTTED field whose table the model does not have (no first-dot guess at a table)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = mergePageFilters(request(), [pf("Gone.Region", ["x"]), pf("Geo.Region", ["East"])], TABLES);

    expect(out.pageFilterFields!.map((f) => `${f.table}.${f.column}`)).toEqual(["Geo.Region"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("no filters: the request is returned as it was (no empty pageFilterFields)", () => {
    const original = request();
    expect(mergePageFilters(original, [], TABLES)).toBe(original);
  });

  it("never mutates the compiled request it was given", () => {
    const original = request({ rowFields: [{ table: "Geo", column: "Region" }] });
    const snapshot = JSON.parse(JSON.stringify(original));

    mergePageFilters(original, [pf("Geo.Region", ["East"]), pf("Time.Year", ["2024"])], TABLES);

    expect(original).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Which page a read takes its filters from
// ---------------------------------------------------------------------------

const SOURCE_ON_1 = { type: "designQuery" as const, dslText: "ROWS: Time.Year\nVALUES: [Revenue]", connectionId: "conn-a" };
const SOURCE_ON_2 = { type: "designQuery" as const, dslText: "ROWS: Time.Year\nVALUES: [Revenue]", connectionId: "conn-a" };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllCharts.mockReturnValue([
    { chartId: "c-1", name: "Chart 1", sheetIndex: 1, spec: { data: SOURCE_ON_1 } },
    { chartId: "c-2", name: "Chart 2", sheetIndex: 2, spec: { data: SOURCE_ON_2 } },
  ]);
  mockGetChartById.mockImplementation((id: string) =>
    (mockGetAllCharts() as Array<{ chartId: string }>).find((c) => c.chartId === id) ?? null,
  );
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_connection_bi_model") return MODEL;
    if (cmd === "run_design_query") return view([{ type: "GrandTotal", label: "Grand Total", value: 5 }]);
    throw new Error(`unexpected ${cmd}`);
  });
  publishReportFilters("slicer", [slicerFilter()]);
});

afterEach(() => {
  publishReportFilters("slicer", []);
  publishReportFilters("ribbon", []);
  publishPageInteractions("id-1", null);
});

describe("compileDesignQuerySource takes the filters of the chart's OWN page", () => {
  it("by the chart named in the context", async () => {
    const req = await compileDesignQuerySource(SOURCE_ON_1, { chartId: "c-1" });
    expect(req.pageFilterFields).toEqual([{ table: "Geo", column: "Region", includedItems: ["East"] }]);

    const other = await compileDesignQuerySource(SOURCE_ON_2, { chartId: "c-2" });
    expect(other.pageFilterFields ?? []).toEqual([]);
  });

  it("by the page named in the context (it wins over the chart)", async () => {
    const req = await compileDesignQuerySource(SOURCE_ON_2, { chartId: "c-2", sheetIndex: 1 });
    expect(req.pageFilterFields?.[0]?.includedItems).toEqual(["East"]);
  });

  it("by IDENTITY of the stored source when no context is given -- never by equal content", async () => {
    // SOURCE_ON_1 and SOURCE_ON_2 are equal in content; only the object
    // tells their pages apart.
    expect(designQueryPageOf(SOURCE_ON_1)).toBe("id-1");
    expect(designQueryPageOf(SOURCE_ON_2)).toBe("id-2");
    expect((await compileDesignQuerySource(SOURCE_ON_1)).pageFilterFields ?? []).toHaveLength(1);
    expect((await compileDesignQuerySource(SOURCE_ON_2)).pageFilterFields ?? []).toHaveLength(0);
  });

  it("reads unfiltered for a source no stored chart holds (the create dialog's preview)", async () => {
    const preview = { ...SOURCE_ON_1 };
    expect(designQueryPageOf(preview)).toBeUndefined();
    expect((await compileDesignQuerySource(preview)).pageFilterFields ?? []).toEqual([]);
  });

  it("ignores another model's filters on the same page", async () => {
    publishReportFilters("slicer", [
      slicerFilter({ sourceId: "s-9", sourceName: "Other", connectionId: "conn-b", includedKeys: ["West"] }),
    ]);
    expect((await compileDesignQuerySource(SOURCE_ON_1, { chartId: "c-1" })).pageFilterFields ?? []).toEqual([]);
  });

  it("a page whose sheet has no id in the page list yet reads unfiltered (never under a guessed page)", async () => {
    expect(designQueryPageOf(SOURCE_ON_1, { sheetIndex: 7 })).toBeUndefined();
    expect((await compileDesignQuerySource(SOURCE_ON_1, { sheetIndex: 7 })).pageFilterFields ?? []).toEqual([]);
  });

  it("an interaction pair slicer -> chart = none drops the slicer for THAT chart only (P4)", async () => {
    const twin = { ...SOURCE_ON_1 };
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-1", name: "Chart 1", sheetIndex: 1, spec: { data: SOURCE_ON_1 } },
      { chartId: "c-3", name: "Chart 3", sheetIndex: 1, spec: { data: twin } },
    ]);
    publishPageInteractions("id-1", {
      pairs: [{ source: { kind: "slicer", id: "s-1" }, target: { kind: "chart", id: "c-1" }, mode: "none" }],
    });
    expect((await compileDesignQuerySource(SOURCE_ON_1, { chartId: "c-1" })).pageFilterFields ?? []).toEqual([]);
    expect((await compileDesignQuerySource(twin, { chartId: "c-3" })).pageFilterFields).toEqual([
      { table: "Geo", column: "Region", includedItems: ["East"] },
    ]);
  });

  it("a ribbon filter scoped to the chart (visuals) reaches it and no other chart of the page", async () => {
    const twin = { ...SOURCE_ON_1 };
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-1", name: "Chart 1", sheetIndex: 1, spec: { data: SOURCE_ON_1 } },
      { chartId: "c-3", name: "Chart 3", sheetIndex: 1, spec: { data: twin } },
    ]);
    publishReportFilters("slicer", []);
    publishReportFilters("ribbon", [
      slicerFilter({
        sourceId: "rf-1",
        sourceName: "Year",
        sourceRef: null,
        scope: { kind: "visuals", targets: [{ kind: "chart", id: "c-3" }] },
        field: "Time.Year",
        includedKeys: ["2024"],
        filterLevel: 2,
      }),
    ]);
    expect((await compileDesignQuerySource(SOURCE_ON_1, { chartId: "c-1" })).pageFilterFields ?? []).toEqual([]);
    expect((await compileDesignQuerySource(twin, { chartId: "c-3" })).pageFilterFields).toEqual([
      { table: "Time", column: "Year", includedItems: ["2024"], level: 2 },
    ]);
  });

  it("readDesignQueryData sends the merged request and reads a measure-only result as one category", async () => {
    const measureOnly = { type: "designQuery" as const, dslText: "VALUES: [Revenue]", connectionId: "conn-a" };

    const data = await readDesignQueryData(measureOnly, { sheetIndex: 1 });

    const sent = mockInvoke.mock.calls.find((c) => c[0] === "run_design_query")?.[1] as { request: DesignQueryRequest };
    expect(sent.request.rowFields).toEqual([]);
    expect(sent.request.columnFields).toEqual([]);
    // The DSL compiles a measure-only query (no validator refusal on the
    // frontend); the backend's refusal is the rust-canvas lane's half.
    expect(sent.request.valueFields.map((v) => v.measureName)).toEqual(["Revenue"]);
    expect(sent.request.pageFilterFields).toEqual([{ table: "Geo", column: "Region", includedItems: ["East"] }]);
    expect(data.categories).toEqual(["Grand Total"]);
    expect(data.series[0].values).toEqual([5]);
  });
});

// ---------------------------------------------------------------------------
// The chart's data formats ride the value fields (WP-C S9b)
// ---------------------------------------------------------------------------

describe("spec.fieldFormats -> request.valueFields[i].numberFormat (by measure name)", () => {
  const twoMeasures = { type: "designQuery" as const, dslText: "ROWS: Time.Year\nVALUES: [Revenue], [Cost]", connectionId: "conn-a" };
  const withCost: BiPivotModelInfo = {
    ...MODEL,
    measures: [...MODEL.measures, { name: "Cost" } as BiPivotModelInfo["measures"][number]],
  };

  beforeEach(() => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_connection_bi_model") return withCost;
      if (cmd === "run_design_query") return view([{ type: "GrandTotal", label: "Grand Total", value: 5 }]);
      throw new Error(`unexpected ${cmd}`);
    });
  });

  it("the context's formats are attached to the matching measure only", async () => {
    const req = await compileDesignQuerySource(twoMeasures, { fieldFormats: { Revenue: "#,##0.00" } });
    expect(req.valueFields).toEqual([
      { measureName: "Revenue", customName: "[Revenue]", numberFormat: "#,##0.00" },
      { measureName: "Cost", customName: "[Cost]" },
    ]);
  });

  it("absent formats -> NO numberFormat key at all (the backend's default stands)", async () => {
    const req = await compileDesignQuerySource(twoMeasures, { fieldFormats: undefined });
    for (const f of req.valueFields) expect("numberFormat" in f).toBe(false);
    // An empty entry is no format either.
    const empty = await compileDesignQuerySource(twoMeasures, { fieldFormats: { Revenue: "" } });
    expect("numberFormat" in empty.valueFields[0]).toBe(false);
  });

  it("with no formats in the context, the STORED chart's are read (by id, else by the source object)", async () => {
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-9", name: "Chart 9", sheetIndex: 1, spec: { data: twoMeasures, fieldFormats: { Cost: "0%" } } },
    ]);
    const byId = await compileDesignQuerySource(twoMeasures, { chartId: "c-9" });
    expect(byId.valueFields.map((f) => f.numberFormat)).toEqual([undefined, "0%"]);
    const bySource = await compileDesignQuerySource(twoMeasures);
    expect(bySource.valueFields.map((f) => f.numberFormat)).toEqual([undefined, "0%"]);
  });

  it("readDesignQueryData SENDS the format on the run_design_query request", async () => {
    await readDesignQueryData(twoMeasures, { fieldFormats: { Cost: "0.0%" } });
    const sent = mockInvoke.mock.calls.find((c) => c[0] === "run_design_query")?.[1] as { request: DesignQueryRequest };
    expect(sent.request.valueFields[1]).toEqual({ measureName: "Cost", customName: "[Cost]", numberFormat: "0.0%" });
    expect("numberFormat" in sent.request.valueFields[0]).toBe(false);
  });
});
