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

import { registerChartQueryProvider } from "./chartQueryProvider";
import { refreshBoundQueryObjects } from "../../_shared/lib/queryObjectRefresh";
import { publishPageFilters } from "@api/pageFilters";

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

  it("re-runs only the design-query charts on a changed page AND model when the page's filters move", () => {
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-1", name: "c-1", sheetIndex: 1, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
      { chartId: "c-2", name: "c-2", sheetIndex: 2, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
      { chartId: "c-3", name: "c-3", sheetIndex: 1, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "other" } } },
      { chartId: "c-4", name: "c-4", sheetIndex: 1, spec: { data: { type: "pivot", pivotId: "p-1" } } },
    ]);

    publishPageFilters("test", [
      { sourceId: "s", sourceName: "S", sheetIndex: 1, connectionId: "conn", field: "T.C", includedItems: ["a"] },
    ]);
    expect(mockInvalidateChartCache.mock.calls.map((c) => c[0])).toEqual(["c-1"]);
    expect(mockEmitAppEvent).toHaveBeenCalledTimes(1);

    // Clearing it is a change too.
    mockInvalidateChartCache.mockClear();
    publishPageFilters("test", []);
    expect(mockInvalidateChartCache.mock.calls.map((c) => c[0])).toEqual(["c-1"]);
  });

  it("stops following the page's filters once unregistered", () => {
    mockGetAllCharts.mockReturnValue([
      { chartId: "c-1", name: "c-1", sheetIndex: 1, spec: { data: { type: "designQuery", dslText: "VALUES: [M]", connectionId: "conn" } } },
    ]);
    unregister?.();
    unregister = null;

    publishPageFilters("test", [
      { sourceId: "s", sourceName: "S", sheetIndex: 1, connectionId: "conn", field: "T.C", includedItems: ["a"] },
    ]);
    publishPageFilters("test", []);

    expect(mockInvalidateChartCache).not.toHaveBeenCalled();
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
