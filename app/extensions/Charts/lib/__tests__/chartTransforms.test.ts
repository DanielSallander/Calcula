//! FILENAME: app/extensions/Charts/lib/__tests__/chartTransforms.test.ts
// PURPOSE: Tests for chart data transform pipeline (filter, sort, aggregate,
//          calculate, window, bin).

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import type { ParsedChartData, TransformSpec, TransformDiagnostic, TidyData } from "../../types";

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
  it("returns data unchanged for empty transform array", async () => {
    const data = makeData();
    const result = await applyTransforms(data, []);
    expect(result).toBe(data);
  });

  it("applies multiple transforms in sequence", async () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 150" },
      { type: "sort", field: "Sales", order: "desc" },
    ];
    const result = await applyTransforms(data, transforms);
    // After filter: Feb(200), Mar(300), May(250)
    // After sort desc: Mar(300), May(250), Feb(200)
    expect(result.categories).toEqual(["Mar", "May", "Feb"]);
    expect(result.series[0].values).toEqual([300, 250, 200]);
  });

  it("ignores unknown transform types", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "unknown" as any, field: "Sales" },
    ]);
    expect(result).toBe(data);
  });
});

// ============================================================================
// Filter Transform
// ============================================================================

describe("filter transform", () => {
  it("filters by numeric series value (greater than)", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 200" },
    ]);
    expect(result.categories).toEqual(["Mar", "May"]);
    expect(result.series[0].values).toEqual([300, 250]);
  });

  it("filters by numeric series value (less than)", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "< 200" },
    ]);
    expect(result.categories).toEqual(["Jan", "Apr"]);
    expect(result.series[0].values).toEqual([100, 150]);
  });

  it("filters by greater-than-or-equal", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: ">= 200" },
    ]);
    expect(result.categories).toEqual(["Feb", "Mar", "May"]);
  });

  it("filters by less-than-or-equal", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "<= 150" },
    ]);
    expect(result.categories).toEqual(["Jan", "Apr"]);
  });

  it("filters by equality", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "= 200" },
    ]);
    expect(result.categories).toEqual(["Feb"]);
  });

  it("filters by inequality", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "!= 200" },
    ]);
    expect(result.categories).toEqual(["Jan", "Mar", "Apr", "May"]);
  });

  it("filters by $category field (string equality)", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "$category", predicate: "= Mar" },
    ]);
    expect(result.categories).toEqual(["Mar"]);
    expect(result.series[0].values).toEqual([300]);
  });

  it("filters by $category inequality", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "$category", predicate: "!= Jan" },
    ]);
    expect(result.categories).toEqual(["Feb", "Mar", "Apr", "May"]);
  });

  it("returns unmodified data for unknown series name", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Unknown", predicate: "> 0" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });

  it("returns unmodified data for invalid predicate", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "invalid" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });

  it("filters all series in parallel", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
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
  it("sorts by series value ascending", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "sort", field: "Sales", order: "asc" },
    ]);
    expect(result.series[0].values).toEqual([100, 150, 200, 250, 300]);
    expect(result.categories).toEqual(["Jan", "Apr", "Feb", "May", "Mar"]);
  });

  it("sorts by series value descending", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "sort", field: "Sales", order: "desc" },
    ]);
    expect(result.series[0].values).toEqual([300, 250, 200, 150, 100]);
    expect(result.categories).toEqual(["Mar", "May", "Feb", "Apr", "Jan"]);
  });

  it("defaults to ascending order", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "sort", field: "Sales" },
    ]);
    expect(result.series[0].values).toEqual([100, 150, 200, 250, 300]);
  });

  it("sorts by $category alphabetically", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "sort", field: "$category", order: "asc" },
    ]);
    expect(result.categories).toEqual(["Apr", "Feb", "Jan", "Mar", "May"]);
  });

  it("reorders all series consistently", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "sort", field: "Sales", order: "asc" },
    ]);
    // Jan=100 (Cost=80), Apr=150 (Cost=90), Feb=200 (Cost=120), May=250 (Cost=150), Mar=300 (Cost=180)
    expect(result.series[1].values).toEqual([80, 90, 120, 150, 180]);
  });

  it("returns unmodified data for unknown series name", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "sort", field: "Unknown", order: "asc" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });

  it("handles empty data", async () => {
    const data = makeData({ categories: [], series: [{ name: "Sales", values: [], color: null }] });
    const result = await applyTransforms(data, [
      { type: "sort", field: "Sales", order: "asc" },
    ]);
    expect(result.categories).toEqual([]);
  });
});

