//! FILENAME: app/extensions/Charts/lib/__tests__/chart-boundary-transitions.test.ts
// PURPOSE: Tests targeting exact boundary transitions in chart transforms:
//          filter predicates at threshold, aggregate group sizes, bin edges,
//          trendline minimum data points, and scale domain boundaries.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline } from "../trendlineComputation";
import type { ParsedChartData, TransformSpec, FilterTransform, AggregateTransform, BinTransform, TrendlineSpec } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["A", "B", "C", "D", "E"],
    series: [{ name: "S1", values: [10, 20, 30, 40, 50], color: null }],
    ...overrides,
  };
}

// ============================================================================
// Filter threshold: value exactly equal to predicate
// ============================================================================

describe("Filter at exact threshold value", () => {
  it(">= keeps value exactly at threshold", () => {
    const data = makeData();
    const filter: FilterTransform = { type: "filter", field: "S1", predicate: ">= 30" };
    const result = applyTransforms(data, [filter]);
    expect(result.series[0].values).toContain(30);
    expect(result.series[0].values).toEqual([30, 40, 50]);
  });

  it("> excludes value exactly at threshold", () => {
    const data = makeData();
    const filter: FilterTransform = { type: "filter", field: "S1", predicate: "> 30" };
    const result = applyTransforms(data, [filter]);
    expect(result.series[0].values).not.toContain(30);
    expect(result.series[0].values).toEqual([40, 50]);
  });

  it("= keeps only value exactly at threshold", () => {
    const data = makeData();
    const filter: FilterTransform = { type: "filter", field: "S1", predicate: "= 30" };
    const result = applyTransforms(data, [filter]);
    expect(result.series[0].values).toEqual([30]);
    expect(result.categories).toEqual(["C"]);
  });

  it("<= keeps value exactly at threshold", () => {
    const data = makeData();
    const filter: FilterTransform = { type: "filter", field: "S1", predicate: "<= 30" };
    const result = applyTransforms(data, [filter]);
    expect(result.series[0].values).toEqual([10, 20, 30]);
  });

  it("< excludes value exactly at threshold", () => {
    const data = makeData();
    const filter: FilterTransform = { type: "filter", field: "S1", predicate: "< 30" };
    const result = applyTransforms(data, [filter]);
    expect(result.series[0].values).toEqual([10, 20]);
  });
});

// ============================================================================
// Aggregate: 1 item per group vs 2+ items
// ============================================================================

describe("Aggregate with varying group sizes", () => {
  it("mean of single-item group equals the item itself", () => {
    // Each category is unique => each group has exactly 1 item
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [10, 20, 30], color: null }],
    });
    const agg: AggregateTransform = {
      type: "aggregate", groupBy: ["$category"], op: "mean", field: "S1", as: "Avg",
    };
    const result = applyTransforms(data, [agg]);
    expect(result.series[0].values).toEqual([10, 20, 30]);
  });

  it("mean of two-item group is their average", () => {
    const data = makeData({
      categories: ["A", "A", "B"],
      series: [{ name: "S1", values: [10, 20, 30], color: null }],
    });
    const agg: AggregateTransform = {
      type: "aggregate", groupBy: ["$category"], op: "mean", field: "S1", as: "Avg",
    };
    const result = applyTransforms(data, [agg]);
    // Group A: (10+20)/2 = 15, Group B: 30
    expect(result.series[0].values).toEqual([15, 30]);
  });

  it("count returns 1 for single-item groups", () => {
    const data = makeData({
      categories: ["X", "Y", "Z"],
      series: [{ name: "S1", values: [5, 10, 15], color: null }],
    });
    const agg: AggregateTransform = {
      type: "aggregate", groupBy: ["$category"], op: "count", field: "S1", as: "N",
    };
    const result = applyTransforms(data, [agg]);
    expect(result.series[0].values).toEqual([1, 1, 1]);
  });

  it("median of 2 items is their average", () => {
    const data = makeData({
      categories: ["A", "A"],
      series: [{ name: "S1", values: [10, 30], color: null }],
    });
    const agg: AggregateTransform = {
      type: "aggregate", groupBy: ["$category"], op: "median", field: "S1", as: "Med",
    };
    const result = applyTransforms(data, [agg]);
    expect(result.series[0].values).toEqual([20]);
  });
});

// ============================================================================
// Bin boundaries: value at exact bin edge
// ============================================================================

