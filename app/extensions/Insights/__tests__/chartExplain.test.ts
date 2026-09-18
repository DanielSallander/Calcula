//! FILENAME: app/extensions/Insights/__tests__/chartExplain.test.ts
// PURPOSE: What "Analyse" is about right now — the routing between a selected
//          chart, the grid selection and the model switch.
// CONTEXT: The owner selected a chart, pressed Analyse, and got facts about the
//          cell they had last clicked. Selecting a chart is deliberate and it is
//          the most recent act, so it names the subject; the grid selection is
//          what remains when no chart is selected. The model switch beats both,
//          because that is a position the reader SET rather than an incidental
//          selection.
//
//          These are routing tests: which backend command is called, with what.
//          The analysis itself is Rust's and is tested there.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolveSeries: vi.fn(),
  selectedChartId: { current: null as string | null },
  charts: { current: [] as Array<{ chartId: string; name: string; title: string | null }> },
  gridState: {
    current: {
      selection: { startRow: 1, startCol: 1, endRow: 9, endCol: 3, type: "cells" },
      sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
    } as unknown,
  },
}));

vi.mock("@api/backendCommands", () => ({
  createBackendChannel: () => ({ set: () => undefined, invoke: (...a: unknown[]) => h.invoke(...a), bound: true }),
}));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => h.gridState.current, navigateToRange: vi.fn() }));
vi.mock("@api/types", () => ({ columnToLetter: (c: number) => String.fromCharCode(65 + c) }));
vi.mock("@api/chartContextMenu", () => ({ registerChartContextMenuContribution: () => () => undefined }));
vi.mock("@api/chartData", () => ({
  CHART_SERIES_MAX_POINTS: 10_000,
  getChartDataProvider: () => ({}),
  resolveChartSeries: (...a: unknown[]) => h.resolveSeries(...a),
  getSelectedChartId: () => h.selectedChartId.current,
  listChartsForData: () => h.charts.current,
}));

const { analyzeCurrentTarget, selectedChartTarget } = await import("../lib/chartExplain");
const store = await import("../lib/store");

const SNAPSHOT = {
  chartId: "chart-1", name: "Chart 1", title: "Sales by month", sheetIndex: 0, mark: "bar",
  categories: ["Jan", "Feb", "Mar"], categoryKind: "nominal" as const,
  series: [{ name: "Sales", values: [100, 200, 300] }], truncated: false,
};

const BUNDLE = { source: "range", insights: [], dropped: 0, markdown: "", factsJson: "{}", notes: [] };

function commandsCalled(): string[] {
  return h.invoke.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(BUNDLE);
  h.resolveSeries.mockReset().mockResolvedValue(SNAPSHOT);
  h.selectedChartId.current = null;
  h.charts.current = [{ chartId: "chart-1", name: "Chart 1", title: "Sales by month" }];
  h.gridState.current = {
    selection: { startRow: 1, startCol: 1, endRow: 9, endCol: 3, type: "cells" },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  };
  store.reset();
});

describe("selectedChartTarget", () => {
  it("names the selected chart by its title", () => {
    h.selectedChartId.current = "chart-1";
    expect(selectedChartTarget()).toEqual({ chartId: "chart-1", label: "Sales by month" });
  });

  it("falls back to the chart's name when it has no title", () => {
    h.selectedChartId.current = "chart-1";
    h.charts.current = [{ chartId: "chart-1", name: "Chart 1", title: null }];
    expect(selectedChartTarget()?.label).toBe("Chart 1");
  });

  it("is null with no chart selected, and null for a chart the provider does not list", () => {
    expect(selectedChartTarget()).toBeNull();
    h.selectedChartId.current = "ghost";
    expect(selectedChartTarget()).toBeNull();
  });
});

describe("analyzeCurrentTarget", () => {
  // The owner's finding: a chart was selected and Analyse answered about a cell.
  it("analyses the SELECTED CHART, not the grid selection", async () => {
    h.selectedChartId.current = "chart-1";
    await analyzeCurrentTarget();

    expect(commandsCalled()).toEqual(["insights_for_series"]);
    expect(commandsCalled()).not.toContain("insights_analyze_range");
    expect(store.getState().origin).toEqual({ kind: "chart", chartId: "chart-1" });
    expect(store.getState().originLabel).toBe("Sales by month");
  });

  it("analyses the grid selection when no chart is selected", async () => {
    await analyzeCurrentTarget();

    expect(commandsCalled()).toEqual(["insights_analyze_range"]);
    expect(store.getState().origin).toMatchObject({ kind: "range" });
  });

  it("analyses the grid selection when the selected chart is not one the provider lists", async () => {
    h.selectedChartId.current = "ghost";
    await analyzeCurrentTarget();
    expect(commandsCalled()).toEqual(["insights_analyze_range"]);
  });

  // The switch is a position the reader set; a chart selected behind the pane
  // must not quietly take it over.
  it("leaves the model switch alone: on Model it analyses the model even with a chart selected", async () => {
    h.selectedChartId.current = "chart-1";
    store.setSource("model");
    store.setConnectionId("conn-1");

    await analyzeCurrentTarget();

    expect(commandsCalled()).toEqual(["insights_analyze_model"]);
  });

  it("reports the chart's own refusal rather than falling back to the range", async () => {
    h.selectedChartId.current = "chart-1";
    h.resolveSeries.mockResolvedValue(null); // a concat container: no single series set

    await analyzeCurrentTarget();

    expect(commandsCalled()).toEqual([]);
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toContain("explain one of them instead");
  });
});
