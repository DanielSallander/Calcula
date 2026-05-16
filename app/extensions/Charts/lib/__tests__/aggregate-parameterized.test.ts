//! FILENAME: app/extensions/Charts/lib/__tests__/aggregate-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for chart aggregate, window, and bin transforms.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import type {
  ParsedChartData,
  AggregateOp,
  AggregateTransform,
  WindowTransform,
  BinTransform,
} from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeData(categories: string[], values: number[], seriesName = "Sales"): ParsedChartData {
  return {
    categories,
    series: [{ name: seriesName, values, color: null }],
  };
}

function aggregate(data: ParsedChartData, op: AggregateOp, field = "Sales", groupBy = ["$category"]): ParsedChartData {
  const t: AggregateTransform = { type: "aggregate", groupBy, op, field, as: `${op}_result` };
  return applyTransforms(data, [t]);
}

function window(data: ParsedChartData, op: "running_sum" | "running_mean" | "rank", field = "Sales"): ParsedChartData {
  const t: WindowTransform = { type: "window", op, field, as: `${op}_result` };
  return applyTransforms(data, [t]);
}

function bin(data: ParsedChartData, binCount: number, field = "Sales"): ParsedChartData {
  const t: BinTransform = { type: "bin", field, binCount, as: "bin_result" };
  return applyTransforms(data, [t]);
}

// ============================================================================
// 1. Aggregate ops x data groups: 6 ops x 20 groups = 120 tests
// ============================================================================

