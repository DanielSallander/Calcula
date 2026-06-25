//! FILENAME: app/extensions/Charts/rendering/__tests__/scatterBubbleNumericX.test.ts
// PURPOSE: Tests for B4 — quantitative (numeric) X axis on scatter/bubble charts
//          via ParsedChartData.categoryValues + resolveScatterXAxis.

import { describe, it, expect } from "vitest";
import { resolveScatterXAxis } from "../chartPainterUtils";
import { computeScatterPointMarkers } from "../scatterChartPainter";
import { computeBubblePointMarkers } from "../bubbleChartPainter";
import { resolveChartTheme } from "../chartTheme";
import type { ChartSpec, ParsedChartData, ChartLayout } from "../../types";

function scatterSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "scatter",
    data: "A1:B3",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Y", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...overrides,
  };
}

const plotArea = { x: 0, width: 100 };
const layout: ChartLayout = {
  width: 100,
  height: 100,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  plotArea: { x: 0, y: 0, width: 100, height: 100 },
};
const theme = resolveChartTheme(undefined);

describe("resolveScatterXAxis", () => {
  it("uses a quantitative (value-proportional) scale when categoryValues are present", () => {
    const data: ParsedChartData = {
      categories: ["0", "10", "20"],
      series: [{ name: "Y", values: [1, 2, 3], color: null }],
      categoryValues: [0, 10, 20],
    };
    const xAxis = resolveScatterXAxis(data, scatterSpec(), plotArea);
    expect(xAxis.numeric).toBe(true);
    expect(xAxis.xOf(0)).toBeCloseTo(0);
    expect(xAxis.xOf(1)).toBeCloseTo(50);
    expect(xAxis.xOf(2)).toBeCloseTo(100);
  });

  it("positions points by value, not evenly (unequal numeric spacing)", () => {
    const data: ParsedChartData = {
      categories: ["0", "10", "100"],
      series: [{ name: "Y", values: [1, 2, 3], color: null }],
      categoryValues: [0, 10, 100],
    };
    const xAxis = resolveScatterXAxis(data, scatterSpec(), plotArea);
    const gap01 = xAxis.xOf(1) - xAxis.xOf(0);
    const gap12 = xAxis.xOf(2) - xAxis.xOf(1);
    expect(gap12).toBeGreaterThan(gap01); // 90 units vs 10 units
  });

  it("honors xAxis.min / max for the quantitative domain", () => {
    const data: ParsedChartData = {
      categories: ["0", "100"],
      series: [{ name: "Y", values: [1, 2], color: null }],
      categoryValues: [0, 100],
    };
    const spec = scatterSpec({
      xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: 0, max: 200 },
    });
    const xAxis = resolveScatterXAxis(data, spec, plotArea);
    expect(xAxis.xOf(0)).toBeCloseTo(0);   // value 0 at left
    expect(xAxis.xOf(1)).toBeCloseTo(50);  // value 100 of [0,200] -> halfway
  });

  it("falls back to evenly-spaced categories when categoryValues are absent", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "Y", values: [1, 2, 3], color: null }],
    };
    const xAxis = resolveScatterXAxis(data, scatterSpec(), plotArea);
    expect(xAxis.numeric).toBe(false);
    const gap01 = xAxis.xOf(1) - xAxis.xOf(0);
    const gap12 = xAxis.xOf(2) - xAxis.xOf(1);
    expect(gap01).toBeCloseTo(gap12);
    expect(xAxis.ticks.map((t) => t.label)).toEqual(["A", "B", "C"]);
  });
});

describe("scatter/bubble markers use numeric X when available", () => {
  it("scatter point markers are positioned by category value", () => {
    const data: ParsedChartData = {
      categories: ["0", "10", "20"],
      series: [{ name: "Y", values: [5, 6, 7], color: null }],
      categoryValues: [0, 10, 20],
    };
    const markers = computeScatterPointMarkers(data, scatterSpec(), layout, theme);
    expect(markers).toHaveLength(3);
    expect(markers[0].cx).toBeCloseTo(0);
    expect(markers[1].cx).toBeCloseTo(50);
    expect(markers[2].cx).toBeCloseTo(100);
  });

  it("bubble value markers are positioned by category value", () => {
    const data: ParsedChartData = {
      categories: ["0", "50", "100"],
      series: [
        { name: "Y", values: [5, 6, 7], color: null },
        { name: "Size", values: [1, 2, 3], color: null },
      ],
      categoryValues: [0, 50, 100],
    };
    const spec = scatterSpec({ mark: "bubble", series: [
      { name: "Y", sourceIndex: 1, color: null },
      { name: "Size", sourceIndex: 2, color: null },
    ] });
    const markers = computeBubblePointMarkers(data, spec, layout, theme);
    // Only the value series (Y) produces markers; Size drives radius.
    expect(markers).toHaveLength(3);
    expect(markers[0].cx).toBeCloseTo(0);
    expect(markers[1].cx).toBeCloseTo(50);
    expect(markers[2].cx).toBeCloseTo(100);
  });

  it("scatter markers stay evenly spaced for text categories (unchanged behavior)", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [{ name: "Y", values: [5, 6, 7], color: null }],
    };
    const markers = computeScatterPointMarkers(data, scatterSpec(), layout, theme);
    const gap01 = markers[1].cx - markers[0].cx;
    const gap12 = markers[2].cx - markers[1].cx;
    expect(gap01).toBeCloseTo(gap12);
  });
});
