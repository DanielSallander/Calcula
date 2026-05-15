//! FILENAME: app/extensions/Charts/rendering/__tests__/barChartPainter.test.ts
// PURPOSE: Tests for bar chart geometry computation (computeBarRects, computeLayout).

import { describe, it, expect } from "vitest";
import { computeBarRects, computeLayout } from "../barChartPainter";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ParsedChartData } from "../../types";

// ============================================================================
// Test Helpers
// ============================================================================

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { startRow: 0, startCol: 0, endRow: 3, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: {
      title: null,
      gridLines: false,
      showLabels: true,
      labelAngle: 0,
      min: null,
      max: null,
    },
    yAxis: {
      title: null,
      gridLines: true,
      showLabels: true,
      labelAngle: 0,
      min: null,
      max: null,
    },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...overrides,
  };
}

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["Jan", "Feb", "Mar"],
    series: [{ name: "Sales", values: [100, 200, 300], color: null }],
    ...overrides,
  };
}

// ============================================================================
// computeLayout
// ============================================================================

describe("computeLayout", () => {
  it("returns layout with correct dimensions", () => {
    const layout = computeLayout(600, 400, makeSpec(), makeData(), DEFAULT_CHART_THEME);
    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });
});

// ============================================================================
// computeBarRects - Grouped
// ============================================================================

describe("computeBarRects (grouped)", () => {
  it("returns one rect per category for single series", () => {
    const spec = makeSpec();
    const data = makeData();
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(3);
    expect(rects[0].categoryName).toBe("Jan");
    expect(rects[1].categoryName).toBe("Feb");
    expect(rects[2].categoryName).toBe("Mar");
  });

  it("returns rects for multiple series", () => {
    const data = makeData({
      series: [
        { name: "Sales", values: [100, 200, 300], color: null },
        { name: "Costs", values: [50, 100, 150], color: null },
      ],
    });
    const spec = makeSpec({
      series: [
        { name: "Sales", sourceIndex: 1, color: null },
        { name: "Costs", sourceIndex: 2, color: null },
      ],
    });
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    // 3 categories * 2 series = 6 rects
    expect(rects).toHaveLength(6);
  });

  it("preserves correct values in rects", () => {
    const data = makeData({ series: [{ name: "S", values: [10, 20, 30], color: null }] });
    const spec = makeSpec();
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects[0].value).toBe(10);
    expect(rects[1].value).toBe(20);
    expect(rects[2].value).toBe(30);
  });

  it("bars have positive width and height", () => {
    const data = makeData();
    const spec = makeSpec();
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    for (const rect of rects) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
  });

  it("bars are ordered left-to-right by category", () => {
    const data = makeData();
    const spec = makeSpec();
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects[0].x).toBeLessThan(rects[1].x);
    expect(rects[1].x).toBeLessThan(rects[2].x);
  });

  it("taller bars have lower y (canvas coordinates)", () => {
    const data = makeData({ series: [{ name: "S", values: [100, 200, 300], color: null }] });
    const spec = makeSpec();
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    // Larger values should have smaller y (higher on screen)
    expect(rects[2].y).toBeLessThan(rects[0].y);
  });

  it("returns empty array when no series", () => {
    const data = makeData({ series: [] });
    const spec = makeSpec({ series: [] });
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(0);
  });
});

// ============================================================================
// computeBarRects - Stacked
// ============================================================================

describe("computeBarRects (stacked)", () => {
  it("stacks bars vertically within each category", () => {
    const data = makeData({
      series: [
        { name: "A", values: [100, 200], color: null },
        { name: "B", values: [50, 100], color: null },
      ],
      categories: ["Jan", "Feb"],
    });
    const spec = makeSpec({
      series: [
        { name: "A", sourceIndex: 1, color: null },
        { name: "B", sourceIndex: 2, color: null },
      ],
      markOptions: { stackMode: "stacked" },
    });
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    // Should have 4 rects (2 categories * 2 series)
    expect(rects).toHaveLength(4);

    // All bars in same category should have same x position (stacked, not side-by-side)
    const janRects = rects.filter((r) => r.categoryName === "Jan");
    expect(janRects).toHaveLength(2);
    expect(janRects[0].x).toBe(janRects[1].x);
  });

  it("percent stacked normalizes values", () => {
    const data = makeData({
      series: [
        { name: "A", values: [75], color: null },
        { name: "B", values: [25], color: null },
      ],
      categories: ["Q1"],
    });
    const spec = makeSpec({
      series: [
        { name: "A", sourceIndex: 1, color: null },
        { name: "B", sourceIndex: 2, color: null },
      ],
      markOptions: { stackMode: "percentStacked" },
    });
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(2);
    // Both rects should exist and have raw values preserved
    expect(rects[0].value).toBe(75);
    expect(rects[1].value).toBe(25);
  });
});

// ============================================================================
// computeBarRects - Negative values
// ============================================================================

describe("computeBarRects (negative values)", () => {
  it("handles negative values correctly", () => {
    const data = makeData({
      series: [{ name: "PnL", values: [100, -50, 200], color: null }],
    });
    const spec = makeSpec();
    const layout = computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(3);
    // All rects should have positive height
    for (const rect of rects) {
      expect(rect.height).toBeGreaterThan(0);
    }
  });
});