describe("aggregate operations - parameterized", () => {
  // Each entry: [label, categories, values, expected { sum, count, mean, median, min, max }]
  const dataGroups: Array<[
    string, string[], number[],
    { sum: number; count: number; mean: number; median: number; min: number; max: number }
  ]> = [
    [
      "simple ascending",
      ["A", "B", "C", "D", "E"],
      [1, 2, 3, 4, 5],
      { sum: 1 + 2 + 3 + 4 + 5, count: 5, mean: 3, median: 3, min: 1, max: 5 },
    ],
    [
      "all same",
      ["A", "B", "C"],
      [7, 7, 7],
      { sum: 21, count: 3, mean: 7, median: 7, min: 7, max: 7 },
    ],
    [
      "single value",
      ["A"],
      [42],
      { sum: 42, count: 1, mean: 42, median: 42, min: 42, max: 42 },
    ],
    [
      "two values",
      ["A", "B"],
      [10, 20],
      { sum: 30, count: 2, mean: 15, median: 15, min: 10, max: 20 },
    ],
    [
      "negatives",
      ["A", "B", "C"],
      [-5, -10, -15],
      { sum: -30, count: 3, mean: -10, median: -10, min: -15, max: -5 },
    ],
    [
      "mixed sign",
      ["A", "B", "C", "D"],
      [-10, 5, -3, 8],
      { sum: 0, count: 4, mean: 0, median: 1, min: -10, max: 8 },
    ],
    [
      "zeros",
      ["A", "B", "C"],
      [0, 0, 0],
      { sum: 0, count: 3, mean: 0, median: 0, min: 0, max: 0 },
    ],
    [
      "large values",
      ["A", "B", "C"],
      [1e9, 2e9, 3e9],
      { sum: 6e9, count: 3, mean: 2e9, median: 2e9, min: 1e9, max: 3e9 },
    ],
    [
      "tiny values",
      ["A", "B", "C"],
      [0.001, 0.002, 0.003],
      { sum: 0.006, count: 3, mean: 0.002, median: 0.002, min: 0.001, max: 0.003 },
    ],
    [
      "even count median",
      ["A", "B", "C", "D"],
      [1, 3, 5, 7],
      { sum: 16, count: 4, mean: 4, median: 4, min: 1, max: 7 },
    ],
    [
      "unsorted for median",
      ["A", "B", "C", "D", "E"],
      [5, 1, 4, 2, 3],
      { sum: 15, count: 5, mean: 3, median: 3, min: 1, max: 5 },
    ],
    [
      "descending",
      ["A", "B", "C", "D"],
      [100, 75, 50, 25],
      { sum: 250, count: 4, mean: 62.5, median: 62.5, min: 25, max: 100 },
    ],
    [
      "one negative rest positive",
      ["A", "B", "C"],
      [-100, 50, 50],
      { sum: 0, count: 3, mean: 0, median: 50, min: -100, max: 50 },
    ],
    [
      "powers of 2",
      ["A", "B", "C", "D", "E"],
      [1, 2, 4, 8, 16],
      { sum: 31, count: 5, mean: 6.2, median: 4, min: 1, max: 16 },
    ],
    [
      "fibonacci",
      ["A", "B", "C", "D", "E", "F"],
      [1, 1, 2, 3, 5, 8],
      { sum: 20, count: 6, mean: 20 / 6, median: 2.5, min: 1, max: 8 },
    ],
    [
      "outlier high",
      ["A", "B", "C", "D", "E"],
      [1, 2, 3, 4, 1000],
      { sum: 1010, count: 5, mean: 202, median: 3, min: 1, max: 1000 },
    ],
    [
      "outlier low",
      ["A", "B", "C", "D", "E"],
      [-1000, 2, 3, 4, 5],
      { sum: -986, count: 5, mean: -197.2, median: 3, min: -1000, max: 5 },
    ],
    [
      "primes",
      ["A", "B", "C", "D", "E", "F", "G"],
      [2, 3, 5, 7, 11, 13, 17],
      { sum: 58, count: 7, mean: 58 / 7, median: 7, min: 2, max: 17 },
    ],
    [
      "squares",
      ["A", "B", "C", "D", "E"],
      [1, 4, 9, 16, 25],
      { sum: 55, count: 5, mean: 11, median: 9, min: 1, max: 25 },
    ],
    [
      "decimal precision",
      ["A", "B", "C"],
      [0.1, 0.2, 0.3],
      { sum: 0.6, count: 3, mean: 0.2, median: 0.2, min: 0.1, max: 0.3 },
    ],
  ];

  // When groupBy=$category and all categories are unique, each group has 1 item.
  // For aggregate to be meaningful, we use duplicate categories.
  // But the current test structure uses unique categories, so aggregation
  // groups each to its own bucket. For single-element groups:
  // sum = value, count = 1, mean = value, median = value, min = value, max = value
  // That's not very interesting. Instead, let's test with ALL same category
  // so everything groups into one bucket.

  const ops: AggregateOp[] = ["sum", "count", "mean", "median", "min", "max"];

  for (const op of ops) {
    it.each(dataGroups)(`${op}: %s`, (_label, _cats, values, expected) => {
      // Use same category for all to get a single aggregated group
      const cats = values.map(() => "All");
      const data = makeData(cats, values);
      const result = aggregate(data, op);
      expect(result.series).toHaveLength(1);
      expect(result.series[0].values).toHaveLength(1);
      const actual = result.series[0].values[0];
      expect(actual).toBeCloseTo(expected[op], 5);
    });
  }
});

// ============================================================================
// 2. Window operations: running_sum x 30 + running_mean x 30 + rank x 30 = 90
// ============================================================================

