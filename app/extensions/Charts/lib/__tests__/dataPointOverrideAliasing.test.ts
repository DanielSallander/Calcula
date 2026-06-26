//! FILENAME: app/extensions/Charts/lib/__tests__/dataPointOverrideAliasing.test.ts
// PURPOSE: ITEM 4 — dataPointOverrides are keyed in AUTHORING (unfiltered) space.
//          applyChartFilters / applySelectionKeep emit painter→original index
//          maps (keptSeriesIndices / keptCategoryIndices), and toAuthoringIndices
//          translates a painter (si,ci) back so a hidden lower-index series or
//          category can't alias an override onto the wrong datum.

import { describe, it, expect } from "vitest";
import { applyChartFilters, applySelectionKeep } from "../chartFilters";
import { toAuthoringIndices } from "../dataPointOverrides";
import type { ParsedChartData, ChartFilters } from "../../types";

function makeData(): ParsedChartData {
  return {
    categories: ["Q1", "Q2", "Q3", "Q4"],
    series: [
      { name: "A", values: [1, 2, 3, 4], color: null },
      { name: "B", values: [5, 6, 7, 8], color: null },
      { name: "C", values: [9, 10, 11, 12], color: null },
    ],
  };
}

describe("applyChartFilters kept-index maps", () => {
  it("emits keptSeriesIndices mapping painter→original when a series is hidden", () => {
    const filters: ChartFilters = { hiddenSeries: [0], hiddenCategories: [] };
    const r = applyChartFilters(makeData(), filters);
    // Series A hidden -> painted series are [B, C] = original indices [1, 2]
    expect(r.series.map((s) => s.name)).toEqual(["B", "C"]);
    expect(r.keptSeriesIndices).toEqual([1, 2]);
    expect(r.keptCategoryIndices).toBeUndefined(); // no category filter ran
  });

  it("emits keptCategoryIndices mapping painter→original when a category is hidden", () => {
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [1] };
    const r = applyChartFilters(makeData(), filters);
    // Q2 hidden -> painted categories [Q1, Q3, Q4] = original [0, 2, 3]
    expect(r.categories).toEqual(["Q1", "Q3", "Q4"]);
    expect(r.keptCategoryIndices).toEqual([0, 2, 3]);
    expect(r.keptSeriesIndices).toBeUndefined();
  });

  it("emits both maps for a combined filter", () => {
    const filters: ChartFilters = { hiddenSeries: [1], hiddenCategories: [0, 3] };
    const r = applyChartFilters(makeData(), filters);
    expect(r.keptSeriesIndices).toEqual([0, 2]); // B hidden -> [A, C]
    expect(r.keptCategoryIndices).toEqual([1, 2]); // Q1, Q4 hidden -> [Q2, Q3]
  });

  it("leaves no maps for a no-op filter (returns the input unchanged)", () => {
    const data = makeData();
    expect(applyChartFilters(data, undefined)).toBe(data);
    expect(applyChartFilters(data, { hiddenSeries: [], hiddenCategories: [] })).toBe(data);
  });
});

describe("applySelectionKeep composes category maps", () => {
  it("emits keptCategoryIndices for a fresh keep", () => {
    const r = applySelectionKeep(makeData(), ["Q1", "Q3"]);
    expect(r.categories).toEqual(["Q1", "Q3"]);
    expect(r.keptCategoryIndices).toEqual([0, 2]);
  });

  it("composes with a PRIOR category filter so the map stays painter→ORIGINAL", () => {
    // Stage 1: hide Q2 (original index 1) -> [Q1, Q3, Q4] = original [0, 2, 3]
    const stage1 = applyChartFilters(makeData(), { hiddenSeries: [], hiddenCategories: [1] });
    // Stage 2: selection-keep [Q1, Q4] -> painted [Q1, Q4]; original indices [0, 3]
    const stage2 = applySelectionKeep(stage1, ["Q1", "Q4"]);
    expect(stage2.categories).toEqual(["Q1", "Q4"]);
    expect(stage2.keptCategoryIndices).toEqual([0, 3]); // NOT [0, 2] — composed through stage1
  });

  it("carries a prior series filter through unchanged (keep only touches categories)", () => {
    const stage1 = applyChartFilters(makeData(), { hiddenSeries: [0], hiddenCategories: [] });
    const stage2 = applySelectionKeep(stage1, ["Q1", "Q3"]);
    expect(stage2.keptSeriesIndices).toEqual([1, 2]); // preserved from stage1
    expect(stage2.keptCategoryIndices).toEqual([0, 2]);
  });
});

describe("toAuthoringIndices translation", () => {
  it("is identity when no maps are present (no filter active)", () => {
    expect(toAuthoringIndices({}, 1, 2)).toEqual({ seriesIndex: 1, categoryIndex: 2 });
  });

  it("translates painter indices back to authoring space", () => {
    const data = applyChartFilters(makeData(), { hiddenSeries: [0], hiddenCategories: [1] });
    // painter (si=0, ci=0) = first painted point = original series B(1), category Q1(0)
    expect(toAuthoringIndices(data, 0, 0)).toEqual({ seriesIndex: 1, categoryIndex: 0 });
    // painter (si=1, ci=1) = series C(2), category Q3(2)
    expect(toAuthoringIndices(data, 1, 1)).toEqual({ seriesIndex: 2, categoryIndex: 2 });
  });

  it("round-trips: a kept original index translates back to itself via the map", () => {
    const data = applyChartFilters(makeData(), { hiddenSeries: [1], hiddenCategories: [] });
    // original series C is painter index 1 (A kept at 0, C kept at 1)
    const painterSi = data.keptSeriesIndices!.indexOf(2);
    expect(toAuthoringIndices(data, painterSi, 0).seriesIndex).toBe(2);
  });
});
