//! FILENAME: app/extensions/Charts/lib/__tests__/chart-config-defaults.test.ts
// PURPOSE: Tests for chart configuration builder patterns and default value chains.

import { describe, it, expect } from "vitest";
import { buildDefaultSpec } from "../chartSpecDefaults";
import {
  CHART_STYLE_PRESETS,
  getPresetById,
  getPresetsByCategory,
  getPresetColors,
  buildPresetUpdates,
} from "../chartStylePresets";
import type { ChartType, ChartSeries, DataRangeRef } from "../../types";
import { DEFAULT_CHART_THEME } from "../../rendering/chartTheme";

// ============================================================================
// Shared fixtures
// ============================================================================

const dataRange: DataRangeRef = {
  sheetIndex: 0,
  startRow: 0,
  startCol: 0,
  endRow: 9,
  endCol: 3,
};

const autoDetected = {
  categoryIndex: 0,
  series: [
    { name: "Revenue", sourceIndex: 1, color: null },
    { name: "Costs", sourceIndex: 2, color: null },
  ] as ChartSeries[],
  orientation: "columns" as const,
};

const ALL_CHART_TYPES: ChartType[] = [
  "bar", "horizontalBar", "line", "area", "scatter", "pie", "donut",
  "waterfall", "combo", "radar", "bubble", "histogram", "funnel",
  "treemap", "stock", "boxPlot", "sunburst", "pareto",
];

// ============================================================================
// buildDefaultSpec for every chart type
// ============================================================================

describe("buildDefaultSpec - all chart types", () => {
  for (const chartType of ALL_CHART_TYPES) {
    it(`produces a valid spec for "${chartType}"`, () => {
      const spec = buildDefaultSpec(dataRange, true, autoDetected, chartType);
      expect(spec.mark).toBe(chartType);
      expect(spec.data).toEqual(dataRange);
      expect(spec.hasHeaders).toBe(true);
      expect(spec.seriesOrientation).toBe("columns");
      expect(spec.categoryIndex).toBe(0);
      expect(spec.series).toHaveLength(2);
      expect(spec.title).toBeNull();
      expect(spec.xAxis).toBeDefined();
      expect(spec.yAxis).toBeDefined();
      expect(spec.legend).toBeDefined();
      expect(spec.palette).toBe("default");
    });
  }
});

// ============================================================================
// Optional fields have sensible defaults (not undefined where value expected)
// ============================================================================

