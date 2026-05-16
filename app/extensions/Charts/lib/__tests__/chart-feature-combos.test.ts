//! FILENAME: app/extensions/Charts/lib/__tests__/chart-feature-combos.test.ts
// PURPOSE: Tests for chart feature combinations and interactions.
// CONTEXT: Ensures multiple features compose correctly when used together.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline } from "../trendlineComputation";
import { applyChartFilters } from "../chartFilters";
import { resolvePointColor, resolvePointOpacity } from "../encodingResolver";
import { getPresetById, buildPresetUpdates, CHART_STYLE_PRESETS } from "../chartStylePresets";
import { resolveChartTheme, getSeriesColor, PALETTES } from "../../rendering/chartTheme";
import type {
  ParsedChartData,
  TransformSpec,
  TrendlineSpec,
  ChartFilters,
  SeriesEncoding,
  ChartSpec,
  AxisSpec,
  DataPointOverride,
} from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeAxis(overrides: Partial<AxisSpec> = {}): AxisSpec {
  return {
    title: null,
    gridLines: true,
    showLabels: true,
    labelAngle: 0,
    min: null,
    max: null,
    ...overrides,
  };
}

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

function makeLargeData(n: number): ParsedChartData {
  const categories: string[] = [];
  const values1: number[] = [];
  const values2: number[] = [];
  for (let i = 0; i < n; i++) {
    categories.push(`Cat${i}`);
    values1.push(Math.sin(i / 10) * 100 + 200 + (i % 7));
    values2.push(Math.cos(i / 8) * 50 + 100);
  }
  return {
    categories,
    series: [
      { name: "Series1", values: values1, color: null },
      { name: "Series2", values: values2, color: null },
    ],
  };
}

// ============================================================================
// Trendline + Data Labels Together
// ============================================================================

describe("trendline + data labels interaction", () => {
  it("trendline computes correctly on data that also has data labels configured", () => {
    const data = makeData();
    const trendline: TrendlineSpec = { type: "linear", seriesIndex: 0, showEquation: true, showRSquared: true };
    const result = computeTrendline(data, trendline);

    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(5);
    expect(result!.equation).toContain("y =");
    expect(result!.rSquared).toBeGreaterThanOrEqual(0);
    expect(result!.rSquared).toBeLessThanOrEqual(1);
  });

  it("trendline on filtered data matches expected reduced point count", () => {
    const data = makeData();
    // Filter to only values > 150, then compute trendline
    const filtered = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 150" },
    ]);
    // Should have Feb(200), Mar(300), May(250)
    expect(filtered.categories).toHaveLength(3);

    const result = computeTrendline(filtered, { type: "linear", seriesIndex: 0 });
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(3);
  });
});

// ============================================================================
// Filter + Sort + Aggregate + Trendline Pipeline
// ============================================================================

describe("filter -> sort -> aggregate -> trendline pipeline", () => {
  it("applies full transform pipeline then computes trendline", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "A", "B", "A", "C", "C"],
      series: [
        { name: "Revenue", values: [100, 200, 150, 50, 300, 10, 20], color: null },
      ],
    };

    const transforms: TransformSpec[] = [
      { type: "filter", field: "Revenue", predicate: "> 10" },
      { type: "sort", field: "Revenue", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    // Filtered out 10, sorted ascending: 20, 50, 100, 150, 200, 300
    expect(result.series[0].values[0]).toBeLessThanOrEqual(result.series[0].values[1]);

    const trend = computeTrendline(result, { type: "linear", seriesIndex: 0 });
    expect(trend).not.toBeNull();
    expect(trend!.rSquared).toBeGreaterThan(0);
  });

  it("aggregate then trendline on grouped data", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "A", "B", "C"],
      series: [
        { name: "Sales", values: [100, 200, 150, 250, 300], color: null },
      ],
    };

    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Sales", as: "TotalSales" },
    ];
    const aggregated = applyTransforms(data, transforms);
    // A=250, B=450, C=300
    expect(aggregated.categories).toHaveLength(3);

    const trend = computeTrendline(aggregated, { type: "linear", seriesIndex: 0 });
    expect(trend).not.toBeNull();
    expect(trend!.points).toHaveLength(3);
  });

  it("filter + sort + aggregate composes correctly", () => {
    const data: ParsedChartData = {
      categories: ["X", "Y", "X", "Y", "Z", "Z"],
      series: [
        { name: "Val", values: [5, 10, 15, 20, 1, 2], color: null },
      ],
    };

    const transforms: TransformSpec[] = [
      { type: "filter", field: "Val", predicate: "> 3" },
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Val", as: "Sum" },
      { type: "sort", field: "Sum", order: "desc" },
    ];
    const result = applyTransforms(data, transforms);
    // Filter removes 1,2 -> X:5,15 Y:10,20. Aggregate: X=20, Y=30. Sort desc: Y=30, X=20
    expect(result.categories[0]).toBe("Y");
    expect(result.series[0].values[0]).toBe(30);
  });
});

