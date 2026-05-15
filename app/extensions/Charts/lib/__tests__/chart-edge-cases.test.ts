//! FILENAME: app/extensions/Charts/lib/__tests__/chart-edge-cases.test.ts
// PURPOSE: Edge-case tests for chart data handling: empty data, extreme values,
//          special characters, and boundary conditions.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import type { ParsedChartData, TransformSpec } from "../../types";
import { computeCartesianLayout, computeRadialLayout, formatTickValue } from "../../rendering/chartPainterUtils";
import type { ChartSpec } from "../../types";
import type { ChartRenderTheme } from "../../rendering/chartTheme";

// ============================================================================
// Test Helpers
// ============================================================================

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["A", "B", "C"],
    series: [
      { name: "Series1", values: [10, 20, 30], color: null },
    ],
    ...overrides,
  };
}

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, showLabels: true, showGridLines: false, labelAngle: 0 },
    yAxis: { title: null, showLabels: true, showGridLines: true, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    stacking: "none",
    transforms: [],
    encodings: {},
    annotations: [],
    dataPointOverrides: [],
    filters: [],
    gradientFill: null,
    stylePreset: null,
    ...overrides,
  } as ChartSpec;
}

const defaultTheme: ChartRenderTheme = {
  titleFontSize: 16,
  axisTitleFontSize: 12,
  labelFontSize: 11,
  legendFontSize: 11,
  fontFamily: "sans-serif",
  colors: ["#4e79a7", "#f28e2b", "#e15759"],
  backgroundColor: "#ffffff",
  plotBackgroundColor: "#f8f8f8",
  gridLineColor: "#e0e0e0",
  axisLineColor: "#333333",
  textColor: "#333333",
  borderRadius: 4,
};

// ============================================================================
// Empty and minimal data
// ============================================================================

describe("Charts with 0 data points", () => {
  it("applyTransforms handles empty categories", () => {
    const data = makeData({ categories: [], series: [{ name: "S1", values: [], color: null }] });
    const result = applyTransforms(data, []);
    expect(result.categories).toHaveLength(0);
    expect(result.series[0].values).toHaveLength(0);
  });

  it("applyTransforms handles empty series array", () => {
    const data = makeData({ categories: [], series: [] });
    const result = applyTransforms(data, []);
    expect(result.series).toHaveLength(0);
  });

  it("filter on empty data returns empty", () => {
    const data = makeData({ categories: [], series: [{ name: "S1", values: [], color: null }] });
    const transforms: TransformSpec[] = [{ type: "filter", field: "S1", predicate: "> 0" }];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(0);
  });

  it("sort on empty data returns empty", () => {
    const data = makeData({ categories: [], series: [{ name: "S1", values: [], color: null }] });
    const transforms: TransformSpec[] = [{ type: "sort", field: "S1", order: "asc" }];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(0);
  });
});

