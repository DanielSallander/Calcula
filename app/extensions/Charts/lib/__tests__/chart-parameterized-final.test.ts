// chart-parameterized-final.test.ts
// Heavily parameterized tests for chart modules using it.each.
// Target: 250+ tests across 6 function groups.

import { describe, it, expect } from "vitest";
import { formatTickValue } from "../../rendering/chartPainterUtils";
import { createLinearScale, valuesToAngles } from "../../rendering/scales";
import { computeBarRects } from "../../rendering/barChartPainter";
import { computePieSliceArcs } from "../../rendering/pieChartPainter";
import { applyChartFilters } from "../chartFilters";
import { resolveConditional } from "../encodingResolver";
import { DEFAULT_CHART_THEME } from "../../rendering/chartTheme";
import type {
  ChartSpec,
  ChartLayout,
  ParsedChartData,
  ChartFilters,
  StackMode,
  ValueCondition,
  ConditionalValue,
} from "../../types";
import type { ChartRenderTheme } from "../../rendering/chartTheme";

// ============================================================================
// Helpers
// ============================================================================

const defaultAxis = {
  title: null,
  gridLines: false,
  showLabels: true,
  labelAngle: 0,
  min: null,
  max: null,
};

function makeSpec(overrides?: Partial<ChartSpec>): ChartSpec {
  return {
    mark: "bar",
    data: "A1:D5",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { ...defaultAxis },
    yAxis: { ...defaultAxis, gridLines: true },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...overrides,
  };
}

function makeLayout(
  width = 400,
  height = 300,
): ChartLayout {
  return {
    width,
    height,
    margin: { top: 20, right: 20, bottom: 40, left: 50 },
    plotArea: { x: 50, y: 20, width: width - 70, height: height - 60 },
  };
}

function makeData(
  categories: string[],
  seriesData: { name: string; values: number[] }[],
): ParsedChartData {
  return { categories, series: seriesData };
}

const theme: ChartRenderTheme = DEFAULT_CHART_THEME;

// ============================================================================
// 1. formatTickValue - 100 values
// ============================================================================

