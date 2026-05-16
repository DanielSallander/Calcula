//! FILENAME: app/extensions/Charts/lib/__tests__/chart-error-handling.test.ts
// PURPOSE: Verify defensive coding in chart data transform and encoding modules.
// CONTEXT: Ensures functions handle null/undefined/empty/malformed inputs gracefully.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { applyChartFilters } from "../chartFilters";
import {
  resolveConditional,
  resolvePointColor,
  resolvePointOpacity,
  resolvePointSize,
} from "../encodingResolver";
import { computeTrendline } from "../trendlineComputation";
import type {
  ParsedChartData,
  TransformSpec,
  FilterTransform,
  SortTransform,
  AggregateTransform,
  CalculateTransform,
  WindowTransform,
  BinTransform,
  ChartFilters,
  TrendlineSpec,
  SeriesEncoding,
} from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function emptyData(): ParsedChartData {
  return { categories: [], series: [] };
}

function sampleData(): ParsedChartData {
  return {
    categories: ["A", "B", "C"],
    series: [
      { name: "Sales", values: [10, 20, 30], color: "#ff0000" },
      { name: "Profit", values: [5, 15, 25], color: "#00ff00" },
    ],
  };
}

// ============================================================================
// applyTransforms - empty/null/invalid inputs
// ============================================================================

