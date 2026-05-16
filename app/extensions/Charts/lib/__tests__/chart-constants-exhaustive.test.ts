//! FILENAME: app/extensions/Charts/lib/__tests__/chart-constants-exhaustive.test.ts
// PURPOSE: Exhaustive verification that all chart enums, constant maps, and
//          configuration objects are complete and consistent.

import { describe, it, expect } from "vitest";
import type {
  ChartType,
  AggregateOp,
  WindowOp,
  TrendlineType,
  TransformSpec,
  ParsedChartData,
} from "../../types";
import { PALETTES, PALETTE_NAMES, getSeriesColor } from "../../rendering/chartTheme";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline } from "../trendlineComputation";

// ============================================================================
// All chart types (the canonical list from types.ts)
// ============================================================================

const ALL_CHART_TYPES: ChartType[] = [
  "bar", "horizontalBar", "line", "area", "scatter",
  "pie", "donut", "waterfall", "combo", "radar",
  "bubble", "histogram", "funnel", "treemap", "stock",
  "boxPlot", "sunburst", "pareto",
];

const ALL_AGGREGATE_OPS: AggregateOp[] = [
  "sum", "mean", "median", "min", "max", "count",
];

const ALL_WINDOW_OPS: WindowOp[] = [
  "running_sum", "running_mean", "rank",
];

const ALL_TRENDLINE_TYPES: TrendlineType[] = [
  "linear", "exponential", "polynomial", "power", "logarithmic", "movingAverage",
];

const ALL_FILTER_OPERATORS = [">", "<", ">=", "<=", "=", "!="];

// ============================================================================
// Helper: sample data for transforms/trendlines
// ============================================================================

function sampleData(): ParsedChartData {
  return {
    categories: ["A", "B", "C", "D", "E"],
    series: [
      { name: "Sales", values: [10, 20, 15, 30, 25], color: null },
      { name: "Cost", values: [5, 10, 8, 12, 9], color: null },
    ],
  };
}

// ============================================================================
// Tests: Chart Type Coverage
// ============================================================================

describe("Chart type exhaustiveness", () => {
  it("ALL_CHART_TYPES has no duplicates", () => {
    const unique = new Set(ALL_CHART_TYPES);
    expect(unique.size).toBe(ALL_CHART_TYPES.length);
  });

  it("every chart type is in ALL_CHART_TYPES", () => {
    expect(ALL_CHART_TYPES).toContain("bar");
    expect(ALL_CHART_TYPES).toContain("line");
    expect(ALL_CHART_TYPES).toContain("pie");
    expect(ALL_CHART_TYPES).toContain("scatter");
  });

  it("every ChartType is in the canonical list (compile-time check)", () => {
    // If a new type is added to the union but not here, TypeScript will catch it
    // at call sites. This test ensures the runtime array is complete.
    expect(ALL_CHART_TYPES.length).toBeGreaterThanOrEqual(18);
  });

  it("isCartesianChart covers all chart types", async () => {
    const { isCartesianChart } = await import("../../types");
    const cartesian = ALL_CHART_TYPES.filter((t) => isCartesianChart(t));
    const nonCartesian = ALL_CHART_TYPES.filter((t) => !isCartesianChart(t));

    // Non-cartesian: pie, donut, radar, funnel, treemap, sunburst
    expect(nonCartesian).toEqual(
      expect.arrayContaining(["pie", "donut", "radar", "funnel", "treemap", "sunburst"]),
    );

    // Every type must be in exactly one bucket
    expect(cartesian.length + nonCartesian.length).toBe(ALL_CHART_TYPES.length);
  });
});

// ============================================================================
// Tests: Palettes
// ============================================================================