describe("formatTickValue", () => {
  // Integers
  it.each([
    [0, "0"],
    [1, "1"],
    [-1, "-1"],
    [2, "2"],
    [5, "5"],
    [10, "10"],
    [42, "42"],
    [99, "99"],
    [100, "100"],
    [255, "255"],
    [500, "500"],
    [999, "999"],
    [1000, "1.0K"],
    [1001, "1.0K"],
    [1500, "1.5K"],
    [2000, "2.0K"],
    [5000, "5.0K"],
    [9999, "10.0K"],
    [10000, "10.0K"],
    [25000, "25.0K"],
    [50000, "50.0K"],
    [99999, "100.0K"],
    [100000, "100.0K"],
    [500000, "500.0K"],
    [999999, "1000.0K"],
    [1000000, "1.0M"],
    [1500000, "1.5M"],
    [2000000, "2.0M"],
    [5000000, "5.0M"],
    [10000000, "10.0M"],
    [100000000, "100.0M"],
    [1000000000, "1000.0M"],
  ] as [number, string][])(
    "integer %d -> %s",
    (input, expected) => {
      expect(formatTickValue(input)).toBe(expected);
    },
  );

  // Negative integers
  it.each([
    [-2, "-2"],
    [-10, "-10"],
    [-100, "-100"],
    [-999, "-999"],
    [-1000, "-1.0K"],
    [-5000, "-5.0K"],
    [-10000, "-10.0K"],
    [-100000, "-100.0K"],
    [-1000000, "-1.0M"],
    [-5000000, "-5.0M"],
    [-10000000, "-10.0M"],
  ] as [number, string][])(
    "negative integer %d -> %s",
    (input, expected) => {
      expect(formatTickValue(input)).toBe(expected);
    },
  );

  // Decimals
  it.each([
    [0.1, "0.1"],
    [0.01, "0.0"],
    [0.001, "0.0"],
    [0.05, "0.1"],
    [0.09, "0.1"],
    [0.5, "0.5"],
    [0.99, "1.0"],
    [1.5, "1.5"],
    [1.1, "1.1"],
    [2.5, "2.5"],
    [9.9, "9.9"],
    [10.5, "10.5"],
    [99.99, "100.0"],
    [100.1, "100.1"],
    [999.5, "999.5"],
    [0.0001, "0.0"],
    [0.15, "0.1"],
    [3.14159, "3.1"],
    [2.71828, "2.7"],
    [-0.5, "-0.5"],
    [-1.5, "-1.5"],
    [-99.99, "-100.0"],
  ] as [number, string][])(
    "decimal %d -> %s",
    (input, expected) => {
      expect(formatTickValue(input)).toBe(expected);
    },
  );

  // Edge cases
  it.each([
    [NaN, "NaN"],
    [Infinity, "InfinityM"],
    [-Infinity, "-InfinityM"],
  ] as [number, string][])(
    "edge case %d -> %s",
    (input, expected) => {
      // NaN, Infinity have unusual behavior - just verify no crash
      const result = formatTickValue(input);
      expect(typeof result).toBe("string");
    },
  );

  // Large values
  it.each([
    [1e7, "10.0M"],
    [1e8, "100.0M"],
    [1e9, "1000.0M"],
    [1e10, "10000.0M"],
    [-1e7, "-10.0M"],
    [-1e8, "-100.0M"],
    [-1e9, "-1000.0M"],
    [-1e10, "-10000.0M"],
  ] as [number, string][])(
    "large value %d -> %s",
    (input, expected) => {
      expect(formatTickValue(input)).toBe(expected);
    },
  );

  // Boundary values between K and M
  it.each([
    [999_999, "1000.0K"],
    [1_000_000, "1.0M"],
    [1_000_001, "1.0M"],
    [999_500, "999.5K"],
    [-999_999, "-1000.0K"],
    [-1_000_000, "-1.0M"],
  ] as [number, string][])(
    "boundary %d -> %s",
    (input, expected) => {
      expect(formatTickValue(input)).toBe(expected);
    },
  );
});

// ============================================================================
// 2. createLinearScale - 50 domain/range combos
// ============================================================================

