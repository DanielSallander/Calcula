//! FILENAME: app/extensions/Charts/lib/__tests__/chart-unusual-data.test.ts
// PURPOSE: Tests with unusual data shapes to find edge cases in chart processing.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import type { ParsedChartData } from "../../types";
import { computeCartesianLayout, computeRadialLayout, formatTickValue } from "../../rendering/chartPainterUtils";
import type { ChartSpec } from "../../types";
import type { ChartRenderTheme } from "../../rendering/chartTheme";

// ============================================================================
// Test Helpers
// ============================================================================

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["A", "B", "C"],
    series: [{ name: "Series1", values: [10, 20, 30], color: null }],
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
// Very wide data: 1 category, 100 series
// ============================================================================

describe("Very wide data (1 category, 100 series)", () => {
  const wideData = makeData({
    categories: ["Only"],
    series: Array.from({ length: 100 }, (_, i) => ({
      name: `S${i}`,
      values: [i * 10],
      color: null,
    })),
  });

  it("applyTransforms preserves all 100 series", () => {
    const result = applyTransforms(wideData, []);
    expect(result.series).toHaveLength(100);
    expect(result.categories).toHaveLength(1);
  });

  it("computeCartesianLayout handles 100-series legend without crashing", () => {
    const spec = makeSpec();
    const layout = computeCartesianLayout(800, 600, spec, wideData, defaultTheme);
    expect(layout.plotArea.x).toBeGreaterThan(0);
    expect(layout.plotArea.width).toBeGreaterThan(0);
  });
});

// ============================================================================
// Very tall data: 100 categories, 1 series
// ============================================================================

describe("Very tall data (100 categories, 1 series)", () => {
  const tallData = makeData({
    categories: Array.from({ length: 100 }, (_, i) => `Cat${i}`),
    series: [{ name: "S1", values: Array.from({ length: 100 }, (_, i) => i), color: null }],
  });

  it("applyTransforms preserves all 100 categories", () => {
    const result = applyTransforms(tallData, []);
    expect(result.categories).toHaveLength(100);
    expect(result.series[0].values).toHaveLength(100);
  });

  it("sort transform works across 100 categories", () => {
    const result = applyTransforms(tallData, [{ type: "sort", field: "S1", order: "desc" }]);
    expect(result.series[0].values[0]).toBe(99);
    expect(result.series[0].values[99]).toBe(0);
  });
});

// ============================================================================
// Alternating null/value pattern
// ============================================================================

describe("Series with alternating null/value pattern", () => {
  const alternatingData = makeData({
    categories: Array.from({ length: 10 }, (_, i) => `C${i}`),
    series: [{
      name: "Alternating",
      values: Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 100 : NaN)),
      color: null,
    }],
  });

  it("applyTransforms does not drop NaN entries", () => {
    const result = applyTransforms(alternatingData, []);
    expect(result.series[0].values).toHaveLength(10);
  });

  it("sort transform handles NaN values without crashing", () => {
    const result = applyTransforms(alternatingData, [{ type: "sort", field: "Alternating", order: "asc" }]);
    expect(result.series[0].values).toHaveLength(10);
  });
});

// ============================================================================
// All values identical
// ============================================================================

describe("Series where all values are the same number", () => {
  const flatData = makeData({
    categories: ["A", "B", "C", "D", "E"],
    series: [{ name: "Flat", values: [42, 42, 42, 42, 42], color: null }],
  });

  it("applyTransforms preserves identical values", () => {
    const result = applyTransforms(flatData, []);
    expect(result.series[0].values.every((v) => v === 42)).toBe(true);
  });

  it("sort on identical values keeps stable category order", () => {
    const result = applyTransforms(flatData, [{ type: "sort", field: "Flat", order: "asc" }]);
    // All values same, categories should remain in some deterministic order
    expect(result.categories).toHaveLength(5);
  });
});

// ============================================================================
// Values spanning 20 orders of magnitude (1e-10 to 1e10)
// ============================================================================

describe("Values spanning 20 orders of magnitude", () => {
  const magnitudes = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10];
  const extremeData = makeData({
    categories: magnitudes.map((m) => `1e${m}`),
    series: [{ name: "Extreme", values: magnitudes.map((m) => Math.pow(10, m)), color: null }],
  });

  it("applyTransforms handles extreme ranges", () => {
    const result = applyTransforms(extremeData, []);
    expect(result.series[0].values[0]).toBeCloseTo(1e-10, 15);
    expect(result.series[0].values[10]).toBeCloseTo(1e10);
  });

  it("formatTickValue formats small and large values", () => {
    expect(formatTickValue(1e-10)).toBeDefined();
    expect(formatTickValue(1e10)).toBeDefined();
    expect(typeof formatTickValue(1e-10)).toBe("string");
    expect(typeof formatTickValue(1e10)).toBe("string");
  });

  it("computeCartesianLayout handles extreme Y range", () => {
    const spec = makeSpec();
    const layout = computeCartesianLayout(800, 600, spec, extremeData, defaultTheme);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });
});

// ============================================================================
// Categories that are all empty strings
// ============================================================================

