//! FILENAME: app/extensions/Insights/__tests__/overlay.test.ts
// PURPOSE: The overlay's owner: show computes ONE bundle and hands it to both
//          the chart and the pane; the notice names the tier; a data change
//          recomputes (debounced) and comments follow their facts; comments
//          persist undoably in the extension's own blob; hide clears cues and
//          keeps comments.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolveSeries: vi.fn(),
  getExtensionData: vi.fn(),
  setExtensionDataUndoable: vi.fn(),
}));

vi.mock("@api/backendCommands", () => ({
  createBackendChannel: () => ({ set: () => undefined, invoke: (...a: unknown[]) => h.invoke(...a), bound: true }),
}));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => null, navigateToRange: vi.fn() }));
vi.mock("@api/types", () => ({ columnToLetter: (c: number) => String.fromCharCode(65 + c) }));
vi.mock("@api/chartData", () => ({
  CHART_SERIES_MAX_POINTS: 10_000,
  getChartDataProvider: () => null,
  resolveChartSeries: (...a: unknown[]) => h.resolveSeries(...a),
}));
vi.mock("@api/extensionData", () => ({
  getExtensionData: (...a: unknown[]) => h.getExtensionData(...a),
  setExtensionDataUndoable: (...a: unknown[]) => h.setExtensionDataUndoable(...a),
}));

const overlay = await import("../lib/overlay");
const store = await import("../lib/store");
const cues = await import("@api/chartCues");

const snapshot = {
  chartId: "chart-1", name: "Chart 1", title: "Sales by month", sheetIndex: 0, mark: "bar",
  categories: ["Jan", "Feb", "Mar"], categoryKind: "nominal" as const,
  series: [{ name: "Sales", values: [100, 200, 300] }], truncated: false,
};
const EXT = "extremes:c//Sales/A1:A4:";