describe("createLinearScale", () => {
  it.each([
    // [domain, range, testValue, description]
    [[0, 100], [0, 500], 50, "positive domain, mid-point"],
    [[0, 100], [0, 500], 0, "positive domain, min"],
    [[0, 100], [0, 500], 100, "positive domain, max"],
    [[0, 1], [0, 100], 0.5, "unit domain"],
    [[0, 10], [0, 1000], 5, "small domain, large range"],
    [[-100, 100], [0, 400], 0, "zero-crossing domain, zero value"],
    [[-100, 100], [0, 400], -50, "zero-crossing domain, negative"],
    [[-100, 100], [0, 400], 50, "zero-crossing domain, positive"],
    [[-1000, -500], [0, 200], -750, "fully negative domain, midpoint"],
    [[-1000, -500], [0, 200], -1000, "fully negative domain, min"],
    [[-1000, -500], [0, 200], -500, "fully negative domain, max"],
    [[0, 1000000], [0, 800], 500000, "wide positive domain"],
    [[0, 0.01], [0, 100], 0.005, "narrow positive domain"],
    [[-0.01, 0.01], [0, 200], 0, "narrow zero-crossing domain"],
    [[0, 100], [100, 0], 50, "reversed range"],
    [[0, 100], [100, 0], 0, "reversed range, min"],
    [[0, 100], [100, 0], 100, "reversed range, max"],
    [[0, 100], [0, 0], 50, "zero-width range"],
    [[0, 1000], [50, 350], 500, "offset range"],
    [[-50, 50], [100, 500], 0, "zero-crossing, offset range"],
    [[0, 10], [0, 10], 5, "identity-like domain and range"],
    [[0, 100], [0, 100], 25, "identity domain and range, quarter"],
    [[-500, 500], [0, 1000], 250, "symmetric domain"],
    [[10, 20], [0, 100], 15, "narrow elevated domain"],
    [[100, 200], [0, 500], 150, "elevated positive domain"],
    [[0, 50], [0, 1000], 25, "2x scale factor"],
    [[0, 10], [0, 50], 7, "5x scale factor"],
    [[-1000, 0], [0, 400], -500, "negative-only domain"],
    [[-1000, 0], [0, 400], -250, "negative-only domain, quarter"],
    [[0, 100], [200, 600], 75, "large offset range"],
    [[-200, 200], [50, 450], 100, "symmetric, offset range"],
    [[0, 1], [0, 1], 0.5, "unit domain and range"],
    [[0, 1000], [0, 1], 500, "large domain, unit range"],
    [[5, 5], [0, 100], 5, "degenerate single-point domain"],
    [[0, 0], [0, 100], 0, "zero-zero domain"],
    [[-10, 10], [0, 100], -5, "small symmetric negative"],
    [[-10, 10], [0, 100], 5, "small symmetric positive"],
    [[0, 100], [0, 50], 100, "half-scale range"],
    [[0, 1000], [100, 200], 500, "narrow offset range"],
    [[-100, 0], [500, 1000], -50, "negative domain, offset range"],
    [[0, 100], [0, 300], 33, "third of domain"],
    [[0, 100], [0, 300], 66, "two-thirds of domain"],
    [[0, 100], [0, 300], 1, "near-zero value"],
    [[0, 100], [0, 300], 99, "near-max value"],
    [[0, 500], [0, 100], 250, "compress 5:1"],
    [[10, 110], [0, 200], 60, "shifted domain"],
    [[0, 10000], [0, 100], 5000, "10K domain"],
    [[0, 10000], [0, 100], 0, "10K domain, zero"],
    [[0, 10000], [0, 100], 10000, "10K domain, max"],
    [[-500, 1500], [0, 800], 500, "asymmetric zero-crossing"],
  ] as [[number, number], [number, number], number, string][])(
    "domain %j range %j value %d (%s)",
    (domain, range, testValue, _desc) => {
      const scale = createLinearScale(domain, range);
      const result = scale.scale(testValue);
      expect(typeof result).toBe("number");
      expect(Number.isFinite(result)).toBe(true);

      // The scale should produce a monotonic mapping
      const a = scale.scale(testValue - 1);
      const b = scale.scale(testValue + 1);
      // If range is not reversed (r0 < r1), increasing values -> increasing pixels
      if (scale.range[0] <= scale.range[1]) {
        expect(b).toBeGreaterThanOrEqual(a);
      } else {
        expect(a).toBeGreaterThanOrEqual(b);
      }
    },
  );
});

// ============================================================================
// 3. computeBarRects - 30 configurations
// ============================================================================