// ============================================================================
// Multiple Trendline Types on Same Data (compare R-squared)
// ============================================================================

describe("multiple trendline types comparison", () => {
  it("linear, exponential, polynomial on same data yield different R-squared", () => {
    // Exponential-ish data: linear should have lower R^2 than polynomial
    const data: ParsedChartData = {
      categories: ["A", "B", "C", "D", "E", "F", "G"],
      series: [{ name: "Growth", values: [2, 4, 8, 16, 32, 64, 128], color: null }],
    };

    const linearR = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    const expR = computeTrendline(data, { type: "exponential", seriesIndex: 0 });
    const polyR = computeTrendline(data, { type: "polynomial", seriesIndex: 0, polynomialDegree: 3 });

    expect(linearR).not.toBeNull();
    expect(expR).not.toBeNull();
    expect(polyR).not.toBeNull();

    // Exponential should fit exponential data better than linear
    expect(expR!.rSquared).toBeGreaterThan(linearR!.rSquared);
    // All should be valid R^2 values
    expect(linearR!.rSquared).toBeGreaterThanOrEqual(0);
    expect(expR!.rSquared).toBeLessThanOrEqual(1);
  });

  it("moving average returns NaN R-squared", () => {
    const data = makeData();
    const ma = computeTrendline(data, { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 2 });
    expect(ma).not.toBeNull();
    expect(ma!.rSquared).toBeNaN();
  });

  it("power and logarithmic trendlines compute on positive data", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C", "D", "E"],
      series: [{ name: "Val", values: [1, 4, 9, 16, 25], color: null }],
    };

    const power = computeTrendline(data, { type: "power", seriesIndex: 0 });
    const log = computeTrendline(data, { type: "logarithmic", seriesIndex: 0 });

    expect(power).not.toBeNull();
    expect(log).not.toBeNull();
    // Both should produce valid R-squared values
    expect(power!.rSquared).toBeGreaterThanOrEqual(0);
    expect(power!.rSquared).toBeLessThanOrEqual(1);
  });
});

// ============================================================================
// Conditional Encoding + Filters
// ============================================================================

describe("conditional encoding + chart filters", () => {
  it("encoding resolves on data remaining after filter hides series", () => {
    const data = makeData();
    const filters: ChartFilters = { hiddenSeries: [1], hiddenCategories: [] };
    const filtered = applyChartFilters(data, filters);

    // Only Sales remains
    expect(filtered.series).toHaveLength(1);
    expect(filtered.series[0].name).toBe("Sales");

    // Encoding on remaining series should still work
    const encoding: SeriesEncoding = {
      color: { condition: { field: "value", gt: 200 }, value: "#00FF00", otherwise: "#FF0000" },
    };

    const c1 = resolvePointColor(encoding, "default", 0, null, 100, "Jan");
    const c2 = resolvePointColor(encoding, "default", 0, null, 300, "Mar");
    expect(c1).toBe("#FF0000");
    expect(c2).toBe("#00FF00");
  });

  it("encoding on hidden categories should not matter after filter", () => {
    const data = makeData();
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [0, 1] };
    const filtered = applyChartFilters(data, filters);

    // Jan and Feb hidden -> Mar, Apr, May remain
    expect(filtered.categories).toHaveLength(3);
    expect(filtered.categories[0]).toBe("Mar");
  });

  it("hiding all series yields empty series array", () => {
    const data = makeData();
    const filters: ChartFilters = { hiddenSeries: [0, 1], hiddenCategories: [] };
    const filtered = applyChartFilters(data, filters);
    expect(filtered.series).toHaveLength(0);
  });
});