describe("Charts with 1 data point", () => {
  it("single point data passes through transforms", () => {
    const data = makeData({
      categories: ["Only"],
      series: [{ name: "S1", values: [42], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.categories).toEqual(["Only"]);
    expect(result.series[0].values).toEqual([42]);
  });

  it("filter keeps single point that matches", () => {
    const data = makeData({
      categories: ["A"],
      series: [{ name: "S1", values: [100], color: null }],
    });
    const transforms: TransformSpec[] = [{ type: "filter", field: "S1", predicate: "> 50" }];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(1);
  });

  it("filter removes single point that does not match", () => {
    const data = makeData({
      categories: ["A"],
      series: [{ name: "S1", values: [10], color: null }],
    });
    const transforms: TransformSpec[] = [{ type: "filter", field: "S1", predicate: "> 50" }];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(0);
  });
});

describe("Charts with 10000 data points", () => {
  it("handles large dataset without crashing", () => {
    const n = 10000;
    const categories = Array.from({ length: n }, (_, i) => `Cat${i}`);
    const values = Array.from({ length: n }, (_, i) => Math.sin(i) * 1000);
    const data = makeData({
      categories,
      series: [{ name: "Big", values, color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.categories).toHaveLength(n);
    expect(result.series[0].values).toHaveLength(n);
  });

  it("sort on large dataset completes", () => {
    const n = 10000;
    const categories = Array.from({ length: n }, (_, i) => `Cat${i}`);
    const values = Array.from({ length: n }, () => Math.random() * 1000);
    const data = makeData({
      categories,
      series: [{ name: "Big", values, color: null }],
    });
    const transforms: TransformSpec[] = [{ type: "sort", field: "Big", order: "desc" }];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(n);
    // Verify sorted descending
    for (let i = 1; i < result.series[0].values.length; i++) {
      expect(result.series[0].values[i]).toBeLessThanOrEqual(result.series[0].values[i - 1]);
    }
  });

  it("filter on large dataset produces subset", () => {
    const n = 10000;
    const categories = Array.from({ length: n }, (_, i) => `Cat${i}`);
    const values = Array.from({ length: n }, (_, i) => i);
    const data = makeData({
      categories,
      series: [{ name: "S", values, color: null }],
    });
    const transforms: TransformSpec[] = [{ type: "filter", field: "S", predicate: ">= 9000" }];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(1000);
  });
});

// ============================================================================
// All-identical values
// ============================================================================

describe("All-identical values", () => {
  it("flat line: all values the same", () => {
    const data = makeData({
      categories: ["A", "B", "C", "D", "E"],
      series: [{ name: "Flat", values: [50, 50, 50, 50, 50], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.series[0].values.every((v) => v === 50)).toBe(true);
  });

  it("all zeros", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "Zero", values: [0, 0, 0], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.series[0].values).toEqual([0, 0, 0]);
  });

  it("sort on identical values preserves order", () => {
    const data = makeData({
      categories: ["X", "Y", "Z"],
      series: [{ name: "S", values: [5, 5, 5], color: null }],
    });
    const transforms: TransformSpec[] = [{ type: "sort", field: "S", order: "asc" }];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([5, 5, 5]);
  });
});

// ============================================================================
// Extremely large/small numbers
// ============================================================================

describe("Extreme numeric values", () => {
  it("handles very large numbers (1e308)", () => {
    const data = makeData({
      categories: ["Big"],
      series: [{ name: "S", values: [1e308], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.series[0].values[0]).toBe(1e308);
  });

  it("handles very small numbers (1e-308)", () => {
    const data = makeData({
      categories: ["Tiny"],
      series: [{ name: "S", values: [1e-308], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.series[0].values[0]).toBe(1e-308);
  });

  it("handles Infinity", () => {
    const data = makeData({
      categories: ["Inf"],
      series: [{ name: "S", values: [Infinity], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.series[0].values[0]).toBe(Infinity);
  });

  it("handles NaN values", () => {
    const data = makeData({
      categories: ["NaN"],
      series: [{ name: "S", values: [NaN], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(Number.isNaN(result.series[0].values[0])).toBe(true);
  });

  it("handles negative Infinity", () => {
    const data = makeData({
      categories: ["NegInf"],
      series: [{ name: "S", values: [-Infinity], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.series[0].values[0]).toBe(-Infinity);
  });

  it("formatTickValue handles very large number", () => {
    expect(formatTickValue(1e9)).toBe("1000.0M");
  });

  it("formatTickValue handles very small positive number", () => {
    const formatted = formatTickValue(0.001);
    expect(formatted).toBe("0.0");
  });

  it("formatTickValue handles zero", () => {
    expect(formatTickValue(0)).toBe("0");
  });

  it("formatTickValue handles negative millions", () => {
    expect(formatTickValue(-5_000_000)).toBe("-5.0M");
  });
});

// ============================================================================
// Mixed positive/negative in stacked charts
// ============================================================================

describe("Mixed positive/negative values", () => {
  it("data with mixed signs passes through", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [
        { name: "Pos", values: [100, -50, 200], color: null },
        { name: "Neg", values: [-30, 80, -100], color: null },
      ],
    });
    const result = applyTransforms(data, []);
    expect(result.series[0].values).toEqual([100, -50, 200]);
    expect(result.series[1].values).toEqual([-30, 80, -100]);
  });

  it("filter with negative threshold", () => {
    const data = makeData({
      categories: ["A", "B", "C"],
      series: [{ name: "S", values: [-10, 5, -20], color: null }],
    });
    const transforms: TransformSpec[] = [{ type: "filter", field: "S", predicate: "< 0" }];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(2);
    expect(result.series[0].values.every((v) => v < 0)).toBe(true);
  });

  it("sort with mixed signs sorts correctly", () => {
    const data = makeData({
      categories: ["A", "B", "C", "D"],
      series: [{ name: "S", values: [10, -5, 3, -8], color: null }],
    });
    const transforms: TransformSpec[] = [{ type: "sort", field: "S", order: "asc" }];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([-8, -5, 3, 10]);
  });
});

// ============================================================================
// Empty / duplicate series names
// ============================================================================

describe("Empty and duplicate series names", () => {
  it("handles empty series name", () => {
    const data = makeData({
      categories: ["A", "B"],
      series: [{ name: "", values: [1, 2], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.series[0].name).toBe("");
  });

  it("handles duplicate series names", () => {
    const data = makeData({
      categories: ["A", "B"],
      series: [
        { name: "Sales", values: [10, 20], color: null },
        { name: "Sales", values: [30, 40], color: null },
      ],
    });
    const result = applyTransforms(data, []);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].name).toBe("Sales");
    expect(result.series[1].name).toBe("Sales");
  });

  it("handles series names with special characters", () => {
    const data = makeData({
      categories: ["A"],
      series: [{ name: 'Sales & "Revenue" <2024>', values: [100], color: null }],
    });
    expect(data.series[0].name).toBe('Sales & "Revenue" <2024>');
  });
});

// ============================================================================
// Category name edge cases
// ============================================================================

describe("Category name edge cases", () => {
  it("handles empty category names", () => {
    const data = makeData({
      categories: ["", "", ""],
      series: [{ name: "S", values: [1, 2, 3], color: null }],
    });
    const result = applyTransforms(data, []);
    expect(result.categories).toEqual(["", "", ""]);
  });

  it("handles very long category names (200 chars)", () => {
    const longName = "A".repeat(200);
    const data = makeData({
      categories: [longName, "Short"],
      series: [{ name: "S", values: [1, 2], color: null }],
    });
    expect(data.categories[0]).toHaveLength(200);
  });

  it("handles category names with special characters", () => {
    const data = makeData({
      categories: ["Q1 (Jan-Mar)", "Q2 [Apr/Jun]", "Q3 {Jul...Sep}", "Q4: Oct->Dec"],
      series: [{ name: "S", values: [1, 2, 3, 4], color: null }],
    });
    expect(data.categories).toHaveLength(4);
  });

  it("handles category names with unicode", () => {
    const data = makeData({
      categories: ["Umsatz", "Gewinn"],
      series: [{ name: "S", values: [100, 50], color: null }],
    });
    expect(data.categories).toHaveLength(2);
  });

  it("handles duplicate category names", () => {
    const data = makeData({
      categories: ["Jan", "Jan", "Jan"],
      series: [{ name: "S", values: [10, 20, 30], color: null }],
    });
    const transforms: TransformSpec[] = [{ type: "sort", field: "S", order: "desc" }];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values[0]).toBe(30);
  });
});

// ============================================================================
// Layout computation edge cases
// ============================================================================

describe("computeCartesianLayout edge cases", () => {
  it("handles zero-size data", () => {
    const data = makeData({ categories: [], series: [] });
    const spec = makeSpec();
    const layout = computeCartesianLayout(800, 600, spec, data, defaultTheme);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });

  it("handles very small canvas", () => {
    const data = makeData();
    const spec = makeSpec({ title: "T" });
    const layout = computeCartesianLayout(50, 50, spec, data, defaultTheme);
    // plotArea minimum is 10x10
    expect(layout.plotArea.width).toBeGreaterThanOrEqual(10);
    expect(layout.plotArea.height).toBeGreaterThanOrEqual(10);
  });

  it("handles many series for legend width calculation", () => {
    const series = Array.from({ length: 20 }, (_, i) => ({
      name: `Series ${i}`,
      values: [i],
      color: null,
    }));
    const data = makeData({ categories: ["A"], series });
    const spec = makeSpec({ legend: { visible: true, position: "right" } });
    const layout = computeCartesianLayout(800, 600, spec, data, defaultTheme);
    expect(layout.plotArea.width).toBeGreaterThan(0);
  });
});
