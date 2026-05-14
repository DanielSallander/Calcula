//! FILENAME: app/extensions/Charts/lib/__tests__/chartTransforms.test.ts
// PURPOSE: Tests for chart data transform pipeline (filter, sort, aggregate,
//          calculate, window, bin).

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import type { ParsedChartData, TransformSpec } from "../../types";

// ============================================================================
// Test Helpers
// ============================================================================

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["Jan", "Feb", "Mar", "Apr", "May"],
    series: [
      { name: "Sales", values: [100, 200, 300, 150, 250], color: null },
      { name: "Cost", values: [80, 120, 180, 90, 150], color: null },
    ],
    ...overrides,
  };
}

// ============================================================================
// applyTransforms (orchestration)
// ============================================================================

describe("applyTransforms", () => {
  it("returns data unchanged for empty transform array", () => {
    const data = makeData();
    const result = applyTransforms(data, []);
    expect(result).toBe(data);
  });

  it("applies multiple transforms in sequence", () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 150" },
      { type: "sort", field: "Sales", order: "desc" },
    ];
    const result = applyTransforms(data, transforms);
    // After filter: Feb(200), Mar(300), May(250)
    // After sort desc: Mar(300), May(250), Feb(200)
    expect(result.categories).toEqual(["Mar", "May", "Feb"]);
    expect(result.series[0].values).toEqual([300, 250, 200]);
  });

  it("ignores unknown transform types", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "unknown" as any, field: "Sales" },
    ]);
    expect(result).toBe(data);
  });
});

// ============================================================================
// Filter Transform
// ============================================================================

describe("filter transform", () => {
  it("filters by numeric series value (greater than)", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 200" },
    ]);
    expect(result.categories).toEqual(["Mar", "May"]);
    expect(result.series[0].values).toEqual([300, 250]);
  });

  it("filters by numeric series value (less than)", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "< 200" },
    ]);
    expect(result.categories).toEqual(["Jan", "Apr"]);
    expect(result.series[0].values).toEqual([100, 150]);
  });

  it("filters by greater-than-or-equal", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: ">= 200" },
    ]);
    expect(result.categories).toEqual(["Feb", "Mar", "May"]);
  });

  it("filters by less-than-or-equal", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "<= 150" },
    ]);
    expect(result.categories).toEqual(["Jan", "Apr"]);
  });

  it("filters by equality", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "= 200" },
    ]);
    expect(result.categories).toEqual(["Feb"]);
  });

  it("filters by inequality", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "!= 200" },
    ]);
    expect(result.categories).toEqual(["Jan", "Mar", "Apr", "May"]);
  });

  it("filters by $category field (string equality)", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "$category", predicate: "= Mar" },
    ]);
    expect(result.categories).toEqual(["Mar"]);
    expect(result.series[0].values).toEqual([300]);
  });

  it("filters by $category inequality", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "$category", predicate: "!= Jan" },
    ]);
    expect(result.categories).toEqual(["Feb", "Mar", "Apr", "May"]);
  });

  it("returns unmodified data for unknown series name", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Unknown", predicate: "> 0" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });

  it("returns unmodified data for invalid predicate", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "invalid" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });

  it("filters all series in parallel", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 200" },
    ]);
    // Cost values should be filtered at the same indices
    expect(result.series[1].values).toEqual([180, 150]);
  });
});

// ============================================================================
// Sort Transform
// ============================================================================

describe("sort transform", () => {
  it("sorts by series value ascending", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "sort", field: "Sales", order: "asc" },
    ]);
    expect(result.series[0].values).toEqual([100, 150, 200, 250, 300]);
    expect(result.categories).toEqual(["Jan", "Apr", "Feb", "May", "Mar"]);
  });

  it("sorts by series value descending", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "sort", field: "Sales", order: "desc" },
    ]);
    expect(result.series[0].values).toEqual([300, 250, 200, 150, 100]);
    expect(result.categories).toEqual(["Mar", "May", "Feb", "Apr", "Jan"]);
  });

  it("defaults to ascending order", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "sort", field: "Sales" },
    ]);
    expect(result.series[0].values).toEqual([100, 150, 200, 250, 300]);
  });

  it("sorts by $category alphabetically", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "sort", field: "$category", order: "asc" },
    ]);
    expect(result.categories).toEqual(["Apr", "Feb", "Jan", "Mar", "May"]);
  });

  it("reorders all series consistently", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "sort", field: "Sales", order: "asc" },
    ]);
    // Jan=100 (Cost=80), Apr=150 (Cost=90), Feb=200 (Cost=120), May=250 (Cost=150), Mar=300 (Cost=180)
    expect(result.series[1].values).toEqual([80, 90, 120, 150, 180]);
  });

  it("returns unmodified data for unknown series name", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "sort", field: "Unknown", order: "asc" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });

  it("handles empty data", () => {
    const data = makeData({ categories: [], series: [{ name: "Sales", values: [], color: null }] });
    const result = applyTransforms(data, [
      { type: "sort", field: "Sales", order: "asc" },
    ]);
    expect(result.categories).toEqual([]);
  });
});