// ============================================================================
// Aggregate Transform
// ============================================================================

describe("aggregate transform", () => {
  it("computes sum by group", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B", "B"],
      series: [{ name: "Val", values: [10, 20, 30, 40, 50], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Val", as: "Total" },
    ]);
    expect(result.categories).toEqual(["A", "B"]);
    expect(result.series[0].name).toBe("Total");
    expect(result.series[0].values).toEqual([30, 120]);
  });

  it("computes mean by group", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B"],
      series: [{ name: "Val", values: [10, 30, 20, 40], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "mean", field: "Val", as: "Avg" },
    ]);
    expect(result.series[0].values).toEqual([20, 30]);
  });

  it("computes median", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "A"],
      series: [{ name: "Val", values: [1, 3, 2], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "median", field: "Val", as: "Med" },
    ]);
    expect(result.series[0].values).toEqual([2]);
  });

  it("computes median for even count", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "A", "A"],
      series: [{ name: "Val", values: [1, 2, 3, 4], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "median", field: "Val", as: "Med" },
    ]);
    expect(result.series[0].values).toEqual([2.5]);
  });

  it("computes min by group", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B"],
      series: [{ name: "Val", values: [10, 5, 20, 15], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "min", field: "Val", as: "Min" },
    ]);
    expect(result.series[0].values).toEqual([5, 15]);
  });

  it("computes max by group", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B"],
      series: [{ name: "Val", values: [10, 5, 20, 15], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "max", field: "Val", as: "Max" },
    ]);
    expect(result.series[0].values).toEqual([10, 20]);
  });

  it("computes count by group", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B", "B"],
      series: [{ name: "Val", values: [10, 20, 30, 40, 50], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "count", field: "Val", as: "Count" },
    ]);
    expect(result.series[0].values).toEqual([2, 3]);
  });

  it("returns unmodified data for unknown field", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Unknown", as: "X" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });

  it("defaults the output name to the field name when `as` is omitted", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B"],
      series: [{ name: "Sales", values: [10, 20, 30], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Sales" },
    ]);
    expect(result.series).toHaveLength(1);
    expect(result.series[0].name).toBe("Sales");
    expect(result.series[0].values).toEqual([30, 30]);
  });
});

describe("aggregate transform: multi-series", () => {
  const data: ParsedChartData = {
    categories: ["A", "A", "B"],
    series: [
      { name: "Sales", values: [10, 20, 30], color: null },
      { name: "Profit", values: [1, 2, 3], color: "#ff0000" },
    ],
  };

  it("aggregates every series per group when field is omitted", async () => {
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum" },
    ]);
    expect(result.categories).toEqual(["A", "B"]);
    expect(result.series).toHaveLength(2);
    expect(result.series[0]).toMatchObject({ name: "Sales", values: [30, 30] });
    expect(result.series[1]).toMatchObject({ name: "Profit", values: [3, 3], color: "#ff0000" });
  });

  it("treats field: \"*\" the same as omitting field", async () => {
    const result = await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "mean", field: "*" },
    ]);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].values).toEqual([15, 30]); // mean(10,20)=15, mean(30)=30
    expect(result.series[1].values).toEqual([1.5, 3]);
  });

  it("returns data unchanged when there are no series", async () => {
    const empty: ParsedChartData = { categories: ["A", "B"], series: [] };
    const result = await applyTransforms(empty, [
      { type: "aggregate", groupBy: ["$category"], op: "sum" },
    ]);
    expect(result).toBe(empty);
  });
});