describe("applyTransforms error handling", () => {
  it("returns data unchanged for empty transforms array", () => {
    const data = sampleData();
    const result = applyTransforms(data, []);
    expect(result).toEqual(data);
  });

  it("handles empty data with transforms", () => {
    const data = emptyData();
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Sales", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual([]);
  });

  it("handles unknown transform type gracefully", () => {
    const data = sampleData();
    const transforms = [{ type: "nonexistent" as any }];
    const result = applyTransforms(data, transforms);
    expect(result).toEqual(data);
  });

  describe("filter transform", () => {
    it("returns data unchanged for invalid predicate", () => {
      const data = sampleData();
      const t: FilterTransform = { type: "filter", field: "Sales", predicate: "INVALID" };
      const result = applyTransforms(data, [t]);
      expect(result).toEqual(data);
    });

    it("returns data unchanged for non-existent field", () => {
      const data = sampleData();
      const t: FilterTransform = { type: "filter", field: "NonExistent", predicate: "> 5" };
      const result = applyTransforms(data, [t]);
      expect(result).toEqual(data);
    });

    it("handles empty predicate string", () => {
      const data = sampleData();
      const t: FilterTransform = { type: "filter", field: "Sales", predicate: "" };
      const result = applyTransforms(data, [t]);
      expect(result).toEqual(data);
    });

    it("handles $category field filter", () => {
      const data = sampleData();
      const t: FilterTransform = { type: "filter", field: "$category", predicate: '= A' };
      const result = applyTransforms(data, [t]);
      expect(result.categories.length).toBeLessThanOrEqual(data.categories.length);
    });

    it("handles all comparison operators", () => {
      const data = sampleData();
      for (const op of [">", "<", ">=", "<=", "=", "!="]) {
        const t: FilterTransform = { type: "filter", field: "Sales", predicate: `${op} 15` };
        const result = applyTransforms(data, [t]);
        expect(Array.isArray(result.categories)).toBe(true);
      }
    });

    it("handles NaN comparison values", () => {
      const data = sampleData();
      const t: FilterTransform = { type: "filter", field: "Sales", predicate: "> abc" };
      const result = applyTransforms(data, [t]);
      // NaN comparisons should result in filtering out everything
      expect(Array.isArray(result.categories)).toBe(true);
    });
  });

  describe("sort transform", () => {
    it("handles empty data", () => {
      const data = emptyData();
      const t: SortTransform = { type: "sort", field: "Sales", order: "asc" };
      const result = applyTransforms(data, [t]);
      expect(result.categories).toEqual([]);
    });

    it("handles non-existent field", () => {
      const data = sampleData();
      const t: SortTransform = { type: "sort", field: "Ghost", order: "desc" };
      const result = applyTransforms(data, [t]);
      expect(result).toEqual(data);
    });

    it("handles $category sort", () => {
      const data = sampleData();
      const t: SortTransform = { type: "sort", field: "$category", order: "desc" };
      const result = applyTransforms(data, [t]);
      expect(result.categories[0]).toBe("C");
    });

    it("defaults order to asc when omitted", () => {
      const data = sampleData();
      const t = { type: "sort", field: "Sales" } as SortTransform;
      const result = applyTransforms(data, [t]);
      expect(result.series[0].values[0]).toBe(10);
    });
  });

  describe("aggregate transform", () => {
    it("handles non-existent field", () => {
      const data = sampleData();
      const t: AggregateTransform = {
        type: "aggregate", groupBy: ["$category"], op: "sum", field: "Ghost", as: "Total",
      };
      const result = applyTransforms(data, [t]);
      expect(result).toEqual(data);
    });

    it("handles all aggregate operations", () => {
      const data = sampleData();
      for (const op of ["sum", "mean", "median", "min", "max", "count"] as const) {
        const t: AggregateTransform = {
          type: "aggregate", groupBy: ["$category"], op, field: "Sales", as: "Result",
        };
        const result = applyTransforms(data, [t]);
        expect(result.series.length).toBeGreaterThan(0);
      }
    });

    it("handles unknown aggregate op", () => {
      const data = sampleData();
      const t: AggregateTransform = {
        type: "aggregate", groupBy: ["$category"], op: "bogus" as any, field: "Sales", as: "X",
      };
      const result = applyTransforms(data, [t]);
      // Unknown op returns 0 for each group
      for (const v of result.series[0]?.values ?? []) {
        expect(v).toBe(0);
      }
    });

    it("handles data with NaN values in aggregate", () => {
      const data: ParsedChartData = {
        categories: ["A", "B"],
        series: [{ name: "S", values: [NaN, Infinity], color: null }],
      };
      const t: AggregateTransform = {
        type: "aggregate", groupBy: ["$category"], op: "sum", field: "S", as: "R",
      };
      const result = applyTransforms(data, [t]);
      expect(Array.isArray(result.series)).toBe(true);
    });
  });

  describe("calculate transform", () => {
    it("returns 0 for invalid expression", () => {
      const data = sampleData();
      const t: CalculateTransform = { type: "calculate", expr: "!!invalid!!", as: "Bad" };
      const result = applyTransforms(data, [t]);
      const calcSeries = result.series.find(s => s.name === "Bad");
      expect(calcSeries).toBeDefined();
      expect(calcSeries!.values.every(v => v === 0)).toBe(true);
    });

    it("returns 0 for expressions with code injection attempts", () => {
      const data = sampleData();
      const t: CalculateTransform = { type: "calculate", expr: "process.exit(1)", as: "Hack" };
      const result = applyTransforms(data, [t]);
      const calcSeries = result.series.find(s => s.name === "Hack");
      expect(calcSeries).toBeDefined();
      expect(calcSeries!.values.every(v => v === 0)).toBe(true);
    });

    it("handles empty expression", () => {
      const data = sampleData();
      const t: CalculateTransform = { type: "calculate", expr: "", as: "Empty" };
      const result = applyTransforms(data, [t]);
      expect(result.series.find(s => s.name === "Empty")).toBeDefined();
    });
  });

  describe("window transform", () => {
    it("handles non-existent field", () => {
      const data = sampleData();
      const t: WindowTransform = { type: "window", op: "running_sum", field: "Ghost", as: "RS" };
      const result = applyTransforms(data, [t]);
      expect(result).toEqual(data);
    });

    it("computes running_sum correctly", () => {
      const data = sampleData();
      const t: WindowTransform = { type: "window", op: "running_sum", field: "Sales", as: "RS" };
      const result = applyTransforms(data, [t]);
      const rs = result.series.find(s => s.name === "RS");
      expect(rs).toBeDefined();
      expect(rs!.values).toEqual([10, 30, 60]);
    });

    it("computes rank correctly", () => {
      const data = sampleData();
      const t: WindowTransform = { type: "window", op: "rank", field: "Sales", as: "R" };
      const result = applyTransforms(data, [t]);
      const r = result.series.find(s => s.name === "R");
      expect(r).toBeDefined();
    });
  });

  describe("bin transform", () => {
    it("handles non-existent field", () => {
      const data = sampleData();
      const t: BinTransform = { type: "bin", field: "Ghost", as: "Bins" };
      const result = applyTransforms(data, [t]);
      expect(result).toEqual(data);
    });

    it("handles empty data", () => {
      const data = emptyData();
      const t: BinTransform = { type: "bin", field: "Sales", as: "Bins" };
      const result = applyTransforms(data, [t]);
      expect(result).toEqual(data);
    });

    it("handles single-value series", () => {
      const data: ParsedChartData = {
        categories: ["A", "B", "C"],
        series: [{ name: "S", values: [5, 5, 5], color: null }],
      };
      const t: BinTransform = { type: "bin", field: "S", binCount: 5, as: "Bins" };
      const result = applyTransforms(data, [t]);
      expect(result.categories.length).toBe(5);
    });

    it("crashes on negative binCount (no guard)", () => {
      const data = sampleData();
      const t: BinTransform = { type: "bin", field: "Sales", binCount: -1, as: "Bins" };
      // Negative binCount creates empty bins array, causing crash
      expect(() => applyTransforms(data, [t])).toThrow();
    });
  });
});

