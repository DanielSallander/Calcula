//! FILENAME: app/extensions/Charts/rendering/__tests__/chartLayoutComputation.test.ts
// PURPOSE: Tests for layout computation functions (cartesian and radial).

import { describe, it, expect } from "vitest";
import {
  computeCartesianLayout,
  computeRadialLayout,
  formatTickValue,
} from "../chartPainterUtils";
import type { ChartSpec, ParsedChartData } from "../../types";
import type { ChartRenderTheme } from "../chartTheme";

// ============================================================================
// Test Helpers
// ============================================================================

function makeTheme(overrides: Partial<ChartRenderTheme> = {}): ChartRenderTheme {
  return {
    background: "#ffffff",
    plotBackground: "#fafafa",
    gridLineColor: "#e8e8e8",
    gridLineWidth: 1,
    axisColor: "#999999",
    axisLabelColor: "#666666",
    axisTitleColor: "#333333",
    titleColor: "#222222",
    legendTextColor: "#555555",
    fontFamily: "Segoe UI",
    titleFontSize: 14,
    labelFontSize: 11,
    axisTitleFontSize: 12,
    legendFontSize: 11,
    ...overrides,
  } as ChartRenderTheme;
}

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    title: "",
    data: { type: "range", range: "A1:B3" },
    series: [{ values: "B1:B3" }],
    xAxis: { showLabels: true, labelAngle: 0 },
    yAxis: { showLabels: true },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...overrides,
  } as ChartSpec;
}

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["Jan", "Feb", "Mar"],
    series: [{ name: "Sales", values: [100, 200, 300] }],
    ...overrides,
  } as ParsedChartData;
}

// ============================================================================
// computeCartesianLayout
// ============================================================================

describe("computeCartesianLayout", () => {
  const theme = makeTheme();

  it("produces a layout that fits within the given dimensions", () => {
    const layout = computeCartesianLayout(600, 400, makeSpec(), makeData(), theme);
    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
    expect(layout.plotArea.x).toBeGreaterThan(0);
    expect(layout.plotArea.y).toBeGreaterThan(0);
    expect(layout.plotArea.x + layout.plotArea.width).toBeLessThanOrEqual(600);
    expect(layout.plotArea.y + layout.plotArea.height).toBeLessThanOrEqual(400);
  });

  it("increases top margin when title is present", () => {
    const noTitle = computeCartesianLayout(600, 400, makeSpec({ title: "" }), makeData(), theme);
    const withTitle = computeCartesianLayout(600, 400, makeSpec({ title: "My Chart" }), makeData(), theme);
    expect(withTitle.margin.top).toBeGreaterThan(noTitle.margin.top);
    expect(withTitle.plotArea.height).toBeLessThan(noTitle.plotArea.height);
  });

  it("increases left margin when y-axis labels are shown", () => {
    const noLabels = computeCartesianLayout(
      600, 400,
      makeSpec({ yAxis: { showLabels: false } }),
      makeData(),
      theme,
    );
    const withLabels = computeCartesianLayout(
      600, 400,
      makeSpec({ yAxis: { showLabels: true } }),
      makeData(),
      theme,
    );
    expect(withLabels.margin.left).toBeGreaterThan(noLabels.margin.left);
  });

  it("increases bottom margin for angled x-axis labels", () => {
    const angle0 = computeCartesianLayout(
      600, 400,
      makeSpec({ xAxis: { showLabels: true, labelAngle: 0 } }),
      makeData(),
      theme,
    );
    const angle90 = computeCartesianLayout(
      600, 400,
      makeSpec({ xAxis: { showLabels: true, labelAngle: 90 } }),
      makeData({ categories: ["January", "February", "March"] }),
      theme,
    );
    expect(angle90.margin.bottom).toBeGreaterThan(angle0.margin.bottom);
  });

  it("increases bottom margin for bottom legend", () => {
    const noLegend = computeCartesianLayout(
      600, 400,
      makeSpec({ legend: { visible: false, position: "bottom" } }),
      makeData(),
      theme,
    );
    const withLegend = computeCartesianLayout(
      600, 400,
      makeSpec({ legend: { visible: true, position: "bottom" } }),
      makeData(),
      theme,
    );
    expect(withLegend.margin.bottom).toBeGreaterThan(noLegend.margin.bottom);
  });

  it("increases right margin for right legend", () => {
    const noLegend = computeCartesianLayout(
      600, 400,
      makeSpec({ legend: { visible: false, position: "right" } }),
      makeData(),
      theme,
    );
    const withLegend = computeCartesianLayout(
      600, 400,
      makeSpec({ legend: { visible: true, position: "right" } }),
      makeData(),
      theme,
    );
    expect(withLegend.margin.right).toBeGreaterThan(noLegend.margin.right);
  });

  it("ensures minimum plot area dimensions even with tiny chart", () => {
    const layout = computeCartesianLayout(50, 50, makeSpec({ title: "Title" }), makeData(), theme);
    expect(layout.plotArea.width).toBeGreaterThanOrEqual(10);
    expect(layout.plotArea.height).toBeGreaterThanOrEqual(10);
  });

  it("increases left margin for left legend", () => {
    const layout = computeCartesianLayout(
      600, 400,
      makeSpec({ legend: { visible: true, position: "left" } }),
      makeData(),
      theme,
    );
    expect(layout.margin.left).toBeGreaterThan(16); // base left is 16
  });

  it("increases top margin for top legend", () => {
    const layout = computeCartesianLayout(
      600, 400,
      makeSpec({ legend: { visible: true, position: "top" } }),
      makeData(),
      theme,
    );
    expect(layout.margin.top).toBeGreaterThan(12); // base top is 12
  });
});

// ============================================================================
// computeRadialLayout
// ============================================================================

describe("computeRadialLayout", () => {
  const theme = makeTheme();

  it("produces valid layout for radial chart", () => {
    const layout = computeRadialLayout(400, 400, makeSpec({ mark: "pie" }), makeData(), theme);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });

  it("increases right margin for right legend using category names", () => {
    const noLeg = computeRadialLayout(
      400, 400,
      makeSpec({ mark: "pie", legend: { visible: false, position: "right" } }),
      makeData(),
      theme,
    );
    const withLeg = computeRadialLayout(
      400, 400,
      makeSpec({ mark: "pie", legend: { visible: true, position: "right" } }),
      makeData(),
      theme,
    );
    expect(withLeg.margin.right).toBeGreaterThan(noLeg.margin.right);
  });
});

// ============================================================================
// formatTickValue
// ============================================================================

describe("formatTickValue", () => {
  it("formats millions", () => {
    expect(formatTickValue(2_500_000)).toBe("2.5M");
  });

  it("formats thousands", () => {
    expect(formatTickValue(12_500)).toBe("12.5K");
  });

  it("formats integers without decimals", () => {
    expect(formatTickValue(42)).toBe("42");
  });

  it("formats small decimals with one decimal place", () => {
    expect(formatTickValue(3.14)).toBe("3.1");
  });

  it("formats zero", () => {
    expect(formatTickValue(0)).toBe("0");
  });

  it("formats negative millions", () => {
    expect(formatTickValue(-1_500_000)).toBe("-1.5M");
  });

  it("formats negative thousands", () => {
    expect(formatTickValue(-2_500)).toBe("-2.5K");
  });
});