// ============================================================================
// Window Transform
// ============================================================================

describe("window transform", () => {
  it("computes running sum", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Sales", as: "CumSales" },
    ]);
    const cumSeries = result.series.find((s) => s.name === "CumSales");
    expect(cumSeries).toBeDefined();
    expect(cumSeries!.values).toEqual([100, 300, 600, 750, 1000]);
  });

  it("computes running mean", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
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

  it("computes rank (descending)", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "window", op: "rank", field: "Sales", as: "Rank" },
    ]);
    const rankSeries = result.series.find((s) => s.name === "Rank");
    expect(rankSeries).toBeDefined();
    // Sales: 100, 200, 300, 150, 250 -> ranks: 5, 3, 1, 4, 2
    expect(rankSeries!.values).toEqual([5, 3, 1, 4, 2]);
  });

  it("adds window series without removing existing series", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Sales", as: "CumSales" },
    ]);
    expect(result.series).toHaveLength(3);
    expect(result.series[0].name).toBe("Sales");
    expect(result.series[1].name).toBe("Cost");
    expect(result.series[2].name).toBe("CumSales");
  });

  it("replaces existing series with same name", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Sales", as: "Sales" },
    ]);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].values).toEqual([100, 300, 600, 750, 1000]);
  });

  it("returns unmodified data for unknown field", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Unknown", as: "X" },
    ]);
    expect(result.series).toHaveLength(2);
  });
});

// ============================================================================
// Calculate Transform
// ============================================================================

