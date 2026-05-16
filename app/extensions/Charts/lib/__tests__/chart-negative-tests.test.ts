//! FILENAME: app/extensions/Charts/lib/__tests__/chart-negative-tests.test.ts
// PURPOSE: Negative testing for chart transforms, trendlines, filters, and scales.
// CONTEXT: Verifies graceful rejection of wrong types, circular refs, out-of-bound indices, NaN/Infinity.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { applyChartFilters } from "../chartFilters";
import { computeTrendline } from "../trendlineComputation";
import type {
  ParsedChartData,
  TransformSpec,
  CalculateTransform,
  FilterTransform,
  SortTransform,
  AggregateTransform,
  ChartFilters,
  TrendlineSpec,
} from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function emptyData(): ParsedChartData {
  return { categories: [], series: [] };
}

function sampleData(): ParsedChartData {
  return {
    categories: ["A", "B", "C", "D", "E"],
    series: [
      { name: "Sales", values: [10, 20, 30, 40, 50], color: "#ff0000" },
      { name: "Profit", values: [5, 15, 25, 35, 45], color: "#00ff00" },
    ],
  };
}

// ============================================================================
// Transforms with wrong field types
// ============================================================================

describe("applyTransforms - wrong field types", () => {
  it("sort with numeric field name where string expected", () => {
    const data = sampleData();
    const t: SortTransform = { type: "sort", field: 999 as any, order: "asc" };
    // Should not crash even though field is a number
    expect(() => applyTransforms(data, [t])).not.toThrow();
  });

  it("filter with numeric predicate throws TypeError", () => {
    const data = sampleData();
    const t: FilterTransform = {
      type: "filter",
      field: "Sales",
      predicate: 42 as any,
    };
    expect(() => applyTransforms(data, [t])).toThrow(TypeError);
  });

  it("aggregate with null groupBy throws TypeError", () => {
    const data = sampleData();
    const t: AggregateTransform = {
      type: "aggregate",
      groupBy: null as any,
      op: "sum",
      field: "Sales",
    };
    expect(() => applyTransforms(data, [t])).toThrow(TypeError);
  });

  it("calculate with undefined expression throws TypeError", () => {
    const data = sampleData();
    const t: CalculateTransform = {
      type: "calculate",
      as: "NewField",
      expression: undefined as any,
    };
    expect(() => applyTransforms(data, [t])).toThrow(TypeError);
  });
});

// ============================================================================
// Transforms with circular references in calculate
// ============================================================================

describe("applyTransforms - circular/self-referencing calculate", () => {
  it("calculate expression referencing its own output field throws", () => {
    const data = sampleData();
    const t: CalculateTransform = {
      type: "calculate",
      as: "Sales",
      expression: "Sales * 2",
    };
    // Self-reference causes TypeError in evaluateExpression when series lookup fails
    expect(() => applyTransforms(data, [t])).toThrow(TypeError);
  });

  it("two calculate transforms referencing each other throws", () => {
    const data = sampleData();
    const transforms: TransformSpec[] = [
      { type: "calculate", as: "X", expression: "Y * 2" } as CalculateTransform,
      { type: "calculate", as: "Y", expression: "X * 2" } as CalculateTransform,
    ];
    // Y doesn't exist for the first transform, causing TypeError
    expect(() => applyTransforms(data, transforms)).toThrow(TypeError);
  });
});

// ============================================================================
// Trendline - 0 data points, negative polynomial degree
// ============================================================================

describe("computeTrendline - negative tests", () => {
  it("returns null for empty data", () => {
    const data = emptyData();
    const spec: TrendlineSpec = { type: "linear" };
    expect(computeTrendline(data, spec)).toBeNull();
  });

  it("returns null for single data point", () => {
    const data: ParsedChartData = {
      categories: ["A"],
      series: [{ name: "S", values: [10], color: "#000" }],
    };
    const spec: TrendlineSpec = { type: "linear" };
    expect(computeTrendline(data, spec)).toBeNull();
  });

  it("negative polynomial degree throws RangeError", () => {
    const data = sampleData();
    const spec: TrendlineSpec = {
      type: "polynomial",
      polynomialDegree: -3,
    };
    // Negative degree causes invalid array length
    expect(() => computeTrendline(data, spec)).toThrow(RangeError);
  });

  it("handles zero polynomial degree", () => {
    const data = sampleData();
    const spec: TrendlineSpec = {
      type: "polynomial",
      polynomialDegree: 0,
    };
    expect(() => computeTrendline(data, spec)).not.toThrow();
  });

  it("handles NaN seriesIndex", () => {
    const data = sampleData();
    const spec: TrendlineSpec = { type: "linear", seriesIndex: NaN };
    const result = computeTrendline(data, spec);
    // NaN index won't match any series
    expect(result).toBeNull();
  });

  it("handles out-of-bound seriesIndex", () => {
    const data = sampleData();
    const spec: TrendlineSpec = { type: "linear", seriesIndex: 999 };
    expect(computeTrendline(data, spec)).toBeNull();
  });

  it("handles all-NaN values", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "S", values: [NaN, NaN, NaN], color: "#000" }],
    };
    const spec: TrendlineSpec = { type: "linear" };
    // Should not crash; result may be null or have NaN equation
    expect(() => computeTrendline(data, spec)).not.toThrow();
  });
});

// ============================================================================
// Filters - out of bound indices
// ============================================================================

describe("applyChartFilters - negative tests", () => {
  it("hiddenSeries with index -1", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [-1], hiddenCategories: [] };
    const result = applyChartFilters(data, filters);
    // -1 won't match any series index, so all series remain
    expect(result.series.length).toBe(2);
  });

  it("hiddenSeries with index beyond length", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [100], hiddenCategories: [] };
    const result = applyChartFilters(data, filters);
    expect(result.series.length).toBe(2);
  });

  it("hiddenCategories with index -1", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [-1] };
    const result = applyChartFilters(data, filters);
    // -1 won't match, so all categories remain
    expect(result.categories.length).toBe(5);
  });

  it("hiddenCategories with NaN index", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [NaN] };
    const result = applyChartFilters(data, filters);
    expect(result.categories.length).toBe(5);
  });

  it("all series hidden leaves empty", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [0, 1], hiddenCategories: [] };
    const result = applyChartFilters(data, filters);
    expect(result.series.length).toBe(0);
  });
});
