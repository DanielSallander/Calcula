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
    cues.setSelectedChartCue("c1", cues.getChartCues("c1")[0].cueId);
    expect(visible("c1")).toEqual([menu.HIDE_POINTS_LABEL, "Add comment on this point…", "Keep this mark in the chart", "Snapshot with points of interest"]);
  });

  it("'Add comment' prompts through the in-app dialog and saves a non-empty answer on the selected fact", async () => {
    h.provider.current = {};
    menu.registerOverlayMenu();
    await overlay.showOverlay("c1");
    cues.setSelectedChartCue("c1", cues.getChartCues("c1")[0].cueId);
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
    cues.setSelectedChartCue("c1", cues.getChartCues("c1")[0].cueId);
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

  // The owner's live finding, at the two menu items that write to the document.
  // `extremes` rings the highest bar (Mar) and the lowest (Jan) under ONE fact
  // id, so selecting the lowest and acting must reach the lowest — the comment
  // must not land on Mar, and the kept mark must not be persisted onto Mar.
  it("acts on the cue that is selected, not on its fact's first cue", async () => {
    h.provider.current = {};
    menu.registerOverlayMenu();
    cues.registerChartCueHost({ keepCue: h.keep, keepComment: vi.fn(), snapshot: h.snapshot });
    await overlay.showOverlay("c1");
    const lowest = cues.getChartCues("c1")[1];
    expect(lowest.anchor).toMatchObject({ categoryLabel: "Jan" });
    cues.setSelectedChartCue("c1", lowest.cueId);

    h.prompt.mockResolvedValue("why so low?");
    getChartContextMenuContributions().find((c) => c.id === menu.OVERLAY_COMMENT_CONTRIBUTION_ID)!.onSelect("c1");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(overlay.commentsOf("c1")[0].anchor?.categoryLabel).toBe("Jan");

    getChartContextMenuContributions().find((c) => c.id === menu.OVERLAY_KEEP_CONTRIBUTION_ID)!.onSelect("c1");
    await Promise.resolve(); await Promise.resolve();
    expect(h.keep).toHaveBeenCalledWith("c1", expect.objectContaining({ anchor: expect.objectContaining({ categoryIndex: 0 }) }));
  });
});

// ============================================================================
// The quick-access buttons (the owner asked for them beside the other icons)
// ============================================================================

describe("the overlay's quick-access buttons", () => {
  function ids(chartId: string): string[] {
    return quickActions.chartQuickActionsFor(chartId).map((a) => a.id);
  }

  it("registers nothing usable without Charts, and both buttons go away on dispose", () => {
    const off = menu.registerOverlayMenu();
    // No chart data provider: the toggle has nothing to analyse.
    expect(ids("c1")).toEqual([]);
    h.provider.current = {};
    expect(ids("c1")).toEqual([menu.OVERLAY_TOGGLE_ACTION_ID]);
    off();
    expect(quickActions.listChartQuickActions()).toEqual([]);
  });

  it("shows the camera only once there is an overlay to snapshot, and the toggle reads the chart's state", async () => {
    h.provider.current = {};
    menu.registerOverlayMenu();

    const toggle = quickActions.chartQuickActionsFor("c1")[0];
    expect(toggle.tooltip("c1")).toBe(menu.SHOW_POINTS_LABEL);
    expect(toggle.active?.("c1")).toBe(false);
    expect(ids("c1")).not.toContain(menu.OVERLAY_SNAPSHOT_ACTION_ID);

    await overlay.showOverlay("c1");
    expect(toggle.tooltip("c1")).toBe(menu.HIDE_POINTS_LABEL);
    expect(toggle.active?.("c1")).toBe(true);
    expect(ids("c1")).toContain(menu.OVERLAY_SNAPSHOT_ACTION_ID);
    // Another chart, with no overlay, is unaffected.
    expect(toggle.tooltip("c2")).toBe(menu.SHOW_POINTS_LABEL);
    expect(ids("c2")).not.toContain(menu.OVERLAY_SNAPSHOT_ACTION_ID);
  });

  it("the button toggles the same overlay the menu item does", async () => {
    h.provider.current = {};
    menu.registerOverlayMenu();
    const toggle = quickActions.chartQuickActionsFor("c1")[0];

    toggle.onSelect("c1");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(overlay.isOverlayOn("c1")).toBe(true);

    toggle.onSelect("c1");
    expect(overlay.isOverlayOn("c1")).toBe(false);
  });

  it("the camera goes through the host Charts registered", async () => {
    h.provider.current = {};
    menu.registerOverlayMenu();
    cues.registerChartCueHost({ keepCue: h.keep, keepComment: vi.fn(), snapshot: h.snapshot });
    await overlay.showOverlay("c1");

    const camera = quickActions.chartQuickActionsFor("c1").find((a) => a.id === menu.OVERLAY_SNAPSHOT_ACTION_ID)!;
    camera.onSelect("c1");
    await Promise.resolve();
    // `snapshotChart(chartId)` passes its optional options through as undefined.
    expect(h.snapshot.mock.calls.map((c) => c[0])).toEqual(["c1"]);
  });
});
