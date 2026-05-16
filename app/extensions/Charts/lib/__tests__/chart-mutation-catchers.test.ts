//! FILENAME: app/extensions/Charts/lib/__tests__/chart-mutation-catchers.test.ts
// PURPOSE: Mutation-catching tests for chart filters, transforms (sort, aggregate,
//          window, bin). Verifies exact values, not just truthy checks.

import { describe, it, expect } from "vitest";
import { applyChartFilters } from "../chartFilters";
import { applyTransforms } from "../chartTransforms";
import type { ParsedChartData, ChartFilters, TransformSpec } from "../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeData(
  categories: string[],
  ...series: Array<{ name: string; values: number[] }>
): ParsedChartData {
  return {
    categories,
    series: series.map((s) => ({ ...s, color: null })),
  };
}

// ---------------------------------------------------------------------------
// Filter: removes exactly the specified series/categories (not +-1)
// ---------------------------------------------------------------------------

describe("applyChartFilters exact removal", () => {
  const data = makeData(
    ["Q1", "Q2", "Q3", "Q4"],
    { name: "Revenue", values: [10, 20, 30, 40] },
    { name: "Cost", values: [5, 10, 15, 20] },
    { name: "Profit", values: [5, 10, 15, 20] },
  );

  it("hiding series 1 removes exactly that series", () => {
    const filters: ChartFilters = { hiddenSeries: [1], hiddenCategories: [] };
    const result = applyChartFilters(data, filters);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].name).toBe("Revenue");
    expect(result.series[1].name).toBe("Profit");
  });

  it("hiding series 0 removes the first series, not the second", () => {
    const filters: ChartFilters = { hiddenSeries: [0], hiddenCategories: [] };
    const result = applyChartFilters(data, filters);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].name).toBe("Cost");
    expect(result.series[1].name).toBe("Profit");
  });

  it("hiding the last series index removes only the last", () => {
    const filters: ChartFilters = { hiddenSeries: [2], hiddenCategories: [] };
    const result = applyChartFilters(data, filters);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].name).toBe("Revenue");
    expect(result.series[1].name).toBe("Cost");
  });

  it("hiding category 0 removes exactly the first category", () => {
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [0] };
    const result = applyChartFilters(data, filters);
    expect(result.categories).toEqual(["Q2", "Q3", "Q4"]);
    expect(result.series[0].values).toEqual([20, 30, 40]);
  });

  it("hiding category 3 removes exactly the last category", () => {
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [3] };
    const result = applyChartFilters(data, filters);
    expect(result.categories).toEqual(["Q1", "Q2", "Q3"]);
    expect(result.series[0].values).toEqual([10, 20, 30]);
  });

  it("hiding categories 1 and 2 keeps only first and last", () => {
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [1, 2] };
    const result = applyChartFilters(data, filters);
    expect(result.categories).toEqual(["Q1", "Q4"]);
    expect(result.series[0].values).toEqual([10, 40]);
  });

  it("combined series+category filter produces exact result", () => {
    const filters: ChartFilters = { hiddenSeries: [0], hiddenCategories: [0] };
    const result = applyChartFilters(data, filters);
    expect(result.series).toHaveLength(2);
    expect(result.categories).toEqual(["Q2", "Q3", "Q4"]);
    expect(result.series[0].name).toBe("Cost");
    expect(result.series[0].values).toEqual([10, 15, 20]);
  });

  it("no filters returns data unchanged", () => {
    const result = applyChartFilters(data, undefined);
    expect(result).toBe(data); // same reference
  });

  it("empty filter arrays return data unchanged", () => {
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [] };
    const result = applyChartFilters(data, filters);
    expect(result).toBe(data);
  });
});

// ---------------------------------------------------------------------------
// Sort: ascending vs descending not swapped
// ---------------------------------------------------------------------------