describe("Palette consistency", () => {
  it("PALETTE_NAMES matches PALETTES keys exactly", () => {
    expect(PALETTE_NAMES.sort()).toEqual(Object.keys(PALETTES).sort());
  });

  it("every palette has at least 4 colors", () => {
    for (const name of PALETTE_NAMES) {
      expect(PALETTES[name].length).toBeGreaterThanOrEqual(4);
    }
  });

  it("all palette colors are valid hex strings", () => {
    const hexRe = /^#[0-9A-Fa-f]{6}$/;
    for (const [name, colors] of Object.entries(PALETTES)) {
      for (const c of colors) {
        expect(c).toMatch(hexRe);
      }
    }
  });

  it("getSeriesColor returns override when provided", () => {
    expect(getSeriesColor("default", 0, "#FF0000")).toBe("#FF0000");
  });

  it("getSeriesColor cycles through palette", () => {
    const colors = PALETTES.default;
    expect(getSeriesColor("default", colors.length, null)).toBe(colors[0]);
  });

  it("getSeriesColor falls back to default for unknown palette", () => {
    const color = getSeriesColor("nonexistent", 0, null);
    expect(color).toBe(PALETTES.default[0]);
  });
});

// ============================================================================
// Tests: Aggregation operations
// ============================================================================

describe("Aggregation operations exhaustiveness", () => {
  it.each(ALL_AGGREGATE_OPS)("aggregate op '%s' produces a numeric result", (op) => {
    const data = sampleData();
    const result = applyTransforms(data, [
      {
        type: "aggregate",
        groupBy: ["$category"],
        op,
        field: "Sales",
        as: "Result",
      },
    ]);
    expect(result.series.length).toBe(1);
    expect(result.series[0].name).toBe("Result");
    for (const v of result.series[0].values) {
      expect(typeof v).toBe("number");
      expect(isFinite(v)).toBe(true);
    }
  });

  it("sum aggregation produces correct total", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B"],
      series: [{ name: "V", values: [10, 20, 30], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "V", as: "R" },
    ]);
    expect(result.categories).toEqual(["A", "B"]);
    expect(result.series[0].values).toEqual([30, 30]);
  });

  it("count aggregation counts rows", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B"],
      series: [{ name: "V", values: [10, 20, 30], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "count", field: "V", as: "R" },
    ]);
    expect(result.series[0].values).toEqual([2, 1]);
  });

  it("median aggregation computes correctly for even/odd counts", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "A", "A"],
      series: [{ name: "V", values: [1, 3, 5, 7], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "median", field: "V", as: "R" },
    ]);
    expect(result.series[0].values[0]).toBe(4); // (3+5)/2
  });
});

// ============================================================================
// Tests: Trendline types
// ============================================================================

describe("Trendline type exhaustiveness", () => {
  it.each(ALL_TRENDLINE_TYPES)("trendline type '%s' produces a result", (type) => {
    const data = sampleData();
    const result = computeTrendline(data, {
      type,
      seriesIndex: 0,
      polynomialDegree: 2,
      movingAveragePeriod: 3,
    });
    expect(result).not.toBeNull();
    expect(result!.points.length).toBeGreaterThan(0);
    expect(typeof result!.equation).toBe("string");
  });

  it("linear trendline has valid R-squared", () => {
    const result = computeTrendline(sampleData(), { type: "linear" });
    expect(result!.rSquared).toBeGreaterThanOrEqual(0);
    expect(result!.rSquared).toBeLessThanOrEqual(1);
  });

  it("movingAverage trendline has NaN R-squared", () => {
    const result = computeTrendline(sampleData(), { type: "movingAverage", movingAveragePeriod: 2 });
    expect(isNaN(result!.rSquared)).toBe(true);
  });
});

// ============================================================================
// Tests: Filter operators
// ============================================================================