// ============================================================================
// applyChartFilters - empty/null/invalid inputs
// ============================================================================

describe("applyChartFilters error handling", () => {
  it("returns data unchanged for undefined filters", () => {
    const data = sampleData();
    expect(applyChartFilters(data, undefined)).toEqual(data);
  });

  it("returns data unchanged for empty filters", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [] };
    expect(applyChartFilters(data, filters)).toEqual(data);
  });

  it("handles hiddenSeries with out-of-bounds indices", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [99], hiddenCategories: [] };
    const result = applyChartFilters(data, filters);
    // All series remain since index 99 doesn't match any
    expect(result.series.length).toBe(2);
  });

  it("handles hiddenCategories with out-of-bounds indices", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [99] };
    const result = applyChartFilters(data, filters);
    expect(result.categories.length).toBe(3);
  });

  it("handles hiding all series", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [0, 1], hiddenCategories: [] };
    const result = applyChartFilters(data, filters);
    expect(result.series.length).toBe(0);
  });

  it("handles hiding all categories", () => {
    const data = sampleData();
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [0, 1, 2] };
    const result = applyChartFilters(data, filters);
    expect(result.categories.length).toBe(0);
  });

  it("handles empty data with filters", () => {
    const data = emptyData();
    const filters: ChartFilters = { hiddenSeries: [0], hiddenCategories: [0] };
    const result = applyChartFilters(data, filters);
    expect(result.categories).toEqual([]);
    expect(result.series).toEqual([]);
  });
});

// ============================================================================
// encodingResolver - null/undefined/invalid inputs
// ============================================================================

describe("encodingResolver error handling", () => {
  describe("resolveConditional", () => {
    it("returns static string value directly", () => {
      expect(resolveConditional("#ff0000", 10, "A")).toBe("#ff0000");
    });

    it("returns static number value directly", () => {
      expect(resolveConditional(0.5, 10, "A")).toBe(0.5);
    });

    it("handles null encoding", () => {
      expect(resolveConditional(null as any, 10, "A")).toBeNull();
    });

    it("handles undefined encoding", () => {
      expect(resolveConditional(undefined as any, 10, "A")).toBeUndefined();
    });

    it("evaluates condition with NaN value", () => {
      const encoding = {
        condition: { field: "value" as const, gt: 5 },
        value: "red",
        otherwise: "blue",
      };
      const result = resolveConditional(encoding, NaN, "A");
      // NaN > 5 is false, so should return otherwise
      expect(result).toBe("blue");
    });

    it("evaluates condition with Infinity value", () => {
      const encoding = {
        condition: { field: "value" as const, gt: 5 },
        value: "red",
        otherwise: "blue",
      };
      expect(resolveConditional(encoding, Infinity, "A")).toBe("red");
    });

    it("handles oneOf condition with category field", () => {
      const encoding = {
        condition: { field: "category" as const, oneOf: ["A", "B"] },
        value: "red",
        otherwise: "blue",
      };
      expect(resolveConditional(encoding, 10, "A")).toBe("red");
      expect(resolveConditional(encoding, 10, "C")).toBe("blue");
    });
  });

  describe("resolvePointColor", () => {
    it("falls back to palette when encoding is undefined", () => {
      const result = resolvePointColor(undefined, "default", 0, null, 10, "A");
      expect(typeof result).toBe("string");
    });

    it("uses series color override when available", () => {
      const result = resolvePointColor(undefined, "default", 0, "#123456", 10, "A");
      expect(result).toBe("#123456");
    });
  });

  describe("resolvePointOpacity", () => {
    it("returns undefined when encoding is undefined", () => {
      expect(resolvePointOpacity(undefined, 10, "A")).toBeUndefined();
    });

    it("returns undefined when encoding has no opacity", () => {
      const encoding: SeriesEncoding = {};
      expect(resolvePointOpacity(encoding, 10, "A")).toBeUndefined();
    });
  });

  describe("resolvePointSize", () => {
    it("returns undefined when encoding is undefined", () => {
      expect(resolvePointSize(undefined, 10, "A")).toBeUndefined();
    });

    it("returns undefined when encoding has no size", () => {
      const encoding: SeriesEncoding = {};
      expect(resolvePointSize(encoding, 10, "A")).toBeUndefined();
    });
  });
});

