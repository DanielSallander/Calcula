//! FILENAME: app/extensions/Charts/lib/__tests__/chart-performance.test.ts
// PURPOSE: Performance regression tests for chart data processing at scale.
// CONTEXT: Ensures chart pipelines remain responsive with large datasets.

import { describe, it, expect } from "vitest";
import { applyChartFilters } from "../chartFilters";
import { computeTrendline } from "../trendlineComputation";
import { applyTransforms } from "../chartTransforms";
import { computeBarRects } from "../../rendering/barChartPainter";
import { DEFAULT_CHART_THEME } from "../../rendering/chartTheme";
import type {
  ParsedChartData,
  ChartFilters,
  TrendlineSpec,
  TransformSpec,
  ChartSpec,
  ChartLayout,
} from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeLargeData(categoryCount: number, seriesCount: number): ParsedChartData {
  const categories: string[] = [];
  for (let i = 0; i < categoryCount; i++) {
    categories.push(`Cat${i}`);
  }
  const series = [];
  for (let s = 0; s < seriesCount; s++) {
    const values: number[] = [];
    for (let i = 0; i < categoryCount; i++) {
      values.push(Math.sin(i * 0.1 + s) * 100 + 200);
    }
    series.push({ name: `Series${s}`, values, color: null });
  }
  return { categories, series };
}

function makeMinimalSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 10, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...overrides,
  };
}

function makeLayout(width = 800, height = 600): ChartLayout {
  return {
    width,
    height,
    margin: { top: 40, right: 20, bottom: 50, left: 60 },
    plotArea: { x: 60, y: 40, width: width - 80, height: height - 90 },
  };
}

// ============================================================================
// applyChartFilters on 10000 categories
// ============================================================================

describe("performance: applyChartFilters", () => {
  it("filters 10000 categories under 100ms", () => {
    const data = makeLargeData(10_000, 3);
    // Hide every other category
    const hiddenCategories: number[] = [];
    for (let i = 0; i < 10_000; i += 2) {
      hiddenCategories.push(i);
    }
    const filters: ChartFilters = {
      hiddenSeries: [],
      hiddenCategories,
    };

    const start = performance.now();
    applyChartFilters(data, filters);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(300); // 3x headroom
  });
});

// ============================================================================
// Trendline computation on 10000 points
// ============================================================================

describe("performance: computeTrendline", () => {
  it("computes linear trendline on 10000 points under 200ms", () => {
    const data = makeLargeData(10_000, 1);
    const spec: TrendlineSpec = { type: "linear", seriesIndex: 0 };

    const start = performance.now();
    computeTrendline(data, spec);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(600); // 3x headroom
  });

  it("computes moving average on 10000 points under 200ms", () => {
    const data = makeLargeData(10_000, 1);
    const spec: TrendlineSpec = { type: "movingAverage", seriesIndex: 0, window: 10 };

    const start = performance.now();
    computeTrendline(data, spec);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(600); // 3x headroom
  });
});

// ============================================================================
// chartTransforms pipeline on 5000 data points
// ============================================================================

describe("performance: applyTransforms", () => {
  it("applies filter + sort transforms on 5000 data points under 300ms", () => {
    const data = makeLargeData(5_000, 3);
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Series0", predicate: "> 150" },
      { type: "sort", field: "Series0", order: "desc" },
    ];

    const start = performance.now();
    applyTransforms(data, transforms);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(900); // 3x headroom
  });
});

// ============================================================================
// computeBarRects with 1000 categories x 10 series
// ============================================================================

describe("performance: computeBarRects", () => {
  it("computes bar rects for 1000 categories x 10 series under 100ms", () => {
    const data = makeLargeData(1_000, 10);
    const spec = makeMinimalSpec();
    const layout = makeLayout();
    const theme = DEFAULT_CHART_THEME;

    const start = performance.now();
    const rects = computeBarRects(data, spec, layout, theme);
    const elapsed = performance.now() - start;

    // Should produce 1000 * 10 = 10000 rects
    expect(rects.length).toBe(10_000);
    expect(elapsed).toBeLessThan(300); // 3x headroom
  });
});
