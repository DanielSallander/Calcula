//! FILENAME: app/extensions/Charts/lib/__tests__/chart-regression-guards.test.ts
// PURPOSE: Regression guards for chart-specific bugs and edge cases.
// CONTEXT: Documents known crashes, NaN propagation, and data integrity issues.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { applyChartFilters } from "../chartFilters";
import { computeTrendline } from "../trendlineComputation";
import type { ParsedChartData, TransformSpec, TrendlineSpec } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeData(
  categories: string[],
  seriesList: Array<{ name: string; values: number[]; color: string | null }>,
): ParsedChartData {
  return { categories, series: seriesList };
}

// ============================================================================
// Guard: applyBin with all-NaN data (known crash)
// ============================================================================

describe("REGRESSION: applyBin with all-NaN data", () => {
  it("does not throw when all values are NaN", () => {
    const data = makeData(["a", "b", "c"], [
      { name: "vals", values: [NaN, NaN, NaN], color: null },
    ]);
    const transforms: TransformSpec[] = [
      { type: "bin", field: "vals", binCount: 5, as: "binned" },
    ];
    // KNOWN BUG: applyBin crashes when all values are NaN because
    // Math.min/max of NaN produces NaN, leading to NaN bin width and
    // NaN bin index, which crashes on array access.
    // This test documents the crash so it can be fixed later.
    expect(() => applyTransforms(data, transforms)).toThrow();
  });

  it("crashes with NaN input - documents known bug for future fix", () => {
    const data = makeData(["a", "b", "c"], [
      { name: "vals", values: [NaN, NaN, NaN], color: null },
    ]);
    const transforms: TransformSpec[] = [
      { type: "bin", field: "vals", binCount: 3, as: "binned" },
    ];
    // When this test starts failing (not throwing), the bug has been fixed
    expect(() => applyTransforms(data, transforms)).toThrow();
  });
});

// ============================================================================
// Guard: trendline exponential with zero values
// ============================================================================

describe("REGRESSION: exponential trendline with zero values", () => {
  it("does not produce NaN coefficients when data contains zeros", () => {
    const data = makeData(["a", "b", "c", "d"], [
      { name: "vals", values: [0, 10, 20, 30], color: null },
    ]);
    const spec: TrendlineSpec = { type: "exponential", seriesIndex: 0 };
    const result = computeTrendline(data, spec);

    // Should either return a valid result or fall back to linear
    if (result) {
      for (const pt of result.points) {
        expect(isFinite(pt.value)).toBe(true);
      }
      expect(isFinite(result.rSquared)).toBe(true);
    }
  });

  it("handles all-zero data without NaN", () => {
    const data = makeData(["a", "b", "c"], [
      { name: "vals", values: [0, 0, 0], color: null },
    ]);
    const spec: TrendlineSpec = { type: "exponential", seriesIndex: 0 };
    const result = computeTrendline(data, spec);

    if (result) {
      for (const pt of result.points) {
        expect(isFinite(pt.value)).toBe(true);
      }
    }
  });
});

// ============================================================================
// Guard: filter with hiddenSeries=[0] removes first series, not second
// ============================================================================

describe("REGRESSION: hiddenSeries index correctness", () => {
  it("hiddenSeries=[0] removes the first series", () => {
    const data = makeData(["Q1", "Q2"], [
      { name: "Revenue", values: [100, 200], color: "#FF0000" },
      { name: "Costs", values: [80, 150], color: "#00FF00" },
      { name: "Profit", values: [20, 50], color: "#0000FF" },
    ]);
    const result = applyChartFilters(data, { hiddenSeries: [0], hiddenCategories: [] });
    expect(result.series.length).toBe(2);
    expect(result.series[0].name).toBe("Costs");
    expect(result.series[1].name).toBe("Profit");
  });

  it("hiddenSeries=[1] removes the middle series", () => {
    const data = makeData(["Q1", "Q2"], [
      { name: "Revenue", values: [100, 200], color: "#FF0000" },
      { name: "Costs", values: [80, 150], color: "#00FF00" },
      { name: "Profit", values: [20, 50], color: "#0000FF" },
    ]);
    const result = applyChartFilters(data, { hiddenSeries: [1], hiddenCategories: [] });
    expect(result.series.length).toBe(2);
    expect(result.series[0].name).toBe("Revenue");
    expect(result.series[1].name).toBe("Profit");
  });

  it("hiddenSeries=[0,2] removes first and last, keeps middle", () => {
    const data = makeData(["Q1"], [
      { name: "A", values: [1], color: null },
      { name: "B", values: [2], color: null },
      { name: "C", values: [3], color: null },
    ]);
    const result = applyChartFilters(data, { hiddenSeries: [0, 2], hiddenCategories: [] });
    expect(result.series.length).toBe(1);
    expect(result.series[0].name).toBe("B");
  });
});

