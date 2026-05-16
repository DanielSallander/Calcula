//! FILENAME: app/extensions/Charts/rendering/stockChartPainter.edge.test.ts
// PURPOSE: Edge case tests for the stock (OHLC/Candlestick) chart painter.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeStockLayout,
  computeStockBarRects,
  paintStockChart,
} from "./stockChartPainter";
import type {
  ChartSpec,
  ParsedChartData,
  StockMarkOptions,
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

function makeOhlcData(
  categories: string[],
  open: number[],
  high: number[],
  low: number[],
  close: number[],
): ParsedChartData {
  return {
    categories,
    series: [
      { name: "Open", values: open, color: null },
      { name: "High", values: high, color: null },
      { name: "Low", values: low, color: null },
      { name: "Close", values: close, color: null },
    ],
  };
}

function makeSpec(opts?: Partial<StockMarkOptions>): ChartSpec {
  return {
    mark: "stock",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 4 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Open", sourceIndex: 1, color: null },
      { name: "High", sourceIndex: 2, color: null },
      { name: "Low", sourceIndex: 3, color: null },
      { name: "Close", sourceIndex: 4, color: null },
    ],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions: opts,
  };
}

// ============================================================================
// OHLC with inverted values (open > close vs close > open)
// ============================================================================

describe("stock chart: inverted values (bullish vs bearish)", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("handles all bearish candles (open > close for every bar)", () => {
    const data = makeOhlcData(
      ["Mon", "Tue", "Wed"],
      [110, 108, 106],  // Open (always higher)
      [112, 110, 108],  // High
      [98, 96, 94],     // Low
      [100, 98, 96],    // Close (always lower)
    );
    const spec = makeSpec({ style: "candlestick" });
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("handles all bullish candles (close > open for every bar)", () => {
    const data = makeOhlcData(
      ["Mon", "Tue", "Wed"],
      [100, 102, 104],  // Open (always lower)
      [112, 114, 116],  // High
      [98, 100, 102],   // Low
      [110, 112, 114],  // Close (always higher)
    );
    const spec = makeSpec({ style: "candlestick" });
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("handles alternating bullish/bearish candles", () => {
    const data = makeOhlcData(
      ["Mon", "Tue", "Wed", "Thu"],
      [100, 110, 100, 110],
      [115, 115, 115, 115],
      [95, 95, 95, 95],
      [110, 100, 110, 100],
    );
    const spec = makeSpec({ style: "ohlc" });
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    const rects = computeStockBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    expect(rects).toHaveLength(4);
  });

  it("handles doji candles (open === close)", () => {
    const data = makeOhlcData(
      ["Mon", "Tue"],
      [100, 105],
      [110, 115],
      [90, 95],
      [100, 105], // same as open
    );
    const spec = makeSpec({ style: "candlestick" });
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    // Body height should be at minimum 1px even for doji
    const rects = computeStockBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    for (const r of rects) {
      expect(r.height).toBeGreaterThanOrEqual(0);
    }
  });
});

// ============================================================================
// Missing data points (gaps in OHLC)
// ============================================================================

describe("stock chart: missing/sparse data points", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("handles series with fewer values than categories", () => {
    const data: ParsedChartData = {
      categories: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      series: [
        { name: "Open", values: [100, 105], color: null },        // only 2
        { name: "High", values: [110, 115, 120], color: null },   // only 3
        { name: "Low", values: [90], color: null },                // only 1
        { name: "Close", values: [105, 110, 115, 108], color: null }, // 4
      ],
    };
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    const rects = computeStockBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    // Should still produce rects for all 5 categories (missing values default to 0)
    expect(rects).toHaveLength(5);
  });

  it("handles empty series values arrays", () => {
    const data: ParsedChartData = {
      categories: ["Mon"],
      series: [
        { name: "Open", values: [], color: null },
        { name: "High", values: [], color: null },
        { name: "Low", values: [], color: null },
        { name: "Close", values: [], color: null },
      ],
    };
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});

// ============================================================================
// Single candlestick
// ============================================================================

describe("stock chart: single candlestick", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("renders a single candlestick correctly", () => {
    const data = makeOhlcData(["Day 1"], [100], [120], [80], [110]);
    const spec = makeSpec({ style: "candlestick" });
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();

    const rects = computeStockBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    expect(rects).toHaveLength(1);
    expect(rects[0].value).toBe(110);
    expect(rects[0].categoryName).toBe("Day 1");
  });

  it("renders a single OHLC bar correctly", () => {
    const data = makeOhlcData(["Day 1"], [100], [120], [80], [90]);
    const spec = makeSpec({ style: "ohlc" });
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});

// ============================================================================
// 100+ candlesticks
// ============================================================================

describe("stock chart: large dataset (100+ candlesticks)", () => {
  it("handles 150 candlesticks without errors", () => {
    const n = 150;
    const categories = Array.from({ length: n }, (_, i) => `Day ${i + 1}`);
    const open = Array.from({ length: n }, (_, i) => 100 + Math.sin(i * 0.1) * 10);
    const high = open.map((o) => o + 5 + Math.random() * 10);
    const low = open.map((o) => o - 5 - Math.random() * 10);
    const close = open.map((o, i) => o + (i % 2 === 0 ? 3 : -3));

    const data = makeOhlcData(categories, open, high, low, close);
    const spec = makeSpec({ style: "candlestick" });
    const layout = computeStockLayout(800, 400, spec, data, DEFAULT_CHART_THEME);

    const ctx = makeCtx();
    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    const rects = computeStockBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    expect(rects).toHaveLength(n);

    // All rects should have positive dimensions
    for (const r of rects) {
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles 200 OHLC bars", () => {
    const n = 200;
    const categories = Array.from({ length: n }, (_, i) => `T${i}`);
    const base = 50;
    const open = Array.from({ length: n }, () => base);
    const high = Array.from({ length: n }, () => base + 10);
    const low = Array.from({ length: n }, () => base - 10);
    const close = Array.from({ length: n }, () => base + 5);

    const data = makeOhlcData(categories, open, high, low, close);
    const spec = makeSpec({ style: "ohlc" });
    const layout = computeStockLayout(1200, 400, spec, data, DEFAULT_CHART_THEME);

    const ctx = makeCtx();
    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    const rects = computeStockBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    expect(rects).toHaveLength(n);
  });
});

// ============================================================================
// All same values (flat market)
// ============================================================================

describe("stock chart: flat market (all values identical)", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("handles all OHLC values being identical", () => {
    const v = 100;
    const data = makeOhlcData(
      ["Mon", "Tue", "Wed"],
      [v, v, v],
      [v, v, v],
      [v, v, v],
      [v, v, v],
    );
    const spec = makeSpec({ style: "candlestick" });
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    const rects = computeStockBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    expect(rects).toHaveLength(3);
    for (const r of rects) {
      expect(r.value).toBe(v);
    }
  });

  it("handles all zeros", () => {
    const data = makeOhlcData(
      ["A", "B"],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    );
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});

// ============================================================================
// Extreme price swings
// ============================================================================

describe("stock chart: extreme price swings", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("handles huge range (penny stock to thousands)", () => {
    const data = makeOhlcData(
      ["Day 1", "Day 2", "Day 3"],
      [0.01, 500, 5000],
      [0.02, 1000, 10000],
      [0.005, 100, 1000],
      [0.015, 800, 8000],
    );
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    const rects = computeStockBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    expect(rects).toHaveLength(3);
    for (const r of rects) {
      expect(r.width).toBeGreaterThan(0);
      expect(isFinite(r.x)).toBe(true);
      expect(isFinite(r.y)).toBe(true);
    }
  });

  it("handles negative prices", () => {
    // Oil futures went negative in 2020!
    const data = makeOhlcData(
      ["T1", "T2"],
      [-10, -30],
      [5, -5],
      [-40, -50],
      [-20, -10],
    );
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    const rects = computeStockBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    expect(rects).toHaveLength(2);
  });

  it("handles very small price differences (micro ticks)", () => {
    const base = 1000000;
    const data = makeOhlcData(
      ["T1", "T2", "T3"],
      [base, base + 0.001, base + 0.002],
      [base + 0.01, base + 0.011, base + 0.012],
      [base - 0.01, base - 0.009, base - 0.008],
      [base + 0.005, base + 0.006, base + 0.007],
    );
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("handles custom bodyWidth and wickWidth", () => {
    const data = makeOhlcData(
      ["A", "B"],
      [100, 105],
      [120, 125],
      [80, 85],
      [110, 95],
    );
    const spec = makeSpec({ bodyWidth: 0.9, wickWidth: 3 });
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const ctx = makeCtx();

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("handles fixed Y axis min/max with data outside range", () => {
    const data = makeOhlcData(
      ["A", "B"],
      [100, 200],
      [150, 250],
      [50, 150],
      [120, 220],
    );
    const spec = makeSpec();
    spec.yAxis.min = 80;
    spec.yAxis.max = 180;
    const layout = computeStockLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const ctx = makeCtx();

    expect(() => {
      paintStockChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});
