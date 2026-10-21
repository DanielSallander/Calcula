//! FILENAME: app/extensions/Charts/lib/__tests__/modelSlicerFiltersDesignQueryCharts.test.ts
// PURPOSE: The whole route of owner decision 5 (2026-10-08) with the backend
//          mocked: a MODEL slicer's selection re-filters the design-query
//          chart on ITS canvas -- and not the one on another sheet -- and
//          clearing the slicer restores the chart's unfiltered query.
// CONTEXT: Three owners meet here and none imports another: the Slicer
//          extension PUBLISHES (Slicer/lib/slicerPageFilters.ts), the seam
//          holds and announces (@api/reportFilters), Charts LISTENS
//          (chartQueryProvider.ts) and MERGES (designQueryChartDataReader.ts).
//          Each has unit tests; this one runs them together with the real
//          event wiring, so a rename on either side, or a publisher that fires
//          an event the provider no longer hears, fails here and not in front
//          of the user. (A test may import across extensions; the boundary
//          lint exempts tests.)
//          What remains for the LIVE run: the rust-canvas lane's measure-only
//          backend, and a journey that clicks a real model slicer on a canvas.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PivotViewResponse } from "@api/pivot";
import type { BiPivotModelInfo } from "../../../_shared/components/types";
import type { DesignQueryRequest } from "../../../_shared/dsl/pivotLayout/designQuery";
import type { Slicer } from "../../../Slicer/lib/slicerTypes";

// --- the Slicer store: what its cache holds ---------------------------------
let slicers: Slicer[] = [];
vi.mock("../../../Slicer/lib/slicerStore", () => ({
  getAllSlicers: () => slicers,
}));

// --- the Charts backend + store + renderer ------------------------------------
const mockInvoke = vi.fn();
vi.mock("../chartsBackend", () => ({
  chartsBackend: { invoke: (...a: unknown[]) => mockInvoke(...a) },
}));

const CHART_ON_CANVAS = {
  chartId: "card-canvas",
  name: "Revenue card",
  sheetIndex: 3,
  spec: { data: { type: "designQuery" as const, dslText: "VALUES: [Revenue]", connectionId: "conn-a" } },
};
const CHART_ON_SHEET1 = {
  chartId: "chart-sheet1",
  name: "Revenue by year",
  sheetIndex: 0,
  spec: { data: { type: "designQuery" as const, dslText: "ROWS: Time.Year\nVALUES: [Revenue]", connectionId: "conn-a" } },
};
const CHARTS = [CHART_ON_CANVAS, CHART_ON_SHEET1];
vi.mock("../chartStore", () => ({
  getAllCharts: () => CHARTS,
  getChartById: (id: string) => CHARTS.find((c) => c.chartId === id) ?? null,
}));

const invalidated: string[] = [];
vi.mock("../../rendering/chartRenderer", () => ({
  invalidateChartCache: (id: string) => invalidated.push(id),
}));

const mockEmitAppEvent = vi.fn();
vi.mock("@api/events", () => ({
  emitAppEvent: (...a: unknown[]) => mockEmitAppEvent(...a),
  onAppEvent: () => () => {},
  AppEvents: { GRID_REFRESH: "app:grid-refresh", AFTER_NEW: "app:after-new", AFTER_OPEN: "app:after-open" },
}));

// --- the page list (P4: pages are sheet IDS): the canvas is sheet 3 ---------
vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  startReportPages: () => () => {},
  onReportPagesChanged: () => () => {},
  getReportPagesSnapshot: () => ({
    pages: [],
    sheetIdByIndex: new Map([
      [0, "sheet1-id"],
      [3, "canvas-id"],
    ]),
    activeIndex: 3,
    version: 1,
  }),
}));

import { installSlicerPageFilterPublisher } from "../../../Slicer/lib/slicerPageFilters";
import { SlicerEvents } from "../../../Slicer/lib/slicerEvents";
import { registerChartQueryProvider } from "../chartQueryProvider";
import { readDesignQueryData } from "../designQueryChartDataReader";

const col = (name: string) => ({ name, dataType: "string", isNumeric: false });
const MODEL: BiPivotModelInfo = {
  tables: [
    { name: "Geo", columns: [col("Region")] },
    { name: "Time", columns: [col("Year")] },
  ],
  measures: [{ name: "Revenue" } as BiPivotModelInfo["measures"][number]],
  connectionId: "conn-a",
};

/** The backend: Revenue is East 10 + West 20; it answers the request it got. */
function runDesignQuery(request: DesignQueryRequest): PivotViewResponse {
  const region = (request.pageFilterFields ?? []).find((f) => f.table === "Geo" && f.column === "Region");
  const kept = region?.includedItems ?? ["East", "West"];
  const total = (kept.includes("East") ? 10 : 0) + (kept.includes("West") ? 20 : 0);
  return {
    pivotId: "dq",
    version: 1,
    rowCount: 2,
    colCount: 2,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: [
      { viewRow: 0, rowType: "ColumnHeader", depth: 0, visible: true, cells: [{ cellType: "Corner", value: "" }, { cellType: "ColumnHeader", value: "Revenue" }] },
      { viewRow: 1, rowType: "GrandTotal", depth: 0, visible: true, cells: [{ cellType: "GrandTotalRow", value: "Grand Total" }, { cellType: "GrandTotal", value: total }] },
    ],
    columns: [
      { viewCol: 0, colType: "RowLabel", depth: 0 },
      { viewCol: 1, colType: "Data", depth: 0 },
    ],
  } as unknown as PivotViewResponse;
}

