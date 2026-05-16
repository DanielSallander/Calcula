//! FILENAME: app/extensions/Charts/rendering/waterfallChartPainter.test.ts
// PURPOSE: Tests for the waterfall chart painter — running totals, increase/decrease, totals.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeWaterfallLayout,
  computeWaterfallBarRects,
  paintWaterfallChart,
} from "./waterfallChartPainter";
import type {
  ChartSpec,
  ParsedChartData,
  WaterfallMarkOptions,
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
    categories: categories ?? values.map((_, i) => `Step ${i + 1}`),
    series: [{ name: "Amount", values, color: null }],
  };
}

function makeSpec(opts?: Partial<WaterfallMarkOptions>): ChartSpec {
  return {
    mark: "waterfall",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Amount", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions: opts,
  };
}

// ============================================================================
// Layout
// ============================================================================

describe("computeWaterfallLayout", () => {
  it("computes a valid cartesian layout", () => {
    const data = makeData([100, -30, 50, -20]);
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });
});

// ============================================================================
// Bar Rects (running total logic)
// ============================================================================

describe("computeWaterfallBarRects", () => {
  it("returns one rect per category", () => {
    const data = makeData([100, -30, 50, -20]);
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeWaterfallBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(4);
  });

  it("tracks running total correctly via bar values", () => {
    const data = makeData([100, -30, 50]);
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeWaterfallBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    // Values are the individual changes
    expect(rects[0].value).toBe(100);
    expect(rects[1].value).toBe(-30);
    expect(rects[2].value).toBe(50);
  });

  it("classifies bars as increase/decrease", () => {
    const data = makeData([100, -30, 50, -80]);
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeWaterfallBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects[0].seriesName).toBe("increase");
    expect(rects[1].seriesName).toBe("decrease");
    expect(rects[2].seriesName).toBe("increase");
    expect(rects[3].seriesName).toBe("decrease");
  });

  it("marks total indices as total bars", () => {
    const data = makeData([100, -30, 0, 50], ["Rev", "Cost", "Subtotal", "Bonus"]);
    const spec = makeSpec({ totalIndices: [2] });
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeWaterfallBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects[2].seriesName).toBe("total");
  });

  it("returns empty for no series", () => {
    const data: ParsedChartData = { categories: ["A"], series: [] };
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeWaterfallBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(0);
  });

  it("handles all negative values", () => {
    const data = makeData([-10, -20, -30]);
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeWaterfallBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(3);
    for (const r of rects) {
      expect(r.seriesName).toBe("decrease");
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
  });

  it("handles all zeros", () => {
    const data = makeData([0, 0, 0]);
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      const rects = computeWaterfallBarRects(data, spec, layout, DEFAULT_CHART_THEME);
      expect(rects).toHaveLength(3);
    }).not.toThrow();
  });

  it("handles single value", () => {
    const data = makeData([42], ["Only"]);
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeWaterfallBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(1);
    expect(rects[0].value).toBe(42);
  });

  it("handles large dataset (50 bars)", () => {
    const n = 50;
    const values = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? -20 : 30));
    const data = makeData(values);
    const spec = makeSpec();
    const layout = computeWaterfallLayout(800, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeWaterfallBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(n);
  });
});

// ============================================================================
// Paint
// ============================================================================

describe("paintWaterfallChart", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("renders without errors", () => {
    const data = makeData([100, -30, 50, -20], ["Rev", "Cost", "Bonus", "Tax"]);
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintWaterfallChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("draws connector lines when enabled", () => {
    const data = makeData([100, -30, 50]);
    const spec = makeSpec({ showConnectors: true });
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintWaterfallChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    expect(ctx.setLineDash).toHaveBeenCalled();
  });

  it("draws fewer dashed lines when connectors are disabled", () => {
    const data = makeData([100, -30, 50]);

    // With connectors
    const specWith = makeSpec({ showConnectors: true });
    const layoutWith = computeWaterfallLayout(600, 400, specWith, data, DEFAULT_CHART_THEME);
    const ctxWith = makeCtx();
    paintWaterfallChart(ctxWith, data, specWith, layoutWith, DEFAULT_CHART_THEME);
    const dashCallsWith = (ctxWith.setLineDash as ReturnType<typeof vi.fn>).mock.calls.length;

    // Without connectors
    const specWithout = makeSpec({ showConnectors: false });
    const layoutWithout = computeWaterfallLayout(600, 400, specWithout, data, DEFAULT_CHART_THEME);
    const ctxWithout = makeCtx();
    paintWaterfallChart(ctxWithout, data, specWithout, layoutWithout, DEFAULT_CHART_THEME);
    const dashCallsWithout = (ctxWithout.setLineDash as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(dashCallsWith).toBeGreaterThan(dashCallsWithout);
  });

  it("renders with title and legend", () => {
    const data = makeData([100, -30, 50]);
    const spec = makeSpec({ totalIndices: [] });
    spec.title = "Revenue Bridge";
    spec.legend.visible = true;
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintWaterfallChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const titleCall = calls.find((c: unknown[]) => c[0] === "Revenue Bridge");
    expect(titleCall).toBeDefined();
  });

  it("handles empty series gracefully", () => {
    const data: ParsedChartData = { categories: [], series: [] };
    const spec = makeSpec();
    const layout = computeWaterfallLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintWaterfallChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});