describe("calculate transform", () => {
  it("computes simple arithmetic expression", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "calculate", expr: "Sales - Cost", as: "Profit" },
    ]);
    const profit = result.series.find((s) => s.name === "Profit");
    expect(profit).toBeDefined();
    expect(profit!.values).toEqual([20, 80, 120, 60, 100]);
  });

  it("computes division", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "calculate", expr: "Cost / Sales", as: "Ratio" },
    ]);
    const ratio = result.series.find((s) => s.name === "Ratio");
    expect(ratio).toBeDefined();
    expect(ratio!.values[0]).toBeCloseTo(0.8);   // 80/100
    expect(ratio!.values[1]).toBeCloseTo(0.6);   // 120/200
  });

  it("replaces existing series with same name", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "calculate", expr: "Sales * 2", as: "Sales" },
    ]);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].values).toEqual([200, 400, 600, 300, 500]);
  });

  it("returns 0 for invalid expressions", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
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
  it("bins values into equal-width bins", async () => {
    const data: ParsedChartData = {
      categories: Array.from({ length: 10 }, (_, i) => String(i)),
      series: [{ name: "Val", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "bin", field: "Val", binCount: 3, as: "Binned" },
    ]);
    expect(result.categories).toHaveLength(3);
    expect(result.series[0].name).toBe("Binned");
    // All values should sum to 10
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(10);
  });

  it("defaults to 10 bins", async () => {
    const data: ParsedChartData = {
      categories: Array.from({ length: 100 }, (_, i) => String(i)),
      series: [{ name: "Val", values: Array.from({ length: 100 }, (_, i) => i), color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "bin", field: "Val", as: "Binned" },
    ]);
    expect(result.categories).toHaveLength(10);
  });

  it("handles all same values", async () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "Val", values: [5, 5, 5], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "bin", field: "Val", binCount: 3, as: "Binned" },
    ]);
    // When range is 0, binWidth defaults to 1/binCount
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });

  it("returns unmodified data for unknown field", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "bin", field: "Unknown", binCount: 5, as: "X" },
    ]);
    expect(result.categories).toEqual(data.categories);
  });

  it("returns unmodified data for empty series", async () => {
    const data: ParsedChartData = {
      categories: [],
      series: [{ name: "Val", values: [], color: null }],
    };
    const result = await applyTransforms(data, [
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

  it("filters 10k points without error", async () => {
    const data = makeLargeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Big", predicate: "> 9000" },
    ]);
    expect(result.categories).toHaveLength(999);
    expect(result.series[0].values.every((v) => v > 9000)).toBe(true);
  });

  it("sorts 10k points", async () => {
    const data = makeLargeData();
    // Reverse the values to force actual sorting work
    data.series[0].values.reverse();
    const result = await applyTransforms(data, [
      { type: "sort", field: "Big", order: "asc" },
    ]);
    expect(result.series[0].values[0]).toBe(0);
    expect(result.series[0].values[SIZE - 1]).toBe(SIZE - 1);
  });

  it("computes running sum on 10k points", async () => {
    const data = makeLargeData();
    const result = await applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Big", as: "Cum" },
    ]);
    const cum = result.series.find((s) => s.name === "Cum")!;
    // Sum of 0..9999 = 49995000
    expect(cum.values[SIZE - 1]).toBe((SIZE * (SIZE - 1)) / 2);
  });

  it("bins 10k points", async () => {
    const data = makeLargeData();
    const result = await applyTransforms(data, [
      { type: "bin", field: "Big", binCount: 100, as: "Binned" },
    ]);
    expect(result.categories).toHaveLength(100);
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(SIZE);
  });

  it("aggregates 10k points into groups", async () => {
    // 10k items in 100 groups
    const data: ParsedChartData = {
      categories: Array.from({ length: SIZE }, (_, i) => `G${i % 100}`),
      series: [{ name: "V", values: Array.from({ length: SIZE }, () => 1), color: null }],
    };
    const result = await applyTransforms(data, [
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

  it("filter with NaN values does not crash", async () => {
    const result = await applyTransforms(makeNanData(), [
      { type: "filter", field: "Bad", predicate: "> 0" },
    ]);
    // NaN > 0 is false, so all should be filtered out
    expect(result.categories).toHaveLength(0);
  });

  it("sort with NaN values does not crash", async () => {
    const result = await applyTransforms(makeNanData(), [
      { type: "sort", field: "Bad", order: "asc" },
    ]);
    expect(result.categories).toHaveLength(3);
  });

  it("running sum of NaN propagates NaN", async () => {
    const result = await applyTransforms(makeNanData(), [
      { type: "window", op: "running_sum", field: "Bad", as: "Cum" },
    ]);
    const cum = result.series.find((s) => s.name === "Cum")!;
    expect(cum.values.every((v) => isNaN(v))).toBe(true);
  });

  it("rank of all-NaN does not crash", async () => {
    const result = await applyTransforms(makeNanData(), [
      { type: "window", op: "rank", field: "Bad", as: "Rank" },
    ]);
    const rank = result.series.find((s) => s.name === "Rank")!;
    expect(rank).toBeDefined();
    expect(rank.values).toHaveLength(3);
  });

  it("bin with all-NaN throws due to invalid bin index", async () => {
    // NaN values produce NaN bin indices, which is a known limitation
    await expect(
      applyTransforms(makeNanData(), [
        { type: "bin", field: "Bad", binCount: 3, as: "Binned" },
      ]),
    ).rejects.toThrow();
  });

  it("aggregate mean of NaN returns NaN", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A"],
      series: [{ name: "Bad", values: [NaN, NaN], color: null }],
    };
    const result = await applyTransforms(data, [
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

  it("filter single point - passes", async () => {
    const result = await applyTransforms(makeSinglePoint(), [
      { type: "filter", field: "Val", predicate: "> 0" },
    ]);
    expect(result.categories).toEqual(["Only"]);
  });

  it("filter single point - fails", async () => {
    const result = await applyTransforms(makeSinglePoint(), [
      { type: "filter", field: "Val", predicate: "> 100" },
    ]);
    expect(result.categories).toEqual([]);
  });

  it("sort single point", async () => {
    const result = await applyTransforms(makeSinglePoint(), [
      { type: "sort", field: "Val", order: "asc" },
    ]);
    expect(result.series[0].values).toEqual([42]);
  });

  it("running sum of single point", async () => {
    const result = await applyTransforms(makeSinglePoint(), [
      { type: "window", op: "running_sum", field: "Val", as: "Cum" },
    ]);
    expect(result.series.find((s) => s.name === "Cum")!.values).toEqual([42]);
  });

  it("rank of single point", async () => {
    const result = await applyTransforms(makeSinglePoint(), [
      { type: "window", op: "rank", field: "Val", as: "Rank" },
    ]);
    expect(result.series.find((s) => s.name === "Rank")!.values).toEqual([1]);
  });

  it("bin single point", async () => {
    const result = await applyTransforms(makeSinglePoint(), [
      { type: "bin", field: "Val", binCount: 5, as: "Binned" },
    ]);
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  it("aggregate single point", async () => {
    const result = await applyTransforms(makeSinglePoint(), [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Val", as: "S" },
    ]);
    expect(result.series[0].values).toEqual([42]);
  });

  it("calculate on single point", async () => {
    const result = await applyTransforms(makeSinglePoint(), [
      { type: "calculate", expr: "Val * 2", as: "Double" },
    ]);
    expect(result.series.find((s) => s.name === "Double")!.values).toEqual([84]);
  });
});

describe("edge: chaining multiple transforms", () => {
  it("filter -> sort -> window -> calculate", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
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

  it("aggregate -> sort -> window", async () => {
    const data: ParsedChartData = {
      categories: ["X", "X", "Y", "Y", "Y", "Z"],
      series: [{ name: "V", values: [10, 20, 5, 15, 10, 100], color: null }],
    };
    const result = await applyTransforms(data, [
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

  it("filter that removes everything yields empty result through chain", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 999999" },
      { type: "sort", field: "Sales", order: "asc" },
      { type: "window", op: "running_sum", field: "Sales", as: "Cum" },
    ]);
    expect(result.categories).toEqual([]);
    expect(result.series[0].values).toEqual([]);
  });

  it("multiple filters narrow progressively", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 100" },
      { type: "filter", field: "Sales", predicate: "< 300" },
    ]);
    // Sales > 100 AND < 300: Feb(200), Apr(150), May(250)
    expect(result.categories).toEqual(["Feb", "Apr", "May"]);
  });
});

describe("edge: negative and zero values", () => {
  it("handles negative values in sort", async () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "V", values: [-10, 5, -20], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "sort", field: "V", order: "asc" },
    ]);
    expect(result.series[0].values).toEqual([-20, -10, 5]);
  });

  it("handles division by zero in calculate", async () => {
    const data: ParsedChartData = {
      categories: ["A"],
      series: [
        { name: "Num", values: [10], color: null },
        { name: "Den", values: [0], color: null },
      ],
    };
    const result = await applyTransforms(data, [
      { type: "calculate", expr: "Num / Den", as: "Ratio" },
    ]);
    const ratio = result.series.find((s) => s.name === "Ratio")!;
    expect(ratio).toBeDefined();
    // Division by zero yields Infinity or NaN - just ensure no crash
    expect(ratio.values).toHaveLength(1);
  });

  it("handles all-zero values in bin", async () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "V", values: [0, 0, 0], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "bin", field: "V", binCount: 3, as: "Binned" },
    ]);
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });
});