describe("window operations - parameterized", () => {
  const windowCases: Array<[
    string, number[],
    { runSum: number[]; runMean: number[]; rank: number[] }
  ]> = [
    [
      "ascending 1-5",
      [1, 2, 3, 4, 5],
      {
        runSum: [1, 3, 6, 10, 15],
        runMean: [1, 1.5, 2, 2.5, 3],
        rank: [5, 4, 3, 2, 1],
      },
    ],
    [
      "all ones",
      [1, 1, 1, 1, 1],
      {
        runSum: [1, 2, 3, 4, 5],
        runMean: [1, 1, 1, 1, 1],
        rank: [1, 2, 3, 4, 5], // ties broken by order in sort
      },
    ],
    [
      "descending 5-1",
      [5, 4, 3, 2, 1],
      {
        runSum: [5, 9, 12, 14, 15],
        runMean: [5, 4.5, 4, 3.5, 3],
        rank: [1, 2, 3, 4, 5],
      },
    ],
    [
      "single value",
      [42],
      {
        runSum: [42],
        runMean: [42],
        rank: [1],
      },
    ],
    [
      "two values",
      [10, 20],
      {
        runSum: [10, 30],
        runMean: [10, 15],
        rank: [2, 1],
      },
    ],
    [
      "zeros",
      [0, 0, 0, 0],
      {
        runSum: [0, 0, 0, 0],
        runMean: [0, 0, 0, 0],
        rank: [1, 2, 3, 4],
      },
    ],
    [
      "negatives",
      [-3, -1, -4, -1, -5],
      {
        runSum: [-3, -4, -8, -9, -14],
        runMean: [-3, -2, -8 / 3, -9 / 4, -14 / 5],
        rank: [3, 1, 4, 2, 5],
      },
    ],
    [
      "mixed sign",
      [-5, 10, -3, 8],
      {
        runSum: [-5, 5, 2, 10],
        runMean: [-5, 2.5, 2 / 3, 2.5],
        rank: [4, 1, 3, 2],
      },
    ],
    [
      "powers of 2",
      [1, 2, 4, 8, 16],
      {
        runSum: [1, 3, 7, 15, 31],
        runMean: [1, 1.5, 7 / 3, 15 / 4, 31 / 5],
        rank: [5, 4, 3, 2, 1],
      },
    ],
    [
      "alternating",
      [1, 10, 1, 10, 1],
      {
        runSum: [1, 11, 12, 22, 23],
        runMean: [1, 5.5, 4, 5.5, 23 / 5],
        rank: [3, 1, 4, 2, 5],
      },
    ],
    [
      "large values",
      [1e6, 2e6, 3e6],
      {
        runSum: [1e6, 3e6, 6e6],
        runMean: [1e6, 1.5e6, 2e6],
        rank: [3, 2, 1],
      },
    ],
    [
      "tiny values",
      [0.001, 0.002, 0.003],
      {
        runSum: [0.001, 0.003, 0.006],
        runMean: [0.001, 0.0015, 0.002],
        rank: [3, 2, 1],
      },
    ],
    [
      "fibonacci",
      [1, 1, 2, 3, 5, 8],
      {
        runSum: [1, 2, 4, 7, 12, 20],
        runMean: [1, 1, 4 / 3, 7 / 4, 12 / 5, 20 / 6],
        rank: [5, 6, 4, 3, 2, 1],
      },
    ],
    [
      "spike",
      [0, 0, 100, 0, 0],
      {
        runSum: [0, 0, 100, 100, 100],
        runMean: [0, 0, 100 / 3, 25, 20],
        rank: [2, 3, 1, 4, 5],
      },
    ],
    [
      "step function",
      [0, 0, 0, 10, 10, 10],
      {
        runSum: [0, 0, 0, 10, 20, 30],
        runMean: [0, 0, 0, 2.5, 4, 5],
        rank: [4, 5, 6, 1, 2, 3],
      },
    ],
    [
      "squares",
      [1, 4, 9, 16, 25],
      {
        runSum: [1, 5, 14, 30, 55],
        runMean: [1, 2.5, 14 / 3, 7.5, 11],
        rank: [5, 4, 3, 2, 1],
      },
    ],
    [
      "three equal pairs",
      [5, 5, 10, 10, 15, 15],
      {
        runSum: [5, 10, 20, 30, 45, 60],
        runMean: [5, 5, 20 / 3, 7.5, 9, 10],
        rank: [5, 6, 3, 4, 1, 2],
      },
    ],
    [
      "v-shape",
      [10, 5, 0, 5, 10],
      {
        runSum: [10, 15, 15, 20, 30],
        runMean: [10, 7.5, 5, 5, 6],
        rank: [1, 3, 5, 4, 2],
      },
    ],
    [
      "saw tooth",
      [1, 3, 1, 3, 1, 3],
      {
        runSum: [1, 4, 5, 8, 9, 12],
        runMean: [1, 2, 5 / 3, 2, 9 / 5, 2],
        rank: [4, 1, 5, 2, 6, 3],
      },
    ],
    [
      "descending powers",
      [1000, 100, 10, 1],
      {
        runSum: [1000, 1100, 1110, 1111],
        runMean: [1000, 550, 370, 277.75],
        rank: [1, 2, 3, 4],
      },
    ],
    [
      "arithmetic sequence",
      [2, 5, 8, 11, 14],
      {
        runSum: [2, 7, 15, 26, 40],
        runMean: [2, 3.5, 5, 6.5, 8],
        rank: [5, 4, 3, 2, 1],
      },
    ],
    [
      "geometric-like",
      [1, 3, 9, 27, 81],
      {
        runSum: [1, 4, 13, 40, 121],
        runMean: [1, 2, 13 / 3, 10, 121 / 5],
        rank: [5, 4, 3, 2, 1],
      },
    ],
    [
      "plateau",
      [1, 5, 5, 5, 10],
      {
        runSum: [1, 6, 11, 16, 26],
        runMean: [1, 3, 11 / 3, 4, 26 / 5],
        rank: [5, 2, 3, 4, 1],
      },
    ],
    [
      "negative ramp",
      [0, -1, -2, -3, -4],
      {
        runSum: [0, -1, -3, -6, -10],
        runMean: [0, -0.5, -1, -1.5, -2],
        rank: [1, 2, 3, 4, 5],
      },
    ],
    [
      "random-like",
      [7, 2, 9, 4, 6],
      {
        runSum: [7, 9, 18, 22, 28],
        runMean: [7, 4.5, 6, 5.5, 28 / 5],
        rank: [2, 5, 1, 4, 3],
      },
    ],
    [
      "primes",
      [2, 3, 5, 7, 11],
      {
        runSum: [2, 5, 10, 17, 28],
        runMean: [2, 2.5, 10 / 3, 17 / 4, 28 / 5],
        rank: [5, 4, 3, 2, 1],
      },
    ],
    [
      "cubes",
      [1, 8, 27, 64],
      {
        runSum: [1, 9, 36, 100],
        runMean: [1, 4.5, 12, 25],
        rank: [4, 3, 2, 1],
      },
    ],
    [
      "ten items ascending",
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      {
        runSum: [1, 3, 6, 10, 15, 21, 28, 36, 45, 55],
        runMean: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5],
        rank: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      },
    ],
    [
      "symmetric",
      [1, 3, 5, 3, 1],
      {
        runSum: [1, 4, 9, 12, 13],
        runMean: [1, 2, 3, 3, 13 / 5],
        rank: [4, 2, 1, 3, 5],
      },
    ],
    [
      "hundred then ones",
      [100, 1, 1, 1, 1],
      {
        runSum: [100, 101, 102, 103, 104],
        runMean: [100, 50.5, 34, 25.75, 20.8],
        rank: [1, 2, 3, 4, 5],
      },
    ],
  ];

  // running_sum x 30
  it.each(windowCases)("running_sum: %s", (_label, values, expected) => {
    const cats = values.map((_, i) => `C${i}`);
    const data = makeData(cats, values);
    const result = window(data, "running_sum");
    const resultSeries = result.series.find((s) => s.name === "running_sum_result");
    expect(resultSeries).toBeDefined();
    expect(resultSeries!.values).toHaveLength(expected.runSum.length);
    for (let i = 0; i < expected.runSum.length; i++) {
      expect(resultSeries!.values[i]).toBeCloseTo(expected.runSum[i], 5);
    }
  });

  // running_mean x 30
  it.each(windowCases)("running_mean: %s", (_label, values, expected) => {
    const cats = values.map((_, i) => `C${i}`);
    const data = makeData(cats, values);
    const result = window(data, "running_mean");
    const resultSeries = result.series.find((s) => s.name === "running_mean_result");
    expect(resultSeries).toBeDefined();
    expect(resultSeries!.values).toHaveLength(expected.runMean.length);
    for (let i = 0; i < expected.runMean.length; i++) {
      expect(resultSeries!.values[i]).toBeCloseTo(expected.runMean[i], 5);
    }
  });

  // rank x 30
  it.each(windowCases)("rank: %s", (_label, values, expected) => {
    const cats = values.map((_, i) => `C${i}`);
    const data = makeData(cats, values);
    const result = window(data, "rank");
    const resultSeries = result.series.find((s) => s.name === "rank_result");
    expect(resultSeries).toBeDefined();
    expect(resultSeries!.values).toHaveLength(expected.rank.length);
    for (let i = 0; i < expected.rank.length; i++) {
      expect(resultSeries!.values[i]).toBe(expected.rank[i]);
    }
  });
});

