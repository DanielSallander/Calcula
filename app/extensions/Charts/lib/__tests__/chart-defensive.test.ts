//! FILENAME: app/extensions/Charts/lib/__tests__/chart-defensive.test.ts
// PURPOSE: Verify defensive coding patterns in chart utilities.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline } from "../trendlineComputation";
import type { ParsedChartData, TrendlineSpec, TransformSpec } from "../../types";
import {
  DEFAULT_CHART_THEME,
  mergeTheme,
  resolveChartTheme,
  type ChartRenderTheme,
} from "../../rendering/chartTheme";
import {
  createLinearScale,
  createBandScale,
} from "../../rendering/scales";

// ============================================================================
// Helpers
// ============================================================================

function makeData(
  categories: string[],
  seriesValues: number[][],
): ParsedChartData {
  return {
    categories,
    series: seriesValues.map((values, i) => ({
      name: `Series ${i}`,
      values,
      color: null,
    })),
  };
}

const emptyData: ParsedChartData = makeData([], []);
const singlePoint: ParsedChartData = makeData(["A"], [[5]]);
const normalData: ParsedChartData = makeData(
  ["A", "B", "C", "D"],
  [[1, 2, 3, 4], [10, 20, 30, 40]],
);
const nanData: ParsedChartData = makeData(
  ["A", "B", "C"],
  [[NaN, 2, NaN]],
);
const zeroData: ParsedChartData = makeData(
  ["A", "B", "C"],
  [[0, 0, 0]],
);
const negativeData: ParsedChartData = makeData(
  ["A", "B", "C"],
  [[-100, -1, -0.001]],
);
const hugeData: ParsedChartData = makeData(
  ["A", "B"],
  [[Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]],
);

// ============================================================================
// 1. Transforms never throw for valid ParsedChartData input
// ============================================================================

describe("transforms never throw for valid ParsedChartData", () => {
  const inputs: [string, ParsedChartData][] = [
    ["empty", emptyData],
    ["single point", singlePoint],
    ["normal", normalData],
    ["NaN values", nanData],
    ["all zeros", zeroData],
    ["negative values", negativeData],
    ["huge values", hugeData],
  ];

  it("applyTransforms with empty transform list returns data", () => {
    for (const [label, data] of inputs) {
      expect(() => applyTransforms(data, [])).not.toThrow();
    }
  });

  it("applyTransforms with sort transform does not throw", () => {
    const sort: TransformSpec = { type: "sort", field: "x", order: "ascending" };
    for (const [label, data] of inputs) {
      expect(() => applyTransforms(data, [sort])).not.toThrow();
    }
  });

  it("applyTransforms with filter transform does not throw", () => {
    const filter: TransformSpec = {
      type: "filter",
      field: "$category",
      predicate: "= A",
    };
    for (const [label, data] of inputs) {
      expect(() => applyTransforms(data, [filter])).not.toThrow();
    }
  });

  it("applyTransforms does not mutate input", () => {
    const data = makeData(["A", "B"], [[1, 2]]);
    const frozen = JSON.parse(JSON.stringify(data));
    applyTransforms(data, []);
    expect(data).toEqual(frozen);
  });
});

// ============================================================================
// 2. Theme operations always return complete objects
// ============================================================================

describe("theme operations return complete objects", () => {
  const requiredKeys: (keyof ChartRenderTheme)[] = [
    "background",
    "plotBackground",
    "gridLineColor",
    "gridLineWidth",
    "axisColor",
    "axisLabelColor",
    "axisTitleColor",
    "titleColor",
    "legendTextColor",
    "fontFamily",
    "titleFontSize",
    "axisTitleFontSize",
    "labelFontSize",
    "legendFontSize",
    "barBorderRadius",
    "barGap",
  ];

  it("DEFAULT_CHART_THEME has all required keys", () => {
    for (const key of requiredKeys) {
      expect(DEFAULT_CHART_THEME).toHaveProperty(key);
      expect(DEFAULT_CHART_THEME[key]).not.toBeUndefined();
    }
  });

  it("mergeTheme with undefined overrides returns complete theme", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, undefined);
    for (const key of requiredKeys) {
      expect(result).toHaveProperty(key);
    }
  });

  it("mergeTheme with empty overrides returns complete theme", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, {});
    for (const key of requiredKeys) {
      expect(result).toHaveProperty(key);
    }
  });

  it("mergeTheme with partial overrides preserves unset keys", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, { background: "#000" });
    expect(result.background).toBe("#000");
    expect(result.plotBackground).toBe(DEFAULT_CHART_THEME.plotBackground);
    for (const key of requiredKeys) {
      expect(result[key]).not.toBeUndefined();
    }
  });

  it("resolveChartTheme with undefined config returns complete theme", () => {
    const result = resolveChartTheme(undefined);
    for (const key of requiredKeys) {
      expect(result).toHaveProperty(key);
    }
  });

  it("resolveChartTheme with empty config returns complete theme", () => {
    const result = resolveChartTheme({});
    for (const key of requiredKeys) {
      expect(result).toHaveProperty(key);
    }
  });
});

