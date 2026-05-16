import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline, type TrendlineResult } from "../trendlineComputation";
import {
  createLinearScale,
  createBandScale,
  createPointScale,
} from "../../rendering/scales";
import {
  mergeTheme,
  resolveChartTheme,
  DEFAULT_CHART_THEME,
  PALETTES,
  PALETTE_NAMES,
  type ChartRenderTheme,
} from "../../rendering/chartTheme";
import type { ParsedChartData, TransformSpec, TrendlineSpec } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeParsedData(
  categories: string[],
  seriesValues: number[][],
): ParsedChartData {
  return {
    categories,
    series: seriesValues.map((values, i) => ({
      name: `Series ${i + 1}`,
      values,
    })),
  };
}

// ============================================================================
// Transform types produce ParsedChartData with same structure
// ============================================================================

describe("chart transforms structural contract", () => {
  const baseData = makeParsedData(
    ["A", "B", "C", "D"],
    [[10, 20, 30, 40], [5, 15, 25, 35]],
  );

  const transformTypes: TransformSpec[] = [
    { type: "filter", field: "$category", predicate: "!= Z" },
    { type: "sort", field: "$category", order: "asc" },
    { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Series 1", as: "agg" },
    { type: "calculate", as: "computed", expr: "Series_1 * 2" },
    { type: "window", op: "sum", field: "Series 1", as: "running" },
    { type: "bin", field: "Series 1", binCount: 5, as: "binned" },
  ];

  for (const transform of transformTypes) {
    it(`"${transform.type}" returns ParsedChartData with categories and series arrays`, () => {
      const result = applyTransforms(baseData, [transform]);
      expect(Array.isArray(result.categories)).toBe(true);
      expect(Array.isArray(result.series)).toBe(true);
      for (const s of result.series) {
        expect(typeof s.name).toBe("string");
        expect(Array.isArray(s.values)).toBe(true);
      }
    });
  }

  it("empty transforms returns data unchanged", () => {
    const result = applyTransforms(baseData, []);
    expect(result).toBe(baseData);
  });
});

// ============================================================================
// Trendline types return TrendlineResult with required fields
// ============================================================================

describe("trendline computation contract", () => {
  const data = makeParsedData(
    ["A", "B", "C", "D", "E"],
    [[2, 4, 6, 8, 10]],
  );

  const trendlineTypes: TrendlineSpec[] = [
    { type: "linear", seriesIndex: 0 },
    { type: "exponential", seriesIndex: 0 },
    { type: "polynomial", seriesIndex: 0, polynomialDegree: 2 },
    { type: "power", seriesIndex: 0 },
    { type: "logarithmic", seriesIndex: 0 },
    { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 2 },
  ];

  for (const spec of trendlineTypes) {
    it(`"${spec.type}" returns TrendlineResult with points, equation, rSquared`, () => {
      const result = computeTrendline(data, spec);
      expect(result).not.toBeNull();
      const r = result as TrendlineResult;
      expect(Array.isArray(r.points)).toBe(true);
      expect(r.points.length).toBeGreaterThan(0);
      expect(typeof r.equation).toBe("string");
      expect(typeof r.rSquared).toBe("number");
      for (const p of r.points) {
        expect(typeof p.ci).toBe("number");
        expect(typeof p.value).toBe("number");
      }
    });
  }

  it("returns null for missing series", () => {
    const result = computeTrendline(data, { type: "linear", seriesIndex: 99 });
    expect(result).toBeNull();
  });

  it("returns null for series with fewer than 2 values", () => {
    const tinyData = makeParsedData(["A"], [[5]]);
    const result = computeTrendline(tinyData, { type: "linear", seriesIndex: 0 });
    expect(result).toBeNull();
  });
});

// ============================================================================
// Scale types return functions with expected domain->range mapping
// ============================================================================

describe("scale contract", () => {
  it("linear scale maps domain endpoints to range endpoints", () => {
    const scale = createLinearScale([0, 100], [0, 500]);
    // Domain 0 should map near range start
    expect(scale.scale(scale.domain[0])).toBeCloseTo(0, 0);
    // Domain end should map near range end
    expect(scale.scale(scale.domain[1])).toBeCloseTo(500, 0);
  });

  it("linear scale ticks returns an array of numbers", () => {
    const scale = createLinearScale([0, 100], [0, 500]);
    const ticks = scale.ticks(5);
    expect(Array.isArray(ticks)).toBe(true);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(typeof t).toBe("number");
    }
  });

  it("band scale maps every category to a number within range", () => {
    const scale = createBandScale(["A", "B", "C"], [0, 300]);
    expect(scale.bandwidth).toBeGreaterThan(0);
    for (const cat of ["A", "B", "C"]) {
      const px = scale.scale(cat);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px + scale.bandwidth).toBeLessThanOrEqual(300 + 1);
    }
  });

  it("point scale maps every category index to a number within range", () => {
    const scale = createPointScale(["X", "Y", "Z"], [0, 200]);
    expect(scale.step).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      const px = scale.scaleIndex(i);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(200);
    }
  });
});

// ============================================================================
// Theme merge always returns complete theme
// ============================================================================

describe("chart theme contract", () => {
  const requiredKeys: (keyof ChartRenderTheme)[] = [
    "background", "plotBackground", "gridLineColor", "gridLineWidth",
    "axisColor", "axisLabelColor", "axisTitleColor", "titleColor",
    "legendTextColor", "fontFamily", "titleFontSize", "axisTitleFontSize",
    "labelFontSize", "legendFontSize", "barBorderRadius", "barGap",
  ];

  it("mergeTheme with undefined overrides returns all required keys", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, undefined);
    for (const key of requiredKeys) {
      expect(result[key]).toBeDefined();
    }
  });

  it("mergeTheme with partial overrides returns all required keys", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, { titleFontSize: 20 });
    for (const key of requiredKeys) {
      expect(result[key]).toBeDefined();
    }
    expect(result.titleFontSize).toBe(20);
  });

  it("resolveChartTheme with no config returns complete theme", () => {
    const result = resolveChartTheme(undefined);
    for (const key of requiredKeys) {
      expect(result[key]).toBeDefined();
    }
  });
});

// ============================================================================
// Palette always has at least 1 color
// ============================================================================

describe("chart palettes", () => {
  it("PALETTE_NAMES is non-empty", () => {
    expect(PALETTE_NAMES.length).toBeGreaterThan(0);
  });

  it("every palette has at least 1 color", () => {
    for (const name of PALETTE_NAMES) {
      expect(PALETTES[name].length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every palette color is a valid hex string", () => {
    for (const name of PALETTE_NAMES) {
      for (const color of PALETTES[name]) {
        expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });
});
