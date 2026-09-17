//! FILENAME: app/src/api/__tests__/chartCues.test.ts
// PURPOSE: The transient chart-cue store: set/get/clear semantics, notification
//          on change only, and immutability of what is stored.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setChartCues,
  getChartCues,
  clearChartCues,
  clearAllChartCues,
  listChartsWithCues,
  onChartCuesChanged,
  type ChartCue,
} from "../chartCues";

function ring(factId: string, categoryIndex = 2): ChartCue {
  return {
    factId,
    kind: "ring",
    polarity: "neutral",
    anchor: { type: "datum", series: "Sales", categoryIndex, categoryLabel: "Mar" },
  };
}

beforeEach(() => clearAllChartCues());

describe("@api/chartCues transient store", () => {
  it("is empty for an unknown chart and never returns undefined", () => {
    expect(getChartCues("nope")).toEqual([]);
    expect(listChartsWithCues()).toEqual([]);
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

  it("treats an empty set as a clear", () => {
    setChartCues("c1", [ring("f1")]);
    setChartCues("c1", []);
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
