//! FILENAME: app/extensions/Charts/rendering/dataLabelPainter.test.ts
// PURPOSE: Tests for the data label painting logic.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { paintDataLabels } from "./dataLabelPainter";
import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  HitGeometry,
  BarRect,
  PointMarker,
  SliceArc,
  DataLabelSpec,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { DEFAULT_CHART_THEME } from "./chartTheme";

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(): CanvasRenderingContext2D {
  return {
    fillText: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    rect: vi.fn(),
    setLineDash: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    clearRect: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 40, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    canvas: { width: 600, height: 400 },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    globalAlpha: 1,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  } as unknown as CanvasRenderingContext2D;
}

const baseLayout: ChartLayout = {
  width: 600,
  height: 400,
  margin: { top: 20, right: 20, bottom: 40, left: 40 },
  plotArea: { x: 40, y: 20, width: 540, height: 340 },
};

const baseData: ParsedChartData = {
  categories: ["A", "B", "C"],
  series: [
    { name: "Sales", values: [100, 200, 300], color: null },
    { name: "Profit", values: [50, 80, 120], color: null },
  ],
};

function makeSpec(dl?: Partial<DataLabelSpec>): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Sales", sourceIndex: 1, color: null },
      { name: "Profit", sourceIndex: 2, color: null },
    ],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    dataLabels: {
      enabled: true,
      ...dl,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("paintDataLabels", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it("does nothing when dataLabels is undefined", () => {
    const spec = makeSpec();
    spec.dataLabels = undefined;
    const geometry: HitGeometry = { type: "bars", rects: [] };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("does nothing when dataLabels.enabled is false", () => {
    const spec = makeSpec({ enabled: false });
    const geometry: HitGeometry = { type: "bars", rects: [] };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("draws labels for bar geometry", () => {
    const spec = makeSpec({ content: ["value"] });
    const rects: BarRect[] = [
      { seriesIndex: 0, categoryIndex: 0, x: 50, y: 100, width: 30, height: 100, value: 100, seriesName: "Sales", categoryName: "A" },
      { seriesIndex: 0, categoryIndex: 1, x: 120, y: 60, width: 30, height: 140, value: 200, seriesName: "Sales", categoryName: "B" },
    ];
    const geometry: HitGeometry = { type: "bars", rects };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });

  it("respects seriesFilter", () => {
    const spec = makeSpec({ content: ["value"], seriesFilter: [1] });
    const rects: BarRect[] = [
      { seriesIndex: 0, categoryIndex: 0, x: 50, y: 100, width: 30, height: 100, value: 100, seriesName: "Sales", categoryName: "A" },
      { seriesIndex: 1, categoryIndex: 0, x: 85, y: 150, width: 30, height: 50, value: 50, seriesName: "Profit", categoryName: "A" },
    ];
    const geometry: HitGeometry = { type: "bars", rects };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    // Only seriesIndex 1 should produce a label
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });

  it("respects minValue threshold", () => {
    const spec = makeSpec({ content: ["value"], minValue: 150 });
    const rects: BarRect[] = [
      { seriesIndex: 0, categoryIndex: 0, x: 50, y: 100, width: 30, height: 100, value: 100, seriesName: "Sales", categoryName: "A" },
      { seriesIndex: 0, categoryIndex: 1, x: 120, y: 60, width: 30, height: 140, value: 200, seriesName: "Sales", categoryName: "B" },
    ];
    const geometry: HitGeometry = { type: "bars", rects };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    // Only value 200 >= 150 threshold
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });

  it("draws labels for point geometry (line/scatter)", () => {
    const spec = makeSpec({ content: ["value"] });
    const markers: PointMarker[] = [
      { seriesIndex: 0, categoryIndex: 0, cx: 80, cy: 150, radius: 4, value: 100, seriesName: "Sales", categoryName: "A" },
      { seriesIndex: 0, categoryIndex: 1, cx: 200, cy: 100, radius: 4, value: 200, seriesName: "Sales", categoryName: "B" },
    ];
    const geometry: HitGeometry = { type: "points", markers };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });

  it("draws labels for slice geometry (pie/donut)", () => {
    const spec = makeSpec({ content: ["percent"] });
    spec.mark = "pie";
    const arcs: SliceArc[] = [
      { seriesIndex: 0, startAngle: 0, endAngle: Math.PI, innerRadius: 0, outerRadius: 100, centerX: 200, centerY: 200, value: 60, label: "A", percent: 60 },
      { seriesIndex: 1, startAngle: Math.PI, endAngle: 2 * Math.PI, innerRadius: 0, outerRadius: 100, centerX: 200, centerY: 200, value: 40, label: "B", percent: 40 },
    ];
    const geometry: HitGeometry = { type: "slices", arcs };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });

  it("handles composite geometry (combo charts)", () => {
    const spec = makeSpec({ content: ["value"] });
    const bars: BarRect[] = [
      { seriesIndex: 0, categoryIndex: 0, x: 50, y: 100, width: 30, height: 100, value: 100, seriesName: "Sales", categoryName: "A" },
    ];
    const points: PointMarker[] = [
      { seriesIndex: 1, categoryIndex: 0, cx: 80, cy: 150, radius: 4, value: 50, seriesName: "Profit", categoryName: "A" },
    ];
    const geometry: HitGeometry = {
      type: "composite",
      groups: [
        { type: "bars", rects: bars },
        { type: "points", markers: points },
      ],
    };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });

  it("renders multiple content fields with separator", () => {
    const spec = makeSpec({ content: ["category", "value"], separator: ": " });
    const rects: BarRect[] = [
      { seriesIndex: 0, categoryIndex: 0, x: 50, y: 100, width: 30, height: 100, value: 100, seriesName: "Sales", categoryName: "Alpha" },
    ];
    const geometry: HitGeometry = { type: "bars", rects };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    // Should contain "Alpha: 100"
    const call = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("Alpha: 100");
  });

  it("applies format pattern to values", () => {
    const spec = makeSpec({ content: ["value"], format: "$,.2f" });
    const rects: BarRect[] = [
      { seriesIndex: 0, categoryIndex: 0, x: 50, y: 100, width: 30, height: 100, value: 1234.5, seriesName: "Sales", categoryName: "A" },
    ];
    const geometry: HitGeometry = { type: "bars", rects };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    const call = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("$1,234.50");
  });

  it("draws background when backgroundColor is set", () => {
    const spec = makeSpec({ content: ["value"], backgroundColor: "#ffffff" });
    const rects: BarRect[] = [
      { seriesIndex: 0, categoryIndex: 0, x: 50, y: 100, width: 30, height: 100, value: 100, seriesName: "Sales", categoryName: "A" },
    ];
    const geometry: HitGeometry = { type: "bars", rects };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    // fillRect called for background + fillText for label
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it("handles empty geometry gracefully", () => {
    const spec = makeSpec({ content: ["value"] });
    const geometry: HitGeometry = { type: "bars", rects: [] };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("renders seriesName content field", () => {
    const spec = makeSpec({ content: ["seriesName", "value"], separator: " = " });
    const rects: BarRect[] = [
      { seriesIndex: 0, categoryIndex: 0, x: 50, y: 100, width: 30, height: 100, value: 100, seriesName: "Sales", categoryName: "A" },
    ];
    const geometry: HitGeometry = { type: "bars", rects };

    paintDataLabels(ctx, baseData, spec, baseLayout, DEFAULT_CHART_THEME, geometry);

    const call = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("Sales = 100");
  });
});
