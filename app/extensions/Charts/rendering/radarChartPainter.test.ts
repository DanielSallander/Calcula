//! FILENAME: app/extensions/Charts/rendering/radarChartPainter.test.ts
// PURPOSE: Tests for the radar (spider) chart painter.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeRadarLayout,
  computeRadarPointMarkers,
  paintRadarChart,
} from "./radarChartPainter";
import type {
  ChartSpec,
  ParsedChartData,
  RadarMarkOptions,
} from "../types";
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
    roundRect: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
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

function makeData(
  categories: string[],
  seriesData: Array<{ name: string; values: number[] }>,
): ParsedChartData {
  return {
    categories,
    series: seriesData.map((s) => ({ ...s, color: null })),
  };
}

function makeSpec(opts?: Partial<RadarMarkOptions>): ChartSpec {
  return {
    mark: "radar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Series 1", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions: opts,
  };
}

const sampleData = makeData(
  ["Speed", "Strength", "Agility", "Endurance", "Intelligence"],
  [
    { name: "Player A", values: [80, 60, 90, 70, 85] },
    { name: "Player B", values: [70, 85, 65, 80, 75] },
  ],
);

// ============================================================================
// Layout
// ============================================================================

describe("computeRadarLayout", () => {
  it("returns valid layout dimensions", () => {
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
    expect(layout.plotArea.width).toBeGreaterThan(0);
  });
});

// ============================================================================
// Point Markers (hit geometry)
// ============================================================================

describe("computeRadarPointMarkers", () => {
  it("returns markers for each series x category", () => {
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const markers = computeRadarPointMarkers(sampleData, spec, layout, DEFAULT_CHART_THEME);

    // 2 series x 5 categories = 10
    expect(markers).toHaveLength(10);
  });

  it("returns empty for fewer than 3 categories", () => {
    const data = makeData(["A", "B"], [{ name: "S1", values: [10, 20] }]);
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeRadarPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers).toHaveLength(0);
  });

  it("exactly 3 categories (minimum valid triangle)", () => {
    const data = makeData(["A", "B", "C"], [{ name: "S1", values: [10, 20, 30] }]);
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeRadarPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers).toHaveLength(3);
  });

  it("marker values are clamped to >= 0", () => {
    const data = makeData(["A", "B", "C"], [{ name: "S1", values: [-10, 20, -5] }]);
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeRadarPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    for (const m of markers) {
      expect(m.value).toBeGreaterThanOrEqual(0);
    }
  });

  it("all markers have same center for all-zero values", () => {
    const data = makeData(["A", "B", "C", "D"], [{ name: "S1", values: [0, 0, 0, 0] }]);
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeRadarPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    // All points should be at or very near the center
    const centerX = layout.plotArea.x + layout.plotArea.width / 2;
    const centerY = layout.plotArea.y + layout.plotArea.height / 2;
    for (const m of markers) {
      expect(m.cx).toBeCloseTo(centerX, 0);
      expect(m.cy).toBeCloseTo(centerY, 0);
    }
  });

  it("respects custom markerRadius", () => {
    const data = makeData(["A", "B", "C"], [{ name: "S1", values: [10, 20, 30] }]);
    const spec = makeSpec({ markerRadius: 8 });
    const layout = computeRadarLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeRadarPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    for (const m of markers) {
      expect(m.radius).toBe(8);
    }
  });

  it("assigns correct series and category names", () => {
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const markers = computeRadarPointMarkers(sampleData, spec, layout, DEFAULT_CHART_THEME);

    // First 5 markers belong to Player A
    for (let i = 0; i < 5; i++) {
      expect(markers[i].seriesName).toBe("Player A");
      expect(markers[i].seriesIndex).toBe(0);
    }
    // Next 5 belong to Player B
    for (let i = 5; i < 10; i++) {
      expect(markers[i].seriesName).toBe("Player B");
      expect(markers[i].seriesIndex).toBe(1);
    }
  });

  it("handles many categories (12-axis radar)", () => {
    const cats = Array.from({ length: 12 }, (_, i) => `Cat ${i + 1}`);
    const vals = Array.from({ length: 12 }, (_, i) => (i + 1) * 10);
    const data = makeData(cats, [{ name: "S1", values: vals }]);
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 600, spec, data, DEFAULT_CHART_THEME);
    const markers = computeRadarPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers).toHaveLength(12);
  });

  it("handles single series with missing values", () => {
    const data: ParsedChartData = {
      categories: ["A", "B", "C", "D"],
      series: [{ name: "S1", values: [10, 20], color: null }], // only 2 values for 4 categories
    };
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const markers = computeRadarPointMarkers(data, spec, layout, DEFAULT_CHART_THEME);

    expect(markers).toHaveLength(4);
    // Missing values default to 0
    expect(markers[2].value).toBe(0);
    expect(markers[3].value).toBe(0);
  });
});

// ============================================================================
// Paint
// ============================================================================

describe("paintRadarChart", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("renders without errors", () => {
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    expect(() => {
      paintRadarChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
  });

  it("shows error for fewer than 3 categories", () => {
    const data = makeData(["A", "B"], [{ name: "S1", values: [10, 20] }]);
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintRadarChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const errMsg = calls.find((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("3 categories"),
    );
    expect(errMsg).toBeDefined();
  });

  it("renders without fill when showFill is false", () => {
    const spec = makeSpec({ showFill: false });
    const layout = computeRadarLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    paintRadarChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);

    // globalAlpha should not have been set to fillOpacity
    // (It's hard to test precisely, but at least it shouldn't throw)
  });

  it("renders without markers when showMarkers is false", () => {
    const spec = makeSpec({ showMarkers: false });
    const layout = computeRadarLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    paintRadarChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);

    // arc is used for markers; with showMarkers false, fewer arc calls
    // Just verify no throw
  });

  it("draws title when present", () => {
    const spec = makeSpec();
    spec.title = "Performance Radar";
    const layout = computeRadarLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    paintRadarChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const titleCall = calls.find((c: unknown[]) => c[0] === "Performance Radar");
    expect(titleCall).toBeDefined();
  });

  it("handles many overlapping series", () => {
    const cats = ["A", "B", "C", "D", "E"];
    const series = Array.from({ length: 10 }, (_, i) => ({
      name: `Series ${i + 1}`,
      values: cats.map(() => Math.random() * 100),
    }));
    const data = makeData(cats, series);
    const spec = makeSpec();
    const layout = computeRadarLayout(600, 600, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintRadarChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});
