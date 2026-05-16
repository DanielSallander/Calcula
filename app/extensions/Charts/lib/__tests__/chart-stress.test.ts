//! FILENAME: app/extensions/Charts/lib/__tests__/chart-stress.test.ts
// PURPOSE: Stress tests for chart data processing under extreme load.
// CONTEXT: Verifies transform pipeline, filters, trendlines, and theme resolution
//          handle large datasets and high-volume operations without timeouts or errors.

import { describe, it, expect } from "vitest";
import { applyChartFilters } from "../chartFilters";
import { computeTrendline } from "../trendlineComputation";
import { applyTransforms } from "../chartTransforms";
import {
  DEFAULT_CHART_THEME,
  mergeTheme,
  resolveChartTheme,
  PALETTES,
} from "../../rendering/chartTheme";
import type {
  ParsedChartData,
  ChartFilters,
  TrendlineSpec,
  TransformSpec,
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

// ============================================================================
// 1. Transform pipeline with 100K data points
// ============================================================================

describe("stress: transform pipeline with 100K data points", () => {
  it("processes 100K points (1000 categories x 100 series) without timeout", () => {
    const data = makeLargeData(1000, 100);
    // Total data points: 1000 * 100 = 100K
    expect(data.series.length).toBe(100);
    expect(data.series[0].values.length).toBe(1000);

    const transforms: TransformSpec[] = [
      { type: "sort", field: "Series0", order: "desc" },
    ];

    const start = performance.now();
    const result = applyTransforms(data, transforms);
    const elapsed = performance.now() - start;

    expect(result.categories.length).toBe(1000);
    expect(result.series.length).toBe(100);
    // Should complete in a reasonable time (under 5 seconds even on slow CI)
    expect(elapsed).toBeLessThan(5000);
  });

  it("identity transform on 100K points returns same data", () => {
    const data = makeLargeData(1000, 100);
    const result = applyTransforms(data, []);
    expect(result).toBe(data);
  });
});

// ============================================================================
// 2. 50 series with 1000 categories each
// ============================================================================

describe("stress: 50 series x 1000 categories", () => {
  it("all series maintain correct values after sort transform", () => {
    const data = makeLargeData(1000, 50);
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Series0", order: "asc" },
    ];
    const result = applyTransforms(data, transforms);

    // Verify sorted on Series0
    const s0 = result.series[0].values;
    for (let i = 1; i < s0.length; i++) {
      expect(s0[i]).toBeGreaterThanOrEqual(s0[i - 1]);
    }
    // All 50 series still present
    expect(result.series.length).toBe(50);
  });

  it("category count preserved across all 50 series", () => {
    const data = makeLargeData(1000, 50);
    for (const s of data.series) {
      expect(s.values.length).toBe(1000);
    }
  });
});

// ============================================================================
// 3. Aggregate reducing 100K points to 100 groups
// ============================================================================

describe("stress: aggregate 100K points to 100 groups", () => {
  it("aggregate sum on 10K categories with repeating group names", () => {
    // Create data with repeating category names to enable aggregation
    const categoryCount = 10_000;
    const groupCount = 100;
    const categories: string[] = [];
    for (let i = 0; i < categoryCount; i++) {
      categories.push(`Group${i % groupCount}`);
    }
    const values: number[] = [];
    for (let i = 0; i < categoryCount; i++) {
      values.push(1);
    }
    const data: ParsedChartData = {
      categories,
      series: [{ name: "Count", values, color: null }],
    };

    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Count" },
    ];

    const start = performance.now();
    const result = applyTransforms(data, transforms);
    const elapsed = performance.now() - start;

    // Aggregation groups duplicate category names
    expect(result.categories.length).toBe(groupCount);
    expect(elapsed).toBeLessThan(5000);
    // Each group should have summed 100 entries of value 1
    for (const v of result.series[0].values) {
      expect(v).toBe(categoryCount / groupCount);
    }
  });
});

