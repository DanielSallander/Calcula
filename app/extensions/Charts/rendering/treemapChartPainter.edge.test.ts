//! FILENAME: app/extensions/Charts/rendering/treemapChartPainter.edge.test.ts
// PURPOSE: Edge case tests for the treemap chart painter — deeply nested, extreme sizes, etc.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeTreemapLayout,
  computeTreemapBarRects,
  paintTreemapChart,
} from "./treemapChartPainter";
import type {
  ChartSpec,
  ParsedChartData,
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
// Single node
// ============================================================================

describe("treemap: single node", () => {
  it("single tile fills entire plot area (no border)", () => {
    const data = makeData([42], ["OnlyItem"]);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(1);
    expect(rects[0].width).toBeCloseTo(layout.plotArea.width, 0);
    expect(rects[0].height).toBeCloseTo(layout.plotArea.height, 0);
    expect(rects[0].categoryName).toBe("OnlyItem");
    expect(rects[0].value).toBe(42);
  });

  it("single tile renders labels correctly", () => {
    const data = makeData([999], ["Sole"]);
    const spec = makeSpec({ showLabels: true, labelFormat: "both" });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const ctx = makeCtx();

    paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    expect(ctx.fillText).toHaveBeenCalled();
  });
});

// ============================================================================
// Negative values
// ============================================================================

describe("treemap: negative and zero values", () => {
  it("negative values are clamped to zero area", () => {
    const data = makeData([100, -50, -25, 30]);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    // Only positive items get meaningful tiles; negatives become 0-area
    const positiveRects = rects.filter((r) => r.width > 0 && r.height > 0);
    expect(positiveRects.length).toBeGreaterThanOrEqual(2);
  });

  it("all negative values produce no rects (total is 0)", () => {
    const data = makeData([-10, -20, -30]);
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(0);
  });

  it("mix of zeros and positives", () => {
    const data = makeData([0, 50, 0, 50, 0]);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    // The two positive items get tiles; zeros may produce degenerate tiles
    const meaningful = rects.filter((r) => r.width > 1 && r.height > 1);
    expect(meaningful.length).toBeGreaterThanOrEqual(2);
  });

  it("single zero value produces no rects", () => {
    const data = makeData([0]);
    const spec = makeSpec();
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(0);
  });
});

// ============================================================================
// Very uneven sizes (one huge, many tiny)
// ============================================================================

describe("treemap: uneven sizes", () => {
  it("one dominant value with many tiny ones", () => {
    const values = [10000, ...Array.from({ length: 20 }, () => 1)];
    const data = makeData(values);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(21);

    // The first tile (largest) should dominate the area
    const areas = rects.map((r) => r.width * r.height);
    const totalArea = areas.reduce((a, b) => a + b, 0);
    const dominantRatio = areas[0] / totalArea;
    expect(dominantRatio).toBeGreaterThan(0.9);
  });

  it("exponentially growing values", () => {
    const values = Array.from({ length: 10 }, (_, i) => Math.pow(2, i));
    const data = makeData(values);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(10);

    // No overlap check
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlapX = a.x < b.x + b.width && a.x + a.width > b.x;
        const overlapY = a.y < b.y + b.height && a.y + a.height > b.y;
        if (overlapX && overlapY) {
          const overlapArea =
            (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
            (Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
          expect(overlapArea).toBeLessThan(1);
        }
      }
    }
  });
});

// ============================================================================
// 100+ leaf nodes
// ============================================================================

describe("treemap: large dataset (100+ nodes)", () => {
  it("handles 150 items without errors", () => {
    const n = 150;
    const values = Array.from({ length: n }, (_, i) => (i + 1) * 10);
    const data = makeData(values);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(800, 600, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(n);

    // Total area should approximate plot area
    const totalRectArea = rects.reduce((sum, r) => sum + r.width * r.height, 0);
    const plotArea = layout.plotArea.width * layout.plotArea.height;
    expect(Math.abs(totalRectArea - plotArea) / plotArea).toBeLessThan(0.02);
  });

  it("renders 100+ tiles without throwing", () => {
    const n = 100;
    const values = Array.from({ length: n }, () => Math.random() * 100 + 1);
    const data = makeData(values);
    const spec = makeSpec();
    const layout = computeTreemapLayout(800, 600, spec, data, DEFAULT_CHART_THEME);
    const ctx = makeCtx();

    expect(() => {
      paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("all tiles stay within plot area for large dataset", () => {
    const n = 120;
    const values = Array.from({ length: n }, (_, i) => n - i);
    const data = makeData(values);
    const spec = makeSpec();
    const layout = computeTreemapLayout(800, 600, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);
    const pa = layout.plotArea;

    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(pa.x - 2);
      expect(r.y).toBeGreaterThanOrEqual(pa.y - 2);
      expect(r.x + r.width).toBeLessThanOrEqual(pa.x + pa.width + 2);
      expect(r.y + r.height).toBeLessThanOrEqual(pa.y + pa.height + 2);
    }
  });
});

// ============================================================================
// Long labels
// ============================================================================

describe("treemap: long labels", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("handles very long category names without errors", () => {
    const longName = "A".repeat(200);
    const data = makeData([100, 50, 25], [longName, "Short", "X"]);
    const spec = makeSpec({ showLabels: true, labelFormat: "both" });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("handles unicode category names", () => {
    const data = makeData([60, 30, 10], ["Umsatz (EUR)", "Kosten", "Gewinn"]);
    const spec = makeSpec({ showLabels: true });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("suppresses labels for tiny tiles (< 30x20)", () => {
    // One huge tile, many tiny. Tiny tiles should not get labels.
    const values = [10000, ...Array.from({ length: 50 }, () => 1)];
    const data = makeData(values);
    const spec = makeSpec({ showLabels: true, labelFormat: "category" });
    const layout = computeTreemapLayout(400, 300, spec, data, DEFAULT_CHART_THEME);

    paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    // fillText should have been called, but not 51 times (tiny tiles skipped)
    const fillTextCalls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(fillTextCalls).toBeLessThan(51);
    expect(fillTextCalls).toBeGreaterThan(0);
  });
});

// ============================================================================
// Label formats
// ============================================================================

describe("treemap: label format options", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("renders with labelFormat 'category'", () => {
    const data = makeData([80, 20], ["Alpha", "Beta"]);
    const spec = makeSpec({ showLabels: true, labelFormat: "category" });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("renders with labelFormat 'value'", () => {
    const data = makeData([80, 20], ["Alpha", "Beta"]);
    const spec = makeSpec({ showLabels: true, labelFormat: "value" });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});

// ============================================================================
// Tile border and radius options
// ============================================================================

describe("treemap: border and radius options", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("renders with zero border width", () => {
    const data = makeData([50, 30, 20]);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    // No stroke calls for borders
    expect(ctx.strokeRect).not.toHaveBeenCalled();
  });

  it("renders with large border width", () => {
    const data = makeData([50, 30, 20]);
    const spec = makeSpec({ tileBorderWidth: 10, tileBorderColor: "#000000" });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("renders with zero tile radius (sharp corners)", () => {
    const data = makeData([50, 30, 20]);
    const spec = makeSpec({ tileRadius: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    // Should use fillRect instead of drawRoundedRect
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("renders with large tile radius", () => {
    const data = makeData([50, 30, 20]);
    const spec = makeSpec({ tileRadius: 20 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintTreemapChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});

// ============================================================================
// Two equal values
// ============================================================================

describe("treemap: equal values", () => {
  it("two equal values produce equal-area tiles", () => {
    const data = makeData([100, 100]);
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(2);
    const area0 = rects[0].width * rects[0].height;
    const area1 = rects[1].width * rects[1].height;
    expect(area0).toBeCloseTo(area1, 0);
  });

  it("many equal values produce equal-area tiles", () => {
    const n = 8;
    const data = makeData(Array.from({ length: n }, () => 50));
    const spec = makeSpec({ tileBorderWidth: 0 });
    const layout = computeTreemapLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const rects = computeTreemapBarRects(data, spec, layout, DEFAULT_CHART_THEME);

    expect(rects).toHaveLength(n);
    const areas = rects.map((r) => r.width * r.height);
    const avgArea = areas.reduce((a, b) => a + b, 0) / n;
    for (const a of areas) {
      expect(a / avgArea).toBeGreaterThan(0.8);
      expect(a / avgArea).toBeLessThan(1.2);
    }
  });
});