// ============================================================================
// Formula-powered calculate & filter (B1)
// ============================================================================

describe("calculate transform: formula functions", () => {
  it("supports IF with a numeric condition", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "calculate", expr: "IF(Sales > 200, 1, 0)", as: "Flag" },
    ]);
    const flag = result.series.find((s) => s.name === "Flag")!;
    // Sales = [100, 200, 300, 150, 250] -> >200 at Mar, May
    expect(flag.values).toEqual([0, 0, 1, 0, 1]);
  });

  it("references $category (regression: previously evaluated to 0)", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "calculate", expr: 'IF($category = "Mar", Sales, 0)', as: "MarOnly" },
    ]);
    const marOnly = result.series.find((s) => s.name === "MarOnly")!;
    expect(marOnly.values).toEqual([0, 0, 300, 0, 0]);
  });

  it("supports nested math functions (ROUND, division)", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "calculate", expr: "ROUND(Cost / Sales * 100, 1)", as: "Ratio%" },
    ]);
    const ratio = result.series.find((s) => s.name === "Ratio%")!;
    // Cost/Sales*100: 80, 60, 60, 60, 60
    expect(ratio.values).toEqual([80, 60, 60, 60, 60]);
  });

  it("supports ABS", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "calculate", expr: "ABS(Cost - Sales)", as: "AbsGap" },
    ]);
    const gap = result.series.find((s) => s.name === "AbsGap")!;
    expect(gap.values).toEqual([20, 80, 120, 60, 100]);
  });

  it("coerces non-numeric (string) results to 0", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "calculate", expr: '$category & "!"', as: "Label" },
    ]);
    const label = result.series.find((s) => s.name === "Label")!;
    expect(label.values).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("filter transform: formula predicates", () => {
  it("supports compound AND across fields", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "AND(value > 100, Cost < 180)" },
    ]);
    // Sales>100: Feb,Mar,Apr,May ; Cost<180: Jan,Feb,Apr,May ; AND -> Feb,Apr,May
    expect(result.categories).toEqual(["Feb", "Apr", "May"]);
  });

  it("supports compound OR", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "OR(value < 120, value > 240)" },
    ]);
    // Sales<120: Jan(100) ; Sales>240: Mar(300), May(250)
    expect(result.categories).toEqual(["Jan", "Mar", "May"]);
  });

  it("supports text functions on $category", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "$category", predicate: 'LEFT($category, 1) = "M"' },
    ]);
    expect(result.categories).toEqual(["Mar", "May"]);
  });

  it("supports a full <> comparison on $category", async () => {
    const data = makeData();
    const result = await applyTransforms(data, [
      { type: "filter", field: "$category", predicate: '$category <> "Jan"' },
    ]);
    expect(result.categories).toEqual(["Feb", "Mar", "Apr", "May"]);
  });
});

