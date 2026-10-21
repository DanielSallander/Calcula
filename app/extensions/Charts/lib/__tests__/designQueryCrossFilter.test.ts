//! FILENAME: app/extensions/Charts/lib/__tests__/designQueryCrossFilter.test.ts
// PURPOSE: The design-query reader as a cross-filter TARGET and SOURCE (P4,
//          G4, S5), with the backend mocked: what the seam resolves for the
//          chart is routed to the right part of the request (per-column
//          filters, tuple filters, a second HIGHLIGHT query), the highlight is
//          aligned onto the chart's datums BY MEMBER KEY, and the chart's own
//          selection never filters it.
// CONTEXT: The alignment test is the one with teeth: the highlighted result
//          has FEWER categories than the base and in ANOTHER ORDER, so an
//          index alignment paints North's value on West's bar.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PivotViewResponse } from "@api/pivot";
import {
  clearCrossFilters,
  getCrossFilters,
  publishPageInteractions,
  publishReportFilters,
  setCrossFilter,
  type CrossFilterSelection,
} from "@api/reportFilters";
import type { BiPivotModelInfo } from "../../../_shared/components/types";
import type { DesignQueryRequest } from "../../../_shared/dsl/pivotLayout/designQuery";
// The built-in marks and their cross-filter declarations (bar can highlight, line cannot).
import "../../rendering/chartDispatch";

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

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => ({
    pages: [],
    sheetIdByIndex: new Map([[1, "id-1"]]),
    activeIndex: 1,
    version: 1,
  }),
}));

import { compileDesignQueryPlan, readDesignQueryData } from "../designQueryChartDataReader";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const col = (name: string) => ({ name, dataType: "string", isNumeric: false });
const MODEL: BiPivotModelInfo = {
  tables: [
    { name: "Geo", columns: [col("Region")] },
    { name: "Time", columns: [col("Year")] },
  ],
  measures: [{ name: "Revenue" } as BiPivotModelInfo["measures"][number]],
  connectionId: "conn-a",
};

/** Region members by valueId (the view's `groupMembers` KEYS). */
const REGION_IDS: Record<string, number> = { East: 1, West: 2, North: 3, "": 4 };

/**
 * A design-query view grouped by Geo.Region (field 0) with one value column.
 * Each body row carries its data cell's `groupPath`, and the view carries the
 * keys: the shape S4b's `fill_group_members` gives a design-query result.
 */
function regionView(rows: Array<[region: string, value: number]>): PivotViewResponse {
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
  const body = rows.map(([region, value], i) => ({
    viewRow: i + 1,
    rowType: "Data" as const,
    depth: 0,
    visible: true,
    cells: [
      { cellType: "RowHeader" as const, value: region === "" ? "(Blank)" : region, groupPath: [[0, REGION_IDS[region]]] },
      { cellType: "Data" as const, value, groupPath: [[0, REGION_IDS[region]]] },
    ],
  }));
  return {
    pivotId: "dq",
    version: 1,
    rowCount: body.length + 1,
    colCount: 2,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [{ fieldIndex: 0, name: "Region" }],
    columnFieldSummaries: [],
    rows: [header, ...body],
    columns: [
      { viewCol: 0, colType: "RowLabel", depth: 0 },
      { viewCol: 1, colType: "Data", depth: 0 },
    ],
    groupMembers: [
      { fieldIndex: 0, fieldKey: "Geo.Region", members: Object.entries(REGION_IDS).map(([k, id]) => [id, k]) },
    ],
  } as unknown as PivotViewResponse;
}

const BAR_SOURCE = { type: "designQuery" as const, dslText: "ROWS: Geo.Region\nVALUES: [Revenue]", connectionId: "conn-a" };
const LINE_SOURCE = { type: "designQuery" as const, dslText: "ROWS: Geo.Region\nVALUES: [Revenue]", connectionId: "conn-a" };
const OTHER_SOURCE = { type: "designQuery" as const, dslText: "ROWS: Time.Year\nVALUES: [Revenue]", connectionId: "conn-a" };

/** Another visual's selection on page id-1 (the chart c-9). */
function selection(over: Partial<CrossFilterSelection> = {}): CrossFilterSelection {
  return {
    source: { kind: "chart", id: "c-9" },
    sourceName: "Revenue by Region",
    pageSheetId: "id-1",
    connectionId: "conn-a",
    fields: ["Geo.Region"],
    tuples: [["East"]],
    ...over,
  };
}

/** The run_design_query requests sent, in order. */
function sentRequests(): DesignQueryRequest[] {
  return mockInvoke.mock.calls
    .filter((c) => c[0] === "run_design_query")
    .map((c) => (c[1] as { request: DesignQueryRequest }).request);
}