describe("sort transform order correctness", () => {
  const data = makeData(
    ["C", "A", "B"],
    { name: "Sales", values: [30, 10, 20] },
  );

  it("ascending sort by category produces A, B, C", () => {
    const transforms: TransformSpec[] = [
      { type: "sort", field: "$category", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(["A", "B", "C"]);
    expect(result.series[0].values).toEqual([10, 20, 30]);
  });

  it("descending sort by category produces C, B, A", () => {
    const transforms: TransformSpec[] = [
      { type: "sort", field: "$category", order: "desc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(["C", "B", "A"]);
    expect(result.series[0].values).toEqual([30, 20, 10]);
  });

  it("ascending sort by numeric field orders values low to high", () => {
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Sales", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([10, 20, 30]);
    expect(result.categories).toEqual(["A", "B", "C"]);
  });

  it("descending sort by numeric field orders values high to low", () => {
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Sales", order: "desc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([30, 20, 10]);
    expect(result.categories).toEqual(["C", "B", "A"]);
  });
});

// ---------------------------------------------------------------------------
// Aggregate: sum vs count vs mean produce correct values
// ---------------------------------------------------------------------------

describe("aggregate transform correctness", () => {
  // Two categories with duplicates for grouping
  const data = makeData(
    ["East", "East", "West", "West", "West"],
    { name: "Sales", values: [10, 20, 30, 40, 50] },
  );

  it("sum aggregation produces correct totals", () => {
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Sales", as: "Total" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(["East", "West"]);
    expect(result.series[0].values).toEqual([30, 120]); // 10+20=30, 30+40+50=120
    expect(result.series[0].name).toBe("Total");
  });

  it("count aggregation produces correct counts", () => {
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "count", field: "Sales", as: "Count" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([2, 3]);
  });

  it("mean aggregation produces correct averages", () => {
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "mean", field: "Sales", as: "Avg" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values[0]).toBe(15);  // (10+20)/2
    expect(result.series[0].values[1]).toBe(40);   // (30+40+50)/3
  });

  it("min aggregation picks the smallest", () => {
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "min", field: "Sales", as: "Min" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([10, 30]);
  });

  it("max aggregation picks the largest", () => {
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "max", field: "Sales", as: "Max" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([20, 50]);
  });

  it("median with even count averages the two middle values", () => {
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "median", field: "Sales", as: "Med" },
    ];
    const result = applyTransforms(data, transforms);
    // East: [10,20] => median = (10+20)/2 = 15
    // West: [30,40,50] => median = 40
    expect(result.series[0].values[0]).toBe(15);
    expect(result.series[0].values[1]).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Window: running sum accumulates correctly at each step
// ---------------------------------------------------------------------------

describe("window transform running_sum step-by-step", () => {
  const data = makeData(
    ["A", "B", "C", "D"],
    { name: "Val", values: [5, 3, 7, 2] },
  );

  it("running_sum produces exact cumulative values", () => {
    const transforms: TransformSpec[] = [
      { type: "window", op: "running_sum", field: "Val", as: "RunSum" },
    ];
    const result = applyTransforms(data, transforms);
    const runSum = result.series.find((s) => s.name === "RunSum")!;
    expect(runSum.values).toEqual([5, 8, 15, 17]);
  });

  it("running_mean produces exact cumulative means", () => {
    const transforms: TransformSpec[] = [
      { type: "window", op: "running_mean", field: "Val", as: "RunMean" },
    ];
    const result = applyTransforms(data, transforms);
    const runMean = result.series.find((s) => s.name === "RunMean")!;
    expect(runMean.values[0]).toBe(5);       // 5/1
    expect(runMean.values[1]).toBe(4);       // 8/2
    expect(runMean.values[2]).toBeCloseTo(5);        // 15/3
    expect(runMean.values[3]).toBeCloseTo(4.25);     // 17/4
  });

  it("rank assigns 1 to the highest value", () => {
    const transforms: TransformSpec[] = [
      { type: "window", op: "rank", field: "Val", as: "Rank" },
    ];
    const result = applyTransforms(data, transforms);
    const rank = result.series.find((s) => s.name === "Rank")!;
    // Values: [5, 3, 7, 2]. Sorted desc: 7(idx2), 5(idx0), 3(idx1), 2(idx3)
    // Ranks:  idx0=2, idx1=3, idx2=1, idx3=4
    expect(rank.values).toEqual([2, 3, 1, 4]);
  });
});

// ---------------------------------------------------------------------------
// Bin: boundary inclusivity/exclusivity
// ---------------------------------------------------------------------------

describe("bin transform boundaries", () => {
  it("all values land in bins and total count equals input length", () => {
    const data = makeData(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      { name: "X", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    );
    const transforms: TransformSpec[] = [
      { type: "bin", field: "X", binCount: 5, as: "Hist" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(5);
    const totalCount = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(totalCount).toBe(10); // no values lost or duplicated
  });

  it("max value is included in the last bin (not out of range)", () => {
    const data = makeData(
      ["a", "b", "c"],
      { name: "X", values: [0, 5, 10] },
    );
    const transforms: TransformSpec[] = [
      { type: "bin", field: "X", binCount: 2, as: "Hist" },
    ];
    const result = applyTransforms(data, transforms);
    // 2 bins, total count must be 3
    const totalCount = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(totalCount).toBe(3);
    // Last bin must contain the max value
    expect(result.series[0].values[1]).toBeGreaterThanOrEqual(1);
  });

  it("min value is included in the first bin", () => {
    const data = makeData(
      ["a", "b"],
      { name: "X", values: [0, 10] },
    );
    const transforms: TransformSpec[] = [
      { type: "bin", field: "X", binCount: 2, as: "Hist" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values[0]).toBeGreaterThanOrEqual(1);
  });

  it("single value input produces all count in one bin", () => {
    const data = makeData(
      ["a", "b", "c"],
      { name: "X", values: [5, 5, 5] },
    );
    const transforms: TransformSpec[] = [
      { type: "bin", field: "X", binCount: 3, as: "Hist" },
    ];
    const result = applyTransforms(data, transforms);
    const totalCount = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(totalCount).toBe(3);
  });

  it("produces exactly binCount categories", () => {
    const data = makeData(
      Array.from({ length: 20 }, (_, i) => `v${i}`),
      { name: "X", values: Array.from({ length: 20 }, (_, i) => i * 3) },
    );
    const transforms: TransformSpec[] = [
      { type: "bin", field: "X", binCount: 7, as: "Hist" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(7);
    expect(result.series[0].values).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Filter transform (predicate-based, distinct from chart filters)
// ---------------------------------------------------------------------------

describe("filter transform predicate exactness", () => {
  const data = makeData(
    ["A", "B", "C", "D", "E"],
    { name: "Val", values: [10, 20, 30, 40, 50] },
  );

  it("> 30 keeps exactly values 40 and 50", () => {
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Val", predicate: "> 30" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([40, 50]);
    expect(result.categories).toEqual(["D", "E"]);
  });

  it(">= 30 keeps exactly values 30, 40, 50", () => {
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Val", predicate: ">= 30" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([30, 40, 50]);
  });

  it("< 20 keeps exactly value 10", () => {
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Val", predicate: "< 20" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([10]);
  });

  it("= 30 keeps exactly the matching value", () => {
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Val", predicate: "= 30" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([30]);
    expect(result.categories).toEqual(["C"]);
  });

  it("!= 30 keeps everything except the matching value", () => {
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Val", predicate: "!= 30" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([10, 20, 40, 50]);
  });
});
