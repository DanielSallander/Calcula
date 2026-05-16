//! FILENAME: app/extensions/Charts/rendering/funnelChartPainter.test.ts
// PURPOSE: Tests for the funnel chart painter.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeFunnelLayout,
  computeFunnelBarRects,
  paintFunnelChart,
} from "./funnelChartPainter";
import type {
  ChartSpec,
  ParsedChartData,
  FunnelMarkOptions,
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

function makeData(values: number[], categories?: string[]): ParsedChartData {
  return {
    categories: categories ?? values.map((_, i) => `Stage ${i + 1}`),
    series: [{ name: "Count", values, color: null }],
  };
}

function makeSpec(opts?: Partial<FunnelMarkOptions>): ChartSpec {
  return {
    mark: "funnel",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Count", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions: opts,
  };
}

// ============================================================================
// Layout
// ============================================================================

describe("computeFunnelLayout", () => {
  it("returns valid layout dimensions", () => {
    const data = makeData([1000, 600, 300, 100]);
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });
});

// ============================================================================
// Hit Geometry
// ============================================================================

describe("computeFunnelBarRects", () => {
  it("returns one rect per stage", () => {
    const data = makeData([1000, 600, 300, 100]);
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeFunnelBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(4);
  });

  it("widths decrease with decreasing values", () => {
    const data = makeData([1000, 600, 300, 100]);
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeFunnelBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    for (let i = 1; i < rects.length; i++) {
      expect(rects[i].width).toBeLessThanOrEqual(rects[i - 1].width);
    }
  });

  it("returns empty for no data", () => {
    const data: ParsedChartData = { categories: [], series: [] };
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeFunnelBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(0);
  });

  it("handles single stage", () => {
    const data = makeData([500], ["Only"]);
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeFunnelBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(1);
    expect(rects[0].categoryName).toBe("Only");
  });

  it("handles equal values (cylinder shape)", () => {
    const data = makeData([100, 100, 100, 100]);
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeFunnelBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(4);
    // All widths should be equal
    const widths = rects.map((r) => r.width);
    for (const w of widths) {
      expect(w).toBeCloseTo(widths[0], 1);
    }
  });

  it("handles negative values by clamping to zero width contribution", () => {
    const data = makeData([100, -50, 30]);
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      const rects = computeFunnelBarRects(data, spec, layout, DEFAULT_CHART_THEME);
      expect(rects).toHaveLength(3);
    }).not.toThrow();
  });

  it("handles large dataset (20 stages)", () => {
    const n = 20;
    const values = Array.from({ length: n }, (_, i) => 1000 - i * 45);
    const data = makeData(values);
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 600, spec, data, DEFAULT_CHART_THEME);
    const rects = computeFunnelBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(n);
  });

  it("all rects stay within plot area", () => {
    const data = makeData([500, 300, 200, 50]);
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeFunnelBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    const pa = layout.plotArea;

    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(pa.x - 1);
      expect(r.y).toBeGreaterThanOrEqual(pa.y - 1);
      expect(r.x + r.width).toBeLessThanOrEqual(pa.x + pa.width + 1);
      expect(r.y + r.height).toBeLessThanOrEqual(pa.y + pa.height + 1);
    }
  });
});

// ============================================================================
// Paint
// ============================================================================

describe("paintFunnelChart", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("renders with labels", () => {
    const data = makeData([1000, 600, 300, 100], ["Visitors", "Leads", "Trials", "Customers"]);
    const spec = makeSpec({ showLabels: true, labelFormat: "both" });
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintFunnelChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it("renders with labelFormat 'value'", () => {
    const data = makeData([1000, 500]);
    const spec = makeSpec({ showLabels: true, labelFormat: "value" });
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintFunnelChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("renders with labelFormat 'percent'", () => {
    const data = makeData([1000, 500]);
    const spec = makeSpec({ showLabels: true, labelFormat: "percent" });
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintFunnelChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("suppresses labels when showLabels is false", () => {
    const data = makeData([1000, 600, 300]);
    const spec = makeSpec({ showLabels: false });
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintFunnelChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("handles empty data gracefully", () => {
    const data: ParsedChartData = { categories: [], series: [] };
    const spec = makeSpec();
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintFunnelChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("draws title when present", () => {
    const data = makeData([100, 50]);
    const spec = makeSpec();
    spec.title = "Sales Funnel";
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintFunnelChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const titleCall = calls.find((c: unknown[]) => c[0] === "Sales Funnel");
    expect(titleCall).toBeDefined();
  });

  it("handles custom neckWidthRatio", () => {
    const data = makeData([100, 80, 60, 40]);
    const spec = makeSpec({ neckWidthRatio: 0.1 });
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintFunnelChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("handles custom sectionGap", () => {
    const data = makeData([100, 80, 60]);
    const spec = makeSpec({ sectionGap: 10 });
    const layout = computeFunnelLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintFunnelChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});