/** run_design_query answers: the base, then (when asked) the highlight. */
let answers: PivotViewResponse[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  answers = [];
  mockGetAllCharts.mockReturnValue([
    { chartId: "c-bar", name: "Bar", sheetIndex: 1, spec: { mark: "bar", data: BAR_SOURCE } },
    { chartId: "c-line", name: "Line", sheetIndex: 1, spec: { mark: "line", data: LINE_SOURCE } },
    { chartId: "c-9", name: "Other", sheetIndex: 1, spec: { mark: "bar", data: OTHER_SOURCE } },
  ]);
  mockGetChartById.mockImplementation(
    (id: string) => (mockGetAllCharts() as Array<{ chartId: string }>).find((c) => c.chartId === id) ?? null,
  );
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_connection_bi_model") return MODEL;
    if (cmd === "run_design_query") {
      const next = answers.shift();
      if (!next) throw new Error("no answer queued for run_design_query");
      return next;
    }
    throw new Error(`unexpected ${cmd}`);
  });
});

afterEach(() => {
  clearCrossFilters();
  publishReportFilters("slicer", []);
  publishPageInteractions("id-1", null);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("what the seam resolves is routed to the right part of the request", () => {
  it("no selection, no filter: ONE query, no highlight request, no tuple filters", async () => {
    answers = [regionView([["East", 100]])];
    const data = await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(sentRequests()).toHaveLength(1);
    expect(sentRequests()[0].tupleFilters ?? []).toEqual([]);
    expect(data.highlightValues).toBeUndefined();
    expect(data.crossFilterSelf).toBeUndefined();
    // The datums carry their member paths (the chart is a source).
    expect(data.categoryMembers).toEqual([[{ field: "Geo.Region", key: "East" }]]);
    expect(data.seriesMembers).toEqual([[]]);
  });

  it("a RECTANGULAR selection on a chart that cannot highlight (line) FILTERS it: a per-column filter by KEY", async () => {
    setCrossFilter(selection({ tuples: [["East"], [""]] }));
    const plan = await compileDesignQueryPlan(LINE_SOURCE, { chartId: "c-line" });
    expect(plan.request.pageFilterFields).toEqual([{ table: "Geo", column: "Region", includedItems: ["East", ""] }]);
    expect(plan.request.tupleFilters ?? []).toEqual([]);
    expect(plan.highlightRequest).toBeNull();
  });

  it("a NON-rectangular selection filters through a tuple filter, split against the model", async () => {
    setCrossFilter(
      selection({
        fields: ["Geo.Region", "Time.Year"],
        tuples: [
          ["East", "2024"],
          ["West", "2025"],
        ],
      }),
    );
    const plan = await compileDesignQueryPlan(LINE_SOURCE, { chartId: "c-line" });
    expect(plan.request.tupleFilters).toEqual([
      {
        fields: [
          { table: "Geo", column: "Region" },
          { table: "Time", column: "Year" },
        ],
        tuples: [
          ["East", "2024"],
          ["West", "2025"],
        ],
      },
    ]);
    expect(plan.request.pageFilterFields ?? []).toEqual([]);
    expect(plan.highlightRequest).toBeNull();
  });

  it("on a chart that CAN highlight (bar) the selection highlights: the base is unfiltered, a SECOND request carries it", async () => {
    // A page slicer filters both requests alike.
    publishReportFilters("slicer", [
      {
        sourceId: "s-1",
        sourceName: "Slicer_Year",
        sourceRef: { kind: "slicer", id: "s-1" },
        scope: { kind: "page", sheetId: "id-1" },
        connectionId: "conn-a",
        field: "Time.Year",
        includedKeys: ["2024"],
      },
    ]);
    setCrossFilter(selection());
    const plan = await compileDesignQueryPlan(BAR_SOURCE, { chartId: "c-bar" });
    expect(plan.request.pageFilterFields).toEqual([{ table: "Time", column: "Year", includedItems: ["2024"] }]);
    expect(plan.highlightRequest?.pageFilterFields).toEqual([
      { table: "Time", column: "Year", includedItems: ["2024"] },
      { table: "Geo", column: "Region", includedItems: ["East"] },
    ]);
  });

  it("a non-rectangular HIGHLIGHT rides the highlight request's tuple filters only", async () => {
    setCrossFilter(
      selection({
        fields: ["Geo.Region", "Time.Year"],
        tuples: [
          ["East", "2024"],
          ["West", "2025"],
        ],
      }),
    );
    const plan = await compileDesignQueryPlan(BAR_SOURCE, { chartId: "c-bar" });
    expect(plan.request.tupleFilters ?? []).toEqual([]);
    expect(plan.highlightRequest?.tupleFilters).toHaveLength(1);
  });

  it("an interaction pair source -> chart = filter makes a highlight-capable chart FILTER instead", async () => {
    publishPageInteractions("id-1", {
      pairs: [{ source: { kind: "chart", id: "c-9" }, target: { kind: "chart", id: "c-bar" }, mode: "filter" }],
    });
    setCrossFilter(selection());
    const plan = await compileDesignQueryPlan(BAR_SOURCE, { chartId: "c-bar" });
    expect(plan.request.pageFilterFields).toEqual([{ table: "Geo", column: "Region", includedItems: ["East"] }]);
    expect(plan.highlightRequest).toBeNull();
  });

  it("a tuple filter naming a column the model does not have is skipped WHOLE (never widened to one column)", async () => {
    setCrossFilter(
      selection({
        fields: ["Geo.Region", "Nowhere.Thing"],
        tuples: [
          ["East", "a"],
          ["West", "b"],
        ],
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plan = await compileDesignQueryPlan(LINE_SOURCE, { chartId: "c-line" });
    expect(plan.request.tupleFilters ?? []).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("the chart's OWN selection never filters or highlights it", async () => {
    setCrossFilter(selection({ source: { kind: "chart", id: "c-bar" } }));
    const plan = await compileDesignQueryPlan(BAR_SOURCE, { chartId: "c-bar" });
    expect(plan.request.pageFilterFields ?? []).toEqual([]);
    expect(plan.request.tupleFilters ?? []).toEqual([]);
    expect(plan.highlightRequest).toBeNull();
    expect(plan.self).toEqual({ ref: { kind: "chart", id: "c-bar" }, pageSheetId: "id-1", connectionId: "conn-a" });
  });
});

// ---------------------------------------------------------------------------
// The highlight query and its alignment
// ---------------------------------------------------------------------------

describe("the highlight is aligned onto the datums BY MEMBER KEY", () => {
  it("runs the second query only while a highlight applies", async () => {
    answers = [regionView([["East", 100]])];
    await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(sentRequests()).toHaveLength(1);

    vi.clearAllMocks();
    setCrossFilter(selection());
    answers = [regionView([["East", 100]]), regionView([["East", 40]])];
    await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(sentRequests()).toHaveLength(2);
  });

  it("a highlighted result with FEWER categories in ANOTHER ORDER lands on the right bars; a missing member reads 0", async () => {
    setCrossFilter(selection({ tuples: [["East"], ["North"]] }));
    answers = [
      regionView([
        ["East", 100],
        ["West", 200],
        ["North", 50],
      ]),
      // The highlight keeps North and East only, North first.
      regionView([
        ["North", 10],
        ["East", 40],
      ]),
    ];
    const data = await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(data.categories).toEqual(["East", "West", "North"]);
    expect(data.series[0].values).toEqual([100, 200, 50]);
    expect(data.highlightValues).toEqual([[40, 0, 10]]);
  });

  it("the blank member aligns by its key \"\" (never by its label)", async () => {
    setCrossFilter(selection({ tuples: [[""]] }));
    answers = [
      regionView([
        ["East", 100],
        ["", 7],
      ]),
      regionView([["", 3]]),
    ];
    const data = await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(data.highlightValues).toEqual([[0, 3]]);
  });

  it("a view without member keys paints no highlight rather than a misaligned one", async () => {
    setCrossFilter(selection());
    const noKeys = (v: PivotViewResponse) => ({ ...v, groupMembers: undefined }) as PivotViewResponse;
    answers = [noKeys(regionView([["East", 100], ["West", 200]])), noKeys(regionView([["West", 9]]))];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(data.highlightValues).toBeUndefined();
    expect(data.categoryMembers).toBeUndefined();
    warn.mockRestore();
  });

  it("a failing highlight query leaves the base chart painted, unhighlighted", async () => {
    setCrossFilter(selection());
    answers = [regionView([["East", 100]])]; // the second call finds no answer and throws
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(data.series[0].values).toEqual([100]);
    expect(data.highlightValues).toBeUndefined();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The chart as a SOURCE
// ---------------------------------------------------------------------------

describe("the chart's own selection: marked, and pruned when its members vanish", () => {
  it("marks the selected datums (crossFilterSelf) and is not filtered by them", async () => {
    setCrossFilter(selection({ source: { kind: "chart", id: "c-bar" }, tuples: [["West"]] }));
    answers = [
      regionView([
        ["East", 100],
        ["West", 200],
      ]),
    ];
    const data = await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(sentRequests()).toHaveLength(1);
    expect(data.crossFilterSelf).toEqual({ categories: [false, true], datums: [[false, true]] });
  });

  it("a selected member the query no longer returns is pruned; the selection goes when nothing is left", async () => {
    setCrossFilter(selection({ source: { kind: "chart", id: "c-bar" }, tuples: [["West"], ["Gone"]] }));
    answers = [regionView([["West", 200]])];
    await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(getCrossFilters("id-1").find((s) => s.source.id === "c-bar")?.tuples).toEqual([["West"]]);

    answers = [regionView([["East", 100]])];
    const data = await readDesignQueryData(BAR_SOURCE, { chartId: "c-bar" });
    expect(getCrossFilters("id-1").find((s) => s.source.id === "c-bar")).toBeUndefined();
    expect(data.crossFilterSelf).toBeUndefined();
  });
});