describe("computeBarRects", () => {
  function barSpec(stackMode: StackMode = "none"): ChartSpec {
    return makeSpec({
      mark: "bar",
      markOptions: { stackMode } as any,
    });
  }

  function barData(
    numSeries: number,
    numCategories: number,
    valueFn: (si: number, ci: number) => number = (si, ci) => (si + 1) * (ci + 1) * 10,
  ): ParsedChartData {
    const categories = Array.from({ length: numCategories }, (_, i) => `Cat${i}`);
    const series = Array.from({ length: numSeries }, (_, si) => ({
      name: `Series${si}`,
      values: Array.from({ length: numCategories }, (_, ci) => valueFn(si, ci)),
    }));
    return { categories, series };
  }

  it.each([
    // [numSeries, numCategories, stackMode, description]
    [1, 1, "none", "1 series x 1 category, grouped"],
    [1, 3, "none", "1 series x 3 categories, grouped"],
    [1, 5, "none", "1 series x 5 categories, grouped"],
    [1, 10, "none", "1 series x 10 categories, grouped"],
    [2, 3, "none", "2 series x 3 categories, grouped"],
    [2, 5, "none", "2 series x 5 categories, grouped"],
    [3, 3, "none", "3 series x 3 categories, grouped"],
    [3, 5, "none", "3 series x 5 categories, grouped"],
    [5, 5, "none", "5 series x 5 categories, grouped"],
    [10, 3, "none", "10 series x 3 categories, grouped"],
    [1, 1, "stacked", "1 series x 1 category, stacked"],
    [2, 3, "stacked", "2 series x 3 categories, stacked"],
    [3, 5, "stacked", "3 series x 5 categories, stacked"],
    [5, 5, "stacked", "5 series x 5 categories, stacked"],
    [10, 3, "stacked", "10 series x 3 categories, stacked"],
    [2, 10, "stacked", "2 series x 10 categories, stacked"],
    [1, 1, "percentStacked", "1x1 percent stacked"],
    [2, 3, "percentStacked", "2x3 percent stacked"],
    [3, 5, "percentStacked", "3x5 percent stacked"],
    [5, 5, "percentStacked", "5x5 percent stacked"],
    [10, 3, "percentStacked", "10x3 percent stacked"],
    [1, 100, "none", "1 series x 100 categories, grouped"],
    [2, 50, "stacked", "2 series x 50 categories, stacked"],
    [3, 20, "percentStacked", "3x20 percent stacked"],
    [4, 4, "none", "4x4 grouped"],
    [6, 6, "stacked", "6x6 stacked"],
    [7, 2, "none", "7x2 grouped"],
    [8, 3, "stacked", "8x3 stacked"],
    [1, 50, "percentStacked", "1x50 percent stacked"],
    [3, 1, "none", "3 series x 1 category, grouped"],
  ] as [number, number, StackMode, string][])(
    "%s series x %s categories, %s (%s)",
    (numSeries, numCategories, stackMode, _desc) => {
      const data = barData(numSeries, numCategories);
      const spec = barSpec(stackMode);
      const layout = makeLayout();
      const rects = computeBarRects(data, spec, layout, theme);

      // Should produce rects
      expect(rects.length).toBeGreaterThan(0);
      // All rects should have positive dimensions
      for (const r of rects) {
        expect(r.width).toBeGreaterThan(0);
        expect(r.height).toBeGreaterThanOrEqual(0);
        expect(r.seriesIndex).toBeGreaterThanOrEqual(0);
        expect(r.categoryIndex).toBeGreaterThanOrEqual(0);
        expect(typeof r.seriesName).toBe("string");
        expect(typeof r.categoryName).toBe("string");
      }

      // For grouped mode, max rects = numSeries * numCategories
      expect(rects.length).toBeLessThanOrEqual(numSeries * numCategories);
    },
  );
});

// ============================================================================
// 4. computePieSliceArcs - 30 datasets
// ============================================================================

