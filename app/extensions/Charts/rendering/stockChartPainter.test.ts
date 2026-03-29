//! FILENAME: app/extensions/Charts/rendering/stockChartPainter.test.ts
// PURPOSE: Tests for the stock (OHLC/Candlestick) chart painter.

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

/** Create OHLC data for testing. */
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

const sampleData = makeOhlcData(
  ["Mon", "Tue", "Wed", "Thu", "Fri"],
  [100, 105, 102, 110, 108],  // Open
  [112, 110, 115, 118, 115],  // High
  [98,  100, 100, 105, 103],  // Low
  [108, 103, 112, 107, 114],  // Close
);

// ============================================================================
// Layout Tests
// ============================================================================

describe("computeStockLayout", () => {
  it("computes a valid cartesian layout", () => {
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
    expect(layout.plotArea.x).toBeGreaterThan(0);
  });

  it("allocates space for Y axis labels", () => {
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    // Left margin should accommodate Y axis labels
    expect(layout.margin.left).toBeGreaterThan(16);
  });
});

// ============================================================================
// Hit Geometry Tests
// ============================================================================

describe("computeStockBarRects", () => {
  it("returns one rect per category (time period)", () => {
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const rects = computeStockBarRects(sampleData, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(5);
  });

  it("returns empty array when fewer than 4 series", () => {
    const badData: ParsedChartData = {
      categories: ["Mon"],
      series: [
        { name: "Open", values: [100], color: null },
        { name: "High", values: [110], color: null },
      ],
    };
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, badData, DEFAULT_CHART_THEME);
    const rects = computeStockBarRects(badData, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(0);
  });

  it("rect value is close price", () => {
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const rects = computeStockBarRects(sampleData, spec, layout, DEFAULT_CHART_THEME);

    // Close values: [108, 103, 112, 107, 114]
    expect(rects[0].value).toBe(108);
    expect(rects[1].value).toBe(103);
    expect(rects[2].value).toBe(112);
    expect(rects[3].value).toBe(107);
    expect(rects[4].value).toBe(114);
  });

  it("rects have positive width and height", () => {
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const rects = computeStockBarRects(sampleData, spec, layout, DEFAULT_CHART_THEME);

    for (const r of rects) {
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
    }
  });

  it("rects stay within plot area", () => {
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const rects = computeStockBarRects(sampleData, spec, layout, DEFAULT_CHART_THEME);
    const pa = layout.plotArea;

    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(pa.x - 1);
      expect(r.x + r.width).toBeLessThanOrEqual(pa.x + pa.width + 1);
      // Y can slightly exceed due to scale "nice" rounding but should be close
      expect(r.y).toBeGreaterThanOrEqual(pa.y - 5);
      expect(r.y + r.height).toBeLessThanOrEqual(pa.y + pa.height + 5);
    }
  });

  it("assigns correct category names", () => {
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const rects = computeStockBarRects(sampleData, spec, layout, DEFAULT_CHART_THEME);

    expect(rects.map((r) => r.categoryName)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  });

  it("respects custom ohlcIndices", () => {
    // Reverse order: Close=0, Low=1, High=2, Open=3
    const reversedData: ParsedChartData = {
      categories: ["Mon"],
      series: [
        { name: "Close", values: [108], color: null },
        { name: "Low", values: [98], color: null },
        { name: "High", values: [112], color: null },
        { name: "Open", values: [100], color: null },
      ],
    };
    const spec = makeSpec({ ohlcIndices: [3, 2, 1, 0] }); // O=3, H=2, L=1, C=0
    const layout = computeStockLayout(600, 400, spec, reversedData, DEFAULT_CHART_THEME);
    const rects = computeStockBarRects(reversedData, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(1);
    expect(rects[0].value).toBe(108); // Close is at index 0
  });

  it("returns empty array for empty categories", () => {
    const emptyData: ParsedChartData = {
      categories: [],
      series: [
        { name: "Open", values: [], color: null },
        { name: "High", values: [], color: null },
        { name: "Low", values: [], color: null },
        { name: "Close", values: [], color: null },
      ],
    };
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, emptyData, DEFAULT_CHART_THEME);
    const rects = computeStockBarRects(emptyData, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(0);
  });
});

// ============================================================================
// Paint Tests
// ============================================================================

describe("paintStockChart", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it("renders candlestick chart without errors", () => {
    const spec = makeSpec({ style: "candlestick" });
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    // Should draw wicks (lines) and bodies (rects)
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("renders OHLC bars without errors", () => {
    const spec = makeSpec({ style: "ohlc" });
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    // Should draw vertical lines and ticks
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.moveTo).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalled();
  });

  it("shows error message when less than 4 series", () => {
    const badData: ParsedChartData = {
      categories: ["Mon"],
      series: [
        { name: "Open", values: [100], color: null },
        { name: "High", values: [110], color: null },
      ],
    };
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, badData, DEFAULT_CHART_THEME);

    paintStockChart(ctx, badData, spec, layout, DEFAULT_CHART_THEME);

    // Should show an informative message
    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const errorMsg = calls.find((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("4 series"),
    );
    expect(errorMsg).toBeDefined();
  });

  it("handles empty categories gracefully", () => {
    const emptyData: ParsedChartData = {
      categories: [],
      series: [
        { name: "Open", values: [], color: null },
        { name: "High", values: [], color: null },
        { name: "Low", values: [], color: null },
        { name: "Close", values: [], color: null },
      ],
    };
    const spec = makeSpec();
    const layout = computeStockLayout(600, 400, spec, emptyData, DEFAULT_CHART_THEME);

    expect(() => {
      paintStockChart(ctx, emptyData, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("draws title when present", () => {
    const spec = makeSpec();
    spec.title = "Stock Prices";
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    paintStockChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const titleCall = calls.find((c: unknown[]) => c[0] === "Stock Prices");
    expect(titleCall).toBeDefined();
  });

  it("uses custom up/down colors", () => {
    const spec = makeSpec({ upColor: "#00FF00", downColor: "#FF0000" });
    const layout = computeStockLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    // Just verify it doesn't throw — color application is internal
    expect(() => {
      paintStockChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});