describe("Bin transform at exact bin edges", () => {
  it("value at exact max goes into last bin (clamped)", () => {
    // Values: [0, 10]. Range=10, binCount=2, binWidth=5.
    // Value 10: binIdx = floor((10-0)/5) = 2, clamped to 1 (last bin)
    const data = makeData({
      categories: ["A", "B"],
      series: [{ name: "S1", values: [0, 10], color: null }],
    });
    const bin: BinTransform = { type: "bin", field: "S1", binCount: 2, as: "Binned" };
    const result = applyTransforms(data, [bin]);
    // Bin 0: [0, 5) has value 0; Bin 1: [5, 10] has value 10
    expect(result.series[0].values).toEqual([1, 1]);
  });

  it("value at exact internal bin boundary goes into higher bin", () => {
    // Values: [0, 5, 10]. Range=10, binCount=2, binWidth=5.
    // Value 5: binIdx = floor((5-0)/5) = 1 => bin 1
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [0, 5, 10], color: null }],
    });
    const bin: BinTransform = { type: "bin", field: "S1", binCount: 2, as: "Binned" };
    const result = applyTransforms(data, [bin]);
    // Bin 0: value 0 (count 1), Bin 1: values 5,10 (count 2)
    expect(result.series[0].values).toEqual([1, 2]);
  });

  it("all identical values: range is 0, all in one bin", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [7, 7, 7], color: null }],
    });
    const bin: BinTransform = { type: "bin", field: "S1", binCount: 3, as: "Binned" };
    const result = applyTransforms(data, [bin]);
    // range = 0, binWidth = 0/3 but code uses range || 1 = 1
    // All values: binIdx = floor((7-7)/0.333) = 0
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });
});

// ============================================================================
// Trendline: minimum data points for each type
// ============================================================================

describe("Trendline minimum data points", () => {
  it("linear returns null with fewer than 2 data points", () => {
    const data = makeData({
      categories: ["A"],
      series: [{ name: "S1", values: [10], color: null }],
    });
    const spec: TrendlineSpec = { type: "linear", seriesIndex: 0 };
    expect(computeTrendline(data, spec)).toBeNull();
  });

  it("linear succeeds with exactly 2 data points", () => {
    const data = makeData({
      categories: ["A", "B"],
      series: [{ name: "S1", values: [10, 20], color: null }],
    });
    const spec: TrendlineSpec = { type: "linear", seriesIndex: 0 };
    const result = computeTrendline(data, spec);
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(2);
    expect(result!.rSquared).toBeCloseTo(1.0, 5);
  });

  it("polynomial degree 2 with exactly 2 points falls back to lower degree", () => {
    const data = makeData({
      categories: ["A", "B"],
      series: [{ name: "S1", values: [10, 20], color: null }],
    });
    const spec: TrendlineSpec = { type: "polynomial", seriesIndex: 0, polynomialDegree: 2 };
    const result = computeTrendline(data, spec);
    // With 2 points, degree is capped to min(2, 2-1, 6) = 1 (linear)
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(2);
  });

  it("polynomial degree 2 succeeds with 3 points", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [1, 4, 9], color: null }],
    });
    const spec: TrendlineSpec = { type: "polynomial", seriesIndex: 0, polynomialDegree: 2 };
    const result = computeTrendline(data, spec);
    expect(result).not.toBeNull();
    expect(result!.rSquared).toBeCloseTo(1.0, 3);
  });

  it("moving average with period equal to data length returns 1 point", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [10, 20, 30], color: null }],
    });
    const spec: TrendlineSpec = { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 3 };
    const result = computeTrendline(data, spec);
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(1);
    expect(result!.points[0].value).toBeCloseTo(20, 5);
  });

  it("exponential with non-positive values falls back to linear", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [-5, 0, 10], color: null }],
    });
    const spec: TrendlineSpec = { type: "exponential", seriesIndex: 0 };
    const result = computeTrendline(data, spec);
    // Should not return null; falls back to linear
    expect(result).not.toBeNull();
  });
});

// ============================================================================
// Scale: value at exact domain min and max
// ============================================================================

describe("Scale domain boundaries via filter", () => {
  it("filter at exact min keeps only the minimum value", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [10, 20, 30], color: null }],
    });
    const filter: FilterTransform = { type: "filter", field: "S1", predicate: "= 10" };
    const result = applyTransforms(data, [filter]);
    expect(result.series[0].values).toEqual([10]);
  });

  it("filter at exact max keeps only the maximum value", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [10, 20, 30], color: null }],
    });
    const filter: FilterTransform = { type: "filter", field: "S1", predicate: "= 30" };
    const result = applyTransforms(data, [filter]);
    expect(result.series[0].values).toEqual([30]);
  });

  it(">= min keeps all values", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [10, 20, 30], color: null }],
    });
    const filter: FilterTransform = { type: "filter", field: "S1", predicate: ">= 10" };
    const result = applyTransforms(data, [filter]);
    expect(result.series[0].values).toEqual([10, 20, 30]);
  });

  it("<= max keeps all values", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S1", values: [10, 20, 30], color: null }],
    });
    const filter: FilterTransform = { type: "filter", field: "S1", predicate: "<= 30" };
    const result = applyTransforms(data, [filter]);
    expect(result.series[0].values).toEqual([10, 20, 30]);
  });
});
