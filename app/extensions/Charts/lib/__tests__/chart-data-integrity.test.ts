//! FILENAME: app/extensions/Charts/lib/__tests__/chart-data-integrity.test.ts
// PURPOSE: Data integrity tests for chart transforms, filters, and theme.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { applyChartFilters } from "../chartFilters";
import {
  DEFAULT_CHART_THEME,
  mergeTheme,
  resolveChartTheme,
} from "../../rendering/chartTheme";
import type { ParsedChartData, TransformSpec, ChartFilters } from "../../types";

function makeData(): ParsedChartData {
  return {
    categories: ["A", "B", "C", "D"],
    series: [
      { name: "Sales", values: [10, 20, 30, 40], color: "#4E79A7" },
      { name: "Cost", values: [5, 15, 25, 35], color: "#F28E2B" },
    ],
  };
}

// ============================================================================
// Transforms don't mutate input data
// ============================================================================

describe("transform input immutability", () => {
  it("filter transform does not mutate input data", () => {
    const data = makeData();
    const snapshot = JSON.parse(JSON.stringify(data));

    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 15" },
    ];

    const result = applyTransforms(data, transforms);

    // Input unchanged
    expect(data).toEqual(snapshot);
    // Result is different (filtered)
    expect(result.categories.length).toBeLessThan(data.categories.length);
  });

  it("sort transform does not mutate input data", () => {
    const data = makeData();
    const snapshot = JSON.parse(JSON.stringify(data));

    const transforms: TransformSpec[] = [
      { type: "sort", field: "Sales", order: "desc" },
    ];

    applyTransforms(data, transforms);
    expect(data).toEqual(snapshot);
  });

  it("aggregate transform does not mutate input data", () => {
    const data: ParsedChartData = {
      categories: ["X", "X", "Y", "Y"],
      series: [{ name: "Val", values: [1, 2, 3, 4], color: null }],
    };
    const snapshot = JSON.parse(JSON.stringify(data));

    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Val", as: "Total" },
    ];

    applyTransforms(data, transforms);
    expect(data).toEqual(snapshot);
  });

  it("window transform does not mutate input data", () => {
    const data = makeData();
    const snapshot = JSON.parse(JSON.stringify(data));

    const transforms: TransformSpec[] = [
      { type: "window", op: "running_sum", field: "Sales", as: "RunningTotal" },
    ];

    applyTransforms(data, transforms);
    expect(data).toEqual(snapshot);
  });

  it("calculate transform does not mutate input data", () => {
    const data = makeData();
    const snapshot = JSON.parse(JSON.stringify(data));

    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Sales - Cost", as: "Profit" },
    ];

    applyTransforms(data, transforms);
    expect(data).toEqual(snapshot);
  });

  it("frozen input data does not cause errors", () => {
    const data: ParsedChartData = Object.freeze({
      categories: Object.freeze(["A", "B", "C"]),
      series: Object.freeze([
        Object.freeze({ name: "S1", values: Object.freeze([1, 2, 3]), color: "#000" }),
      ]),
    }) as ParsedChartData;

    const transforms: TransformSpec[] = [
      { type: "filter", field: "S1", predicate: "> 1" },
    ];

    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(["B", "C"]);
  });
});

// ============================================================================
// Filter produces new arrays, not views of original
// ============================================================================

describe("filter produces independent arrays", () => {
  it("applyChartFilters returns new arrays, not slices of original", () => {
    const data = makeData();
    const filters: ChartFilters = {
      hiddenSeries: [1],
      hiddenCategories: [0, 3],
    };

    const result = applyChartFilters(data, filters);

    // Result arrays are different objects
    expect(result.categories).not.toBe(data.categories);
    expect(result.series).not.toBe(data.series);

    // Result has filtered content
    expect(result.categories).toEqual(["B", "C"]);
    expect(result.series.length).toBe(1);
    expect(result.series[0].name).toBe("Sales");
    expect(result.series[0].values).toEqual([20, 30]);

    // Original data unchanged
    expect(data.categories).toEqual(["A", "B", "C", "D"]);
    expect(data.series.length).toBe(2);
  });

  it("mutating filtered result does not affect original", () => {
    const data = makeData();
    const filters: ChartFilters = {
      hiddenSeries: [],
      hiddenCategories: [0],
    };

    const result = applyChartFilters(data, filters);
    result.categories.push("Z");
    result.series[0].values.push(999);

    expect(data.categories).toEqual(["A", "B", "C", "D"]);
    expect(data.series[0].values).toEqual([10, 20, 30, 40]);
  });

  it("applying no filters returns the original object (optimization)", () => {
    const data = makeData();
    const result = applyChartFilters(data, undefined);
    expect(result).toBe(data);
  });
});

// ============================================================================
// Theme merge doesn't modify DEFAULT_CHART_THEME
// ============================================================================

describe("theme merge immutability", () => {
  it("mergeTheme does not modify DEFAULT_CHART_THEME", () => {
    const snapshot = { ...DEFAULT_CHART_THEME };

    mergeTheme(DEFAULT_CHART_THEME, {
      background: "#000000",
      titleFontSize: 24,
      barGap: 10,
    });

    expect(DEFAULT_CHART_THEME).toEqual(snapshot);
  });

  it("resolveChartTheme does not modify DEFAULT_CHART_THEME", () => {
    const snapshot = { ...DEFAULT_CHART_THEME };

    resolveChartTheme({
      theme: {
        background: "#FF0000",
        gridLineColor: "#000000",
      },
    });

    expect(DEFAULT_CHART_THEME).toEqual(snapshot);
  });

  it("mergeTheme returns a new object, not the base", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, { background: "#123456" });
    expect(result).not.toBe(DEFAULT_CHART_THEME);
    expect(result.background).toBe("#123456");
    expect(DEFAULT_CHART_THEME.background).toBe("#ffffff");
  });
});

// ============================================================================
// Multiple resolveChartTheme calls with same input produce equal output
// ============================================================================

describe("resolveChartTheme determinism", () => {
  it("multiple calls with same input produce deeply equal output", () => {
    const config = {
      theme: {
        background: "#222222",
        titleFontSize: 18,
        barBorderRadius: 4,
      },
    };

    const result1 = resolveChartTheme(config);
    const result2 = resolveChartTheme(config);

    expect(result1).toEqual(result2);
    // But they should be separate objects
    expect(result1).not.toBe(result2);
  });

  it("calling with undefined produces the default theme values", () => {
    const result1 = resolveChartTheme(undefined);
    const result2 = resolveChartTheme(undefined);

    expect(result1).toEqual(DEFAULT_CHART_THEME);
    expect(result2).toEqual(DEFAULT_CHART_THEME);
  });

  it("calling with empty theme produces default theme values", () => {
    const result = resolveChartTheme({ theme: {} });
    expect(result).toEqual(DEFAULT_CHART_THEME);
  });
});