function bundleFor(bestLabel: string, bestIndex: number, best: number, provenance: unknown[] = []) {
  return {
    source: "range",
    insights: [{ id: EXT, kind: "extremes", score: 0.6, text: `Sales is highest at ${bestLabel}.`, evidence: [], provenance }],
    dropped: 0,
    markdown: "",
    factsJson: JSON.stringify({
      facts: [{ id: EXT, score: 0.6, evidenceA1: [], kind: {
        fact: "extremes", subject: { type: "column", name: "Sales" },
        bestLabel, bestIndex, best, worstLabel: "Jan", worstIndex: 0, worst: 100,
      } }],
    }),
    notes: [],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  h.invoke.mockReset();
  h.resolveSeries.mockReset();
  h.getExtensionData.mockReset().mockResolvedValue(null);
  h.setExtensionDataUndoable.mockReset().mockResolvedValue(undefined);
  h.resolveSeries.mockResolvedValue(snapshot);
  h.invoke.mockResolvedValue(bundleFor("Mar", 2, 300));
  cues.clearAllChartCues();
  overlay.resetOverlays();
  store.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("showOverlay", () => {
  it("computes one bundle, places its cues on the chart, and names the tier", async () => {
    const r = await overlay.showOverlay("chart-1");
    expect(r.outcome).toBe("shown");
    if (r.outcome !== "shown") return;
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke.mock.calls[0][0]).toBe("insights_for_series");
    expect(cues.getChartCues("chart-1").map((c) => [c.kind, c.anchor])).toEqual([
      ["ring", { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" }],
      ["ring", { type: "datum", series: "Sales", categoryIndex: 0, categoryLabel: "Jan" }],
    ]);
    expect(overlay.isOverlayOn("chart-1")).toBe(true);
    expect(r.notice).toBe("1 point of interest, computed from the numbers; no strategy declares which way is good.");
  });

  it("names the strategy when the chart carries one", async () => {
    h.resolveSeries.mockResolvedValue({ ...snapshot, strategy: { connectionId: "c", measures: [{ series: "Sales", measure: "Net Sales" }] } });
    const r = await overlay.showOverlay("chart-1");
    expect(r.outcome === "shown" && r.notice).toBe("1 point of interest, computed from the model's strategy — not guessed.");
  });

  it("lands the stepper on the asked fact and selects it", async () => {
    await overlay.showOverlay("chart-1", { stepToFactId: EXT });
    expect(cues.getChartCueStep("chart-1")).toBe(0);
    expect(cues.getSelectedChartCue("chart-1")?.factId).toBe(EXT);
  });

  it("refuses, with a reason, when the chart has no series set or the analysis fails", async () => {
    h.resolveSeries.mockResolvedValue(null);
    expect((await overlay.showOverlay("chart-1")).outcome).toBe("refused");
    h.resolveSeries.mockResolvedValue(snapshot);
    h.invoke.mockRejectedValue(new Error("backend down"));
    const r = await overlay.showOverlay("chart-1");
    expect(r).toEqual({ outcome: "refused", chartId: "chart-1", reason: "backend down" });
    expect(overlay.isOverlayOn("chart-1")).toBe(false);
  });

  it("refreshes the pane's bundle when the pane is on the same chart, and leaves it alone otherwise", async () => {
    const token = store.beginRun("this chart", { kind: "chart", chartId: "chart-1" });
    store.completeRun(token, bundleFor("Feb", 1, 200) as never, "old");
    await overlay.showOverlay("chart-1");
    expect(store.getState().bundle?.insights[0].text).toBe("Sales is highest at Mar.");

    const other = store.beginRun("range", { kind: "range" });
    store.completeRun(other, bundleFor("Feb", 1, 200) as never);
    await overlay.showOverlay("chart-1");
    expect(store.getState().bundle?.insights[0].text).toBe("Sales is highest at Feb.");
  });
});

describe("following the data", () => {
  it("recomputes once after a burst of data changes, and comments follow their fact", async () => {
    await overlay.showOverlay("chart-1");
    await overlay.addComment("chart-1", EXT, "Launch month");
    expect(cues.getChartComments("chart-1")[0].anchor?.categoryLabel).toBe("Mar");

    // The data changed: the highest month is now Feb.
    h.invoke.mockResolvedValue(bundleFor("Feb", 1, 200));
    h.resolveSeries.mockResolvedValue({ ...snapshot, series: [{ name: "Sales", values: [100, 200, 150] }] });
    const off = overlay.followChartData();
    cues.announceChartDataChanged("chart-1");
    cues.announceChartDataChanged("chart-1");
    cues.announceChartDataChanged("chart-1");
    expect(h.invoke).toHaveBeenCalledTimes(1); // nothing yet: debounced
    await vi.advanceTimersByTimeAsync(overlay.RECOMPUTE_DEBOUNCE_MS + 10);
    await flush();
    off();
    expect(h.invoke).toHaveBeenCalledTimes(2); // one recomputation for three announcements

    expect(cues.getChartCues("chart-1")[0].anchor).toMatchObject({ categoryIndex: 1, categoryLabel: "Feb" });
    const comment = cues.getChartComments("chart-1")[0];
    expect(comment.anchor?.categoryLabel).toBe("Feb");
    expect(comment.movedFrom).toBe("Mar");
  });

  it("ignores data changes on a chart whose overlay is off", async () => {
    const off = overlay.followChartData();
    cues.announceChartDataChanged("chart-9");
    await vi.advanceTimersByTimeAsync(1000);
    off();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

describe("comments", () => {
  it("persist undoably in the extension's own blob and reload from it", async () => {
    await overlay.showOverlay("chart-1");
    const c = await overlay.addComment("chart-1", EXT, "Launch month");
    expect(h.setExtensionDataUndoable).toHaveBeenCalledWith(
      "calcula.insights",
      { comments: { "chart-1": [c] } },
      "Add comment",
    );
    await overlay.editComment("chart-1", c.id, "Launch");
    expect(overlay.commentsOf("chart-1")[0].text).toBe("Launch");
    await overlay.removeComment("chart-1", c.id);
    expect(overlay.commentsOf("chart-1")).toEqual([]);
    expect(h.setExtensionDataUndoable).toHaveBeenLastCalledWith("calcula.insights", { comments: {} }, "Remove comment");

    h.getExtensionData.mockResolvedValue({ comments: { "chart-1": [c, { bogus: true }] } });
    await overlay.loadComments();
    expect(overlay.commentsOf("chart-1")).toEqual([c]);
    expect(cues.getChartComments("chart-1")).toEqual([c]);
  });

  it("the overlay style persists in the same blob, undoably, becomes what painters read, and reloads", async () => {
    const style = await import("@api/insightStyle");
    await overlay.showOverlay("chart-1");
    const c = await overlay.addComment("chart-1", EXT, "note");
    await overlay.saveOverlayStyle(style.normalizeOverlayStyle({ polarity: { bad: { color: "#800000", dash: [] } } }));
    expect(style.overlayStyleFor("bad").color).toBe("#800000");
    const [id, payload, description] = h.setExtensionDataUndoable.mock.calls.at(-1)!;
    expect(id).toBe("calcula.insights");
    expect(description).toBe("Change overlay style");
    expect((payload as { comments: unknown; style: { polarity: { bad: { color: string } } } }).comments).toEqual({ "chart-1": [c] });
    expect((payload as { style: { polarity: { bad: { color: string } } } }).style.polarity.bad.color).toBe("#800000");
    // A later comment write carries the style along rather than dropping it.
    await overlay.addComment("chart-1", EXT, "second");
    expect((h.setExtensionDataUndoable.mock.calls.at(-1)![1] as { style?: unknown }).style).toBeTruthy();

    await overlay.saveOverlayStyle(null);
    expect(style.getDocumentOverlayStyle()).toBeNull();
    expect((h.setExtensionDataUndoable.mock.calls.at(-1)![1] as { style?: unknown }).style).toBeUndefined();

    h.getExtensionData.mockResolvedValue({ comments: {}, style: { polarity: { good: { color: "lime", dash: [] } }, lineWidth: 99 } });
    await overlay.loadComments();
    expect(style.overlayStyleFor("good").color).toBe("lime");
    expect(style.resolveOverlayStyle().lineWidth).toBe(style.DEFAULT_OVERLAY_STYLE.lineWidth); // 99 refused, the rest kept
    overlay.resetOverlays();
    expect(style.getDocumentOverlayStyle()).toBeNull();
  });

  it("hide clears the cues but keeps the comments; reset drops everything", async () => {
    await overlay.showOverlay("chart-1");
    await overlay.addComment("chart-1", EXT, "note");
    overlay.hideOverlay("chart-1");
    expect(overlay.isOverlayOn("chart-1")).toBe(false);
    expect(cues.getChartCues("chart-1")).toEqual([]);
    expect(cues.getChartComments("chart-1")).toHaveLength(1);
    overlay.resetOverlays();
    expect(overlay.commentsOf("chart-1")).toEqual([]);
  });
});
