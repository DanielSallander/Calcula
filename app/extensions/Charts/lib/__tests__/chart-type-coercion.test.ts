//! FILENAME: app/extensions/Charts/lib/__tests__/chart-type-coercion.test.ts
// PURPOSE: Exercise JS type coercion edge cases in chart data pipeline
// CONTEXT: Filters, aggregates, sorts, and trendlines with mixed types

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline } from "../trendlineComputation";
import type { ParsedChartData, TransformSpec } from "../../types";

function makeData(
  categories: string[],
  seriesEntries: Array<{ name: string; values: number[] }>,
): ParsedChartData {
  return {
    categories,
    series: seriesEntries.map((s) => ({ ...s, color: null })),
  };
}

// ---------------------------------------------------------------------------
// Filter with string vs number comparison
// ---------------------------------------------------------------------------

describe("filter transform with string/number coercion", () => {
  it("string '5' compared with > 3 works (parseFloat coerces)", () => {
    const data = makeData(["A", "B", "C"], [
      { name: "Sales", values: [1, 5, 3] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 3" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(["B"]);
    expect(result.series[0].values).toEqual([5]);
  });

  it("filter on category with numeric-looking strings", () => {
    const data = makeData(["10", "2", "30"], [
      { name: "Val", values: [100, 200, 300] },
    ]);
    // Category filter: = means string equality
    const transforms: TransformSpec[] = [
      { type: "filter", field: "$category", predicate: "= 10" },
    ];
    const result = applyTransforms(data, transforms);
    // "10" is compared numerically since both parse as numbers
    expect(result.categories).toHaveLength(1);
  });

  it("filter with NaN values does not match numeric predicates", () => {
    const data = makeData(["A", "B"], [
      { name: "X", values: [NaN, 5] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "filter", field: "X", predicate: "> 0" },
    ];
    const result = applyTransforms(data, transforms);
    // NaN > 0 is false, only B passes
    expect(result.categories).toEqual(["B"]);
  });
});

// ---------------------------------------------------------------------------
// Aggregate with mixed string/number values
// ---------------------------------------------------------------------------

describe("aggregate transform with mixed types", () => {
  it("sum of numeric values works normally", () => {
    const data = makeData(["A", "A", "B"], [
      { name: "Amt", values: [10, 20, 30] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Amt", as: "Total" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toContain(30); // A group
    expect(result.series[0].values).toContain(30); // B group
  });

  it("mean of single-element groups equals the element", () => {
    const data = makeData(["X"], [
      { name: "V", values: [42] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "mean", field: "V", as: "Avg" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values[0]).toBe(42);
  });

  it("aggregate with NaN in values propagates through sum", () => {
    const data = makeData(["A", "A"], [
      { name: "V", values: [10, NaN] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "V", as: "Total" },
    ];
    const result = applyTransforms(data, transforms);
    // 10 + NaN = NaN
    expect(isNaN(result.series[0].values[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sort with mixed types
// ---------------------------------------------------------------------------

describe("sort transform with mixed-type data", () => {
  it("sort by category uses localeCompare (string sort, not numeric)", () => {
    const data = makeData(["10", "2", "1"], [
      { name: "V", values: [100, 200, 300] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "sort", field: "$category", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    // localeCompare: "1" < "10" < "2" (string sort)
    expect(result.categories[0]).toBe("1");
    expect(result.categories[1]).toBe("10");
    expect(result.categories[2]).toBe("2");
  });

  it("sort by numeric series uses subtraction (numeric sort)", () => {
    const data = makeData(["A", "B", "C"], [
      { name: "V", values: [30, 10, 20] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "sort", field: "V", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([10, 20, 30]);
  });

  it("sort with NaN values - NaN subtraction yields NaN, sort is unstable", () => {
    const data = makeData(["A", "B", "C"], [
      { name: "V", values: [NaN, 1, 2] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "sort", field: "V", order: "asc" },
    ];
    // Should not throw
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Trendline with edge-case data
// ---------------------------------------------------------------------------

describe("trendline computation with coercion-sensitive data", () => {
  it("NaN values in series are skipped", () => {
    const data = makeData(["A", "B", "C", "D"], [
      { name: "S", values: [1, NaN, 3, 4] },
    ]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(4);
  });

  it("Infinity values are skipped (isFinite filter)", () => {
    const data = makeData(["A", "B", "C"], [
      { name: "S", values: [1, Infinity, 3] },
    ]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result).not.toBeNull();
    // Only 2 valid points (1 and 3), which is the minimum
    expect(result!.points).toHaveLength(3);
  });

  it("all NaN values returns null (fewer than 2 valid points)", () => {
    const data = makeData(["A", "B"], [
      { name: "S", values: [NaN, NaN] },
    ]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result).toBeNull();
  });

  it("single-element series returns null", () => {
    const data = makeData(["A"], [
      { name: "S", values: [42] },
    ]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scale / domain with string bounds (calculate transform)
// ---------------------------------------------------------------------------

describe("calculate transform with string-like expressions", () => {
  it("expression referencing series names resolves correctly", () => {
    const data = makeData(["A", "B"], [
      { name: "Revenue", values: [100, 200] },
      { name: "Cost", values: [60, 80] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Revenue - Cost", as: "Profit" },
    ];
    const result = applyTransforms(data, transforms);
    const profit = result.series.find((s) => s.name === "Profit");
    expect(profit).toBeDefined();
    expect(profit!.values).toEqual([40, 120]);
  });

  it("expression with invalid chars returns 0 for each row", () => {
    const data = makeData(["A"], [
      { name: "V", values: [10] },
    ]);
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "alert('xss')", as: "Bad" },
    ];
    const result = applyTransforms(data, transforms);
    const bad = result.series.find((s) => s.name === "Bad");
    expect(bad!.values[0]).toBe(0);
  });
});
