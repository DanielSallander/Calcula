//! FILENAME: app/extensions/Charts/rendering/__tests__/chart-layout-combos.test.ts
// PURPOSE: Tests for chart layout computation with various feature combinations.
// CONTEXT: Ensures margins and plot area adapt correctly when multiple chrome
//          elements (title, legend, axes, secondary axis) are enabled together.

import { describe, it, expect } from "vitest";
import { computeCartesianLayout, computeRadialLayout } from "../chartPainterUtils";
import { DEFAULT_CHART_THEME, resolveChartTheme } from "../chartTheme";
import type { ChartSpec, ParsedChartData, AxisSpec, ChartLayout } from "../../types";
import type { ChartRenderTheme } from "../chartTheme";

// ============================================================================
// Helpers
// ============================================================================

const W = 800;
const H = 600;

function makeAxis(overrides: Partial<AxisSpec> = {}): AxisSpec {
  return {
    title: null,
    gridLines: true,
    showLabels: true,
    labelAngle: 0,
    min: null,
    max: null,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Sales", sourceIndex: 1, color: null },
      { name: "Cost", sourceIndex: 2, color: null },
    ],
    title: null,
    xAxis: makeAxis(),
    yAxis: makeAxis(),
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...overrides,
  };
}

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["Jan", "Feb", "Mar", "Apr"],
    series: [
      { name: "Sales", values: [100, 200, 300, 150], color: null },
      { name: "Cost", values: [80, 120, 180, 90], color: null },
    ],
    ...overrides,
  };
}

const theme = DEFAULT_CHART_THEME;

// ============================================================================
// Title + Subtitle + Legend + Axis Labels All Enabled
// ============================================================================

describe("all chrome elements enabled", () => {
  it("title + legend bottom + axis labels reduces plot area", () => {
    const spec = makeSpec({
      title: "Revenue Overview",
      legend: { visible: true, position: "bottom" },
      xAxis: makeAxis({ title: "Month", showLabels: true }),
      yAxis: makeAxis({ title: "Amount ($)", showLabels: true }),
    });
    const data = makeData();
    const layout = computeCartesianLayout(W, H, spec, data, theme);

    // Title adds to top margin
    expect(layout.margin.top).toBeGreaterThan(12);
    // Legend at bottom adds to bottom margin
    expect(layout.margin.bottom).toBeGreaterThan(30);
    // Y axis title adds to left margin
    expect(layout.margin.left).toBeGreaterThan(30);
    // X axis title adds to bottom margin
    expect(layout.plotArea.height).toBeLessThan(H - 60);
  });

  it("title + legend right + both axis titles", () => {
    const spec = makeSpec({
      title: "Full Chrome Chart",
      legend: { visible: true, position: "right" },
      xAxis: makeAxis({ title: "X", showLabels: true }),
      yAxis: makeAxis({ title: "Y", showLabels: true }),
    });
    const data = makeData();
    const layout = computeCartesianLayout(W, H, spec, data, theme);

    // Right legend should increase right margin
    expect(layout.margin.right).toBeGreaterThan(16);
    // Plot area width should be reduced
    expect(layout.plotArea.width).toBeLessThan(W - 80);
  });
});

// ============================================================================
// No Title, No Legend (maximized plot area)
// ============================================================================

describe("no chrome elements (maximized plot area)", () => {
  it("no title, no legend, no axis titles yields maximum plot area", () => {
    const spec = makeSpec({
      title: null,
      legend: { visible: false, position: "bottom" },
      xAxis: makeAxis({ title: null, showLabels: false }),
      yAxis: makeAxis({ title: null, showLabels: false }),
    });
    const data = makeData();
    const layout = computeCartesianLayout(W, H, spec, data, theme);

    // Minimal margins
    expect(layout.margin.top).toBeLessThanOrEqual(12);
    expect(layout.margin.right).toBeLessThanOrEqual(16);
    // Plot area should be close to full size
    expect(layout.plotArea.width).toBeGreaterThan(W - 50);
    expect(layout.plotArea.height).toBeGreaterThan(H - 40);
  });

  it("maximized plot area is larger than fully chromed layout", () => {
    const data = makeData();
    const minSpec = makeSpec({
      title: null,
      legend: { visible: false, position: "bottom" },
      xAxis: makeAxis({ title: null, showLabels: false }),
      yAxis: makeAxis({ title: null, showLabels: false }),
    });
    const maxSpec = makeSpec({
      title: "Title",
      legend: { visible: true, position: "bottom" },
      xAxis: makeAxis({ title: "X Axis", showLabels: true }),
      yAxis: makeAxis({ title: "Y Axis", showLabels: true }),
    });

    const minLayout = computeCartesianLayout(W, H, minSpec, data, theme);
    const maxLayout = computeCartesianLayout(W, H, maxSpec, data, theme);

    expect(minLayout.plotArea.width).toBeGreaterThan(maxLayout.plotArea.width);
    expect(minLayout.plotArea.height).toBeGreaterThan(maxLayout.plotArea.height);
  });
});