// ============================================================================
// Aggregate Transform
// ============================================================================

describe("aggregate transform", () => {
  it("computes sum by group", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B", "B"],
      series: [{ name: "Val", values: [10, 20, 30, 40, 50], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Val", as: "Total" },
    ]);
    expect(result.categories).toEqual(["A", "B"]);
    expect(result.series[0].name).toBe("Total");
    expect(result.series[0].values).toEqual([30, 120]);
  });

  it("computes mean by group", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B"],
      series: [{ name: "Val", values: [10, 30, 20, 40], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "mean", field: "Val", as: "Avg" },
    ]);
    expect(result.series[0].values).toEqual([20, 30]);
  });

  it("computes median", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "A"],
      series: [{ name: "Val", values: [1, 3, 2], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "median", field: "Val", as: "Med" },
    ]);
    expect(result.series[0].values).toEqual([2]);
  });

  it("computes median for even count", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "A", "A"],
      series: [{ name: "Val", values: [1, 2, 3, 4], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "median", field: "Val", as: "Med" },
    ]);
    expect(result.series[0].values).toEqual([2.5]);
  });

  it("computes min by group", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B"],
      series: [{ name: "Val", values: [10, 5, 20, 15], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "min", field: "Val", as: "Min" },
    ]);
    expect(result.series[0].values).toEqual([5, 15]);
  });

  it("computes max by group", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B"],
      series: [{ name: "Val", values: [10, 5, 20, 15], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "max", field: "Val", as: "Max" },
    ]);
    expect(result.series[0].values).toEqual([10, 20]);
  });

  it("computes count by group", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B", "B"],
      series: [{ name: "Val", values: [10, 20, 30, 40, 50], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "count", field: "Val", as: "Count" },
    ]);
    expect(result.series[0].values).toEqual([2, 3]);
  });

  it("returns unmodified data for unknown field", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Unknown", as: "X" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });
});

// ============================================================================
// Window Transform
// ============================================================================

describe("window transform", () => {
  it("computes running sum", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Sales", as: "CumSales" },
    ]);
    const cumSeries = result.series.find((s) => s.name === "CumSales");
    expect(cumSeries).toBeDefined();
    expect(cumSeries!.values).toEqual([100, 300, 600, 750, 1000]);
  });

  it("computes running mean", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "window", op: "running_mean", field: "Sales", as: "AvgSales" },
    ]);
    const avgSeries = result.series.find((s) => s.name === "AvgSales");
    expect(avgSeries).toBeDefined();
    expect(avgSeries!.values[0]).toBeCloseTo(100);   // 100/1
    expect(avgSeries!.values[1]).toBeCloseTo(150);   // 300/2
    expect(avgSeries!.values[2]).toBeCloseTo(200);   // 600/3
    expect(avgSeries!.values[3]).toBeCloseTo(187.5); // 750/4
    expect(avgSeries!.values[4]).toBeCloseTo(200);   // 1000/5
  });

  it("computes rank (descending)", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "window", op: "rank", field: "Sales", as: "Rank" },
    ]);
    const rankSeries = result.series.find((s) => s.name === "Rank");
    expect(rankSeries).toBeDefined();
    // Sales: 100, 200, 300, 150, 250 -> ranks: 5, 3, 1, 4, 2
    expect(rankSeries!.values).toEqual([5, 3, 1, 4, 2]);
  });

  it("adds window series without removing existing series", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Sales", as: "CumSales" },
    ]);
    expect(result.series).toHaveLength(3);
    expect(result.series[0].name).toBe("Sales");
    expect(result.series[1].name).toBe("Cost");
    expect(result.series[2].name).toBe("CumSales");
  });

  it("replaces existing series with same name", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Sales", as: "Sales" },
    ]);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].values).toEqual([100, 300, 600, 750, 1000]);
  });

  it("returns unmodified data for unknown field", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Unknown", as: "X" },
    ]);
    expect(result.series).toHaveLength(2);
  });
});