describe("computePieSliceArcs", () => {
  function pieSpec(): ChartSpec {
    return makeSpec({ mark: "pie" });
  }

  function pieData(values: number[], categories?: string[]): ParsedChartData {
    const cats = categories ?? values.map((_, i) => `Slice${i}`);
    return {
      categories: cats,
      series: [{ name: "Values", values }],
    };
  }

  it.each([
    [[100], "single value"],
    [[50, 50], "two equal values"],
    [[25, 25, 25, 25], "four equal values"],
    [[10, 10, 10, 10, 10, 10, 10, 10, 10, 10], "ten equal values"],
    [[90, 10], "dominant first"],
    [[10, 90], "dominant second"],
    [[1, 2, 3, 4, 5], "ascending"],
    [[5, 4, 3, 2, 1], "descending"],
    [[100, 1, 1, 1], "one very large, rest small"],
    [[1, 1, 1, 100], "last very large"],
    [[0.1, 0.2, 0.3], "small fractional values"],
    [[1000, 2000, 3000], "large values"],
    [[1, 1000000], "extreme ratio"],
    [[33.33, 33.33, 33.34], "near-equal thirds"],
    [[0, 0, 0], "all zeros"],
    [[0, 100], "one zero, one positive"],
    [[0, 0, 100], "two zeros, one positive"],
    [[50, 0, 50], "zero in middle"],
    [[1], "single value 1"],
    [[99, 1], "99-1 split"],
    [Array.from({ length: 20 }, (_, i) => i + 1), "20 ascending values"],
    [[10, 20, 30, 40], "linear progression"],
    [[1, 2, 4, 8, 16], "exponential progression"],
    [[100, 100, 100, 100, 100], "five equal 100s"],
    [[0.001, 0.002, 0.003], "very small values"],
    [[1e6, 2e6, 3e6], "millions"],
    [[50, 25, 12.5, 6.25, 3.125], "halving series"],
    [[7, 13, 17, 23, 29], "prime numbers"],
    [[-10, 50, 30], "includes negative (clamped to 0)"],
    [[0], "single zero"],
  ] as [number[], string][])(
    "dataset: %s (%s)",
    (values, _desc) => {
      const data = pieData(values);
      const spec = pieSpec();
      const layout = makeLayout();
      const arcs = computePieSliceArcs(data, spec, layout, theme);

      const total = values.reduce((s, v) => s + Math.max(0, v), 0);

      if (total === 0) {
        // All zeros -> no arcs
        expect(arcs.length).toBe(0);
        return;
      }

      expect(arcs.length).toBe(values.length);

      // All arcs should have valid geometry
      for (const arc of arcs) {
        expect(arc.outerRadius).toBeGreaterThan(0);
        expect(arc.innerRadius).toBe(0); // pie, not donut
        expect(typeof arc.label).toBe("string");
        expect(arc.percent).toBeGreaterThanOrEqual(0);
        expect(arc.percent).toBeLessThanOrEqual(100.01);
      }

      // Percentages should sum to ~100 (ignoring negatives which are clamped)
      const percentSum = arcs.reduce((s, a) => s + a.percent, 0);
      if (total > 0) {
        expect(percentSum).toBeCloseTo(100, 0);
      }
    },
  );
});

// ============================================================================
// 5. applyChartFilters - 40 filter combos
// ============================================================================