// ============================================================================
// Horizontal Legend at All Positions
// ============================================================================

describe("horizontal legend positions", () => {
  it("legend at top adds to top margin", () => {
    const spec = makeSpec({ legend: { visible: true, position: "top" } });
    const noLegendSpec = makeSpec({ legend: { visible: false, position: "top" } });
    const data = makeData();

    const withLegend = computeCartesianLayout(W, H, spec, data, theme);
    const without = computeCartesianLayout(W, H, noLegendSpec, data, theme);

    expect(withLegend.margin.top).toBeGreaterThan(without.margin.top);
  });

  it("legend at bottom adds to bottom margin", () => {
    const spec = makeSpec({ legend: { visible: true, position: "bottom" } });
    const noLegendSpec = makeSpec({ legend: { visible: false, position: "bottom" } });
    const data = makeData();

    const withLegend = computeCartesianLayout(W, H, spec, data, theme);
    const without = computeCartesianLayout(W, H, noLegendSpec, data, theme);

    expect(withLegend.margin.bottom).toBeGreaterThan(without.margin.bottom);
  });
});

// ============================================================================
// Vertical Legend at All Positions
// ============================================================================

describe("vertical legend positions", () => {
  it("legend at left adds to left margin", () => {
    const spec = makeSpec({ legend: { visible: true, position: "left" } });
    const noLegendSpec = makeSpec({ legend: { visible: false, position: "left" } });
    const data = makeData();

    const withLegend = computeCartesianLayout(W, H, spec, data, theme);
    const without = computeCartesianLayout(W, H, noLegendSpec, data, theme);

    expect(withLegend.margin.left).toBeGreaterThan(without.margin.left);
    expect(withLegend.plotArea.width).toBeLessThan(without.plotArea.width);
  });

  it("legend at right adds to right margin", () => {
    const spec = makeSpec({ legend: { visible: true, position: "right" } });
    const noLegendSpec = makeSpec({ legend: { visible: false, position: "right" } });
    const data = makeData();

    const withLegend = computeCartesianLayout(W, H, spec, data, theme);
    const without = computeCartesianLayout(W, H, noLegendSpec, data, theme);

    expect(withLegend.margin.right).toBeGreaterThan(without.margin.right);
    expect(withLegend.plotArea.width).toBeLessThan(without.plotArea.width);
  });

  it("long series names increase legend width", () => {
    const shortData = makeData({
      series: [
        { name: "A", values: [1, 2, 3, 4], color: null },
        { name: "B", values: [1, 2, 3, 4], color: null },
      ],
    });
    const longData = makeData({
      series: [
        { name: "Very Long Series Name Alpha", values: [1, 2, 3, 4], color: null },
        { name: "Very Long Series Name Beta", values: [1, 2, 3, 4], color: null },
      ],
    });
    const spec = makeSpec({ legend: { visible: true, position: "right" } });

    const shortLayout = computeCartesianLayout(W, H, spec, shortData, theme);
    const longLayout = computeCartesianLayout(W, H, spec, longData, theme);

    expect(longLayout.margin.right).toBeGreaterThan(shortLayout.margin.right);
  });
});

// ============================================================================
// Very Long Title Text
// ============================================================================

describe("long title text", () => {
  it("title reserves same space regardless of length (no wrapping in layout)", () => {
    const shortSpec = makeSpec({ title: "Hi" });
    const longSpec = makeSpec({ title: "This Is A Very Long Chart Title That Might Need Wrapping In Some Cases" });
    const data = makeData();

    const shortLayout = computeCartesianLayout(W, H, shortSpec, data, theme);
    const longLayout = computeCartesianLayout(W, H, longSpec, data, theme);

    // Layout reserves same vertical space for title regardless of length
    expect(shortLayout.margin.top).toBe(longLayout.margin.top);
  });
});

// ============================================================================
// Layout with Rotated X-axis Labels + Legend
// ============================================================================