// ============================================================================
// 4. Running sum on 50K points
// ============================================================================

describe("stress: running sum on 50K points", () => {
  it("computes running sum across 50K categories", () => {
    const data = makeLargeData(50_000, 1);
    const transforms: TransformSpec[] = [
      { type: "window", op: "running_sum", field: "Series0" },
    ];

    const start = performance.now();
    const result = applyTransforms(data, transforms);
    const elapsed = performance.now() - start;

    // Window transform adds a new series for the running sum
    expect(result.series.length).toBeGreaterThanOrEqual(1);
    // The last series should be the running sum (or original is replaced)
    const lastSeries = result.series[result.series.length - 1];
    expect(lastSeries.values.length).toBe(50_000);
    // Running sum should be monotonically non-decreasing (since all values are positive)
    for (let i = 1; i < Math.min(100, lastSeries.values.length); i++) {
      expect(lastSeries.values[i]).toBeGreaterThanOrEqual(lastSeries.values[i - 1]);
    }
    expect(elapsed).toBeLessThan(5000);
  });
});

// ============================================================================
// 5. Filter removing 99% of data
// ============================================================================

describe("stress: filter removing 99% of data", () => {
  it("filters 99% of 10K categories via hiddenCategories", () => {
    const data = makeLargeData(10_000, 5);
    const hidden: number[] = [];
    // Hide 99% (indices 0-9899)
    for (let i = 0; i < 9_900; i++) {
      hidden.push(i);
    }
    const filters: ChartFilters = {
      hiddenSeries: [],
      hiddenCategories: hidden,
    };

    const start = performance.now();
    const result = applyChartFilters(data, filters);
    const elapsed = performance.now() - start;

    expect(result.categories.length).toBe(100);
    expect(result.series.length).toBe(5);
    for (const s of result.series) {
      expect(s.values.length).toBe(100);
    }
    expect(elapsed).toBeLessThan(2000);
  });

  it("filters 99% of series (hide 49 of 50)", () => {
    const data = makeLargeData(100, 50);
    const hidden: number[] = [];
    for (let i = 0; i < 49; i++) {
      hidden.push(i);
    }
    const filters: ChartFilters = {
      hiddenSeries: hidden,
      hiddenCategories: [],
    };

    const result = applyChartFilters(data, filters);
    expect(result.series.length).toBe(1);
    expect(result.series[0].name).toBe("Series49");
    expect(result.categories.length).toBe(100);
  });

  it("filter predicate transform removing 99% via > threshold", () => {
    // Series values are sin*100+200, range ~100-300
    // Filter > 299 should remove almost everything
    const data = makeLargeData(10_000, 1);
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Series0", predicate: "> 299" },
    ];

    const result = applyTransforms(data, transforms);
    // Very few points should survive
    expect(result.categories.length).toBeLessThan(1000);
  });
});

// ============================================================================
// 6. Trendline on 50K points
// ============================================================================

