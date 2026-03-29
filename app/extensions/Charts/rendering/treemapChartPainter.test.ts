//! FILENAME: app/extensions/Charts/rendering/treemapChartPainter.test.ts
// PURPOSE: Tests for the treemap chart painter — layout algorithm, hit geometry, rendering.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeTreemapLayout,
  computeTreemapBarRects,
  paintTreemapChart,
} from "./treemapChartPainter";
import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  TreemapMarkOptions,
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
    categories: categories ?? values.map((_, i) => `Cat ${i + 1}`),
    series: [{ name: "Values", values, color: null }],
  };
}

function makeSpec(opts?: Partial<TreemapMarkOptions>): ChartSpec {
  return {
    mark: "treemap",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Values", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions: opts,
  };
}

// ============================================================================
// Layout Tests
// ============================================================================

describe("computeTreemapLayout", () => {
  it("computes a valid layout with plot area", () => {
    const data = makeData([40, 30, 20, 10]);
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(layout.width).toBe(600);
    expect(layout.height).toBe(400);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });

  it("accounts for title in top margin", () => {
    const data = makeData([40, 30, 20, 10]);
    const specNoTitle = makeSpec();
    const specWithTitle = makeSpec();
    specWithTitle.title = "My Treemap";

    const layoutNoTitle = computeTreemapLayout(600, 400, specNoTitle, data, DEFAULT_CHART_THEME);
    const layoutWithTitle = computeTreemapLayout(600, 400, specWithTitle, data, DEFAULT_CHART_THEME);

    expect(layoutWithTitle.plotArea.y).toBeGreaterThan(layoutNoTitle.plotArea.y);
  });
});

// ============================================================================
// Hit Geometry Tests (Squarified Layout)
// ============================================================================

describe("computeTreemapBarRects", () => {
  it("returns one rect per category", () => {
    const data = makeData([40, 30, 20, 10]);
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(4);
  });

  it("total area of rects approximates plot area", () => {
    const data = makeData([40, 30, 20, 10]);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    const totalRectArea = rects.reduce((sum, r) => sum + r.width * r.height, 0);
    const plotArea = layout.plotArea.width * layout.plotArea.height;

    // Should be very close (within 1% tolerance)
    expect(Math.abs(totalRectArea - plotArea) / plotArea).toBeLessThan(0.01);
  });

  it("rect areas are proportional to values", () => {
    const data = makeData([100, 50]);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    const area0 = rects[0].width * rects[0].height;
    const area1 = rects[1].width * rects[1].height;

    // Value 100 should have ~2x the area of value 50
    const ratio = area0 / area1;
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
  });

  it("returns empty array for no data", () => {
    const data: ParsedChartData = { categories: [], series: [] };
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(0);
  });

  it("returns empty array for all-zero values", () => {
    const data = makeData([0, 0, 0]);
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(0);
  });

  it("handles single item", () => {
    const data = makeData([100], ["Only One"]);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(1);
    // Single tile should fill the entire plot area
    expect(rects[0].width).toBeCloseTo(layout.plotArea.width, 0);
    expect(rects[0].height).toBeCloseTo(layout.plotArea.height, 0);
  });

  it("tiles do not overlap", () => {
    const data = makeData([50, 30, 15, 5]);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    // Check no pair of rects overlaps
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlapX = a.x < b.x + b.width && a.x + a.width > b.x;
        const overlapY = a.y < b.y + b.height && a.y + a.height > b.y;
        // Allow tiny floating-point overlap (< 0.5px)
        if (overlapX && overlapY) {
          const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          expect(overlapWidth * overlapHeight).toBeLessThan(1);
        }
      }
    }
  });

  it("all tiles stay within plot area", () => {
    const data = makeData([80, 60, 40, 20, 10, 5]);
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    const pa = layout.plotArea;

    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(pa.x - 1);
      expect(r.y).toBeGreaterThanOrEqual(pa.y - 1);
      expect(r.x + r.width).toBeLessThanOrEqual(pa.x + pa.width + 1);
      expect(r.y + r.height).toBeLessThanOrEqual(pa.y + pa.height + 1);
    }
  });

  it("assigns correct category names to rects", () => {
    const data = makeData([100, 50, 25], ["Alpha", "Beta", "Gamma"]);
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    const names = rects.map((r) => r.categoryName).sort();
    expect(names).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("handles negative values by clamping to zero", () => {
    const data = makeData([100, -50, 30]);
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    // Negative value maps to 0 area — may or may not produce a rect
    // At minimum, the other two should be present
    expect(rects.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Paint Tests
// ============================================================================

describe("paintTreemapChart", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it("renders tiles with labels", () => {
    const data = makeData([40, 30, 20, 10], ["A", "B", "C", "D"]);
    const spec = makeSpec({ showLabels: true });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    // Should have drawn fill calls for tiles and fillText calls for labels
    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it("suppresses labels when showLabels is false", () => {
    const data = makeData([40, 30, 20, 10], ["A", "B", "C", "D"]);
    const spec = makeSpec({ showLabels: false });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("handles empty data without errors", () => {
    const data: ParsedChartData = { categories: [], series: [] };
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("draws title when present", () => {
    const data = makeData([40, 30], ["A", "B"]);
    const spec = makeSpec();
    spec.title = "Treemap Title";
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const titleCall = calls.find((c: unknown[]) => c[0] === "Treemap Title");
    expect(titleCall).toBeDefined();
  });
});