// ============================================================================
// Transform diagnostics (A5)
// ============================================================================

describe("transform diagnostics", () => {
  it("reports an error for an invalid calculate expression", async () => {
    const diags: TransformDiagnostic[] = [];
    const result = await applyTransforms(makeData(), [
      { type: "calculate", expr: "1 +", as: "X" },
    ], diags);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ index: 0, transformType: "calculate", severity: "error" });
    // Values still produced (all zeros), never a crash.
    expect(result.series.find((s) => s.name === "X")!.values).toEqual([0, 0, 0, 0, 0]);
  });

  it("reports a warning when calculate rows cannot be evaluated", async () => {
    const diags: TransformDiagnostic[] = [];
    await applyTransforms(makeData(), [
      { type: "calculate", expr: "Missing + 1", as: "X" },
    ], diags);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ transformType: "calculate", severity: "warning" });
    expect(diags[0].message).toContain("5 of 5 rows");
  });

  it("reports a warning for an unknown filter field", async () => {
    const diags: TransformDiagnostic[] = [];
    await applyTransforms(makeData(), [
      { type: "filter", field: "Nope", predicate: "> 0" },
    ], diags);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ transformType: "filter", severity: "warning" });
    expect(diags[0].message).toContain("unknown field");
  });

  it("reports a warning for an invalid filter predicate", async () => {
    const diags: TransformDiagnostic[] = [];
    await applyTransforms(makeData(), [
      { type: "filter", field: "Sales", predicate: "AND(" },
    ], diags);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("invalid predicate");
  });

  it("reports unknown fields for sort, window, and bin", async () => {
    for (const t of [
      { type: "sort", field: "Nope" } as TransformSpec,
      { type: "window", op: "running_sum", field: "Nope", as: "X" } as TransformSpec,
      { type: "bin", field: "Nope", as: "X" } as TransformSpec,
    ]) {
      const diags: TransformDiagnostic[] = [];
      await applyTransforms(makeData(), [t], diags);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain("unknown field");
    }
  });

  it("reports unknown groupBy fields in aggregate", async () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B"],
      series: [{ name: "V", values: [1, 2, 3], color: null }],
    };
    const diags: TransformDiagnostic[] = [];
    await applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category", "Ghost"], op: "sum", field: "V", as: "T" },
    ], diags);
    expect(diags.some((d) => d.message.includes("groupBy"))).toBe(true);
  });

  it("reports the correct transform index in a pipeline", async () => {
    const diags: TransformDiagnostic[] = [];
    await applyTransforms(makeData(), [
      { type: "sort", field: "Sales", order: "desc" },
      { type: "filter", field: "Nope", predicate: "> 0" },
    ], diags);
    expect(diags).toHaveLength(1);
    expect(diags[0].index).toBe(1);
  });

  it("produces no diagnostics for valid transforms", async () => {
    const diags: TransformDiagnostic[] = [];
    await applyTransforms(makeData(), [
      { type: "calculate", expr: "Sales - Cost", as: "Profit" },
      { type: "filter", field: "Profit", predicate: "> 0" },
      { type: "sort", field: "Sales", order: "desc" },
    ], diags);
    expect(diags).toEqual([]);
  });

  it("works without a diagnostics collector (no crash)", async () => {
    await expect(applyTransforms(makeData(), [
      { type: "calculate", expr: "1 +", as: "X" },
    ])).resolves.not.toThrow();
  });
});

