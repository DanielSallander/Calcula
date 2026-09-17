//! FILENAME: app/extensions/Insights/__tests__/provider.test.ts
// PURPOSE: The provider hands back exactly what Rust computed, and the chart
//          route resolves the series BEFORE it asks for facts about them.
// CONTEXT: The provider is the reason the chat's "analyse this" is deterministic
//          rather than an impression, so the property under test is precisely
//          "the bundle is passed through untouched". A frontend that reordered,
//          filtered or reworded on the way out would make the whole claim false
//          while every screenshot still looked right.
//
//          The chart route is tested for ORDER, not just for calls: resolving
//          the series is what produces the `null`s that stop a blank month from
//          being analysed as a zero. Asking Rust first and resolving afterwards
//          would still "call both functions".

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolveSeries: vi.fn(),
  chartProvider: { current: null as unknown },
}));

vi.mock("@api/backendCommands", () => ({
  createBackendChannel: () => ({
    set: () => undefined,
    invoke: (...args: unknown[]) => h.invoke(...args),
    bound: true,
  }),
}));

// The grid + type helpers the store reaches for. Doubled so this file never
// drags the core state tree into a unit test.
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => null,
  navigateToRange: vi.fn(),
}));
vi.mock("@api/types", () => ({
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
}));

vi.mock("@api/chartData", () => ({
  CHART_SERIES_MAX_POINTS: 10_000,
  getChartDataProvider: () => h.chartProvider.current,
  resolveChartSeries: (...args: unknown[]) => h.resolveSeries(...args),
}));

const { createInsightsProvider } = await import("../lib/provider");
const { refreshConnections, reset, getState } = await import("../lib/store");
const { registerChartExplain, EXPLAIN_CHART_CONTRIBUTION_ID, explainChart } = await import(
  "../lib/chartExplain"
);
const {
  registerInsightsProvider,
  getInsightsProvider,
  resetInsightsProvider,
} = await import("@api/insightsService");
const {
  getChartContextMenuContributions,
  resetChartContextMenuContributions,
} = await import("@api/chartContextMenu");

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    source: "range",
    insights: [
      {
        id: "i1",
        kind: "trend",
        score: 0.81,
        text: "Column B rises steadily from January to June.",
        evidence: [],
        provenance: [],
      },
    ],
    dropped: 0,
    markdown: "- Column B rises steadily from January to June.",
    factsJson: "{}",
    notes: [],
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  h.invoke.mockReset();
  h.resolveSeries.mockReset();
  h.chartProvider.current = null;
  reset();
  resetInsightsProvider();
  resetChartContextMenuContributions();
});

describe("the Insights provider", () => {
  it("returns the bundle the range command returned, unchanged", async () => {
    const computed = bundle();
    h.invoke.mockResolvedValue(computed);

    const result = await createInsightsProvider().analyzeRange({
      sheetIndex: 0,
      startRow: 1,
      startCol: 1,
      endRow: 10,
      endCol: 3,
    });

    expect(result).toBe(computed);
    expect(h.invoke).toHaveBeenCalledWith("insights_analyze_range", {
      request: { sheetIndex: 0, startRow: 1, startCol: 1, endRow: 10, endCol: 3 },
    });
  });

  it("returns the bundle the model command returned, unchanged", async () => {
    const computed = bundle({ source: "model" });
    h.invoke.mockResolvedValue(computed);

    const result = await createInsightsProvider().analyzeModel({ connectionId: "conn-1" });

    expect(result).toBe(computed);
    expect(h.invoke).toHaveBeenCalledWith("insights_analyze_model", {
      request: { connectionId: "conn-1" },
    });
  });

  it("reports no model until the workbook's connections have been read", async () => {
    const provider = createInsightsProvider();
    expect(provider.hasModel()).toBe(false);

    h.invoke.mockResolvedValue([{ id: "conn-1", name: "Sales" }]);
    await refreshConnections();

    expect(provider.hasModel()).toBe(true);
    expect(getState().connectionId).toBe("conn-1");
  });

  it("is reachable through the @api seam once registered, and gone once not", async () => {
    const provider = createInsightsProvider();
    const off = registerInsightsProvider(provider);
    expect(getInsightsProvider()).toBe(provider);
    off();
    expect(getInsightsProvider()).toBeNull();
  });
});

