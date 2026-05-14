//! FILENAME: app/extensions/Charts/rendering/__tests__/chartTheme.test.ts
// PURPOSE: Tests for chart theme merging, resolution, and palette color logic.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_CHART_THEME,
  mergeTheme,
  resolveChartTheme,
  getSeriesColor,
  PALETTES,
  PALETTE_NAMES,
  type ChartRenderTheme,
} from "../chartTheme";

// ============================================================================
// DEFAULT_CHART_THEME
// ============================================================================

describe("DEFAULT_CHART_THEME", () => {
  it("has all required properties", () => {
    expect(DEFAULT_CHART_THEME.background).toBeTruthy();
    expect(DEFAULT_CHART_THEME.plotBackground).toBeTruthy();
    expect(DEFAULT_CHART_THEME.gridLineColor).toBeTruthy();
    expect(DEFAULT_CHART_THEME.axisColor).toBeTruthy();
    expect(DEFAULT_CHART_THEME.axisLabelColor).toBeTruthy();
    expect(DEFAULT_CHART_THEME.axisTitleColor).toBeTruthy();
    expect(DEFAULT_CHART_THEME.titleColor).toBeTruthy();
    expect(DEFAULT_CHART_THEME.legendTextColor).toBeTruthy();
    expect(DEFAULT_CHART_THEME.fontFamily).toBeTruthy();
    expect(DEFAULT_CHART_THEME.titleFontSize).toBeGreaterThan(0);
    expect(DEFAULT_CHART_THEME.axisTitleFontSize).toBeGreaterThan(0);
    expect(DEFAULT_CHART_THEME.labelFontSize).toBeGreaterThan(0);
    expect(DEFAULT_CHART_THEME.legendFontSize).toBeGreaterThan(0);
    expect(DEFAULT_CHART_THEME.gridLineWidth).toBeGreaterThan(0);
    expect(typeof DEFAULT_CHART_THEME.barBorderRadius).toBe("number");
    expect(typeof DEFAULT_CHART_THEME.barGap).toBe("number");
  });

  it("uses a light background by default", () => {
    expect(DEFAULT_CHART_THEME.background).toBe("#ffffff");
  });

  it("does not have gradient fills by default", () => {
    expect(DEFAULT_CHART_THEME.backgroundGradient).toBeUndefined();
    expect(DEFAULT_CHART_THEME.plotBackgroundGradient).toBeUndefined();
  });
});

// ============================================================================
// mergeTheme
// ============================================================================

describe("mergeTheme", () => {
  it("returns the base theme when overrides is undefined", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, undefined);
    expect(result).toBe(DEFAULT_CHART_THEME);
  });

  it("returns the base theme when overrides is empty", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, {});
    expect(result).toEqual(DEFAULT_CHART_THEME);
  });

  it("merges a single override", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, { background: "#000000" });
    expect(result.background).toBe("#000000");
    // All other fields should be the defaults
    expect(result.plotBackground).toBe(DEFAULT_CHART_THEME.plotBackground);
    expect(result.titleFontSize).toBe(DEFAULT_CHART_THEME.titleFontSize);
  });

  it("merges multiple overrides", () => {
    const result = mergeTheme(DEFAULT_CHART_THEME, {
      background: "#111111",
      titleColor: "#AABBCC",
      barBorderRadius: 8,
    });
    expect(result.background).toBe("#111111");
    expect(result.titleColor).toBe("#AABBCC");
    expect(result.barBorderRadius).toBe(8);
    expect(result.fontFamily).toBe(DEFAULT_CHART_THEME.fontFamily);
  });

  it("can override with gradient fills", () => {
    const gradient = {
      type: "linear" as const,
      stops: [
        { offset: 0, color: "#000" },
        { offset: 1, color: "#FFF" },
      ],
    };
    const result = mergeTheme(DEFAULT_CHART_THEME, { backgroundGradient: gradient });
    expect(result.backgroundGradient).toBe(gradient);
    expect(result.plotBackgroundGradient).toBeUndefined();
  });

  it("does not mutate the base theme", () => {
    const original = { ...DEFAULT_CHART_THEME };
    mergeTheme(DEFAULT_CHART_THEME, { background: "#000000" });
    expect(DEFAULT_CHART_THEME.background).toBe(original.background);
  });

  it("override values take priority over base values", () => {
    const base: ChartRenderTheme = { ...DEFAULT_CHART_THEME, barGap: 5 };
    const result = mergeTheme(base, { barGap: 10 });
    expect(result.barGap).toBe(10);
  });
});