// ============================================================================
// Calculate Transform
// ============================================================================

describe("calculate transform", () => {
  it("computes simple arithmetic expression", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "calculate", expr: "Sales - Cost", as: "Profit" },
    ]);
    const profit = result.series.find((s) => s.name === "Profit");
    expect(profit).toBeDefined();
    expect(profit!.values).toEqual([20, 80, 120, 60, 100]);
  });

  it("computes division", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "calculate", expr: "Cost / Sales", as: "Ratio" },
    ]);
    const ratio = result.series.find((s) => s.name === "Ratio");
    expect(ratio).toBeDefined();
    expect(ratio!.values[0]).toBeCloseTo(0.8);   // 80/100
    expect(ratio!.values[1]).toBeCloseTo(0.6);   // 120/200
  });

  it("replaces existing series with same name", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "calculate", expr: "Sales * 2", as: "Sales" },
    ]);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].values).toEqual([200, 400, 600, 300, 500]);
  });

  it("returns 0 for invalid expressions", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "calculate", expr: "alert('hack')", as: "Bad" },
    ]);
    const bad = result.series.find((s) => s.name === "Bad");
    expect(bad).toBeDefined();
    expect(bad!.values.every((v) => v === 0)).toBe(true);
  });
});

// ============================================================================
// Bin Transform
// ============================================================================

describe("bin transform", () => {
  it("bins values into equal-width bins", () => {
    const data: ParsedChartData = {
      categories: Array.from({ length: 10 }, (_, i) => String(i)),
      series: [{ name: "Val", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "bin", field: "Val", binCount: 3, as: "Binned" },
    ]);
    expect(result.categories).toHaveLength(3);
    expect(result.series[0].name).toBe("Binned");
    // All values should sum to 10
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(10);
  });

  it("defaults to 10 bins", () => {
    const data: ParsedChartData = {
      categories: Array.from({ length: 100 }, (_, i) => String(i)),
      series: [{ name: "Val", values: Array.from({ length: 100 }, (_, i) => i), color: null }],
    };
    const result = applyTransforms(data, [
      { type: "bin", field: "Val", as: "Binned" },
    ]);
    expect(result.categories).toHaveLength(10);
  });

  it("handles all same values", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "Val", values: [5, 5, 5], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "bin", field: "Val", binCount: 3, as: "Binned" },
    ]);
    // When range is 0, binWidth defaults to 1/binCount
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });

  it("returns unmodified data for unknown field", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "bin", field: "Unknown", binCount: 5, as: "X" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });

  it("returns unmodified data for empty series", () => {
    const data: ParsedChartData = {
      categories: [],
      series: [{ name: "Val", values: [], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "bin", field: "Val", binCount: 5, as: "Binned" },
    ]);
    expect(result.categories).toEqual([]);
  });
});

// ============================================================================
// Stress & Edge Cases
// ============================================================================

describe("stress: large datasets (10k+ points)", () => {
  const SIZE = 10_000;

  function makeLargeData(): ParsedChartData {
    return {
      categories: Array.from({ length: SIZE }, (_, i) => `Cat${i}`),
      series: [
        { name: "Big", values: Array.from({ length: SIZE }, (_, i) => i), color: null },
      ],
    };
  }

  it("filters 10k points without error", () => {
    const data = makeLargeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Big", predicate: "> 9000" },
    ]);
    expect(result.categories).toHaveLength(999);
    expect(result.series[0].values.every((v) => v > 9000)).toBe(true);
  });

  it("sorts 10k points", () => {
    const data = makeLargeData();
    // Reverse the values to force actual sorting work
    data.series[0].values.reverse();
    const result = applyTransforms(data, [
      { type: "sort", field: "Big", order: "asc" },
    ]);
    expect(result.series[0].values[0]).toBe(0);
    expect(result.series[0].values[SIZE - 1]).toBe(SIZE - 1);
  });

  it("computes running sum on 10k points", () => {
    const data = makeLargeData();
    const result = applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Big", as: "Cum" },
    ]);
    const cum = result.series.find((s) => s.name === "Cum")!;
    // Sum of 0..9999 = 49995000
    expect(cum.values[SIZE - 1]).toBe((SIZE * (SIZE - 1)) / 2);
  });

  it("bins 10k points", () => {
    const data = makeLargeData();
    const result = applyTransforms(data, [
      { type: "bin", field: "Big", binCount: 100, as: "Binned" },
    ]);
    expect(result.categories).toHaveLength(100);
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(SIZE);
  });

  it("aggregates 10k points into groups", () => {
    // 10k items in 100 groups
    const data: ParsedChartData = {
      categories: Array.from({ length: SIZE }, (_, i) => `G${i % 100}`),
      series: [{ name: "V", values: Array.from({ length: SIZE }, () => 1), color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "V", as: "Total" },
    ]);
    expect(result.categories).toHaveLength(100);
    expect(result.series[0].values.every((v) => v === 100)).toBe(true);
  });
});

