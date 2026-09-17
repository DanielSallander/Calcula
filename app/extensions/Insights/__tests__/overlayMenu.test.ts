//! FILENAME: app/extensions/Insights/__tests__/overlayMenu.test.ts
// PURPOSE: The overlay's chart-menu items appear only when they can act: the
//          toggle only with Charts present, the cue items only while a cue is
//          selected on a chart whose overlay is on.

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

describe("the overlay's chart-menu items", () => {
  it("offers nothing without Charts, and only 'Show points of interest' with it", () => {
    const off = menu.registerOverlayMenu();
    expect(visible("c1")).toEqual([]);
    h.provider.current = {};
    expect(visible("c1")).toEqual([menu.SHOW_POINTS_LABEL]);
    off();
    expect(getChartContextMenuContributions()).toEqual([]);
  });

  it("once shown, offers Hide and Snapshot; with a selected cue, also comment and keep", async () => {
    h.provider.current = {};
    menu.registerOverlayMenu();
    await overlay.showOverlay("c1");
    expect(visible("c1")).toEqual([menu.HIDE_POINTS_LABEL, "Snapshot with points of interest"]);
    cues.setSelectedChartCue("c1", EXT);
    expect(visible("c1")).toEqual([menu.HIDE_POINTS_LABEL, "Add comment on this point…", "Keep this mark in the chart", "Snapshot with points of interest"]);
  });

  it("'Add comment' prompts through the in-app dialog and saves a non-empty answer on the selected fact", async () => {
    h.provider.current = {};
    menu.registerOverlayMenu();
    await overlay.showOverlay("c1");
    cues.setSelectedChartCue("c1", EXT);
    const item = getChartContextMenuContributions().find((c) => c.id === menu.OVERLAY_COMMENT_CONTRIBUTION_ID)!;

    h.prompt.mockResolvedValue("   ");
    item.onSelect("c1");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(overlay.commentsOf("c1")).toEqual([]);

    h.prompt.mockResolvedValue("Launch month");
    item.onSelect("c1");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(overlay.commentsOf("c1").map((c) => [c.factId, c.text])).toEqual([[EXT, "Launch month"]]);
    expect(h.prompt.mock.calls[1][0]).toContain("Highest Sales");
  });

  it("'Keep' and 'Snapshot' go through the host Charts registered, and say so when it refuses", async () => {
    h.provider.current = {};
    menu.registerOverlayMenu();
    cues.registerChartCueHost({ keepCue: h.keep, keepComment: vi.fn(), snapshot: h.snapshot });
    await overlay.showOverlay("c1");
    cues.setSelectedChartCue("c1", EXT);
    const keep = getChartContextMenuContributions().find((c) => c.id === menu.OVERLAY_KEEP_CONTRIBUTION_ID)!;
    keep.onSelect("c1");
    await Promise.resolve(); await Promise.resolve();
    expect(h.keep).toHaveBeenCalledWith("c1", expect.objectContaining({ factId: EXT }));

    const snap = getChartContextMenuContributions().find((c) => c.id === menu.OVERLAY_SNAPSHOT_CONTRIBUTION_ID)!;
    h.snapshot.mockRejectedValue(new Error("no clipboard"));
    snap.onSelect("c1");
    await Promise.resolve(); await Promise.resolve();
    expect(h.toast).toHaveBeenCalledWith("no clipboard", { variant: "warning" });
  });
});