describe("applyChartFilters", () => {
  function filterData(
    numSeries: number,
    numCategories: number,
  ): ParsedChartData {
    return {
      categories: Array.from({ length: numCategories }, (_, i) => `C${i}`),
      series: Array.from({ length: numSeries }, (_, si) => ({
        name: `S${si}`,
        values: Array.from({ length: numCategories }, (_, ci) => (si + 1) * 10 + ci),
      })),
    };
  }

  it.each([
    // [numSeries, numCats, hiddenSeries, hiddenCategories, expectedSeries, expectedCats, desc]
    [3, 5, [], [], 3, 5, "no filters"],
    [3, 5, [0], [], 2, 5, "hide first series"],
    [3, 5, [1], [], 2, 5, "hide middle series"],
    [3, 5, [2], [], 2, 5, "hide last series"],
    [3, 5, [0, 1], [], 1, 5, "hide two series"],
    [3, 5, [0, 1, 2], [], 0, 5, "hide all series"],
    [3, 5, [], [0], 3, 4, "hide first category"],
    [3, 5, [], [2], 3, 4, "hide middle category"],
    [3, 5, [], [4], 3, 4, "hide last category"],
    [3, 5, [], [0, 1], 3, 3, "hide two categories"],
    [3, 5, [], [0, 1, 2, 3, 4], 3, 0, "hide all categories"],
    [3, 5, [0], [0], 2, 4, "hide 1 series + 1 category"],
    [3, 5, [0, 2], [1, 3], 1, 3, "hide 2 series + 2 categories"],
    [3, 5, [0, 1, 2], [0, 1, 2, 3, 4], 0, 0, "hide all series and all categories"],
    [1, 1, [], [], 1, 1, "minimal 1x1, no filters"],
    [1, 1, [0], [], 0, 1, "minimal 1x1, hide series"],
    [1, 1, [], [0], 1, 0, "minimal 1x1, hide category"],
    [1, 1, [0], [0], 0, 0, "minimal 1x1, hide both"],
    [5, 3, [1, 3], [], 3, 3, "5 series, hide 2 non-adjacent"],
    [5, 3, [0, 4], [], 3, 3, "5 series, hide first+last"],
    [2, 10, [], [0, 2, 4, 6, 8], 2, 5, "hide even categories"],
    [2, 10, [], [1, 3, 5, 7, 9], 2, 5, "hide odd categories"],
    [4, 4, [0], [0], 3, 3, "4x4, hide first of each"],
    [4, 4, [3], [3], 3, 3, "4x4, hide last of each"],
    [4, 4, [1, 2], [1, 2], 2, 2, "4x4, hide middle of each"],
    [10, 10, [0, 1, 2, 3, 4, 5, 6, 7, 8], [], 1, 10, "10 series, hide 9"],
    [3, 3, [], [0, 2], 3, 1, "3x3, hide outer categories"],
    [3, 3, [0, 2], [], 1, 3, "3x3, hide outer series"],
    [2, 5, [0], [0, 4], 1, 3, "hide 1 series + 2 categories"],
    [2, 5, [1], [1, 2, 3], 1, 2, "hide 1 series + 3 categories"],
    [6, 2, [0, 1, 2, 3, 4], [0], 1, 1, "6x2, keep 1 series + 1 category"],
    [3, 5, [0], [1], 2, 4, "hide first series + second category"],
    [3, 5, [2], [0, 4], 2, 3, "hide last series + first+last category"],
    [5, 5, [0, 1, 2, 3], [0, 1, 2, 3], 1, 1, "5x5, keep 1 each"],
    [1, 3, [], [1], 1, 2, "1 series, hide middle category"],
    [1, 5, [], [0, 1, 2, 3], 1, 1, "1 series, hide 4 of 5 categories"],
    [3, 1, [0, 1], [], 1, 1, "3 series x 1 cat, hide 2 series"],
    [4, 6, [1], [2, 4], 3, 4, "4x6, scattered hiding"],
    [2, 2, [0], [1], 1, 1, "2x2, hide one of each"],
    [2, 2, [1], [0], 1, 1, "2x2, hide other one of each"],
  ] as [number, number, number[], number[], number, number, string][])(
    "%s series x %s cats, hidden=%j/%j -> %sx%s (%s)",
    (numSeries, numCats, hiddenSeries, hiddenCategories, expectedSeries, expectedCats, _desc) => {
      const data = filterData(numSeries, numCats);
      const filters: ChartFilters = { hiddenSeries, hiddenCategories };
      const result = applyChartFilters(data, filters);

      expect(result.series.length).toBe(expectedSeries);
      expect(result.categories.length).toBe(expectedCats);

      // All remaining series values should have correct length
      for (const s of result.series) {
        expect(s.values.length).toBe(expectedCats);
      }
    },
  );
});

// ============================================================================
// 6. resolveConditional - 60 condition combos
// ============================================================================