// ============================================================================
// Lookup Transform (B3)
// ============================================================================

describe("lookup transform", () => {
  function secondary(series: ParsedChartData["series"], categories = ["Jan", "Mar", "May"]): ParsedChartData {
    return { categories, series };
  }

  it("joins matching categories and adds the series, defaulting unmatched to 0", async () => {
    const main = makeData();
    const lookupData = new Map<number, ParsedChartData>([
      [0, secondary([{ name: "Target", values: [90, 280, 240], color: null }])],
    ]);
    const result = await applyTransforms(main, [{ type: "lookup", from: "X" }], undefined, lookupData);
    const target = result.series.find((s) => s.name === "Target")!;
    expect(target).toBeDefined();
    // categories Jan,Feb,Mar,Apr,May -> 90, 0, 280, 0, 240
    expect(target.values).toEqual([90, 0, 280, 0, 240]);
    expect(result.categories).toEqual(main.categories);
    expect(result.series).toHaveLength(3);
  });

  it("uses the provided default for unmatched categories", async () => {
    const main = makeData();
    const lookupData = new Map<number, ParsedChartData>([
      [0, secondary([{ name: "Target", values: [90, 280, 240], color: null }])],
    ]);
    const result = await applyTransforms(main, [{ type: "lookup", from: "X", default: -1 }], undefined, lookupData);
    const target = result.series.find((s) => s.name === "Target")!;
    expect(target.values).toEqual([90, -1, 280, -1, 240]);
  });

  it("adds only the requested fields", async () => {
    const main = makeData();
    const lookupData = new Map<number, ParsedChartData>([
      [0, secondary([
        { name: "Target", values: [90, 280, 240], color: null },
        { name: "Quota", values: [1, 2, 3], color: null },
      ])],
    ]);
    const result = await applyTransforms(main, [{ type: "lookup", from: "X", fields: ["Target"] }], undefined, lookupData);
    expect(result.series.some((s) => s.name === "Target")).toBe(true);
    expect(result.series.some((s) => s.name === "Quota")).toBe(false);
  });

  it("replaces an existing series with the same name (aligned by category)", async () => {
    const main = makeData();
    const lookupData = new Map<number, ParsedChartData>([
      [0, secondary([{ name: "Sales", values: [11, 33, 55], color: null }])],
    ]);
    const result = await applyTransforms(main, [{ type: "lookup", from: "X" }], undefined, lookupData);
    expect(result.series).toHaveLength(2); // Sales replaced, Cost kept
    const sales = result.series.find((s) => s.name === "Sales")!;
    expect(sales.values).toEqual([11, 0, 33, 0, 55]);
  });

  it("warns and leaves data unchanged when the lookup data is missing", async () => {
    const main = makeData();
    const diags: TransformDiagnostic[] = [];
    const result = await applyTransforms(main, [{ type: "lookup", from: "X" }], diags);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ transformType: "lookup", severity: "warning" });
    expect(result.series).toHaveLength(2);
  });

  it("warns when no categories match", async () => {
    const main = makeData();
    const diags: TransformDiagnostic[] = [];
    const lookupData = new Map<number, ParsedChartData>([
      [0, secondary([{ name: "Target", values: [1, 2], color: null }], ["X", "Y"])],
    ]);
    await applyTransforms(main, [{ type: "lookup", from: "X" }], diags, lookupData);
    expect(diags.some((d) => d.transformType === "lookup" && d.message.includes("no categories matched"))).toBe(true);
  });
});

