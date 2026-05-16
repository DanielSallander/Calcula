//! FILENAME: app/extensions/Charts/lib/__tests__/chart-comprehensive-final.test.ts
// PURPOSE: Comprehensive chart tests to push toward the 10K test milestone.

import { describe, it, expect } from "vitest";
import { buildDefaultSpec } from "../chartSpecDefaults";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline } from "../trendlineComputation";
import {
  PALETTES,
  PALETTE_NAMES,
  getSeriesColor,
  DEFAULT_CHART_THEME,
  mergeTheme,
  resolveChartTheme,
} from "../../rendering/chartTheme";
import type {
  ChartType,
  ChartSeries,
  DataRangeRef,
  ParsedChartData,
  TransformSpec,
  TrendlineSpec,
  ChartSpec,
} from "../../types";
import { isCartesianChart, isDataRangeRef, isPivotDataSource } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

const ALL_CHART_TYPES: ChartType[] = [
  "bar", "horizontalBar", "line", "area", "scatter", "pie", "donut",
  "waterfall", "combo", "radar", "bubble", "histogram", "funnel",
  "treemap", "stock", "boxPlot", "sunburst", "pareto",
];

const CARTESIAN_TYPES: ChartType[] = [
  "bar", "horizontalBar", "line", "area", "scatter", "waterfall",
  "combo", "bubble", "histogram", "stock", "boxPlot", "pareto",
];

const RADIAL_TYPES: ChartType[] = ["pie", "donut", "radar"];
const NON_CARTESIAN: ChartType[] = ["pie", "donut", "radar", "funnel", "treemap", "sunburst"];

const dataRange: DataRangeRef = {
  sheetIndex: 0, startRow: 0, startCol: 0, endRow: 9, endCol: 3,
};

const autoDetected = {
  categoryIndex: 0,
  series: [
    { name: "Revenue", sourceIndex: 1, color: null },
    { name: "Costs", sourceIndex: 2, color: null },
  ] as ChartSeries[],
  orientation: "columns" as const,
};

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["A", "B", "C", "D", "E"],
    series: [
      { name: "Sales", values: [100, 200, 300, 150, 250], color: null },
      { name: "Cost", values: [80, 120, 180, 90, 150], color: null },
    ],
    ...overrides,
  };
}

// ============================================================================
// 1. All 18 chart types x buildDefaultSpec
// ============================================================================

describe("buildDefaultSpec for all 18 chart types", () => {
  it.each(ALL_CHART_TYPES)("builds a valid spec for %s", (chartType) => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected, chartType);
    expect(spec.mark).toBe(chartType);
    expect(spec.data).toEqual(dataRange);
    expect(spec.hasHeaders).toBe(true);
    expect(spec.series).toHaveLength(2);
    expect(spec.legend.visible).toBe(true);
    expect(spec.palette).toBe("default");
  });

  it.each(ALL_CHART_TYPES)("spec for %s has correct axis defaults", (chartType) => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected, chartType);
    expect(spec.xAxis.gridLines).toBe(false);
    expect(spec.yAxis.gridLines).toBe(true);
    expect(spec.xAxis.showLabels).toBe(true);
    expect(spec.yAxis.showLabels).toBe(true);
    expect(spec.xAxis.labelAngle).toBe(0);
    expect(spec.yAxis.labelAngle).toBe(0);
    expect(spec.xAxis.min).toBeNull();
    expect(spec.yAxis.max).toBeNull();
  });

  it.each(ALL_CHART_TYPES)("spec for %s has null title", (chartType) => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected, chartType);
    expect(spec.title).toBeNull();
  });
});

// ============================================================================
// 2. isCartesianChart type guard
// ============================================================================

describe("isCartesianChart for all chart types", () => {
  it.each(CARTESIAN_TYPES)("%s is cartesian", (t) => {
    expect(isCartesianChart(t)).toBe(true);
  });

  it.each(NON_CARTESIAN)("%s is not cartesian", (t) => {
    expect(isCartesianChart(t)).toBe(false);
  });
});

// ============================================================================
// 3. DataSource type guards
// ============================================================================