describe("Explain this chart", () => {
  const snapshot = {
    chartId: "chart-1",
    name: "Chart 1",
    title: "Revenue by month",
    sheetIndex: 0,
    mark: "line",
    categories: ["Jan", "Feb", "Mar"],
    categoryKind: "temporal" as const,
    categoryValues: [1, 2, 3],
    series: [{ name: "Revenue", values: [10, null, 30] }],
    truncated: false,
  };

  it("resolves the chart's series first, then asks for facts about them", async () => {
    h.resolveSeries.mockResolvedValue(snapshot);
    h.invoke.mockResolvedValue(bundle());

    await explainChart("chart-1", () => undefined);
    await flush();

    expect(h.resolveSeries).toHaveBeenCalledWith("chart-1", 10_000);
    expect(h.invoke).toHaveBeenCalledWith("insights_for_series", {
      request: {
        title: "Revenue by month",
        categories: ["Jan", "Feb", "Mar"],
        categoryKind: "temporal",
        categoryValues: [1, 2, 3],
        series: [{ name: "Revenue", values: [10, null, 30] }],
      },
    });
    expect(h.resolveSeries.mock.invocationCallOrder[0]).toBeLessThan(
      h.invoke.mock.invocationCallOrder[0],
    );
  });

  it("keeps a blank point as null rather than substituting a zero", async () => {
    h.resolveSeries.mockResolvedValue(snapshot);
    h.invoke.mockResolvedValue(bundle());

    await explainChart("chart-1", () => undefined);
    await flush();

    const request = h.invoke.mock.calls[0][1] as { request: { series: Array<{ values: unknown[] }> } };
    expect(request.request.series[0].values).toEqual([10, null, 30]);
  });

  it("forwards the chart's strategy to Rust when the snapshot carries one, and omits it otherwise", async () => {
    h.resolveSeries.mockResolvedValue({
      ...snapshot,
      strategy: { connectionId: "conn-1", measures: [{ series: "Revenue", measure: "Net Revenue" }] },
    });
    h.invoke.mockResolvedValue(bundle());

    await explainChart("chart-1", () => undefined);
    await flush();

    const sent = h.invoke.mock.calls[0][1] as { request: Record<string, unknown> };
    expect(sent.request.strategy).toEqual({
      connectionId: "conn-1",
      measures: [{ series: "Revenue", measure: "Net Revenue" }],
    });

    // An empty binding list is no strategy at all: the request must not carry
    // a `strategy` key for Rust to look up a connection for nothing.
    h.invoke.mockClear();
    h.resolveSeries.mockResolvedValue({ ...snapshot, strategy: { connectionId: "conn-1", measures: [] } });
    await explainChart("chart-1", () => undefined);
    await flush();
    const bare = h.invoke.mock.calls[0][1] as { request: Record<string, unknown> };
    expect("strategy" in bare.request).toBe(false);
  });

  it("says so rather than analysing nothing when the chart has no single series set", async () => {
    h.resolveSeries.mockResolvedValue(null);

    await explainChart("chart-1", () => undefined);
    await flush();

    expect(h.invoke).not.toHaveBeenCalled();
    expect(getState().status).toBe("error");
    expect(getState().error).toContain("no single set of series");
  });

  it("contributes the menu item, visible only while a chart data provider exists", () => {
    const off = registerChartExplain(() => undefined);
    const item = getChartContextMenuContributions().find(
      (c) => c.id === EXPLAIN_CHART_CONTRIBUTION_ID,
    );

    expect(item).toBeDefined();
    expect(item?.label).toBe("Explain this chart");
    expect(item?.order).toBe(50);
    expect(item?.visible?.("chart-1")).toBe(false);

    h.chartProvider.current = {};
    expect(item?.visible?.("chart-1")).toBe(true);

    off();
    expect(
      getChartContextMenuContributions().some((c) => c.id === EXPLAIN_CHART_CONTRIBUTION_ID),
    ).toBe(false);
  });
});