// ============================================================================
// 3. Scale functions never return NaN for finite inputs
// ============================================================================

describe("scale functions never return NaN for finite inputs", () => {
  it("linear scale maps finite values without NaN", () => {
    const scale = createLinearScale([0, 100], [0, 500]);
    for (const v of [0, 50, 100, -10, 200, 0.001, -0.001]) {
      const result = scale.scale(v);
      expect(Number.isNaN(result)).toBe(false);
      expect(Number.isFinite(result)).toBe(true);
    }
  });

  it("linear scale with equal domain bounds does not return NaN", () => {
    const scale = createLinearScale([5, 5], [0, 500]);
    const result = scale.scale(5);
    expect(Number.isNaN(result)).toBe(false);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("linear scale with zero-width range returns finite", () => {
    const scale = createLinearScale([0, 100], [200, 200]);
    const result = scale.scale(50);
    expect(Number.isNaN(result)).toBe(false);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("linear scale ticks never contain NaN", () => {
    const scale = createLinearScale([0, 100], [0, 500]);
    const ticks = scale.ticks(10);
    for (const t of ticks) {
      expect(Number.isNaN(t)).toBe(false);
      expect(Number.isFinite(t)).toBe(true);
    }
  });

  it("band scale with empty domain does not throw", () => {
    expect(() => createBandScale([], [0, 500])).not.toThrow();
  });

  it("band scale bandwidth is finite and non-negative", () => {
    const scale = createBandScale(["A", "B", "C"], [0, 300]);
    expect(Number.isFinite(scale.bandwidth)).toBe(true);
    expect(scale.bandwidth).toBeGreaterThanOrEqual(0);
  });

  it("band scale with single category does not return NaN", () => {
    const scale = createBandScale(["A"], [0, 500]);
    const result = scale.scale("A");
    expect(Number.isNaN(result)).toBe(false);
    expect(Number.isFinite(result)).toBe(true);
  });
});

// ============================================================================
// 4. Trendline always returns null or valid result (never partial)
// ============================================================================

describe("trendline returns null or valid result", () => {
  const trendlineTypes: TrendlineSpec["type"][] = [
    "linear",
    "exponential",
    "polynomial",
    "power",
    "logarithmic",
    "movingAverage",
  ];

  it("returns null for empty data", () => {
    for (const type of trendlineTypes) {
      const result = computeTrendline(emptyData, { type });
      expect(result).toBeNull();
    }
  });

  it("returns null for single point (< 2 values)", () => {
    for (const type of trendlineTypes) {
      const result = computeTrendline(singlePoint, { type });
      expect(result).toBeNull();
    }
  });

  it("returns null for nonexistent series index", () => {
    const result = computeTrendline(normalData, {
      type: "linear",
      seriesIndex: 999,
    });
    expect(result).toBeNull();
  });

  it("returns null for all-NaN series", () => {
    const allNaN = makeData(["A", "B", "C"], [[NaN, NaN, NaN]]);
    for (const type of trendlineTypes) {
      const result = computeTrendline(allNaN, { type });
      expect(result).toBeNull();
    }
  });

  it("valid result has points array and equation string", () => {
    for (const type of trendlineTypes) {
      const result = computeTrendline(normalData, { type });
      if (result !== null) {
        expect(Array.isArray(result.points)).toBe(true);
        expect(result.points.length).toBeGreaterThan(0);
        expect(typeof result.equation).toBe("string");
        expect(typeof result.rSquared).toBe("number");
        // Each point must have ci and value as numbers
        for (const pt of result.points) {
          expect(typeof pt.ci).toBe("number");
          expect(typeof pt.value).toBe("number");
        }
      }
    }
  });

  it("trendline on data with NaN gaps produces valid result or null", () => {
    const gappyData = makeData(["A", "B", "C", "D"], [[1, NaN, 3, NaN]]);
    for (const type of trendlineTypes) {
      const result = computeTrendline(gappyData, { type });
      if (result !== null) {
        expect(Array.isArray(result.points)).toBe(true);
        expect(typeof result.equation).toBe("string");
      }
    }
  });
});
