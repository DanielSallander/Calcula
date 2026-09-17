//! FILENAME: app/extensions/Charts/rendering/__tests__/markerPainter.test.ts
// PURPOSE: A kept marker sits where the bar (or point) it marks sits — the
//          same band/point scale and the same value scale the marks use — and
//          paints nothing for a datum that cannot be placed.

import { describe, it, expect } from "vitest";
import { markerBox, paintMarkerMark } from "../markerPainter";
import { computeBarRects } from "../barChartPainter";
import { computeLinePointMarkers } from "../lineChartPainter";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ChartLayout, ParsedChartData, LayerSpec } from "../../types";

const data: ParsedChartData = {
  categories: ["Jan", "Feb", "Mar", "Apr", "May"],
  series: [
    { name: "Sales", values: [100, 200, 300, 150, 250], color: null },
    { name: "Cost", values: [80, 120, 180, 90, 150], color: null },
  ],
};
function spec(mark: string): ChartSpec {
  return {
    mark, data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 2 }, hasHeaders: true,
    seriesOrientation: "columns", categoryIndex: 0, series: [], title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" }, stacking: "none", transforms: [], encodings: {},
    annotations: [], dataPointOverrides: [], filters: [], gradientFill: null, stylePreset: null,
  } as unknown as ChartSpec;
}
const layout: ChartLayout = { width: 600, height: 400, margin: { top: 40, right: 20, bottom: 40, left: 60 }, plotArea: { x: 60, y: 40, width: 520, height: 320 } };

describe("markerBox", () => {
  it("on a bar chart, encloses exactly the bar the built-in painter draws for that datum", () => {
    const s = spec("bar");
    const rects = computeBarRects(data, s, layout, DEFAULT_CHART_THEME);
    const bar = rects.find((r) => r.seriesName === "Cost" && r.categoryIndex === 2)!;
    const box = markerBox(data, s, layout, { series: "Cost", x: 2, shape: "ring" })!;
    expect(box.cx).toBeCloseTo(bar.x + bar.width / 2, 6);
    expect(box.cy).toBeCloseTo(bar.y + bar.height / 2, 6);
    expect(box.rx).toBeCloseTo(bar.width / 2 + 4, 6);
    expect(box.ry).toBeCloseTo(bar.height / 2 + 4, 6);
  });

  it("on a line chart, centres on the point the built-in painter draws", () => {
    const s = spec("line");
    const markers = computeLinePointMarkers(data, s, layout, DEFAULT_CHART_THEME);
    const p = markers.find((m) => m.seriesName === "Sales" && m.categoryIndex === 2)!;
    const box = markerBox(data, s, layout, { series: "Sales", x: 2, shape: "ring" })!;
    expect(box.cx).toBeCloseTo(p.cx, 6);
    expect(box.cy).toBeCloseTo(p.cy, 6);
  });

  it("places nothing for an unknown series, an index past the end, or a radial mark", () => {
    expect(markerBox(data, spec("bar"), layout, { series: "Profit", x: 2, shape: "ring" })).toBeNull();
    expect(markerBox(data, spec("bar"), layout, { series: "Sales", x: 9, shape: "ring" })).toBeNull();
    expect(markerBox(data, spec("pie"), layout, { series: "Sales", x: 2, shape: "ring" })).toBeNull();
  });
});

describe("paintMarkerMark", () => {
  it("strokes an ellipse and writes the label; paints nothing it cannot place", () => {
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"), restore: () => calls.push("restore"), beginPath: () => calls.push("beginPath"),
      ellipse: () => calls.push("ellipse"), stroke: () => calls.push("stroke"), fillText: (t: string) => calls.push(`text:${t}`),
      setLineDash: () => {}, strokeStyle: "", fillStyle: "", lineWidth: 0, globalAlpha: 1, font: "", textAlign: "", textBaseline: "",
    } as unknown as CanvasRenderingContext2D;
    const layer: LayerSpec = { mark: "marker", markOptions: { series: "Sales", x: 2, shape: "ring", label: "Highest Sales" } };
    paintMarkerMark(ctx, data, layer, spec("bar"), layout, DEFAULT_CHART_THEME);
    expect(calls).toContain("ellipse");
    expect(calls).toContain("text:Highest Sales");

    calls.length = 0;
    paintMarkerMark(ctx, data, { mark: "marker", markOptions: { series: "Nope", x: 2, shape: "ring" } }, spec("bar"), layout, DEFAULT_CHART_THEME);
    expect(calls).toEqual([]);
  });
});