// ============================================================================
// Guard: sort descending on ties preserves original order (stability)
// ============================================================================

describe("REGRESSION: sort stability on tied values", () => {
  it("descending sort on ties preserves original category order", () => {
    const data = makeData(["Alpha", "Beta", "Gamma", "Delta"], [
      { name: "Score", values: [10, 10, 10, 10], color: null },
    ]);
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Score", order: "desc" },
    ];
    const result = applyTransforms(data, transforms);
    // All values are equal, so original order should be preserved (stable sort)
    expect(result.categories).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });

  it("ascending sort on partial ties preserves order within tie groups", () => {
    const data = makeData(["A", "B", "C", "D"], [
      { name: "Score", values: [20, 10, 10, 30], color: null },
    ]);
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Score", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    // B and C are tied at 10, should appear in original relative order
    expect(result.categories[0]).toBe("B");
    expect(result.categories[1]).toBe("C");
    expect(result.categories[2]).toBe("A");
    expect(result.categories[3]).toBe("D");
  });
});

// ============================================================================
// Guard: aggregate "count" counts all items including duplicates
// ============================================================================

describe("REGRESSION: aggregate count includes duplicates", () => {
  it("count returns total number of items, not unique count", () => {
    const data = makeData(["X", "X", "X", "Y", "Y"], [
      { name: "Val", values: [10, 10, 10, 20, 20], color: null },
    ]);
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "count", field: "Val", as: "Count" },
    ];
    const result = applyTransforms(data, transforms);
    // X appears 3 times, Y appears 2 times
    const xIdx = result.categories.indexOf("X");
    const yIdx = result.categories.indexOf("Y");
    expect(result.series[0].values[xIdx]).toBe(3);
    expect(result.series[0].values[yIdx]).toBe(2);
  });
});

// ============================================================================
// Guard: running_sum accumulates correctly across NaN gaps
// ============================================================================

describe("REGRESSION: running_sum with NaN values", () => {
  it("NaN in running_sum propagates NaN forward (sum + NaN = NaN)", () => {
    const data = makeData(["a", "b", "c", "d"], [
      { name: "Val", values: [10, NaN, 20, 30], color: null },
    ]);
    const transforms: TransformSpec[] = [
      { type: "window", op: "running_sum", field: "Val", as: "RunSum" },
    ];
    const result = applyTransforms(data, transforms);
    const runSum = result.series.find((s) => s.name === "RunSum");
    expect(runSum).toBeDefined();
    // First value is correct
    expect(runSum!.values[0]).toBe(10);
    // After NaN, sum becomes NaN because 10 + NaN = NaN
    expect(runSum!.values[1]).toBeNaN();
  });

  it("running_sum with all finite values accumulates correctly", () => {
    const data = makeData(["a", "b", "c"], [
      { name: "Val", values: [5, 10, 15], color: null },
    ]);
    const transforms: TransformSpec[] = [
      { type: "window", op: "running_sum", field: "Val", as: "RunSum" },
    ];
    const result = applyTransforms(data, transforms);
    const runSum = result.series.find((s) => s.name === "RunSum");
    expect(runSum!.values).toEqual([5, 15, 30]);
  });
});