describe("rotated x-axis labels + legend", () => {
  it("45-degree labels increase bottom margin", () => {
    const normalSpec = makeSpec({ xAxis: makeAxis({ labelAngle: 0, showLabels: true }) });
    const rotatedSpec = makeSpec({ xAxis: makeAxis({ labelAngle: 45, showLabels: true }) });
    const data = makeData();

    const normal = computeCartesianLayout(W, H, normalSpec, data, theme);
    const rotated = computeCartesianLayout(W, H, rotatedSpec, data, theme);

    expect(rotated.margin.bottom).toBeGreaterThan(normal.margin.bottom);
  });

  it("90-degree labels with long categories increase bottom margin further", () => {
    const data = makeData({
      categories: ["January 2025", "February 2025", "March 2025", "April 2025"],
    });
    const spec = makeSpec({ xAxis: makeAxis({ labelAngle: 90, showLabels: true }) });

    const layout = computeCartesianLayout(W, H, spec, data, theme);
    expect(layout.margin.bottom).toBeGreaterThan(40);
  });

  it("rotated labels + bottom legend both add to bottom margin", () => {
    const data = makeData();
    const spec = makeSpec({
      xAxis: makeAxis({ labelAngle: 45, showLabels: true }),
      legend: { visible: true, position: "bottom" },
    });

    const layout = computeCartesianLayout(W, H, spec, data, theme);
    // Should account for both rotated labels AND legend
    expect(layout.margin.bottom).toBeGreaterThan(50);
  });
});

// ============================================================================
// Radial Layout Combinations
// ============================================================================

describe("radial layout (pie/donut)", () => {
  it("pie with no chrome yields maximal plot area", () => {
    const spec = makeSpec({ mark: "pie", title: null, legend: { visible: false, position: "bottom" } });
    const data = makeData();
    const layout = computeRadialLayout(W, H, spec, data, theme);

    expect(layout.plotArea.width).toBeGreaterThan(W - 50);
    expect(layout.plotArea.height).toBeGreaterThan(H - 40);
  });

  it("pie with title + right legend reduces plot area", () => {
    const data = makeData();
    const spec = makeSpec({
      mark: "pie",
      title: "Revenue Distribution",
      legend: { visible: true, position: "right" },
    });
    const layout = computeRadialLayout(W, H, spec, data, theme);

    expect(layout.margin.top).toBeGreaterThan(12);
    expect(layout.margin.right).toBeGreaterThan(16);
    expect(layout.plotArea.width).toBeLessThan(W - 50);
  });
});

// ============================================================================
// Plot Area Invariants
// ============================================================================

describe("plot area invariants", () => {
  it("plot area never has negative dimensions", () => {
    // Tiny chart with lots of chrome
    const spec = makeSpec({
      title: "Title",
      legend: { visible: true, position: "right" },
      xAxis: makeAxis({ title: "X Axis Title", showLabels: true, labelAngle: 90 }),
      yAxis: makeAxis({ title: "Y Axis Title", showLabels: true }),
    });
    const data = makeData({
      categories: ["Very Long Cat A", "Very Long Cat B", "Very Long Cat C", "Very Long Cat D"],
      series: [
        { name: "Very Long Series Name", values: [1000000, 2000000, 3000000, 4000000], color: null },
      ],
    });

    // Even at small size, plot area should be clamped to minimum
    const layout = computeCartesianLayout(200, 100, spec, data, theme);
    expect(layout.plotArea.width).toBeGreaterThanOrEqual(10);
    expect(layout.plotArea.height).toBeGreaterThanOrEqual(10);
  });

  it("plot area x + width <= total width", () => {
    const spec = makeSpec({
      title: "Test",
      legend: { visible: true, position: "left" },
      yAxis: makeAxis({ title: "Y", showLabels: true }),
    });
    const data = makeData();
    const layout = computeCartesianLayout(W, H, spec, data, theme);

    expect(layout.plotArea.x + layout.plotArea.width).toBeLessThanOrEqual(W);
    expect(layout.plotArea.y + layout.plotArea.height).toBeLessThanOrEqual(H);
  });

  it("margins are consistent with plot area position", () => {
    const spec = makeSpec({ title: "Test", legend: { visible: true, position: "bottom" } });
    const data = makeData();
    const layout = computeCartesianLayout(W, H, spec, data, theme);

    expect(layout.plotArea.x).toBe(layout.margin.left);
    expect(layout.plotArea.y).toBe(layout.margin.top);
  });
});
