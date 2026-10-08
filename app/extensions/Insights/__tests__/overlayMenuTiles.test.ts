//! FILENAME: app/extensions/Insights/__tests__/overlayMenuTiles.test.ts
// PURPOSE: "Show points of interest" and the snapshot are not offered on a
//          title-only TILE (Card, Multi-row card, KPI, Gauge): Charts paints no
//          cues there, so the toggle flipped with nothing to show
//          (canvas-review visuals finding; contract 4.2).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  provider: { current: null as unknown },
  prompt: vi.fn(),
  keep: vi.fn(),
  snapshot: vi.fn(),
  toast: vi.fn(),
  resolveSeries: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@api/chartData", () => ({
  CHART_SERIES_MAX_POINTS: 10_000,
  getChartDataProvider: () => h.provider.current,
  resolveChartSeries: (...a: unknown[]) => h.resolveSeries(...a),
}));
vi.mock("@api/dialogs", () => ({ promptAsync: (...a: unknown[]) => h.prompt(...a) }));
vi.mock("@api/notifications", () => ({ showToast: (...a: unknown[]) => h.toast(...a) }));
vi.mock("@api/backendCommands", () => ({
  createBackendChannel: () => ({ set: () => undefined, invoke: (...a: unknown[]) => h.invoke(...a), bound: true }),
}));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => null, navigateToRange: vi.fn() }));
vi.mock("@api/types", () => ({ columnToLetter: (c: number) => String.fromCharCode(65 + c) }));
vi.mock("@api/extensionData", () => ({ getExtensionData: vi.fn(async () => null), setExtensionDataUndoable: vi.fn(async () => undefined) }));

const menu = await import("../lib/overlayMenu");
const cues = await import("@api/chartCues");
const overlay = await import("../lib/overlay");
const { getChartContextMenuContributions, resetChartContextMenuContributions } = await import("@api/chartContextMenu");
const quickActions = await import("@api/chartQuickActions");

const snapshot = {
  chartId: "c1", name: "Chart", title: null, sheetIndex: 0, mark: "bar",
  categories: ["Jan", "Feb", "Mar"], categoryKind: "nominal" as const, series: [{ name: "Sales", values: [1, 2, 3] }], truncated: false,
};
const EXT = "extremes:x";
const bundle = {
  source: "range", insights: [{ id: EXT, kind: "extremes", score: 1, text: "Sales is highest at Mar.", evidence: [], provenance: [] }],
  dropped: 0, markdown: "", notes: [],
  factsJson: JSON.stringify({ facts: [{ id: EXT, score: 1, evidenceA1: [], kind: { fact: "extremes", subject: { type: "column", name: "Sales" }, bestLabel: "Mar", bestIndex: 2, best: 3, worstLabel: "Jan", worstIndex: 0, worst: 1 } }] }),
};

function visible(chartId: string): string[] {
  return getChartContextMenuContributions().filter((c) => !c.visible || c.visible(chartId)).map((c) => c.label);
}

beforeEach(() => {
  resetChartContextMenuContributions();
  quickActions.resetChartQuickActions();
  cues.clearAllChartCues();
  cues.registerChartCueHost(null);
  overlay.resetOverlays();
  h.provider.current = null;
  h.prompt.mockReset();
  h.keep.mockReset().mockResolvedValue(undefined);
  h.snapshot.mockReset().mockResolvedValue(null);
  h.toast.mockReset();
  h.resolveSeries.mockReset().mockResolvedValue(snapshot);
  h.invoke.mockReset().mockResolvedValue(bundle);
});

function quick(chartId: string): string[] {
  return quickActions.chartQuickActionsFor(chartId).map((a) => a.id);
}

function providerWith(marks: Record<string, string>): unknown {
  return {
    listCharts: () => Object.entries(marks).map(([chartId, mark]) => ({ chartId, name: chartId, title: null, sheetIndex: 0, mark, sourceKind: "range" })),
  };
}

const { registerChartMark, unregisterChartMark } = await import("@api/chartMarks");
const tileDef = (label: string) => ({
  meta: { label, layoutFamily: "other" as const, furniture: "titleOnly" as const },
  paint: () => undefined,
  computeLayout: () => ({}),
  computeGeometry: () => ({}),
});

describe("tiles get no points-of-interest actions", () => {
  beforeEach(() => {
    // What Charts registers for its tiles (chartDispatch); the furniture is
    // the registry's answer, so the test states it the same way.
    unregisterChartMark("card");
    unregisterChartMark("kpi");
    registerChartMark("card", tileDef("Card"));
    registerChartMark("kpi", tileDef("KPI"));
  });

  it("a Card is offered neither the menu toggle nor the quick-access toggle", () => {
    h.provider.current = providerWith({ card1: "card", kpi1: "kpi", bar1: "bar" });
    menu.registerOverlayMenu();
    expect(visible("card1")).toEqual([]);
    expect(visible("kpi1")).toEqual([]);
    expect(quick("card1")).toEqual([]);
    // A column chart still is.
    expect(visible("bar1")).toEqual([menu.SHOW_POINTS_LABEL]);
    expect(quick("bar1")).toEqual([menu.OVERLAY_TOGGLE_ACTION_ID]);
  });

  it("a chart the listing cannot name is treated as a chart, not a tile", () => {
    h.provider.current = providerWith({});
    menu.registerOverlayMenu();
    expect(visible("unknown")).toEqual([menu.SHOW_POINTS_LABEL]);
  });
});
