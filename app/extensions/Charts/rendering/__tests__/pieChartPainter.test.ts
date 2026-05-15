//! FILENAME: app/extensions/Charts/rendering/__tests__/pieChartPainter.test.ts
// PURPOSE: Tests for pie/donut chart geometry computation (computePieSliceArcs, computePieLayout).

import { describe, it, expect } from "vitest";
import { computePieSliceArcs, computePieLayout } from "../pieChartPainter";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ParsedChartData } from "../../types";

// ============================================================================
// Test Helpers
// ============================================================================

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "pie",
    data: { startRow: 0, startCol: 0, endRow: 3, endCol: 1, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Values", sourceIndex: 1, color: null }],
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
      gridLines: false,
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
    categories: ["A", "B", "C", "D"],
    series: [{ name: "Values", values: [25, 25, 25, 25], color: null }],
    ...overrides,
  };
}

// ============================================================================
// computePieLayout
// ============================================================================

describe("computePieLayout", () => {
  it("returns layout with correct dimensions", () => {
    const layout = computePieLayout(600, 400, makeSpec(), makeData(), DEFAULT_CHART_THEME);
    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });
});

// ============================================================================
// computePieSliceArcs
// ============================================================================

describe("computePieSliceArcs", () => {
  it("returns one arc per category value", () => {
    const data = makeData();
    const spec = makeSpec();
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    expect(arcs).toHaveLength(4);
  });

  it("equal values produce equal angle spans", () => {
    const data = makeData({ series: [{ name: "V", values: [25, 25, 25, 25], color: null }] });
    const spec = makeSpec();
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    const spans = arcs.map((a) => a.endAngle - a.startAngle);
    // All spans should be approximately equal (within pad angle tolerance)
    const avg = spans.reduce((s, v) => s + v, 0) / spans.length;
    for (const span of spans) {
      expect(span).toBeCloseTo(avg, 1);
    }
  });

  it("percent values sum to 100", () => {
    const data = makeData({ series: [{ name: "V", values: [10, 20, 30, 40], color: null }] });
    const spec = makeSpec();
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    const totalPercent = arcs.reduce((s, a) => s + a.percent, 0);
    expect(totalPercent).toBeCloseTo(100, 5);
  });

  it("preserves correct values and labels", () => {
    const data = makeData({
      categories: ["Alpha", "Beta"],
      series: [{ name: "V", values: [60, 40], color: null }],
    });
    const spec = makeSpec();
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    expect(arcs[0].value).toBe(60);
    expect(arcs[0].label).toBe("Alpha");
    expect(arcs[0].percent).toBeCloseTo(60, 5);
    expect(arcs[1].value).toBe(40);
    expect(arcs[1].label).toBe("Beta");
    expect(arcs[1].percent).toBeCloseTo(40, 5);
  });

  it("pie chart has innerRadius = 0", () => {
    const data = makeData();
    const spec = makeSpec({ mark: "pie" });
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    for (const arc of arcs) {
      expect(arc.innerRadius).toBe(0);
    }
  });

  it("donut chart has innerRadius > 0", () => {
    const data = makeData();
    const spec = makeSpec({ mark: "donut" });
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    for (const arc of arcs) {
      expect(arc.innerRadius).toBeGreaterThan(0);
      expect(arc.innerRadius).toBeLessThan(arc.outerRadius);
    }
  });

  it("returns empty array when all values are zero", () => {
    const data = makeData({ series: [{ name: "V", values: [0, 0, 0], color: null }] });
    const spec = makeSpec();
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    expect(arcs).toHaveLength(0);
  });

  it("returns empty array when no series", () => {
    const data = makeData({ series: [] });
    const spec = makeSpec();
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    expect(arcs).toHaveLength(0);
  });

  it("all arcs share the same center", () => {
    const data = makeData();
    const spec = makeSpec();
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    const cx = arcs[0].centerX;
    const cy = arcs[0].centerY;
    for (const arc of arcs) {
      expect(arc.centerX).toBe(cx);
      expect(arc.centerY).toBe(cy);
    }
  });

  it("custom innerRadiusRatio is applied for donut", () => {
    const data = makeData();
    const spec = makeSpec({
      mark: "donut",
      markOptions: { innerRadiusRatio: 0.7 },
    });
    const layout = computePieLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const arcs = computePieSliceArcs(data, spec, layout, DEFAULT_CHART_THEME);

    // innerRadius should be 70% of outerRadius
    const expected = arcs[0].outerRadius * 0.7;
    expect(arcs[0].innerRadius).toBeCloseTo(expected, 5);
  });
});