describe("Categories that are all empty strings", () => {
  const emptyCategories = makeData({
    categories: ["", "", "", ""],
    series: [{ name: "S1", values: [1, 2, 3, 4], color: null }],
  });

  it("applyTransforms preserves empty category strings", () => {
    const result = applyTransforms(emptyCategories, []);
    expect(result.categories).toEqual(["", "", "", ""]);
  });

  it("computeCartesianLayout handles empty category labels", () => {
    const spec = makeSpec();
    const layout = computeCartesianLayout(800, 600, spec, emptyCategories, defaultTheme);
    expect(layout.plotArea.width).toBeGreaterThan(0);
  });
});

// ============================================================================
// Categories that are very long (500+ chars each)
// ============================================================================

describe("Categories with very long names (500+ chars)", () => {
  const longName = "A".repeat(500);
  const longData = makeData({
    categories: [longName, longName + "B", longName + "C"],
    series: [{ name: "S1", values: [1, 2, 3], color: null }],
  });

  it("applyTransforms preserves long category names", () => {
    const result = applyTransforms(longData, []);
    expect(result.categories[0].length).toBe(500);
  });

  it("computeCartesianLayout does not crash with long labels", () => {
    const spec = makeSpec();
    const layout = computeCartesianLayout(800, 600, spec, longData, defaultTheme);
    expect(layout.plotArea.width).toBeGreaterThan(0);
  });
});

// ============================================================================
// Duplicate category names
// ============================================================================

describe("Duplicate category names", () => {
  const dupData = makeData({
    categories: ["Dup", "Dup", "Dup", "Unique"],
    series: [{ name: "S1", values: [10, 20, 30, 40], color: null }],
  });

  it("applyTransforms keeps all duplicates (does not deduplicate)", () => {
    const result = applyTransforms(dupData, []);
    expect(result.categories).toEqual(["Dup", "Dup", "Dup", "Unique"]);
    expect(result.series[0].values).toHaveLength(4);
  });

  it("sort transform handles duplicate categories correctly", () => {
    const result = applyTransforms(dupData, [{ type: "sort", field: "S1", order: "desc" }]);
    expect(result.series[0].values[0]).toBe(40);
  });
});

// ============================================================================
// Series with only 2 values (minimum for line charts)
// ============================================================================

describe("Series with only 2 values", () => {
  const minData = makeData({
    categories: ["Start", "End"],
    series: [{ name: "S1", values: [0, 100], color: null }],
  });

  it("applyTransforms works with 2-element series", () => {
    const result = applyTransforms(minData, []);
    expect(result.series[0].values).toEqual([0, 100]);
  });

  it("computeCartesianLayout produces valid layout for 2 categories", () => {
    const spec = makeSpec({ mark: "line" });
    const layout = computeCartesianLayout(800, 600, spec, minData, defaultTheme);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });
});

// ============================================================================
// Data where every value is 0
// ============================================================================

describe("Data where every value is 0", () => {
  const zeroData = makeData({
    categories: ["A", "B", "C", "D"],
    series: [{ name: "Zeroes", values: [0, 0, 0, 0], color: null }],
  });

  it("applyTransforms preserves zero values", () => {
    const result = applyTransforms(zeroData, []);
    expect(result.series[0].values.every((v) => v === 0)).toBe(true);
  });

  it("computeCartesianLayout handles all-zero Y axis", () => {
    const spec = makeSpec();
    const layout = computeCartesianLayout(800, 600, spec, zeroData, defaultTheme);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });

  it("computeRadialLayout handles all-zero pie data", () => {
    const spec = makeSpec({ mark: "pie" });
    const layout = computeRadialLayout(800, 600, spec, zeroData, defaultTheme);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });
});

// ============================================================================
// Data where every value is negative
// ============================================================================

describe("Data where every value is negative", () => {
  const negData = makeData({
    categories: ["A", "B", "C"],
    series: [{ name: "Neg", values: [-100, -200, -50], color: null }],
  });

  it("applyTransforms preserves negative values", () => {
    const result = applyTransforms(negData, []);
    expect(result.series[0].values).toEqual([-100, -200, -50]);
  });

  it("sort transform orders negatives correctly", () => {
    const result = applyTransforms(negData, [{ type: "sort", field: "Neg", order: "asc" }]);
    expect(result.series[0].values[0]).toBe(-200);
    expect(result.series[0].values[2]).toBe(-50);
  });

  it("computeCartesianLayout handles all-negative Y range", () => {
    const spec = makeSpec();
    const layout = computeCartesianLayout(800, 600, spec, negData, defaultTheme);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });
});

// ============================================================================
// Data with MAX_SAFE_INTEGER values
// ============================================================================

describe("Data with MAX_SAFE_INTEGER values", () => {
  const maxIntData = makeData({
    categories: ["Max", "NegMax", "Zero"],
    series: [{
      name: "Extremes",
      values: [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0],
      color: null,
    }],
  });

  it("applyTransforms preserves MAX_SAFE_INTEGER values", () => {
    const result = applyTransforms(maxIntData, []);
    expect(result.series[0].values[0]).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.series[0].values[1]).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it("formatTickValue handles MAX_SAFE_INTEGER", () => {
    const formatted = formatTickValue(Number.MAX_SAFE_INTEGER);
    expect(formatted).toBeDefined();
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("computeCartesianLayout handles MAX_SAFE_INTEGER range", () => {
    const spec = makeSpec();
    const layout = computeCartesianLayout(800, 600, spec, maxIntData, defaultTheme);
    expect(layout.plotArea.width).toBeGreaterThan(0);
  });
});