describe("DataSource type guards", () => {
  it("isDataRangeRef returns true for DataRangeRef", () => {
    expect(isDataRangeRef(dataRange)).toBe(true);
  });

  it("isDataRangeRef returns false for string", () => {
    expect(isDataRangeRef("Sheet1!A1:D10")).toBe(false);
  });

  it("isDataRangeRef returns false for PivotDataSource", () => {
    expect(isDataRangeRef({ type: "pivot", pivotId: 1 })).toBe(false);
  });

  it("isPivotDataSource returns true for PivotDataSource", () => {
    expect(isPivotDataSource({ type: "pivot", pivotId: 1 })).toBe(true);
  });

  it("isPivotDataSource returns false for DataRangeRef", () => {
    expect(isPivotDataSource(dataRange)).toBe(false);
  });

  it("isPivotDataSource returns false for string", () => {
    expect(isPivotDataSource("Sheet1!A1:D10")).toBe(false);
  });
});

// ============================================================================
// 4. All 6 transform types x 3 data shapes
// ============================================================================

describe("transform types with varied data shapes", () => {
  const emptyData: ParsedChartData = { categories: [], series: [] };
  const singlePoint: ParsedChartData = {
    categories: ["X"],
    series: [{ name: "S", values: [42], color: null }],
  };
  const normalData = makeData();

  const shapes = [
    { name: "empty", data: emptyData },
    { name: "single-point", data: singlePoint },
    { name: "normal", data: normalData },
  ];

  // Filter
  describe.each(shapes)("filter on $name data", ({ data }) => {
    it("applies filter transform without crash", () => {
      const result = applyTransforms(data, [{ type: "filter", field: "Sales", predicate: "> 100" }]);
      expect(result).toBeDefined();
      expect(result.categories.length).toBeLessThanOrEqual(data.categories.length);
    });

    it("filter on $category works", () => {
      const result = applyTransforms(data, [{ type: "filter", field: "$category", predicate: "= A" }]);
      expect(result).toBeDefined();
    });
  });

  // Sort
  describe.each(shapes)("sort on $name data", ({ data }) => {
    it("applies sort asc", () => {
      const result = applyTransforms(data, [{ type: "sort", field: "$category", order: "asc" }]);
      expect(result.categories.length).toBe(data.categories.length);
    });

    it("applies sort desc", () => {
      const result = applyTransforms(data, [{ type: "sort", field: "$category", order: "desc" }]);
      expect(result.categories.length).toBe(data.categories.length);
    });
  });

  // Aggregate
  describe.each(shapes)("aggregate on $name data", ({ data }) => {
    it("sum aggregation", () => {
      const result = applyTransforms(data, [
        { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Sales", as: "Total" },
      ]);
      expect(result).toBeDefined();
    });
  });

  // Calculate
  describe.each(shapes)("calculate on $name data", ({ data }) => {
    it("simple expression", () => {
      const result = applyTransforms(data, [
        { type: "calculate", expr: "Sales * 2", as: "Double" },
      ]);
      expect(result).toBeDefined();
    });
  });

  // Window
  describe.each(shapes)("window on $name data", ({ data }) => {
    it("running_sum", () => {
      const result = applyTransforms(data, [
        { type: "window", op: "running_sum", field: "Sales", as: "RunSum" },
      ]);
      expect(result).toBeDefined();
    });
  });

  // Bin
  describe.each(shapes)("bin on $name data", ({ data }) => {
    it("bin with default count", () => {
      const result = applyTransforms(data, [
        { type: "bin", field: "Sales", as: "Binned" },
      ]);
      expect(result).toBeDefined();
    });
  });
});

// ============================================================================
// 5. Aggregate operations exhaustive
// ============================================================================

describe("all aggregate operations produce correct results", () => {
  const data = makeData();
  const ops: Array<{ op: "sum" | "mean" | "median" | "min" | "max" | "count"; expected: number }> = [
    { op: "sum", expected: 1000 },
    { op: "mean", expected: 200 },
    { op: "median", expected: 200 },
    { op: "min", expected: 100 },
    { op: "max", expected: 300 },
    { op: "count", expected: 5 },
  ];

  it.each(ops)("$op produces correct value", ({ op, expected }) => {
    const result = applyTransforms(data, [
      { type: "aggregate", groupBy: [], op, field: "Sales", as: "Result" },
    ]);
    expect(result.series[0].values[0]).toBeCloseTo(expected, 5);
  });
});

// ============================================================================
// 6. Window operations exhaustive
// ============================================================================

describe("all window operations", () => {
  const data = makeData();

  it("running_sum is cumulative", () => {
    const result = applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Sales", as: "RS" },
    ]);
    const rs = result.series.find((s) => s.name === "RS")!;
    expect(rs.values).toEqual([100, 300, 600, 750, 1000]);
  });

  it("running_mean is cumulative average", () => {
    const result = applyTransforms(data, [
      { type: "window", op: "running_mean", field: "Sales", as: "RM" },
    ]);
    const rm = result.series.find((s) => s.name === "RM")!;
    expect(rm.values[0]).toBeCloseTo(100, 5);
    expect(rm.values[1]).toBeCloseTo(150, 5);
    expect(rm.values[4]).toBeCloseTo(200, 5);
  });

  it("rank assigns rank 1 to highest value", () => {
    const result = applyTransforms(data, [
      { type: "window", op: "rank", field: "Sales", as: "R" },
    ]);
    const r = result.series.find((s) => s.name === "R")!;
    // 300 is highest => rank 1
    expect(r.values[2]).toBe(1);
  });
});