// ============================================================================
// Pivot Transform (C2)
// ============================================================================

describe("pivot transform", () => {
  const empty: ParsedChartData = { categories: [], series: [] };
  const tidy: TidyData = {
    fields: [
      { name: "Region", values: ["N", "N", "S", "S"] },
      { name: "Month", values: ["Jan", "Feb", "Jan", "Feb"] },
      { name: "Sales", values: ["10", "20", "30", "40"] },
    ],
  };

  it("spreads a long table into wide series", async () => {
    const result = await applyTransforms(
      empty,
      [{ type: "pivot", category: "Region", key: "Month", value: "Sales" }],
      undefined,
      undefined,
      tidy,
    );
    expect(result.categories).toEqual(["N", "S"]);
    expect(result.series.map((s) => s.name)).toEqual(["Jan", "Feb"]);
    expect(result.series[0].values).toEqual([10, 30]); // Jan: N=10, S=30
    expect(result.series[1].values).toEqual([20, 40]); // Feb: N=20, S=40
  });

  it("aggregates rows that share a (category, key)", async () => {
    const dupTidy: TidyData = {
      fields: [
        { name: "Region", values: ["N", "N", "N"] },
        { name: "Month", values: ["Jan", "Jan", "Feb"] },
        { name: "Sales", values: ["10", "5", "20"] },
      ],
    };
    const summed = await applyTransforms(empty, [{ type: "pivot", category: "Region", key: "Month", value: "Sales", op: "sum" }], undefined, undefined, dupTidy);
    expect(summed.series.find((s) => s.name === "Jan")!.values).toEqual([15]);

    const meaned = await applyTransforms(empty, [{ type: "pivot", category: "Region", key: "Month", value: "Sales", op: "mean" }], undefined, undefined, dupTidy);
    expect(meaned.series.find((s) => s.name === "Jan")!.values).toEqual([7.5]);
  });

  it("fills missing (category, key) combinations with 0", async () => {
    const sparse: TidyData = {
      fields: [
        { name: "Region", values: ["N", "S"] },
        { name: "Month", values: ["Jan", "Feb"] },
        { name: "Sales", values: ["10", "40"] },
      ],
    };
    const result = await applyTransforms(empty, [{ type: "pivot", category: "Region", key: "Month", value: "Sales" }], undefined, undefined, sparse);
    // N has only Jan, S has only Feb -> the cross cells are 0.
    expect(result.categories).toEqual(["N", "S"]);
    expect(result.series.find((s) => s.name === "Jan")!.values).toEqual([10, 0]);
    expect(result.series.find((s) => s.name === "Feb")!.values).toEqual([0, 40]);
  });

  it("warns on unknown columns and leaves data unchanged", async () => {
    const diags: TransformDiagnostic[] = [];
    const result = await applyTransforms(empty, [{ type: "pivot", category: "Nope", key: "Month", value: "Sales" }], diags, undefined, tidy);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ transformType: "pivot", severity: "warning" });
    expect(result).toBe(empty);
  });

  it("warns when there is no tidy (cell-range) source", async () => {
    const diags: TransformDiagnostic[] = [];
    await applyTransforms(empty, [{ type: "pivot", category: "Region", key: "Month", value: "Sales" }], diags);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ transformType: "pivot", severity: "warning" });
  });
});
