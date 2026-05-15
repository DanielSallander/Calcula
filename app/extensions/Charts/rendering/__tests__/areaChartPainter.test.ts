//! FILENAME: app/extensions/Charts/rendering/__tests__/areaChartPainter.test.ts
// PURPOSE: Tests for area chart geometry computation (computeAreaPointMarkers, computeAreaLayout).

import { describe, it, expect } from "vitest";
import { computeAreaPointMarkers, computeAreaLayout } from "../areaChartPainter";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ParsedChartData } from "../../types";

// ============================================================================
// Test Helpers
// ============================================================================

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "area",
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
// computeAreaLayout
// ============================================================================

describe("computeAreaLayout", () => {
  it("returns layout with correct dimensions", () => {
    const layout = computeAreaLayout(600, 400, makeSpec(), makeData(), DEFAULT_CHART_THEME);
    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });
});

// ============================================================================
// computeAreaPointMarkers - Non-stacked
// ============================================================================

describe("computeAreaPointMarkers (non-stacked)", () => {
  it("returns one marker per data point", () => {
    const data = makeData();
    const spec = makeSpec();
    const layout = computeAreaLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeAreaPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers).toHaveLength(3);
  });

  it("markers for multiple series", () => {
    const data = makeData({
      series: [
        { name: "A", values: [10, 20, 30], color: null },
        { name: "B", values: [5, 15, 25], color: null },
      ],
    });
    const spec = makeSpec({
      series: [
        { name: "A", sourceIndex: 1, color: null },
        { name: "B", sourceIndex: 2, color: null },
      ],
    });
    const layout = computeAreaLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeAreaPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers).toHaveLength(6); // 3 categories * 2 series
  });

  it("preserves correct values and names", () => {
    const data = makeData();
    const spec = makeSpec();
    const layout = computeAreaLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeAreaPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers[0].value).toBe(100);
    expect(markers[0].seriesName).toBe("Sales");
    expect(markers[0].categoryName).toBe("Jan");
    expect(markers[1].value).toBe(200);
    expect(markers[2].value).toBe(300);
  });

  it("larger values produce lower cy (higher on screen)", () => {
    const data = makeData({ series: [{ name: "S", values: [100, 200, 300], color: null }] });
    const spec = makeSpec();
    const layout = computeAreaLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeAreaPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers[2].cy).toBeLessThan(markers[0].cy);
  });

  it("markers are ordered left-to-right by category", () => {
    const data = makeData();
    const spec = makeSpec();
    const layout = computeAreaLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeAreaPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers[0].cx).toBeLessThan(markers[1].cx);
    expect(markers[1].cx).toBeLessThan(markers[2].cx);
  });
});

// ============================================================================
// computeAreaPointMarkers - Stacked
// ============================================================================

describe("computeAreaPointMarkers (stacked)", () => {
  it("stacked mode accumulates values", () => {
    const data = makeData({
      categories: ["Q1"],
      series: [
        { name: "A", values: [100], color: null },
        { name: "B", values: [50], color: null },
      ],
    });
    const spec = makeSpec({
      series: [
        { name: "A", sourceIndex: 1, color: null },
        { name: "B", sourceIndex: 2, color: null },
      ],
      markOptions: { stackMode: "stacked" },
    });
    const layout = computeAreaLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeAreaPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers).toHaveLength(2);
    // Original values should be preserved
    expect(markers[0].value).toBe(100);
    expect(markers[1].value).toBe(50);
    // Second series marker should be higher on screen (lower cy) due to stacking
    expect(markers[1].cy).toBeLessThan(markers[0].cy);
  });

  it("percent stacked preserves original values", () => {
    const data = makeData({
      categories: ["Q1"],
      series: [
        { name: "A", values: [75], color: null },
        { name: "B", values: [25], color: null },
      ],
    });
    const spec = makeSpec({
      series: [
        { name: "A", sourceIndex: 1, color: null },
        { name: "B", sourceIndex: 2, color: null },
      ],
      markOptions: { stackMode: "percentStacked" },
    });
    const layout = computeAreaLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeAreaPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    // Original values preserved
    expect(markers[0].value).toBe(75);
    expect(markers[1].value).toBe(25);
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe("computeAreaPointMarkers (edge cases)", () => {
  it("returns empty array when no series", () => {
    const data = makeData({ series: [] });
    const spec = makeSpec({ series: [] });
    const layout = computeAreaLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeAreaPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers).toHaveLength(0);
  });

  it("handles single data point", () => {
    const data = makeData({
      categories: ["Only"],
      series: [{ name: "S", values: [42], color: null }],
    });
    const spec = makeSpec();
    const layout = computeAreaLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeAreaPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers).toHaveLength(1);
    expect(markers[0].value).toBe(42);
  });
});