describe("stress: trendline on 50K points", () => {
  it("computes linear trendline on 50K data points", () => {
    const data = makeLargeData(50_000, 1);
    const trendline: TrendlineSpec = {
      type: "linear",
      seriesIndex: 0,
    };

    const start = performance.now();
    const result = computeTrendline(data, trendline);
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(result!.points.length).toBe(50_000);
    expect(result!.equation).toContain("y =");
    expect(result!.rSquared).toBeGreaterThanOrEqual(0);
    expect(result!.rSquared).toBeLessThanOrEqual(1);
    expect(elapsed).toBeLessThan(5000);
  });

  it("computes moving average trendline on 50K points", () => {
    const data = makeLargeData(50_000, 1);
    const trendline: TrendlineSpec = {
      type: "movingAverage",
      seriesIndex: 0,
      period: 10,
    };

    const start = performance.now();
    const result = computeTrendline(data, trendline);
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(result!.points.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });
});

// ============================================================================
// 7. 100 chart filters applied simultaneously
// ============================================================================

describe("stress: 100 chart filters applied simultaneously", () => {
  it("hides 100 specific categories from 200-category dataset", () => {
    const data = makeLargeData(200, 3);
    const hidden: number[] = [];
    for (let i = 0; i < 100; i++) {
      hidden.push(i * 2); // Hide even indices
    }
    const filters: ChartFilters = {
      hiddenSeries: [],
      hiddenCategories: hidden,
    };

    const result = applyChartFilters(data, filters);
    expect(result.categories.length).toBe(100);
    // All remaining should be odd-indexed originals
    for (const cat of result.categories) {
      const idx = parseInt(cat.replace("Cat", ""));
      expect(idx % 2).toBe(1);
    }
  });

  it("applies filter transform 100 times in sequence", () => {
    // Build a pipeline of 100 filter transforms (each is a no-op if field missing)
    const data = makeLargeData(1000, 1);
    // Use a single real filter that progressively narrows
    const transforms: TransformSpec[] = [];
    for (let i = 0; i < 100; i++) {
      transforms.push({
        type: "filter",
        field: "Series0",
        predicate: `< 400`, // Keep most data each time (values ~100-300)
      });
    }

    const start = performance.now();
    const result = applyTransforms(data, transforms);
    const elapsed = performance.now() - start;

    // All 100 filters should complete
    expect(result.categories.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });

  it("combined series + category filters on large dataset", () => {
    const data = makeLargeData(500, 20);
    const hiddenSeries: number[] = [];
    for (let i = 0; i < 15; i++) hiddenSeries.push(i);
    const hiddenCategories: number[] = [];
    for (let i = 0; i < 400; i++) hiddenCategories.push(i);

    const filters: ChartFilters = { hiddenSeries, hiddenCategories };
    const result = applyChartFilters(data, filters);

    expect(result.series.length).toBe(5);
    expect(result.categories.length).toBe(100);
    for (const s of result.series) {
      expect(s.values.length).toBe(100);
    }
  });
});

// ============================================================================
// 8. Theme resolution called 10K times
// ============================================================================

describe("stress: theme resolution 10K times", () => {
  it("resolveChartTheme 10K times produces consistent results", () => {
    const start = performance.now();
    let lastTheme = resolveChartTheme(undefined);

    for (let i = 0; i < 10_000; i++) {
      const theme = resolveChartTheme(undefined);
      expect(theme.background).toBe(lastTheme.background);
      lastTheme = theme;
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("mergeTheme 10K times with varying overrides", () => {
    const overrides = [
      { background: "#111" },
      { gridLineColor: "#222", titleColor: "#333" },
      { barBorderRadius: 5, barGap: 3 },
      { labelFontSize: 12, titleFontSize: 16 },
      {},
    ];

    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const o = overrides[i % overrides.length];
      const theme = mergeTheme(DEFAULT_CHART_THEME, o);
      expect(theme.fontFamily).toBe(DEFAULT_CHART_THEME.fontFamily);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("resolveChartTheme with deep overrides 10K times", () => {
    const configs = [];
    for (let i = 0; i < 100; i++) {
      configs.push({
        theme: {
          background: `#${String(i).padStart(6, "0")}`,
          plotBackground: `#${String(i + 100).padStart(6, "0")}`,
          gridLineWidth: i % 3 + 1,
        },
      });
    }

    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const theme = resolveChartTheme(configs[i % 100]);
      expect(theme.axisColor).toBe(DEFAULT_CHART_THEME.axisColor);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("palette access 10K times", () => {
    const paletteNames = Object.keys(PALETTES);
    expect(paletteNames.length).toBeGreaterThan(0);

    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const name = paletteNames[i % paletteNames.length];
      const colors = PALETTES[name];
      expect(colors.length).toBeGreaterThan(0);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});