describe("edge: all-NaN/null data", () => {
  function makeNanData(): ParsedChartData {
    return {
      categories: ["A", "B", "C"],
      series: [
        { name: "Bad", values: [NaN, NaN, NaN], color: null },
      ],
    };
  }

  it("filter with NaN values does not crash", () => {
    const result = applyTransforms(makeNanData(), [
      { type: "filter", field: "Bad", predicate: "> 0" },
    ]);
    // NaN > 0 is false, so all should be filtered out
    expect(result.categories).toHaveLength(0);
  });

  it("sort with NaN values does not crash", () => {
    const result = applyTransforms(makeNanData(), [
      { type: "sort", field: "Bad", order: "asc" },
    ]);
    expect(result.categories).toHaveLength(3);
  });

  it("running sum of NaN propagates NaN", () => {
    const result = applyTransforms(makeNanData(), [
      { type: "window", op: "running_sum", field: "Bad", as: "Cum" },
    ]);
    const cum = result.series.find((s) => s.name === "Cum")!;
    expect(cum.values.every((v) => isNaN(v))).toBe(true);
  });

  it("rank of all-NaN does not crash", () => {
    const result = applyTransforms(makeNanData(), [
      { type: "window", op: "rank", field: "Bad", as: "Rank" },
    ]);
    const rank = result.series.find((s) => s.name === "Rank")!;
    expect(rank).toBeDefined();
    expect(rank.values).toHaveLength(3);
  });

  it("bin with all-NaN throws due to invalid bin index", () => {
    // NaN values produce NaN bin indices, which is a known limitation
    expect(() =>
      applyTransforms(makeNanData(), [
        { type: "bin", field: "Bad", binCount: 3, as: "Binned" },
      ]),
    ).toThrow();
  });

  it("aggregate mean of NaN returns NaN", () => {
    const data: ParsedChartData = {
      categories: ["A", "A"],
      series: [{ name: "Bad", values: [NaN, NaN], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "mean", field: "Bad", as: "Avg" },
    ]);
    expect(result.series[0].values).toHaveLength(1);
    expect(isNaN(result.series[0].values[0])).toBe(true);
  });
});

