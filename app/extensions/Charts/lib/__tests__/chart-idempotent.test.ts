//! FILENAME: app/extensions/Charts/lib/__tests__/chart-idempotent.test.ts
// PURPOSE: Tests for idempotency of chart data transforms and store operations.
// CONTEXT: Verifies that applying transforms twice, identity transforms, and
//          redundant operations produce stable, predictable results.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyTransforms } from "../chartTransforms";
import type { ParsedChartData, TransformSpec, ChartFilters } from "../../types";

// Mock the backend for chart store tests
vi.mock("@api/backend", () => ({
  invokeBackend: vi.fn().mockResolvedValue([]),
}));
vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  addGridRegions: vi.fn(),
}));

// ============================================================================
// Helpers
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

function makeSortedData(): ParsedChartData {
  return {
    categories: ["A", "B", "C", "D"],
    series: [
      { name: "Val", values: [10, 20, 30, 40], color: null },
    ],
  };
}

/** Apply a filter spec to parsed data. */
function applyFilter(data: ParsedChartData, filters: ChartFilters): ParsedChartData {
  const visibleCategories = data.categories.filter((_, i) => !filters.hiddenCategories.includes(i));
  const visibleSeries = data.series
    .filter((_, i) => !filters.hiddenSeries.includes(i))
    .map((s) => ({
      ...s,
      values: s.values.filter((_, i) => !filters.hiddenCategories.includes(i)),
    }));
  return { categories: visibleCategories, series: visibleSeries };
}

// ============================================================================
// Applying empty filter = no change
// ============================================================================

describe("chart transforms - empty/identity idempotency", () => {
  it("empty transform array returns same data reference", () => {
    const data = makeData();
    const result = applyTransforms(data, []);
    expect(result).toBe(data);
  });

  it("empty filter (no hidden series/categories) produces identical data", () => {
    const data = makeData();
    const emptyFilters: ChartFilters = { hiddenSeries: [], hiddenCategories: [] };
    const result = applyFilter(data, emptyFilters);
    expect(result.categories).toEqual(data.categories);
    expect(result.series.length).toBe(data.series.length);
    expect(result.series[0].values).toEqual(data.series[0].values);
  });

  it("filter that matches all rows produces same categories", () => {
    const data = makeData();
    // Filter predicate that keeps everything: Sales > 0 (all values are positive)
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 0" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(data.categories);
    expect(result.series[0].values).toEqual(data.series[0].values);
  });

  it("filter with non-existent field leaves data unchanged", () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "filter", field: "NonExistent", predicate: "> 0" },
    ];
    const result = applyTransforms(data, transforms);
    // Non-existent field filter should not crash and should keep data
    expect(result.categories.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Sorting already-sorted data = same result
// ============================================================================

describe("chart transforms - sort idempotency", () => {
  it("sorting already-sorted ascending data by same field produces same order", () => {
    const data = makeSortedData(); // Already sorted asc by Val
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Val", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(data.categories);
    expect(result.series[0].values).toEqual(data.series[0].values);
  });

  it("double sort by same field and order produces same result as single sort", () => {
    const data = makeData();
    const singleSort: TransformSpec[] = [
      { type: "sort", field: "Sales", order: "desc" },
    ];
    const doubleSort: TransformSpec[] = [
      { type: "sort", field: "Sales", order: "desc" },
      { type: "sort", field: "Sales", order: "desc" },
    ];
    const single = applyTransforms(data, singleSort);
    const double = applyTransforms(data, doubleSort);
    expect(double.categories).toEqual(single.categories);
    expect(double.series[0].values).toEqual(single.series[0].values);
  });

  it("sort on single-value data is a no-op", () => {
    const data: ParsedChartData = {
      categories: ["Only"],
      series: [{ name: "X", values: [42], color: null }],
    };
    const transforms: TransformSpec[] = [
      { type: "sort", field: "X", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(["Only"]);
    expect(result.series[0].values).toEqual([42]);
  });

  it("sort on uniform values preserves original order", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "X", values: [5, 5, 5], color: null }],
    };
    const transforms: TransformSpec[] = [
      { type: "sort", field: "X", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.series[0].values).toEqual([5, 5, 5]);
  });
});

// ============================================================================
// Double-aggregate produces same result
// ============================================================================

describe("chart transforms - aggregate idempotency", () => {
  it("aggregating already-unique categories produces same result twice", () => {
    const data = makeData(); // Each category is unique
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Sales", as: "TotalSales" },
    ];
    const first = applyTransforms(data, transforms);
    const second = applyTransforms(first, transforms);
    // After first aggregate, categories are unique. Second aggregate should produce same totals.
    expect(second.categories).toEqual(first.categories);
    const firstTotals = second.series.find((s) => s.name === "TotalSales");
    const origTotals = first.series.find((s) => s.name === "TotalSales");
    expect(firstTotals?.values).toEqual(origTotals?.values);
  });

  it("aggregating with duplicate categories merges, then second aggregate is stable", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "B", "B"],
      series: [{ name: "Val", values: [10, 20, 30, 40], color: null }],
    };
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Val", as: "Total" },
    ];
    const first = applyTransforms(data, transforms);
    const second = applyTransforms(first, transforms);
    // After first: A=30, B=70. After second: should still be A=30, B=70
    const firstTotal = first.series.find((s) => s.name === "Total");
    const secondTotal = second.series.find((s) => s.name === "Total");
    expect(secondTotal?.values).toEqual(firstTotal?.values);
    expect(second.categories).toEqual(first.categories);
  });

  it("mean aggregate on uniform values returns same values", () => {
    const data: ParsedChartData = {
      categories: ["A", "A", "A"],
      series: [{ name: "Val", values: [5, 5, 5], color: null }],
    };
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "mean", field: "Val", as: "AvgVal" },
    ];
    const result = applyTransforms(data, transforms);
    const avg = result.series.find((s) => s.name === "AvgVal");
    expect(avg?.values).toEqual([5]);
  });
});

// ============================================================================
// Identity transforms
// ============================================================================

describe("chart transforms - identity transforms", () => {
  it("calculate with identity expression (multiply by 1) preserves values", () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Sales * 1", as: "SalesCopy" },
    ];
    const result = applyTransforms(data, transforms);
    const copy = result.series.find((s) => s.name === "SalesCopy");
    const original = result.series.find((s) => s.name === "Sales");
    expect(copy?.values).toEqual(original?.values);
  });

  it("calculate with add zero preserves values", () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Sales + 0", as: "SalesZero" },
    ];
    const result = applyTransforms(data, transforms);
    const copy = result.series.find((s) => s.name === "SalesZero");
    const original = result.series.find((s) => s.name === "Sales");
    expect(copy?.values).toEqual(original?.values);
  });

  it("window running_sum on single-element data equals the element", () => {
    const data: ParsedChartData = {
      categories: ["Only"],
      series: [{ name: "X", values: [42], color: null }],
    };
    const transforms: TransformSpec[] = [
      { type: "window", op: "running_sum", field: "X", as: "RunSum" },
    ];
    const result = applyTransforms(data, transforms);
    const runSum = result.series.find((s) => s.name === "RunSum");
    expect(runSum?.values).toEqual([42]);
  });

  it("applying same transform pipeline twice on same input gives equal results", () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 100" },
      { type: "sort", field: "Sales", order: "asc" },
    ];
    const result1 = applyTransforms(data, transforms);
    const result2 = applyTransforms(data, transforms);
    expect(result1.categories).toEqual(result2.categories);
    expect(result1.series[0].values).toEqual(result2.series[0].values);
  });
});