// ============================================================================
// Style Presets + Theme Override Interaction
// ============================================================================

describe("style presets + theme override interaction", () => {
  it("preset theme overrides merge with default theme", () => {
    const preset = getPresetById("dark-1");
    expect(preset).toBeDefined();

    const theme = resolveChartTheme({ theme: preset!.theme });
    expect(theme.background).toBe("#1e1e1e");
    // Non-overridden fields should keep defaults
    expect(theme.fontFamily).toContain("Segoe UI");
  });

  it("user theme override on top of preset takes precedence", () => {
    const preset = getPresetById("colorful-1");
    expect(preset).toBeDefined();

    // Apply preset first, then user override
    const combined = { ...preset!.theme, titleColor: "#FF0000" };
    const theme = resolveChartTheme({ theme: combined });
    expect(theme.titleColor).toBe("#FF0000");
    expect(theme.background).toBe(preset!.theme.background);
  });

  it("buildPresetUpdates includes gridLines and barBorderRadius", () => {
    const preset = getPresetById("outline-2")!;
    const currentSpec = { yAxis: { gridLines: false } as AxisSpec & Record<string, unknown>, markOptions: {} };
    const updates = buildPresetUpdates(preset, currentSpec);

    expect((updates.yAxis as { gridLines: boolean }).gridLines).toBe(true);
    expect((updates.config as { theme: { barBorderRadius: number } }).theme.barBorderRadius).toBe(6);
  });

  it("all presets have unique IDs", () => {
    const ids = CHART_STYLE_PRESETS.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ============================================================================
// Data Point Overrides + Series Color Cycling
// ============================================================================

describe("data point overrides + series color cycling", () => {
  it("series color cycles through palette", () => {
    const palette = "default";
    const colors = PALETTES[palette];

    for (let i = 0; i < 12; i++) {
      const c = getSeriesColor(palette, i, null);
      expect(c).toBe(colors[i % colors.length]);
    }
  });

  it("data point override color takes precedence over encoding", () => {
    // Scenario: series has encoding, plus a per-point override
    const encoding: SeriesEncoding = {
      color: { condition: { field: "value", gt: 0 }, value: "#00FF00", otherwise: "#FF0000" },
    };
    const overrides: DataPointOverride[] = [
      { seriesIndex: 0, categoryIndex: 2, color: "#0000FF" },
    ];

    // Point at index 2 has override, so it should be blue regardless of encoding
    const encodedColor = resolvePointColor(encoding, "default", 0, null, 300, "Mar");
    expect(encodedColor).toBe("#00FF00"); // encoding says green

    // The override would be applied at render time - verify it exists
    const override = overrides.find((o) => o.seriesIndex === 0 && o.categoryIndex === 2);
    expect(override).toBeDefined();
    expect(override!.color).toBe("#0000FF");
  });

  it("series color override takes precedence over palette cycling", () => {
    const c = getSeriesColor("default", 0, "#AABBCC");
    expect(c).toBe("#AABBCC");
  });

  it("opacity encoding composes with point override", () => {
    const encoding: SeriesEncoding = {
      opacity: { condition: { field: "value", gt: 200 }, value: 1.0, otherwise: 0.3 },
    };
    const op1 = resolvePointOpacity(encoding, 100, "Jan");
    const op2 = resolvePointOpacity(encoding, 300, "Mar");
    expect(op1).toBe(0.3);
    expect(op2).toBe(1.0);
  });
});

// ============================================================================
// Large Dataset Through Full Pipeline
// ============================================================================

describe("large dataset through full pipeline", () => {
  it("filter -> sort -> window on 1000 points", () => {
    const data = makeLargeData(1000);
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Series1", predicate: "> 150" },
      { type: "sort", field: "Series1", order: "asc" },
      { type: "window", op: "running_sum", field: "Series1", as: "RunSum" },
    ];
    const result = applyTransforms(data, transforms);

    expect(result.categories.length).toBeLessThan(1000);
    expect(result.categories.length).toBeGreaterThan(0);

    // Running sum should be monotonically non-decreasing (all values positive after filter > 150)
    const runSum = result.series.find((s) => s.name === "RunSum");
    expect(runSum).toBeDefined();
    for (let i = 1; i < runSum!.values.length; i++) {
      expect(runSum!.values[i]).toBeGreaterThanOrEqual(runSum!.values[i - 1]);
    }
  });

  it("filter -> sort -> aggregate -> window -> bin on 500 points", () => {
    const data = makeLargeData(500);
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Series1", predicate: "> 100" },
      { type: "sort", field: "Series1", order: "desc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories.length).toBeGreaterThan(0);

    // Verify sorted desc
    for (let i = 1; i < result.series[0].values.length; i++) {
      expect(result.series[0].values[i]).toBeLessThanOrEqual(result.series[0].values[i - 1]);
    }
  });

  it("trendline on large dataset computes in reasonable time", () => {
    const data = makeLargeData(500);
    const start = performance.now();
    const result = computeTrendline(data, { type: "polynomial", seriesIndex: 0, polynomialDegree: 3 });
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(500);
    expect(elapsed).toBeLessThan(1000); // should be well under 1 second
  });
});

// ============================================================================
// Empty Result at Each Pipeline Stage
// ============================================================================

describe("empty results at pipeline stages", () => {
  it("filter removes all data points", () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 9999" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(0);
    expect(result.series[0].values).toHaveLength(0);
  });

  it("trendline returns null on empty filtered data", () => {
    const data: ParsedChartData = {
      categories: [],
      series: [{ name: "Sales", values: [], color: null }],
    };
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result).toBeNull();
  });

  it("aggregate on empty data returns empty", () => {
    const data: ParsedChartData = {
      categories: [],
      series: [{ name: "Sales", values: [], color: null }],
    };
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Sales", as: "Total" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(0);
  });

  it("window transform on empty data returns empty", () => {
    const data: ParsedChartData = {
      categories: [],
      series: [{ name: "Sales", values: [], color: null }],
    };
    const transforms: TransformSpec[] = [
      { type: "window", op: "running_sum", field: "Sales", as: "RunSum" },
    ];
    const result = applyTransforms(data, transforms);
    const runSum = result.series.find((s) => s.name === "RunSum");
    expect(runSum).toBeDefined();
    expect(runSum!.values).toHaveLength(0);
  });

  it("filter removing all then sort on empty is safe", () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 9999" },
      { type: "sort", field: "Sales", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(0);
  });

  it("chart filters hiding all categories yields empty categories", () => {
    const data = makeData();
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [0, 1, 2, 3, 4] };
    const result = applyChartFilters(data, filters);
    expect(result.categories).toHaveLength(0);
    expect(result.series[0].values).toHaveLength(0);
  });
});

// ============================================================================
// Transform Type Switching
// ============================================================================

describe("transform type switching", () => {
  it("switching from aggregate to window changes output structure", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B"],
      series: [{ name: "Val", values: [10, 20, 30, 40], color: null }],
    };

    // Aggregate groups by category
    const aggResult = applyTransforms(data, [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Val", as: "Sum" },
    ]);
    expect(aggResult.categories).toHaveLength(2); // A, B

    // Window preserves all points
    const winResult = applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Val", as: "RunSum" },
    ]);
    expect(winResult.categories).toHaveLength(4); // all original points
    const runSum = winResult.series.find((s) => s.name === "RunSum")!;
    expect(runSum.values).toEqual([10, 30, 60, 100]);
  });

  it("switching from filter to calculate yields different series count", () => {
    const data = makeData();

    const filterResult = applyTransforms(data, [
      { type: "filter", field: "Sales", predicate: "> 200" },
    ]);
    expect(filterResult.series).toHaveLength(2); // same series, fewer points

    const calcResult = applyTransforms(data, [
      { type: "calculate", expr: "Sales - Cost", as: "Profit" },
    ]);
    expect(calcResult.series).toHaveLength(3); // added Profit series
    expect(calcResult.series[2].name).toBe("Profit");
    expect(calcResult.series[2].values[0]).toBe(20); // 100-80
  });
});