describe("edge: single data point", () => {
  function makeSinglePoint(): ParsedChartData {
    return {
      categories: ["Only"],
      series: [{ name: "Val", values: [42], color: null }],
    };
  }

  it("filter single point - passes", () => {
    const result = applyTransforms(makeSinglePoint(), [
      { type: "filter", field: "Val", predicate: "> 0" },
    ]);
    expect(result.categories).toEqual(["Only"]);
  });

  it("filter single point - fails", () => {
    const result = applyTransforms(makeSinglePoint(), [
      { type: "filter", field: "Val", predicate: "> 100" },
    ]);
    expect(result.categories).toEqual([]);
  });

  it("sort single point", () => {
    const result = applyTransforms(makeSinglePoint(), [
      { type: "sort", field: "Val", order: "asc" },
    ]);
    expect(result.series[0].values).toEqual([42]);
  });

  it("running sum of single point", () => {
    const result = applyTransforms(makeSinglePoint(), [
      { type: "window", op: "running_sum", field: "Val", as: "Cum" },
    ]);
    expect(result.series.find((s) => s.name === "Cum")!.values).toEqual([42]);
  });

  it("rank of single point", () => {
    const result = applyTransforms(makeSinglePoint(), [
      { type: "window", op: "rank", field: "Val", as: "Rank" },
    ]);
    expect(result.series.find((s) => s.name === "Rank")!.values).toEqual([1]);
  });

  it("bin single point", () => {
    const result = applyTransforms(makeSinglePoint(), [
      { type: "bin", field: "Val", binCount: 5, as: "Binned" },
    ]);
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  it("aggregate single point", () => {
    const result = applyTransforms(makeSinglePoint(), [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Val", as: "S" },
    ]);
    expect(result.series[0].values).toEqual([42]);
  });

  it("calculate on single point", () => {
    const result = applyTransforms(makeSinglePoint(), [
      { type: "calculate", expr: "Val * 2", as: "Double" },
    ]);
    expect(result.series.find((s) => s.name === "Double")!.values).toEqual([84]);
  });
});

describe("edge: chaining multiple transforms", () => {
  it("filter -> sort -> window -> calculate", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: ">= 150" },
      { type: "sort", field: "Sales", order: "asc" },
      { type: "window", op: "running_sum", field: "Sales", as: "CumSales" },
      { type: "calculate", expr: "Sales - Cost", as: "Profit" },
    ]);
    // After filter: Feb(200), Mar(300), Apr(150), May(250)
    // After sort asc: Apr(150), Feb(200), May(250), Mar(300)
    expect(result.categories).toEqual(["Apr", "Feb", "May", "Mar"]);
    expect(result.series[0].values).toEqual([150, 200, 250, 300]);
    // Running sum: 150, 350, 600, 900
    const cum = result.series.find((s) => s.name === "CumSales")!;
    expect(cum.values).toEqual([150, 350, 600, 900]);
    // Profit: Sales - Cost (Apr: 150-90=60, Feb: 200-120=80, May: 250-150=100, Mar: 300-180=120)
    const profit = result.series.find((s) => s.name === "Profit")!;
    expect(profit.values).toEqual([60, 80, 100, 120]);
  });

  it("aggregate -> sort -> window", () => {
    const data: ParsedChartData = {
      categories: ["X", "X", "Y", "Y", "Y", "Z"],
      series: [{ name: "V", values: [10, 20, 5, 15, 10, 100], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "V", as: "Total" },
      { type: "sort", field: "Total", order: "desc" },
      { type: "window", op: "running_sum", field: "Total", as: "Cum" },
    ]);
    // Aggregate: X=30, Y=30, Z=100
    // Sort desc: Z=100, X=30, Y=30
    expect(result.categories[0]).toBe("Z");
    expect(result.series[0].values[0]).toBe(100);
    // Cum: 100, 130, 160
    const cum = result.series.find((s) => s.name === "Cum")!;
    expect(cum.values).toEqual([100, 130, 160]);
  });

  it("filter that removes everything yields empty result through chain", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 999999" },
      { type: "sort", field: "Sales", order: "asc" },
      { type: "window", op: "running_sum", field: "Sales", as: "Cum" },
    ]);
    expect(result.categories).toEqual([]);
    expect(result.series[0].values).toEqual([]);
  });

  it("multiple filters narrow progressively", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 100" },
      { type: "filter", field: "Sales", predicate: "< 300" },
    ]);
    // Sales > 100 AND < 300: Feb(200), Apr(150), May(250)
    expect(result.categories).toEqual(["Feb", "Apr", "May"]);
  });
});

describe("edge: negative and zero values", () => {
  it("handles negative values in sort", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "V", values: [-10, 5, -20], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "sort", field: "V", order: "asc" },
    ]);
    expect(result.series[0].values).toEqual([-20, -10, 5]);
  });

  it("handles division by zero in calculate", () => {
    const data: ParsedChartData = {
      categories: ["A"],
      series: [
        { name: "Num", values: [10], color: null },
        { name: "Den", values: [0], color: null },
      ],
    };
    const result = applyTransforms(data, [
      { type: "calculate", expr: "Num / Den", as: "Ratio" },
    ]);
    const ratio = result.series.find((s) => s.name === "Ratio")!;
    expect(ratio).toBeDefined();
    // Division by zero yields Infinity or NaN - just ensure no crash
    expect(ratio.values).toHaveLength(1);
  });

  it("handles all-zero values in bin", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "V", values: [0, 0, 0], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "bin", field: "V", binCount: 3, as: "Binned" },
    ]);
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });
});