// ============================================================================
// resolveChartTheme
// ============================================================================

describe("resolveChartTheme", () => {
  it("returns the default theme when config is undefined", () => {
    const result = resolveChartTheme(undefined);
    expect(result).toEqual(DEFAULT_CHART_THEME);
  });

  it("returns the default theme when config has no theme", () => {
    const result = resolveChartTheme({});
    expect(result).toEqual(DEFAULT_CHART_THEME);
  });

  it("merges config theme overrides with defaults", () => {
    const result = resolveChartTheme({
      theme: { background: "#222222", titleFontSize: 20 },
    });
    expect(result.background).toBe("#222222");
    expect(result.titleFontSize).toBe(20);
    expect(result.plotBackground).toBe(DEFAULT_CHART_THEME.plotBackground);
  });

  it("handles config with empty theme object", () => {
    const result = resolveChartTheme({ theme: {} });
    expect(result).toEqual(DEFAULT_CHART_THEME);
  });
});

// ============================================================================
// PALETTES & PALETTE_NAMES
// ============================================================================

describe("PALETTES", () => {
  it("contains at least 4 palettes", () => {
    expect(Object.keys(PALETTES).length).toBeGreaterThanOrEqual(4);
  });

  it("has default, vivid, pastel, and ocean palettes", () => {
    expect(PALETTES.default).toBeDefined();
    expect(PALETTES.vivid).toBeDefined();
    expect(PALETTES.pastel).toBeDefined();
    expect(PALETTES.ocean).toBeDefined();
  });

  it("each palette has at least 8 colors", () => {
    for (const [name, colors] of Object.entries(PALETTES)) {
      expect(colors.length).toBeGreaterThanOrEqual(8);
    }
  });

  it("all palette colors are valid hex codes", () => {
    for (const [, colors] of Object.entries(PALETTES)) {
      for (const color of colors) {
        expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });
});

describe("PALETTE_NAMES", () => {
  it("matches the keys of PALETTES", () => {
    expect(PALETTE_NAMES).toEqual(Object.keys(PALETTES));
  });
});

// ============================================================================
// getSeriesColor
// ============================================================================

describe("getSeriesColor", () => {
  it("returns the override color when provided", () => {
    expect(getSeriesColor("default", 0, "#FF0000")).toBe("#FF0000");
    expect(getSeriesColor("vivid", 5, "#CUSTOM")).toBe("#CUSTOM");
  });

  it("returns palette color when override is null", () => {
    const firstDefault = PALETTES.default[0];
    expect(getSeriesColor("default", 0, null)).toBe(firstDefault);
  });

  it("cycles through palette colors", () => {
    const paletteLen = PALETTES.default.length;
    expect(getSeriesColor("default", 0, null)).toBe(
      getSeriesColor("default", paletteLen, null),
    );
    expect(getSeriesColor("default", 1, null)).toBe(
      getSeriesColor("default", paletteLen + 1, null),
    );
  });

  it("uses the correct palette", () => {
    expect(getSeriesColor("vivid", 0, null)).toBe(PALETTES.vivid[0]);
    expect(getSeriesColor("pastel", 0, null)).toBe(PALETTES.pastel[0]);
    expect(getSeriesColor("ocean", 0, null)).toBe(PALETTES.ocean[0]);
  });

  it("falls back to default palette for unknown palette name", () => {
    expect(getSeriesColor("nonexistent", 0, null)).toBe(PALETTES.default[0]);
    expect(getSeriesColor("", 0, null)).toBe(PALETTES.default[0]);
  });

  it("handles large series indices via cycling", () => {
    const color100 = getSeriesColor("default", 100, null);
    const expected = PALETTES.default[100 % PALETTES.default.length];
    expect(color100).toBe(expected);
  });
});
