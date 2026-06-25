//! FILENAME: app/extensions/Charts/rendering/__tests__/lineAreaProportionalX.test.ts
// PURPOSE: Line/area opt-in quantitative & temporal X axes (C2 part 2).
// CONTEXT: Line/area use a proportional X only when xAxis.scale is set (opt-in),
//          so existing category-axis charts are unchanged. When opted in with a
//          numeric/date category column, points are positioned by value/time.

import { describe, it, expect } from "vitest";
import { computeLinePointMarkers } from "../lineChartPainter";
import { computeAreaPointMarkers } from "../areaChartPainter";
import { resolveScatterXAxis } from "../chartPainterUtils";
import { resolveChartTheme } from "../chartTheme";
import type { ChartSpec, ParsedChartData, ChartLayout, ScaleSpec } from "../../types";

function lineSpec(mark: "line" | "area", scale?: ScaleSpec): ChartSpec {
  return {
    mark,
    data: "A1:B4",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Y", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null, scale },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
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

const quantData: ParsedChartData = {
  categories: ["0", "10", "100"],
  series: [{ name: "Y", values: [1, 2, 3], color: null }],
  categoryField: { type: "quantitative", values: [0, 10, 100] },
};

describe("line/area X axis is opt-in proportional", () => {
  it("stays evenly spaced by default (no xAxis.scale) even with a numeric category field", () => {
    const xAxis = resolveScatterXAxis(quantData, lineSpec("line"), plotArea, { requireScale: true });
    expect(xAxis.numeric).toBe(false);
    const gap01 = xAxis.xOf(1) - xAxis.xOf(0);
    const gap12 = xAxis.xOf(2) - xAxis.xOf(1);
    expect(gap01).toBeCloseTo(gap12);
  });

  it("becomes value-proportional when xAxis.scale is set", () => {
    const xAxis = resolveScatterXAxis(quantData, lineSpec("line", { type: "linear" }), plotArea, { requireScale: true });
    expect(xAxis.numeric).toBe(true);
    expect(xAxis.xOf(0)).toBeCloseTo(0);
    expect(xAxis.xOf(2)).toBeCloseTo(100);
    expect(xAxis.xOf(2) - xAxis.xOf(1)).toBeGreaterThan(xAxis.xOf(1) - xAxis.xOf(0));
  });

  it("scatter (auto, no opt-in) is proportional without xAxis.scale", () => {
    // Sanity check that the opt-in gate only applies when requested.
    const xAxis = resolveScatterXAxis(quantData, lineSpec("line"), plotArea);
    expect(xAxis.numeric).toBe(true);
  });
});

describe("line markers respect the opt-in axis", () => {
  it("evenly spaced by default", () => {
    const markers = computeLinePointMarkers(quantData, lineSpec("line"), layout, theme);
    const gap01 = markers[1].cx - markers[0].cx;
    const gap12 = markers[2].cx - markers[1].cx;
    expect(gap01).toBeCloseTo(gap12);
  });

  it("value-proportional when xAxis.scale is set", () => {
    const markers = computeLinePointMarkers(quantData, lineSpec("line", { type: "linear" }), layout, theme);
    expect(markers[0].cx).toBeCloseTo(0);
    expect(markers[2].cx).toBeCloseTo(100);
    expect(markers[2].cx - markers[1].cx).toBeGreaterThan(markers[1].cx - markers[0].cx);
  });

  it("time-proportional for a temporal category field with a time scale", () => {
    const temporal: ParsedChartData = {
      categories: ["2024-01-01", "2024-07-01", "2025-01-01"],
      series: [{ name: "Y", values: [1, 2, 3], color: null }],
      categoryField: { type: "temporal", values: [Date.UTC(2024, 0, 1), Date.UTC(2024, 6, 1), Date.UTC(2025, 0, 1)] },
    };
    const markers = computeLinePointMarkers(temporal, lineSpec("line", { type: "time" }), layout, theme);
    expect(markers[0].cx).toBeCloseTo(0);
    expect(markers[2].cx).toBeCloseTo(100);
    expect(markers[1].cx).toBeGreaterThan(40);
    expect(markers[1].cx).toBeLessThan(60);
  });
});

describe("area markers respect the opt-in axis", () => {
  it("evenly spaced by default", () => {
    const markers = computeAreaPointMarkers(quantData, lineSpec("area"), layout, theme);
    const gap01 = markers[1].cx - markers[0].cx;
    const gap12 = markers[2].cx - markers[1].cx;
    expect(gap01).toBeCloseTo(gap12);
  });

  it("value-proportional when xAxis.scale is set", () => {
    const markers = computeAreaPointMarkers(quantData, lineSpec("area", { type: "linear" }), layout, theme);
    expect(markers[0].cx).toBeCloseTo(0);
    expect(markers[2].cx).toBeCloseTo(100);
    expect(markers[2].cx - markers[1].cx).toBeGreaterThan(markers[1].cx - markers[0].cx);
  });
});