// ============================================================================
// 3. Bin transform: 20 datasets x 3 bin counts = 60 tests
// ============================================================================

describe("bin transform - parameterized", () => {
  const binCases: Array<[string, number[], number, number]> = [
    ["uniform 0-9", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5, 10],
    ["uniform 0-99", Array.from({ length: 100 }, (_, i) => i), 10, 100],
    ["all same", [5, 5, 5, 5, 5], 3, 5],
    ["two values", [0, 10], 2, 2],
    ["single value", [42], 5, 1],
    ["negatives", [-10, -8, -6, -4, -2, 0], 3, 6],
    ["mixed sign", [-5, -3, 0, 3, 5], 5, 5],
    ["large range", [0, 1000], 10, 2],
    ["clustered", [1, 1, 1, 1, 10, 10, 10, 10], 2, 8],
    ["exponential dist", [1, 2, 4, 8, 16, 32, 64, 128], 4, 8],
    ["normal-ish", [1, 2, 3, 4, 4, 5, 5, 5, 6, 6, 7, 8, 9], 5, 13],
    ["bimodal", [1, 1, 2, 2, 8, 8, 9, 9], 4, 8],
    ["uniform 1-10", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10, 10],
    ["sparse", [0, 50, 100], 10, 3],
    ["dense low", [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], 5, 11],
    ["outlier heavy", [1, 2, 3, 4, 5, 100], 5, 6],
    ["decreasing", [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 5, 10],
    ["squares", [1, 4, 9, 16, 25, 36, 49, 64], 4, 8],
    ["repeated pairs", [1, 1, 5, 5, 9, 9], 3, 6],
    ["three clusters", [1, 2, 3, 10, 11, 12, 20, 21, 22], 3, 9],
  ];

  const binCounts = [3, 5, 10] as const;

  for (const bc of binCounts) {
    it.each(binCases)(`binCount=${bc}, %s: produces ${bc} bins`, (_label, values, _defaultBins, totalItems) => {
      const cats = values.map((_, i) => `C${i}`);
      const data = makeData(cats, values);
      const result = bin(data, bc);
      // Should have exactly binCount categories (bins)
      expect(result.categories).toHaveLength(bc);
      expect(result.series).toHaveLength(1);
      expect(result.series[0].values).toHaveLength(bc);
      // Sum of bin counts should equal total items
      const sum = result.series[0].values.reduce((a, b) => a + b, 0);
      expect(sum).toBe(totalItems);
      // All counts should be non-negative
      for (const count of result.series[0].values) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it("bin categories contain range labels", () => {
    const data = makeData(["A", "B", "C"], [0, 5, 10]);
    const result = bin(data, 2);
    // Each category should be a range like "0-5" or "0.0-5.0"
    for (const cat of result.categories) {
      expect(cat).toContain("\u2013"); // en-dash used in formatBinEdge
    }
  });

  it("all-same-value data: all items in one bin", () => {
    const data = makeData(["A", "B", "C", "D"], [5, 5, 5, 5]);
    const result = bin(data, 3);
    const sum = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(sum).toBe(4);
    // At least one bin has all 4
    expect(Math.max(...result.series[0].values)).toBe(4);
  });
});
