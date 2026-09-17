//! FILENAME: app/src/api/__tests__/chartCues.test.ts
// PURPOSE: The transient chart-overlay store: cues, stepping, selection,
//          comments, notification on change only, immutability of what is
//          stored, and the host hooks that only Charts can implement.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setChartCues,
  getChartCues,
  clearChartCues,
  clearAllChartCues,
  listChartsWithCues,
  onChartCuesChanged,
  chartCueSteps,
  getChartCueStep,
  setChartCueStep,
  stepChartCues,
  visibleChartCues,
  setSelectedChartCue,
  getSelectedChartCue,
  setChartComments,
  getChartComments,
  getChartOverlay,
  announceChartDataChanged,
  onChartDataChanged,
  registerChartCueHost,
  keepChartCue,
  snapshotChart,
  type ChartCue,
  type ChartCueComment,
} from "../chartCues";

function ring(factId: string, categoryIndex = 2): ChartCue {
  return {
    factId,
    kind: "ring",
    polarity: "neutral",
    anchor: { type: "datum", series: "Sales", categoryIndex, categoryLabel: "Mar" },
  };
}

function comment(id: string, factId: string, attached = true): ChartCueComment {
  return { id, factId, text: `note ${id}`, anchor: attached ? { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" } : null };
}

beforeEach(() => {
  clearAllChartCues();
  registerChartCueHost(null);
});

describe("@api/chartCues cues", () => {
  it("is empty for an unknown chart and never returns undefined", () => {
    expect(getChartCues("nope")).toEqual([]);
    expect(getChartComments("nope")).toEqual([]);
    expect(listChartsWithCues()).toEqual([]);
    expect(getChartOverlay("nope").step).toBe(0);
  });

  it("stores, reports and clears per chart", () => {
    setChartCues("c1", [ring("f1")]);
    setChartCues("c2", [ring("f2"), ring("f3", 0)]);
    expect(getChartCues("c1").map((c) => c.factId)).toEqual(["f1"]);
    expect(getChartCues("c2").map((c) => c.factId)).toEqual(["f2", "f3"]);
    expect(listChartsWithCues().sort()).toEqual(["c1", "c2"]);

    clearChartCues("c1");
    expect(getChartCues("c1")).toEqual([]);
    expect(getChartCues("c2")).toHaveLength(2);

    clearAllChartCues();
    expect(listChartsWithCues()).toEqual([]);
  });

  it("stores a frozen copy, so the caller's array and the stored list cannot drift", () => {
    const mine = [ring("f1")];
    setChartCues("c1", mine);
    mine.push(ring("f2"));
    mine[0].anchor.categoryIndex = 99;
    const stored = getChartCues("c1");
    expect(stored).toHaveLength(1);
    expect(stored[0].anchor.categoryIndex).toBe(2);
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it("notifies with the chart id on set and on a clear that removed something", () => {
    const seen: string[] = [];
    const off = onChartCuesChanged((id) => seen.push(id));

    setChartCues("c1", [ring("f1")]);
    clearChartCues("c1");
    clearChartCues("c1"); // nothing to drop: no notification
    setChartCues("c2", [ring("f2")]);
    clearAllChartCues();
    expect(seen).toEqual(["c1", "c1", "c2", "c2"]);

    off();
    setChartCues("c3", [ring("f3")]);
    expect(seen).toHaveLength(4);
  });
});

describe("stepping", () => {
  it("steps one fact at a time, in cue order, wrapping, and 'all' shows everything", () => {
    setChartCues("c1", [ring("a"), ring("a", 0), ring("b"), ring("c")]);
    expect(chartCueSteps("c1")).toEqual(["a", "b", "c"]);
    expect(getChartCueStep("c1")).toBe(0);
    expect(visibleChartCues("c1").map((c) => c.factId)).toEqual(["a", "a"]);

    stepChartCues("c1", 1);
    expect(visibleChartCues("c1").map((c) => c.factId)).toEqual(["b"]);
    stepChartCues("c1", 1);
    stepChartCues("c1", 1);
    expect(getChartCueStep("c1")).toBe(0); // wrapped
    stepChartCues("c1", -1);
    expect(getChartCueStep("c1")).toBe(2);

    setChartCueStep("c1", "all");
    expect(visibleChartCues("c1")).toHaveLength(4);
    stepChartCues("c1", 1);
    expect(getChartCueStep("c1")).toBe(0);
    setChartCueStep("c1", "all");
    stepChartCues("c1", -1);
    expect(getChartCueStep("c1")).toBe(2);

    setChartCueStep("c1", 99);
    expect(getChartCueStep("c1")).toBe(2); // clamped
  });

  it("keeps the reader on the same fact when the cues are replaced, and resets when it is gone", () => {
    setChartCues("c1", [ring("a"), ring("b"), ring("c")]);
    setChartCueStep("c1", 1);
    setChartCues("c1", [ring("b"), ring("c")]); // a filter dropped fact a
    expect(getChartCueStep("c1")).toBe(0);
    expect(visibleChartCues("c1")[0].factId).toBe("b");

    setChartCueStep("c1", 1); // on c
    setChartCues("c1", [ring("a"), ring("b")]); // c is gone
    expect(getChartCueStep("c1")).toBe(0);
  });

  it("does nothing on a chart with no cues", () => {
    stepChartCues("none", 1);
    setChartCueStep("none", 3);
    expect(getChartCueStep("none")).toBe(0);
    expect(listChartsWithCues()).toEqual([]);
  });
});

describe("selection", () => {
  it("selects only a fact that has a cue, and survives a replacement that keeps it", () => {
    setChartCues("c1", [ring("a"), ring("b")]);
    setSelectedChartCue("c1", "b");
    expect(getSelectedChartCue("c1")?.factId).toBe("b");
    setSelectedChartCue("c1", "zzz");
    expect(getSelectedChartCue("c1")).toBeNull();
    setSelectedChartCue("c1", "a");
    setChartCues("c1", [ring("a")]);
    expect(getSelectedChartCue("c1")?.factId).toBe("a");
    setChartCues("c1", [ring("b")]);
    expect(getSelectedChartCue("c1")).toBeNull();
    setSelectedChartCue("c1", "b");
    clearChartCues("c1");
    expect(getSelectedChartCue("c1")).toBeNull();
  });
});

describe("comments", () => {
  it("are stored per chart, frozen, and survive a cue clear (they may be unattached)", () => {
    setChartCues("c1", [ring("a")]);
    const mine = [comment("k1", "a"), comment("k2", "gone", false)];
    setChartComments("c1", mine);
    mine[0].text = "changed";
    expect(getChartComments("c1").map((c) => c.text)).toEqual(["note k1", "note k2"]);
    expect(Object.isFrozen(getChartComments("c1"))).toBe(true);

    clearChartCues("c1");
    expect(getChartCues("c1")).toEqual([]);
    expect(getChartComments("c1")).toHaveLength(2);
    expect(listChartsWithCues()).toEqual(["c1"]);

    setChartComments("c1", []);
    expect(listChartsWithCues()).toEqual([]);
  });
});

describe("data-changed announcements and the host", () => {
  it("relays a data change to listeners with the chart id", () => {
    const seen: string[] = [];
    const off = onChartDataChanged((id) => seen.push(id));
    announceChartDataChanged("c9");
    off();
    announceChartDataChanged("c9");
    expect(seen).toEqual(["c9"]);
  });

  it("rejects host calls when Charts is not there, and delegates when it is", async () => {
    await expect(keepChartCue("c1", ring("a"))).rejects.toThrow("Charts is not available");
    await expect(snapshotChart("c1")).rejects.toThrow("Charts is not available");
    const host = { keepCue: vi.fn().mockResolvedValue(undefined), keepComment: vi.fn().mockResolvedValue(undefined), snapshot: vi.fn().mockResolvedValue("C:/x.png") };
    registerChartCueHost(host);
    await keepChartCue("c1", ring("a"));
    expect(host.keepCue).toHaveBeenCalledWith("c1", ring("a"));
    await expect(snapshotChart("c1", { saveToFile: true })).resolves.toBe("C:/x.png");
    expect(host.snapshot).toHaveBeenCalledWith("c1", { saveToFile: true });
  });
});
