//! FILENAME: app/extensions/Charts/rendering/__tests__/chartPainterUtils.test.ts
// PURPOSE: Tests for chart layout computation and utility functions.

import { describe, it, expect } from "vitest";
import {
  computeCartesianLayout,
  computeRadialLayout,
  formatTickValue,
} from "../chartPainterUtils";
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
    legend: {
      visible: true,
      position: "bottom",
    },
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
// computeCartesianLayout
// ============================================================================

describe("computeCartesianLayout", () => {
  const width = 600;
  const height = 400;

  it("returns correct total width and height", () => {
    const layout = computeCartesianLayout(width, height, makeSpec(), makeData(), DEFAULT_CHART_THEME);
    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
  });

  it("plot area is inside the margins", () => {
    const layout = computeCartesianLayout(width, height, makeSpec(), makeData(), DEFAULT_CHART_THEME);
    expect(layout.plotArea.x).toBe(layout.margin.left);
    expect(layout.plotArea.y).toBe(layout.margin.top);
    expect(layout.plotArea.width).toBe(width - layout.margin.left - layout.margin.right);
    expect(layout.plotArea.height).toBe(height - layout.margin.top - layout.margin.bottom);
  });

  it("increases top margin when title is set", () => {
    const noTitle = computeCartesianLayout(width, height, makeSpec({ title: null }), makeData(), DEFAULT_CHART_THEME);
    const withTitle = computeCartesianLayout(width, height, makeSpec({ title: "My Chart" }), makeData(), DEFAULT_CHART_THEME);
    expect(withTitle.margin.top).toBeGreaterThan(noTitle.margin.top);
  });

  it("increases left margin when y-axis labels are shown", () => {
    const hidden = computeCartesianLayout(
      width, height,
      makeSpec({ yAxis: { ...makeSpec().yAxis, showLabels: false } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const shown = computeCartesianLayout(
      width, height,
      makeSpec({ yAxis: { ...makeSpec().yAxis, showLabels: true } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(shown.margin.left).toBeGreaterThan(hidden.margin.left);
  });

  it("increases left margin when y-axis title is set", () => {
    const noYTitle = computeCartesianLayout(
      width, height,
      makeSpec({ yAxis: { ...makeSpec().yAxis, title: null } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const withYTitle = computeCartesianLayout(
      width, height,
      makeSpec({ yAxis: { ...makeSpec().yAxis, title: "Revenue" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(withYTitle.margin.left).toBeGreaterThan(noYTitle.margin.left);
  });

  it("increases bottom margin for x-axis labels at angle 0", () => {
    const hidden = computeCartesianLayout(
      width, height,
      makeSpec({ xAxis: { ...makeSpec().xAxis, showLabels: false } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const shown = computeCartesianLayout(
      width, height,
      makeSpec({ xAxis: { ...makeSpec().xAxis, showLabels: true, labelAngle: 0 } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(shown.margin.bottom).toBeGreaterThan(hidden.margin.bottom);
  });

  it("increases bottom margin more for angled labels (45 degrees)", () => {
    const angle0 = computeCartesianLayout(
      width, height,
      makeSpec({ xAxis: { ...makeSpec().xAxis, showLabels: true, labelAngle: 0 } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const angle45 = computeCartesianLayout(
      width, height,
      makeSpec({ xAxis: { ...makeSpec().xAxis, showLabels: true, labelAngle: 45 } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(angle45.margin.bottom).toBeGreaterThan(angle0.margin.bottom);
  });

  it("increases bottom margin for x-axis title", () => {
    const noXTitle = computeCartesianLayout(
      width, height,
      makeSpec({ xAxis: { ...makeSpec().xAxis, title: null } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const withXTitle = computeCartesianLayout(
      width, height,
      makeSpec({ xAxis: { ...makeSpec().xAxis, title: "Month" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(withXTitle.margin.bottom).toBeGreaterThan(noXTitle.margin.bottom);
  });

  it("adds space for bottom legend", () => {
    const noLegend = computeCartesianLayout(
      width, height,
      makeSpec({ legend: { visible: false, position: "bottom" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const withLegend = computeCartesianLayout(
      width, height,
      makeSpec({ legend: { visible: true, position: "bottom" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(withLegend.margin.bottom).toBeGreaterThan(noLegend.margin.bottom);
  });

  it("adds space for top legend", () => {
    const noLegend = computeCartesianLayout(
      width, height,
      makeSpec({ legend: { visible: false, position: "top" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const withLegend = computeCartesianLayout(
      width, height,
      makeSpec({ legend: { visible: true, position: "top" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(withLegend.margin.top).toBeGreaterThan(noLegend.margin.top);
  });

  it("adds space for right legend", () => {
    const noLegend = computeCartesianLayout(
      width, height,
      makeSpec({ legend: { visible: false, position: "right" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const withLegend = computeCartesianLayout(
      width, height,
      makeSpec({ legend: { visible: true, position: "right" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(withLegend.margin.right).toBeGreaterThan(noLegend.margin.right);
  });

  it("adds space for left legend", () => {
    const noLegend = computeCartesianLayout(
      width, height,
      makeSpec({ legend: { visible: false, position: "left" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const withLegend = computeCartesianLayout(
      width, height,
      makeSpec({ legend: { visible: true, position: "left" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(withLegend.margin.left).toBeGreaterThan(noLegend.margin.left);
  });

  it("enforces minimum plot area of 10x10", () => {
    const layout = computeCartesianLayout(
      20, 20,  // very small canvas
      makeSpec({ title: "Title", xAxis: { ...makeSpec().xAxis, title: "X" }, yAxis: { ...makeSpec().yAxis, title: "Y" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(layout.plotArea.width).toBeGreaterThanOrEqual(10);
    expect(layout.plotArea.height).toBeGreaterThanOrEqual(10);
  });

  it("handles no series data gracefully", () => {
    const data = makeData({ series: [] });
    const spec = makeSpec({ legend: { visible: true, position: "bottom" } });
    const layout = computeCartesianLayout(width, height, spec, data, DEFAULT_CHART_THEME);
    expect(layout.width).toBe(width);
    expect(layout.height).toBe(height);
  });

  it("wider y-axis labels for large values", () => {
    const smallData = makeData({ series: [{ name: "S", values: [1, 2, 3], color: null }] });
    const bigData = makeData({ series: [{ name: "S", values: [1000000, 2000000, 3000000], color: null }] });
    const smallLayout = computeCartesianLayout(width, height, makeSpec(), smallData, DEFAULT_CHART_THEME);
    const bigLayout = computeCartesianLayout(width, height, makeSpec(), bigData, DEFAULT_CHART_THEME);
    expect(bigLayout.margin.left).toBeGreaterThanOrEqual(smallLayout.margin.left);
  });
});

// ============================================================================
// computeRadialLayout
// ============================================================================

describe("computeRadialLayout", () => {
  const width = 500;
  const height = 500;

  it("returns correct total width and height", () => {
    const layout = computeRadialLayout(width, height, makeSpec(), makeData(), DEFAULT_CHART_THEME);
    expect(layout.width).toBe(500);
    expect(layout.height).toBe(500);
  });

  it("plot area is inside margins", () => {
    const layout = computeRadialLayout(width, height, makeSpec(), makeData(), DEFAULT_CHART_THEME);
    expect(layout.plotArea.x).toBe(layout.margin.left);
    expect(layout.plotArea.y).toBe(layout.margin.top);
  });

  it("increases top margin when title is set", () => {
    const noTitle = computeRadialLayout(width, height, makeSpec({ title: null }), makeData(), DEFAULT_CHART_THEME);
    const withTitle = computeRadialLayout(width, height, makeSpec({ title: "Pie Chart" }), makeData(), DEFAULT_CHART_THEME);
    expect(withTitle.margin.top).toBeGreaterThan(noTitle.margin.top);
  });

  it("increases bottom margin for bottom legend", () => {
    const noLegend = computeRadialLayout(
      width, height,
      makeSpec({ legend: { visible: false, position: "bottom" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    const withLegend = computeRadialLayout(
      width, height,
      makeSpec({ legend: { visible: true, position: "bottom" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(withLegend.margin.bottom).toBeGreaterThan(noLegend.margin.bottom);
  });

  it("uses category names for right/left legend sizing", () => {
    const shortCats = makeData({ categories: ["A", "B", "C"] });
    const longCats = makeData({ categories: ["Very Long Category A", "Very Long Category B", "Very Long Category C"] });
    const shortLayout = computeRadialLayout(
      width, height,
      makeSpec({ legend: { visible: true, position: "right" } }),
      shortCats,
      DEFAULT_CHART_THEME,
    );
    const longLayout = computeRadialLayout(
      width, height,
      makeSpec({ legend: { visible: true, position: "right" } }),
      longCats,
      DEFAULT_CHART_THEME,
    );
    expect(longLayout.margin.right).toBeGreaterThan(shortLayout.margin.right);
  });

  it("enforces minimum plot area of 10x10", () => {
    const layout = computeRadialLayout(
      20, 20,
      makeSpec({ title: "T", legend: { visible: true, position: "bottom" } }),
      makeData(),
      DEFAULT_CHART_THEME,
    );
    expect(layout.plotArea.width).toBeGreaterThanOrEqual(10);
    expect(layout.plotArea.height).toBeGreaterThanOrEqual(10);
  });
});

// ============================================================================
// formatTickValue
// ============================================================================

describe("formatTickValue", () => {
  it("formats millions with M suffix", () => {
    expect(formatTickValue(1000000)).toBe("1.0M");
    expect(formatTickValue(2500000)).toBe("2.5M");
    expect(formatTickValue(-5000000)).toBe("-5.0M");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTickValue(1000)).toBe("1.0K");
    expect(formatTickValue(2500)).toBe("2.5K");
    expect(formatTickValue(-3000)).toBe("-3.0K");
  });

  it("formats integers without decimal", () => {
    expect(formatTickValue(0)).toBe("0");
    expect(formatTickValue(42)).toBe("42");
    expect(formatTickValue(-7)).toBe("-7");
    expect(formatTickValue(999)).toBe("999");
  });

  it("formats non-integer small values with one decimal", () => {
    expect(formatTickValue(0.5)).toBe("0.5");
    expect(formatTickValue(3.7)).toBe("3.7");
    expect(formatTickValue(-1.3)).toBe("-1.3");
  });

  it("handles zero", () => {
    expect(formatTickValue(0)).toBe("0");
  });

  it("handles boundary between K and M", () => {
    expect(formatTickValue(999999)).toBe("1000.0K");
    expect(formatTickValue(1000000)).toBe("1.0M");
  });

  it("handles very large millions", () => {
    expect(formatTickValue(100000000)).toBe("100.0M");
  });
});
