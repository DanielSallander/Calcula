//! FILENAME: app/extensions/Charts/lib/chartQueryProvider.test.ts
// PURPOSE: The Charts family hookup to the shared query-object refresh service:
//   only design-query charts with @param bindings are targeted; refresh =
//   invalidate + one overlay repaint.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetAllCharts = vi.fn();
vi.mock("./chartStore", () => ({
  getAllCharts: (...a: unknown[]) => mockGetAllCharts(...a),
}));

const mockInvalidateChartCache = vi.fn();
vi.mock("../rendering/chartRenderer", () => ({
  invalidateChartCache: (...a: unknown[]) => mockInvalidateChartCache(...a),
}));

const mockEmitAppEvent = vi.fn();
vi.mock("@api/events", () => ({
  emitAppEvent: (...a: unknown[]) => mockEmitAppEvent(...a),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
}));

// The page list: sheet 1 is "id-1", sheet 2 is "id-2" (P4: pages by sheet id).
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

import { registerChartQueryProvider, chartsReachedByReportFilters } from "./chartQueryProvider";
import { refreshBoundQueryObjects } from "../../_shared/lib/queryObjectRefresh";
import { publishReportFilters, type ReportFilterInput } from "@api/reportFilters";

function pageFilter(over: Partial<ReportFilterInput> = {}): ReportFilterInput {
  return {
    sourceId: "s",
    sourceName: "S",
    sourceRef: null,
    scope: { kind: "page", sheetId: "id-1" },
    connectionId: "conn",
    field: "T.C",
    includedKeys: ["a"],
    ...over,
  };
}

/** One animation frame (the provider coalesces its report-filter repaints into one per frame). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 20);
  });
}

function chart(chartId: string, data: unknown, name = chartId) {
  return { chartId, name, spec: { data } };
}

let unregister: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  unregister = registerChartQueryProvider();
});

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("chartQueryProvider", () => {
  it("invalidates only design-query charts bound to the changed control", async () => {
    mockGetAllCharts.mockReturnValue([
      chart("c-1", { type: "designQuery", dslText: "FILTERS: x = @Region\nVALUES: [M]", connectionId: "conn" }),
      chart("c-2", { type: "designQuery", dslText: "ROWS: a\nVALUES: [M]", connectionId: "conn" }),
      chart("c-3", { type: "pivot", pivotId: "p-1" }),
      chart("c-4", "A1:B4"),
    ]);

    await refreshBoundQueryObjects(["Region"]);

    expect(mockInvalidateChartCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateChartCache).toHaveBeenCalledWith("c-1");
    // Charts are overlays: repaint-only app event, exactly once per pass.
    expect(mockEmitAppEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitAppEvent).toHaveBeenCalledWith("app:grid-refresh");
  });

  it("re-runs only the design-query charts on a changed page AND model when the page's filters move", async () => {
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-1", name: "c-1", sheetIndex: 1, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
      { chartId: "c-2", name: "c-2", sheetIndex: 2, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
      { chartId: "c-3", name: "c-3", sheetIndex: 1, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "other" } } },
      { chartId: "c-4", name: "c-4", sheetIndex: 1, spec: { data: { type: "pivot", pivotId: "p-1" } } },
    ]);

    publishReportFilters("test", [pageFilter()]);
    expect(mockInvalidateChartCache.mock.calls.map((c) => c[0])).toEqual(["c-1"]);
    // The repaint waits for the frame (coalesced), the invalidation does not.
    expect(mockEmitAppEvent).not.toHaveBeenCalled();
    await nextFrame();
    expect(mockEmitAppEvent).toHaveBeenCalledTimes(1);

    // Clearing it is a change too.
    mockInvalidateChartCache.mockClear();
    publishReportFilters("test", []);
    expect(mockInvalidateChartCache.mock.calls.map((c) => c[0])).toEqual(["c-1"]);
  });

  it("stops following the page's filters once unregistered", () => {
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-1", name: "c-1", sheetIndex: 1, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
    ]);
    unregister?.();
    unregister = null;

    publishReportFilters("test", [pageFilter()]);
    publishReportFilters("test", []);

    expect(mockInvalidateChartCache).not.toHaveBeenCalled();
  });

  it("an all-pages change reaches every chart on the model; a targeted change reaches its charts on any page", () => {
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-1", name: "c-1", sheetIndex: 1, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
      { chartId: "c-2", name: "c-2", sheetIndex: 2, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
      { chartId: "c-3", name: "c-3", sheetIndex: 2, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "other" } } },
      { chartId: "c-9", name: "c-9", sheetIndex: 7, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
    ]);
    expect(chartsReachedByReportFilters({ pages: [{ sheetId: "*", connectionId: "conn" }], targets: [] })).toEqual([
      "c-1",
      "c-2",
      "c-9",
    ]);
    expect(chartsReachedByReportFilters({ pages: [{ sheetId: "id-2", connectionId: "conn" }], targets: [] })).toEqual(["c-2"]);
    // A sheet with no id in the page list is never matched by a page key ...
    expect(chartsReachedByReportFilters({ pages: [{ sheetId: "id-7", connectionId: "conn" }], targets: [] })).toEqual([]);
    // ... but a named target is reached wherever it sits; other kinds are not charts.
    expect(
      chartsReachedByReportFilters({
        pages: [],
        targets: [
          { kind: "chart", id: "c-3" },
          { kind: "pivot", id: "c-1" },
        ],
      }),
    ).toEqual(["c-3"]);

    publishReportFilters("test", [pageFilter({ scope: { kind: "visuals", targets: [{ kind: "chart", id: "c-9" }] } })]);
    expect(mockInvalidateChartCache.mock.calls.map((c) => c[0])).toEqual(["c-9"]);
    publishReportFilters("test", []);
  });

  it("several report-filter changes in one frame cost ONE repaint (coalesced), and the next frame repaints again", async () => {
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-1", name: "c-1", sheetIndex: 1, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
      { chartId: "c-2", name: "c-2", sheetIndex: 2, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
    ]);

    publishReportFilters("test", [pageFilter()]);
    publishReportFilters("test", [pageFilter({ scope: { kind: "page", sheetId: "id-2" } })]);
    publishReportFilters("test", [pageFilter({ scope: { kind: "all" } })]);
    // Every change invalidated its charts at once ...
    expect(mockInvalidateChartCache.mock.calls.map((c) => c[0])).toEqual(["c-1", "c-1", "c-2", "c-1", "c-2"]);
    await nextFrame();
    // ... and the frame repainted once.
    expect(mockEmitAppEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitAppEvent).toHaveBeenCalledWith("app:grid-refresh");

    publishReportFilters("test", []);
    await nextFrame();
    expect(mockEmitAppEvent).toHaveBeenCalledTimes(2);
  });

  it("an unregister cancels a repaint still waiting for its frame", async () => {
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-1", name: "c-1", sheetIndex: 1, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
    ]);
    publishReportFilters("test", [pageFilter()]);
    unregister?.();
    unregister = null;
    await nextFrame();
    expect(mockEmitAppEvent).not.toHaveBeenCalled();
    publishReportFilters("test", []);
  });

  it("does nothing when no design-query chart references the control", async () => {
    mockGetAllCharts.mockReturnValue([
      chart("c-1", { type: "designQuery", dslText: "FILTERS: x = @Other\nVALUES: [M]", connectionId: "conn" }),
    ]);

    await refreshBoundQueryObjects(["Region"]);

    expect(mockInvalidateChartCache).not.toHaveBeenCalled();
    expect(mockEmitAppEvent).not.toHaveBeenCalled();
  });
});