describe("buildDefaultSpec - optional fields are sensible", () => {
  it("axis specs have no undefined required fields", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    // All required AxisSpec fields must be defined
    for (const axis of [spec.xAxis, spec.yAxis]) {
      expect(axis.title).toBeDefined(); // null is defined
      expect(typeof axis.gridLines).toBe("boolean");
      expect(typeof axis.showLabels).toBe("boolean");
      expect(typeof axis.labelAngle).toBe("number");
      // min/max are nullable but must be explicitly set
      expect("min" in axis).toBe(true);
      expect("max" in axis).toBe(true);
    }
  });

  it("legend has both visible and position set", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(typeof spec.legend.visible).toBe("boolean");
    expect(typeof spec.legend.position).toBe("string");
  });

  it("palette is a non-empty string", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(spec.palette.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Spec with no overrides matches spec with empty overrides
// ============================================================================

describe("buildDefaultSpec - no overrides vs empty overrides", () => {
  it("calling with default mark type matches calling without mark type", () => {
    const specNoMark = buildDefaultSpec(dataRange, true, autoDetected);
    const specBarMark = buildDefaultSpec(dataRange, true, autoDetected, "bar");
    expect(specNoMark).toEqual(specBarMark);
  });

  it("two calls with identical args produce identical specs", () => {
    const spec1 = buildDefaultSpec(dataRange, true, autoDetected, "line");
    const spec2 = buildDefaultSpec(dataRange, true, autoDetected, "line");
    expect(spec1).toEqual(spec2);
  });
});

// ============================================================================
// Partial overrides only modify specified fields
// ============================================================================

describe("buildDefaultSpec - partial overrides", () => {
  it("changing mark type does not affect axis or legend", () => {
    const barSpec = buildDefaultSpec(dataRange, true, autoDetected, "bar");
    const lineSpec = buildDefaultSpec(dataRange, true, autoDetected, "line");
    expect(barSpec.xAxis).toEqual(lineSpec.xAxis);
    expect(barSpec.yAxis).toEqual(lineSpec.yAxis);
    expect(barSpec.legend).toEqual(lineSpec.legend);
  });

  it("different series input only changes series field", () => {
    const singleSeries = {
      categoryIndex: 0,
      series: [{ name: "A", sourceIndex: 1, color: null }] as ChartSeries[],
      orientation: "columns" as const,
    };
    const spec1 = buildDefaultSpec(dataRange, true, autoDetected);
    const spec2 = buildDefaultSpec(dataRange, true, singleSeries);
    expect(spec1.xAxis).toEqual(spec2.xAxis);
    expect(spec1.yAxis).toEqual(spec2.yAxis);
    expect(spec1.legend).toEqual(spec2.legend);
    expect(spec1.palette).toEqual(spec2.palette);
    expect(spec1.series).not.toEqual(spec2.series);
  });
});

// ============================================================================
// Theme defaults vs explicit theme values
// ============================================================================

describe("theme defaults vs explicit values", () => {
  it("DEFAULT_CHART_THEME has all required fields defined", () => {
    expect(typeof DEFAULT_CHART_THEME.background).toBe("string");
    expect(typeof DEFAULT_CHART_THEME.plotBackground).toBe("string");
    expect(typeof DEFAULT_CHART_THEME.gridLineColor).toBe("string");
    expect(typeof DEFAULT_CHART_THEME.gridLineWidth).toBe("number");
    expect(typeof DEFAULT_CHART_THEME.axisColor).toBe("string");
    expect(typeof DEFAULT_CHART_THEME.axisLabelColor).toBe("string");
    expect(typeof DEFAULT_CHART_THEME.axisTitleColor).toBe("string");
    expect(typeof DEFAULT_CHART_THEME.titleColor).toBe("string");
    expect(typeof DEFAULT_CHART_THEME.legendTextColor).toBe("string");
    expect(typeof DEFAULT_CHART_THEME.fontFamily).toBe("string");
    expect(typeof DEFAULT_CHART_THEME.titleFontSize).toBe("number");
    expect(typeof DEFAULT_CHART_THEME.axisTitleFontSize).toBe("number");
    expect(typeof DEFAULT_CHART_THEME.labelFontSize).toBe("number");
    expect(typeof DEFAULT_CHART_THEME.legendFontSize).toBe("number");
    expect(typeof DEFAULT_CHART_THEME.barBorderRadius).toBe("number");
    expect(typeof DEFAULT_CHART_THEME.barGap).toBe("number");
  });

  it("all presets have theme overrides that are subsets of ChartRenderTheme keys", () => {
    const validKeys = new Set(Object.keys(DEFAULT_CHART_THEME).concat(
      ["backgroundGradient", "plotBackgroundGradient"]
    ));
    for (const preset of CHART_STYLE_PRESETS) {
      for (const key of Object.keys(preset.theme)) {
        expect(validKeys.has(key)).toBe(true);
      }
    }
  });

  it("every preset has a non-empty id and name", () => {
    for (const preset of CHART_STYLE_PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0);
      expect(preset.name.length).toBeGreaterThan(0);
    }
  });

  it("getPresetById returns undefined for unknown id", () => {
    expect(getPresetById("nonexistent")).toBeUndefined();
  });

  it("getPresetById returns the correct preset", () => {
    const preset = getPresetById("colorful-1");
    expect(preset).toBeDefined();
    expect(preset!.name).toBe("Classic");
  });

  it("getPresetsByCategory groups all presets", () => {
    const grouped = getPresetsByCategory();
    const totalGrouped = Object.values(grouped).reduce((s, a) => s + a.length, 0);
    expect(totalGrouped).toBe(CHART_STYLE_PRESETS.length);
  });

  it("getPresetColors returns an array of 4 colors", () => {
    const preset = CHART_STYLE_PRESETS[0];
    const colors = getPresetColors(preset);
    expect(colors).toHaveLength(4);
    for (const c of colors) {
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("buildPresetUpdates includes palette and config", () => {
    const preset = CHART_STYLE_PRESETS[0];
    const currentSpec = { yAxis: { gridLines: true }, markOptions: {} };
    const updates = buildPresetUpdates(preset, currentSpec as any);
    expect(updates.palette).toBe(preset.palette);
    expect(updates.config).toBeDefined();
  });
});