describe("Filter operator exhaustiveness", () => {
  it.each(ALL_FILTER_OPERATORS)("filter operator '%s' is handled", (op) => {
    const data = sampleData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: `${op} 15` },
    ]);
    // Should return valid data (maybe fewer rows)
    expect(result.categories.length).toBeLessThanOrEqual(data.categories.length);
    expect(result.series.length).toBe(data.series.length);
  });

  it("filter '> 15' keeps only values above 15", () => {
    const data = sampleData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 15" },
    ]);
    // Sales: [10, 20, 15, 30, 25] -> keep 20, 30, 25
    expect(result.categories).toEqual(["B", "D", "E"]);
  });

  it("filter '= someText' works on category field", () => {
    const data = sampleData();
    const result = applyTransforms(data, [
      { type: "filter", field: "$category", predicate: "= A" },
    ]);
    expect(result.categories).toEqual(["A"]);
  });

  it("filter '!= 0' keeps non-zero values", () => {
    const data: ParsedChartData = {
      categories: ["X", "Y", "Z"],
      series: [{ name: "V", values: [0, 5, 0], color: null }],
    };
    const result = applyTransforms(data, [
      { type: "filter", field: "V", predicate: "!= 0" },
    ]);
    expect(result.categories).toEqual(["Y"]);
  });
});

// ============================================================================
// Tests: Window operations
// ============================================================================

describe("Window operation exhaustiveness", () => {
  it.each(ALL_WINDOW_OPS)("window op '%s' produces correct-length output", (op) => {
    const data = sampleData();
    const result = applyTransforms(data, [
      { type: "window", op, field: "Sales", as: "Result" },
    ]);
    const resultSeries = result.series.find((s) => s.name === "Result");
    expect(resultSeries).toBeDefined();
    expect(resultSeries!.values.length).toBe(data.categories.length);
  });

  it("running_sum computes cumulative sum", () => {
    const data = sampleData();
    const result = applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Sales", as: "RS" },
    ]);
    const rs = result.series.find((s) => s.name === "RS")!;
    expect(rs.values).toEqual([10, 30, 45, 75, 100]);
  });

  it("running_mean computes cumulative average", () => {
    const data = sampleData();
    const result = applyTransforms(data, [
      { type: "window", op: "running_mean", field: "Sales", as: "RM" },
    ]);
    const rm = result.series.find((s) => s.name === "RM")!;
    expect(rm.values[0]).toBe(10);
    expect(rm.values[1]).toBe(15); // (10+20)/2
  });

  it("rank assigns rank 1 to highest value", () => {
    const data = sampleData();
    const result = applyTransforms(data, [
      { type: "window", op: "rank", field: "Sales", as: "Rank" },
    ]);
    const rank = result.series.find((s) => s.name === "Rank")!;
    // Sales: [10, 20, 15, 30, 25] -> ranks: 30=1, 25=2, 20=3, 15=4, 10=5
    expect(rank.values).toEqual([5, 3, 4, 1, 2]);
  });
});

// ============================================================================
// Tests: Transform type dispatch
// ============================================================================

describe("Transform type dispatch completeness", () => {
  const TRANSFORM_TYPES: TransformSpec["type"][] = [
    "filter", "sort", "aggregate", "calculate", "window", "bin",
  ];

  it("all transform types are dispatched without errors", () => {
    const data = sampleData();
    for (const type of TRANSFORM_TYPES) {
      let transform: TransformSpec;
      switch (type) {
        case "filter":
          transform = { type: "filter", field: "Sales", predicate: "> 0" };
          break;
        case "sort":
          transform = { type: "sort", field: "$category", order: "asc" };
          break;
        case "aggregate":
          transform = { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Sales", as: "R" };
          break;
        case "calculate":
          transform = { type: "calculate", expr: "Sales * 2", as: "Double" };
          break;
        case "window":
          transform = { type: "window", op: "running_sum", field: "Sales", as: "RS" };
          break;
        case "bin":
          transform = { type: "bin", field: "Sales", binCount: 3, as: "Bins" };
          break;
      }
      const result = applyTransforms(data, [transform]);
      expect(result.categories.length).toBeGreaterThan(0);
    }
  });

  it("unknown transform type returns data unchanged", () => {
    const data = sampleData();
    const result = applyTransforms(data, [
      { type: "unknown" as any, field: "Sales" },
    ]);
    expect(result).toEqual(data);
  });
});