/** A model slicer on the canvas (sheet 3), on Geo.Region of conn-a. */
function modelSlicer(selectedItems: string[] | null): Slicer {
  return {
    id: "slicer-region",
    name: "Slicer_Region",
    sheetIndex: 3,
    sourceType: "biConnection",
    cacheSourceId: "conn-a",
    fieldName: "Geo.Region",
    selectedItems,
    filterLevel: 1,
    connectedSources: [{ sourceType: "biConnection", sourceId: "conn-a" }],
  } as Slicer;
}

/** What the renderer does with an invalidated chart: read it again. */
async function cardValue(chart: typeof CHART_ON_CANVAS): Promise<number> {
  const data = await readDesignQueryData(chart.spec.data, { chartId: chart.chartId });
  return data.series[0].values[0];
}

/** One animation frame (chartQueryProvider coalesces its repaints into one per frame). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 20);
  });
}

function lastSentRequest(): DesignQueryRequest {
  const calls = mockInvoke.mock.calls.filter((c) => c[0] === "run_design_query");
  return (calls[calls.length - 1][1] as { request: DesignQueryRequest }).request;
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  invalidated.length = 0;
  slicers = [modelSlicer(null)];
  mockInvoke.mockImplementation(async (cmd: string, args: { request: DesignQueryRequest }) => {
    if (cmd === "get_connection_bi_model") return MODEL;
    if (cmd === "run_design_query") return runDesignQuery(args.request);
    throw new Error(`unexpected ${cmd}`);
  });
  cleanups.push(registerChartQueryProvider());
  cleanups.push(installSlicerPageFilterPublisher());
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function select(selectedItems: string[] | null, event: string = SlicerEvents.SLICER_SELECTION_CHANGED): void {
  slicers = [modelSlicer(selectedItems)];
  window.dispatchEvent(new CustomEvent(event, { detail: { slicerId: "slicer-region", selectedItems } }));
}

describe("a model slicer filters the design-query charts on its own canvas", () => {
  it("re-runs the canvas card with the slicer's items, and leaves the chart on another sheet alone", async () => {
    expect(await cardValue(CHART_ON_CANVAS)).toBe(30);

    select(["East"]);

    expect(invalidated).toEqual(["card-canvas"]);
    await nextFrame(); // the provider repaints once per frame
    expect(mockEmitAppEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitAppEvent).toHaveBeenCalledWith("app:grid-refresh");
    expect(await cardValue(CHART_ON_CANVAS)).toBe(10);
    expect(lastSentRequest().pageFilterFields).toEqual([
      { table: "Geo", column: "Region", includedItems: ["East"] },
    ]);
    // The page filter never becomes one of the query's own FILTERS (a GROUP BY
    // column the backend would roll back up with SUM).
    expect(lastSentRequest().filterFields).toEqual([]);

    // The chart on Sheet 1 queries the same model but is not on the slicer's
    // page: it is neither re-run nor filtered when it reads.
    await readDesignQueryData(CHART_ON_SHEET1.spec.data, { chartId: CHART_ON_SHEET1.chartId });
    expect(lastSentRequest().pageFilterFields ?? []).toEqual([]);
  });

  it("clearing the slicer re-runs the card and restores the unfiltered total", async () => {
    select(["West"]);
    expect(await cardValue(CHART_ON_CANVAS)).toBe(20);
    invalidated.length = 0;

    // A Clear Filter lands as a store re-read (SLICER_DATA_CHANGED) with a
    // null selection.
    select(null, SlicerEvents.SLICER_DATA_CHANGED);

    expect(invalidated).toEqual(["card-canvas"]);
    expect(await cardValue(CHART_ON_CANVAS)).toBe(30);
    expect(lastSentRequest().pageFilterFields ?? []).toEqual([]);
  });

  it("a store re-read that changed nothing re-runs nothing (a sheet switch costs no model query)", async () => {
    select(["East"]);
    await nextFrame();
    invalidated.length = 0;
    mockEmitAppEvent.mockClear();

    select(["East"], SlicerEvents.SLICER_DATA_CHANGED);
    select(["East"], SlicerEvents.SLICER_DATA_CHANGED);
    await nextFrame();

    expect(invalidated).toEqual([]);
    expect(mockEmitAppEvent).not.toHaveBeenCalled();
  });

  it("a deactivated Slicer extension withdraws its filters: the card follows a slicer that is no longer there no more", async () => {
    select(["East"]);
    invalidated.length = 0;

    cleanups.splice(1, 1)[0](); // the publisher's cleanup

    expect(invalidated).toEqual(["card-canvas"]);
    expect(await cardValue(CHART_ON_CANVAS)).toBe(30);
  });
});