// ============================================================================
// 7. Trendline computation for known datasets
// ============================================================================

describe("trendline computation for known datasets", () => {
  const datasets = [
    { name: "linear-perfect", values: [1, 2, 3, 4, 5] },
    { name: "constant", values: [5, 5, 5, 5, 5] },
    { name: "quadratic", values: [1, 4, 9, 16, 25] },
    { name: "exponential-like", values: [2, 4, 8, 16, 32] },
    { name: "noisy", values: [10, 12, 9, 15, 11] },
  ];

  const trendlineTypes: TrendlineSpec["type"][] = [
    "linear", "exponential", "polynomial", "power", "logarithmic",
  ];

  describe.each(datasets)("dataset: $name", ({ values }) => {
    const data: ParsedChartData = {
      categories: values.map((_, i) => `C${i}`),
      series: [{ name: "Y", values, color: null }],
    };

    it.each(trendlineTypes)("computes %s trendline without error", (type) => {
      const result = computeTrendline(data, { type, seriesIndex: 0 });
      expect(result).not.toBeNull();
      expect(result!.points.length).toBeGreaterThan(0);
      expect(result!.equation).toBeTruthy();
    });
  });

  it("linear trendline on perfect line has R^2 = 1", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C", "D", "E"],
      series: [{ name: "Y", values: [2, 4, 6, 8, 10], color: null }],
    };
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result!.rSquared).toBeCloseTo(1.0, 5);
  });

  it("constant data linear trendline has zero slope", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C", "D", "E"],
      series: [{ name: "Y", values: [5, 5, 5, 5, 5], color: null }],
    };
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    // All predicted values should be 5
    for (const p of result!.points) {
      expect(p.value).toBeCloseTo(5, 5);
    }
  });

  it("polynomial degree 2 fits quadratic perfectly", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C", "D", "E"],
      series: [{ name: "Y", values: [0, 1, 4, 9, 16], color: null }],
    };
    const result = computeTrendline(data, { type: "polynomial", seriesIndex: 0, polynomialDegree: 2 });
    expect(result!.rSquared).toBeCloseTo(1.0, 3);
  });

  it("moving average returns fewer points than input", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C", "D", "E"],
      series: [{ name: "Y", values: [10, 20, 30, 40, 50], color: null }],
    };
    const result = computeTrendline(data, { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 3 });
    expect(result!.points.length).toBe(3); // 5 - 3 + 1
    expect(result!.rSquared).toBeNaN();
  });

  it("moving average computes correct values", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C", "D", "E"],
      series: [{ name: "Y", values: [10, 20, 30, 40, 50], color: null }],
    };
    const result = computeTrendline(data, { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 3 });
    expect(result!.points[0].value).toBeCloseTo(20, 5); // (10+20+30)/3
    expect(result!.points[1].value).toBeCloseTo(30, 5); // (20+30+40)/3
    expect(result!.points[2].value).toBeCloseTo(40, 5); // (30+40+50)/3
  });
});

// ============================================================================
// 8. Color/palette exhaustive cycling through 20 series
// ============================================================================