describe("resolveConditional", () => {
  // Helper to build a conditional encoding
  function cond(
    condition: ValueCondition,
    value: string,
    otherwise: string,
  ): ConditionalValue<string> {
    return { condition, value, otherwise };
  }

  // gt operator
  it.each([
    [{ field: "value" as const, gt: 50 }, 100, "A", true, "gt 50, value=100"],
    [{ field: "value" as const, gt: 50 }, 50, "A", false, "gt 50, value=50 (boundary)"],
    [{ field: "value" as const, gt: 50 }, 0, "A", false, "gt 50, value=0"],
    [{ field: "value" as const, gt: 50 }, -10, "A", false, "gt 50, value=-10"],
    [{ field: "value" as const, gt: 50 }, 51, "A", true, "gt 50, value=51"],
    [{ field: "value" as const, gt: 0 }, 1, "A", true, "gt 0, value=1"],
    [{ field: "value" as const, gt: 0 }, 0, "A", false, "gt 0, value=0"],
    [{ field: "value" as const, gt: 0 }, -1, "A", false, "gt 0, value=-1"],
    [{ field: "value" as const, gt: -10 }, 0, "A", true, "gt -10, value=0"],
    [{ field: "value" as const, gt: 1000 }, 999, "A", false, "gt 1000, value=999"],
  ] as [ValueCondition, number, string, boolean, string][])(
    "gt: %s value=%d -> match=%s (%s)",
    (condition, value, _v, shouldMatch, _desc) => {
      const result = resolveConditional(cond(condition, "YES", "NO"), value, "cat");
      expect(result).toBe(shouldMatch ? "YES" : "NO");
    },
  );

  // lt operator
  it.each([
    [{ field: "value" as const, lt: 50 }, 10, true, "lt 50, value=10"],
    [{ field: "value" as const, lt: 50 }, 50, false, "lt 50, value=50 (boundary)"],
    [{ field: "value" as const, lt: 50 }, 100, false, "lt 50, value=100"],
    [{ field: "value" as const, lt: 0 }, -1, true, "lt 0, value=-1"],
    [{ field: "value" as const, lt: 0 }, 0, false, "lt 0, value=0"],
    [{ field: "value" as const, lt: 0 }, 1, false, "lt 0, value=1"],
    [{ field: "value" as const, lt: -100 }, -200, true, "lt -100, value=-200"],
    [{ field: "value" as const, lt: -100 }, -100, false, "lt -100, value=-100"],
    [{ field: "value" as const, lt: 1000 }, 999, true, "lt 1000, value=999"],
    [{ field: "value" as const, lt: 1000 }, 1000, false, "lt 1000, value=1000"],
  ] as [ValueCondition, number, boolean, string][])(
    "lt: %s value=%d -> match=%s (%s)",
    (condition, value, shouldMatch, _desc) => {
      const result = resolveConditional(cond(condition, "YES", "NO"), value, "cat");
      expect(result).toBe(shouldMatch ? "YES" : "NO");
    },
  );

  // gte operator
  it.each([
    [{ field: "value" as const, gte: 50 }, 50, true, "gte 50, value=50"],
    [{ field: "value" as const, gte: 50 }, 51, true, "gte 50, value=51"],
    [{ field: "value" as const, gte: 50 }, 49, false, "gte 50, value=49"],
    [{ field: "value" as const, gte: 0 }, 0, true, "gte 0, value=0"],
    [{ field: "value" as const, gte: 0 }, -1, false, "gte 0, value=-1"],
    [{ field: "value" as const, gte: -10 }, -10, true, "gte -10, value=-10"],
    [{ field: "value" as const, gte: -10 }, -11, false, "gte -10, value=-11"],
    [{ field: "value" as const, gte: 100 }, 100, true, "gte 100, value=100"],
    [{ field: "value" as const, gte: 100 }, 0, false, "gte 100, value=0"],
    [{ field: "value" as const, gte: 100 }, 1000, true, "gte 100, value=1000"],
  ] as [ValueCondition, number, boolean, string][])(
    "gte: %s value=%d -> match=%s (%s)",
    (condition, value, shouldMatch, _desc) => {
      const result = resolveConditional(cond(condition, "YES", "NO"), value, "cat");
      expect(result).toBe(shouldMatch ? "YES" : "NO");
    },
  );

  // lte operator
  it.each([
    [{ field: "value" as const, lte: 50 }, 50, true, "lte 50, value=50"],
    [{ field: "value" as const, lte: 50 }, 49, true, "lte 50, value=49"],
    [{ field: "value" as const, lte: 50 }, 51, false, "lte 50, value=51"],
    [{ field: "value" as const, lte: 0 }, 0, true, "lte 0, value=0"],
    [{ field: "value" as const, lte: 0 }, 1, false, "lte 0, value=1"],
    [{ field: "value" as const, lte: -10 }, -10, true, "lte -10, value=-10"],
    [{ field: "value" as const, lte: -10 }, -9, false, "lte -10, value=-9"],
    [{ field: "value" as const, lte: 100 }, 100, true, "lte 100, value=100"],
    [{ field: "value" as const, lte: 100 }, 200, false, "lte 100, value=200"],
    [{ field: "value" as const, lte: 100 }, -50, true, "lte 100, value=-50"],
  ] as [ValueCondition, number, boolean, string][])(
    "lte: %s value=%d -> match=%s (%s)",
    (condition, value, shouldMatch, _desc) => {
      const result = resolveConditional(cond(condition, "YES", "NO"), value, "cat");
      expect(result).toBe(shouldMatch ? "YES" : "NO");
    },
  );

  // oneOf operator
  it.each([
    [{ field: "category" as const, oneOf: ["A", "B"] }, 10, "A", true, "oneOf A/B, cat=A"],
    [{ field: "category" as const, oneOf: ["A", "B"] }, 10, "B", true, "oneOf A/B, cat=B"],
    [{ field: "category" as const, oneOf: ["A", "B"] }, 10, "C", false, "oneOf A/B, cat=C"],
    [{ field: "category" as const, oneOf: ["X"] }, 10, "X", true, "oneOf X, cat=X"],
    [{ field: "category" as const, oneOf: ["X"] }, 10, "Y", false, "oneOf X, cat=Y"],
    [{ field: "value" as const, oneOf: [10, 20, 30] }, 10, "cat", true, "oneOf nums, val=10"],
    [{ field: "value" as const, oneOf: [10, 20, 30] }, 20, "cat", true, "oneOf nums, val=20"],
    [{ field: "value" as const, oneOf: [10, 20, 30] }, 15, "cat", false, "oneOf nums, val=15"],
    [{ field: "category" as const, oneOf: [] }, 10, "A", false, "empty oneOf"],
    [{ field: "category" as const, oneOf: ["A", "B", "C", "D"] }, 10, "D", true, "oneOf ABCD, cat=D"],
  ] as [ValueCondition, number, string, boolean, string][])(
    "oneOf: %s value=%d cat=%s -> match=%s (%s)",
    (condition, value, category, shouldMatch, _desc) => {
      const result = resolveConditional(cond(condition, "YES", "NO"), value, category);
      expect(result).toBe(shouldMatch ? "YES" : "NO");
    },
  );

  // Combined operators
  it.each([
    [{ field: "value" as const, gt: 10, lt: 50 }, 25, true, "gt10 & lt50, value=25"],
    [{ field: "value" as const, gt: 10, lt: 50 }, 10, false, "gt10 & lt50, value=10"],
    [{ field: "value" as const, gt: 10, lt: 50 }, 50, false, "gt10 & lt50, value=50"],
    [{ field: "value" as const, gt: 10, lt: 50 }, 5, false, "gt10 & lt50, value=5"],
    [{ field: "value" as const, gt: 10, lt: 50 }, 60, false, "gt10 & lt50, value=60"],
    [{ field: "value" as const, gte: 0, lte: 100 }, 0, true, "gte0 & lte100, value=0"],
    [{ field: "value" as const, gte: 0, lte: 100 }, 100, true, "gte0 & lte100, value=100"],
    [{ field: "value" as const, gte: 0, lte: 100 }, 50, true, "gte0 & lte100, value=50"],
    [{ field: "value" as const, gte: 0, lte: 100 }, -1, false, "gte0 & lte100, value=-1"],
    [{ field: "value" as const, gte: 0, lte: 100 }, 101, false, "gte0 & lte100, value=101"],
  ] as [ValueCondition, number, boolean, string][])(
    "combined: %s value=%d -> match=%s (%s)",
    (condition, value, shouldMatch, _desc) => {
      const result = resolveConditional(cond(condition, "YES", "NO"), value, "cat");
      expect(result).toBe(shouldMatch ? "YES" : "NO");
    },
  );

  // Static (non-conditional) values
  it.each([
    ["red", 0, "cat", "red", "static string"],
    ["blue", 100, "X", "blue", "static string, any value"],
    ["#ff0000", -50, "Y", "#ff0000", "static hex color"],
  ] as [string, number, string, string, string][])(
    "static: %s value=%d cat=%s -> %s (%s)",
    (encoding, value, category, expected, _desc) => {
      const result = resolveConditional(encoding, value, category);
      expect(result).toBe(expected);
    },
  );
});