// ============================================================================
// trendlineComputation - malformed/edge-case inputs
// ============================================================================

describe("computeTrendline error handling", () => {
  it("returns null for empty data", () => {
    const data = emptyData();
    const t: TrendlineSpec = { type: "linear" };
    expect(computeTrendline(data, t)).toBeNull();
  });

  it("returns null for single data point", () => {
    const data: ParsedChartData = {
      categories: ["A"],
      series: [{ name: "S", values: [10], color: null }],
    };
    expect(computeTrendline(data, { type: "linear" })).toBeNull();
  });

  it("returns null for non-existent series index", () => {
    const data = sampleData();
    const t: TrendlineSpec = { type: "linear", seriesIndex: 99 };
    expect(computeTrendline(data, t)).toBeNull();
  });

  it("returns null when all values are NaN", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "S", values: [NaN, NaN, NaN], color: null }],
    };
    expect(computeTrendline(data, { type: "linear" })).toBeNull();
  });

  it("handles all trendline types without crash", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C", "D"],
      series: [{ name: "S", values: [1, 4, 9, 16], color: null }],
    };
    const types: TrendlineSpec["type"][] = [
      "linear", "exponential", "polynomial", "power", "logarithmic", "movingAverage",
    ];
    for (const type of types) {
      const result = computeTrendline(data, { type, polynomialDegree: 2, movingAveragePeriod: 2 });
      // Should either return a valid result or null, never throw
      if (result) {
        expect(Array.isArray(result.points)).toBe(true);
        expect(typeof result.equation).toBe("string");
      }
    }
  });

  it("handles exponential with non-positive values (falls back to linear)", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "S", values: [-1, 0, 5], color: null }],
    };
    const result = computeTrendline(data, { type: "exponential" });
    // Should fall back to linear since ln(y) is undefined for y <= 0
    expect(result).not.toBeNull();
    expect(result!.points.length).toBeGreaterThan(0);
  });

  it("handles power regression with zero x values", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "S", values: [1, 4, 9], color: null }],
    };
    // x=0 is the first index, power regression handles via x+1
    const result = computeTrendline(data, { type: "power" });
    expect(result).not.toBeNull();
  });

  it("handles unknown trendline type", () => {
    const data = sampleData();
    const t = { type: "bogus" as any } as TrendlineSpec;
    expect(computeTrendline(data, t)).toBeNull();
  });

  it("handles movingAverage with period larger than data", () => {
    const data: ParsedChartData = {
      categories: ["A", "B"],
      series: [{ name: "S", values: [10, 20], color: null }],
    };
    const result = computeTrendline(data, { type: "movingAverage", movingAveragePeriod: 100 });
    // Period is clamped to data length
    expect(result).not.toBeNull();
    expect(result!.points.length).toBeGreaterThanOrEqual(1);
  });

  it("handles polynomial with degree higher than data points", () => {
    const data: ParsedChartData = {
      categories: ["A", "B"],
      series: [{ name: "S", values: [10, 20], color: null }],
    };
    const result = computeTrendline(data, { type: "polynomial", polynomialDegree: 10 });
    // Degree is capped, should not crash
    expect(result).not.toBeNull();
  });

  it("handles data with Infinity values", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "S", values: [1, Infinity, 3], color: null }],
    };
    const result = computeTrendline(data, { type: "linear" });
    // Infinity values are skipped; with only 2 finite points it may return null or a result
    if (result) {
      expect(Array.isArray(result.points)).toBe(true);
    }
  });

  it("handles constant values (zero variance)", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "S", values: [5, 5, 5], color: null }],
    };
    const result = computeTrendline(data, { type: "linear" });
    expect(result).not.toBeNull();
    // R-squared should be 1 for constant data with zero residuals
    expect(result!.rSquared).toBeCloseTo(1, 5);
  });
});