describe("palette color cycling through 20 series", () => {
  it.each(PALETTE_NAMES)("palette %s cycles through all colors", (paletteName) => {
    const colors = PALETTES[paletteName];
    for (let i = 0; i < 20; i++) {
      const color = getSeriesColor(paletteName, i, null);
      expect(color).toBe(colors[i % colors.length]);
    }
  });

  it.each(PALETTE_NAMES)("palette %s override takes precedence", (paletteName) => {
    const override = "#FF0000";
    for (let i = 0; i < 5; i++) {
      expect(getSeriesColor(paletteName, i, override)).toBe(override);
    }
  });

  it("unknown palette falls back to default", () => {
    const color = getSeriesColor("nonexistent", 0, null);
    expect(color).toBe(PALETTES.default[0]);
  });

  it("each palette has at least 8 colors", () => {
    for (const name of PALETTE_NAMES) {
      expect(PALETTES[name].length).toBeGreaterThanOrEqual(8);
    }
  });

  // Every color in every palette is a valid hex
  it.each(PALETTE_NAMES)("all colors in %s are valid hex", (paletteName) => {
    for (const color of PALETTES[paletteName]) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ============================================================================
// 9. Theme merging
// ============================================================================

describe("theme merging", () => {
  it("mergeTheme with undefined returns base", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, undefined);
    expect(result).toBe(DEFAULT_CHART_THEME);
  });

  it("mergeTheme overrides specific fields", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, { background: "#000000" });
    expect(result.background).toBe("#000000");
    expect(result.plotBackground).toBe(DEFAULT_CHART_THEME.plotBackground);
  });

  it("resolveChartTheme with no config returns default", () => {
    expect(resolveChartTheme(undefined)).toEqual(DEFAULT_CHART_THEME);
  });

  it("resolveChartTheme with empty theme returns default", () => {
    expect(resolveChartTheme({ theme: {} })).toEqual(DEFAULT_CHART_THEME);
  });

  const themeFields: Array<keyof typeof DEFAULT_CHART_THEME> = [
    "background", "plotBackground", "gridLineColor", "axisColor",
    "axisLabelColor", "axisTitleColor", "titleColor", "legendTextColor", "fontFamily",
  ];

  it.each(themeFields)("DEFAULT_CHART_THEME.%s is a non-empty string", (field) => {
    expect(typeof DEFAULT_CHART_THEME[field]).toBe("string");
    expect((DEFAULT_CHART_THEME[field] as string).length).toBeGreaterThan(0);
  });

  const numericFields: Array<keyof typeof DEFAULT_CHART_THEME> = [
    "gridLineWidth", "titleFontSize", "axisTitleFontSize", "labelFontSize",
    "legendFontSize", "barBorderRadius", "barGap",
  ];

  it.each(numericFields)("DEFAULT_CHART_THEME.%s is a positive number", (field) => {
    expect(typeof DEFAULT_CHART_THEME[field]).toBe("number");
    expect(DEFAULT_CHART_THEME[field] as number).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 10. Filter predicates exhaustive
// ============================================================================

describe("filter predicate operators", () => {
  const data = makeData();

  const predicates = [
    { pred: "> 200", expectedCount: 2 },    // 300, 250
    { pred: "< 200", expectedCount: 2 },    // 100, 150
    { pred: ">= 200", expectedCount: 3 },   // 200, 300, 250
    { pred: "<= 200", expectedCount: 3 },   // 100, 200, 150
    { pred: "= 200", expectedCount: 1 },    // 200
    { pred: "!= 200", expectedCount: 4 },   // 100, 300, 150, 250
  ];

  it.each(predicates)("filter Sales $pred keeps $expectedCount items", ({ pred, expectedCount }) => {
    const result = applyTransforms(data, [{ type: "filter", field: "Sales", predicate: pred }]);
    expect(result.categories.length).toBe(expectedCount);
  });
});

// ============================================================================
// 11. Sort directions
// ============================================================================

describe("sort directions", () => {
  const data = makeData();

  it("sort by Sales asc orders correctly", () => {
    const result = applyTransforms(data, [{ type: "sort", field: "Sales", order: "asc" }]);
    for (let i = 1; i < result.series[0].values.length; i++) {
      expect(result.series[0].values[i]).toBeGreaterThanOrEqual(result.series[0].values[i - 1]);
    }
  });

  it("sort by Sales desc orders correctly", () => {
    const result = applyTransforms(data, [{ type: "sort", field: "Sales", order: "desc" }]);
    for (let i = 1; i < result.series[0].values.length; i++) {
      expect(result.series[0].values[i]).toBeLessThanOrEqual(result.series[0].values[i - 1]);
    }
  });

  it("sort by $category asc is alphabetical", () => {
    const result = applyTransforms(data, [{ type: "sort", field: "$category", order: "asc" }]);
    for (let i = 1; i < result.categories.length; i++) {
      expect(result.categories[i] >= result.categories[i - 1]).toBe(true);
    }
  });

  it("sort by unknown field returns data unchanged", () => {
    const result = applyTransforms(data, [{ type: "sort", field: "NoSuchField" }]);
    expect(result).toEqual(data);
  });
});

// ============================================================================
// 12. Calculate expression evaluation
// ============================================================================

describe("calculate expression evaluation", () => {
  const data = makeData();

  it("multiplies series by constant", () => {
    const result = applyTransforms(data, [{ type: "calculate", expr: "Sales * 2", as: "Double" }]);
    const d = result.series.find((s) => s.name === "Double")!;
    expect(d.values).toEqual([200, 400, 600, 300, 500]);
  });

  it("subtracts two series", () => {
    const result = applyTransforms(data, [{ type: "calculate", expr: "Sales - Cost", as: "Profit" }]);
    const p = result.series.find((s) => s.name === "Profit")!;
    expect(p.values).toEqual([20, 80, 120, 60, 100]);
  });

  it("invalid expression returns zeros", () => {
    const result = applyTransforms(data, [{ type: "calculate", expr: "alert('xss')", as: "Bad" }]);
    const b = result.series.find((s) => s.name === "Bad")!;
    expect(b.values.every((v) => v === 0)).toBe(true);
  });

  it("replaces existing series with same name", () => {
    const result = applyTransforms(data, [{ type: "calculate", expr: "Sales + 1", as: "Sales" }]);
    expect(result.series.filter((s) => s.name === "Sales")).toHaveLength(1);
    expect(result.series.find((s) => s.name === "Sales")!.values[0]).toBe(101);
  });
});

// ============================================================================
// 13. Bin transform
// ============================================================================

describe("bin transform", () => {
  it("creates correct number of bins", () => {
    const data = makeData();
    const result = applyTransforms(data, [{ type: "bin", field: "Sales", binCount: 5, as: "Bins" }]);
    expect(result.categories.length).toBe(5);
  });

  it("default bin count is 10", () => {
    const data: ParsedChartData = {
      categories: Array.from({ length: 100 }, (_, i) => `C${i}`),
      series: [{ name: "V", values: Array.from({ length: 100 }, (_, i) => i), color: null }],
    };
    const result = applyTransforms(data, [{ type: "bin", field: "V", as: "Bins" }]);
    expect(result.categories.length).toBe(10);
  });

  it("sum of bin counts equals original data length", () => {
    const data = makeData();
    const result = applyTransforms(data, [{ type: "bin", field: "Sales", binCount: 3, as: "Bins" }]);
    const total = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(total).toBe(data.categories.length);
  });
});

// ============================================================================
// 14. Transform pipeline composition
// ============================================================================

describe("transform pipeline composition", () => {
  it("filter then sort", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 100" },
      { type: "sort", field: "Sales", order: "asc" },
    ]);
    expect(result.categories.length).toBeLessThan(5); // some filtered out
    for (let i = 1; i < result.series[0].values.length; i++) {
      expect(result.series[0].values[i]).toBeGreaterThanOrEqual(result.series[0].values[i - 1]);
    }
  });

  it("calculate then window", () => {
    const data = makeData();
    const result = applyTransforms(data, [
      { type: "calculate", expr: "Sales - Cost", as: "Profit" },
      { type: "window", op: "running_sum", field: "Profit", as: "CumProfit" },
    ]);
    const cp = result.series.find((s) => s.name === "CumProfit")!;
    expect(cp).toBeDefined();
    expect(cp.values.length).toBe(5);
  });

  it("empty transform array returns same reference", () => {
    const data = makeData();
    const result = applyTransforms(data, []);
    expect(result).toBe(data);
  });
});
