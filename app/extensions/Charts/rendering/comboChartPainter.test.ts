//! FILENAME: app/extensions/Charts/rendering/comboChartPainter.test.ts
// PURPOSE: Tests for the combo chart painter (bar + line + area).

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeComboLayout,
  computeComboHitGeometry,
  paintComboChart,
} from "./comboChartPainter";
import type {
  ChartSpec,
  ParsedChartData,
  ComboMarkOptions,
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

function makeSpec(opts?: Partial<ComboMarkOptions>): ChartSpec {
  return {
    mark: "combo",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Trend", sourceIndex: 2, color: null },
    ],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions: opts,
  };
}

const sampleData = makeData(
  ["Q1", "Q2", "Q3", "Q4"],
  [
    { name: "Revenue", values: [100, 150, 130, 180] },
    { name: "Trend", values: [110, 125, 140, 160] },
  ],
);

// ============================================================================
// Layout
// ============================================================================

describe("computeComboLayout", () => {
  it("returns valid layout", () => {
    const spec = makeSpec();
    const layout = computeComboLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    expect(layout.width).toBe(600);
    expect(layout.plotArea.width).toBeGreaterThan(0);
  });

  it("adds extra margin for secondary Y axis", () => {
    const specNoSec = makeSpec();
    const specWithSec = makeSpec({ secondaryYAxis: true, secondaryAxisSeries: [1] });

    const layoutNoSec = computeComboLayout(600, 400, specNoSec, sampleData, DEFAULT_CHART_THEME);
    const layoutWithSec = computeComboLayout(600, 400, specWithSec, sampleData, DEFAULT_CHART_THEME);

    expect(layoutWithSec.margin.right).toBeGreaterThan(layoutNoSec.margin.right);
    expect(layoutWithSec.plotArea.width).toBeLessThan(layoutNoSec.plotArea.width);
  });
});

// ============================================================================
// Hit Geometry
// ============================================================================

describe("computeComboHitGeometry", () => {
  it("returns composite hit geometry with bar and point groups", () => {
    const spec = makeSpec({ seriesMarks: { 0: "bar", 1: "line" } });
    const layout = computeComboLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const geo = computeComboHitGeometry(sampleData, spec, layout, DEFAULT_CHART_THEME);

    expect(geo.type).toBe("composite");
    if (geo.type === "composite") {
      expect(geo.groups.length).toBeGreaterThan(0);
    }
  });

  it("handles all-bar combo", () => {
    const spec = makeSpec({ seriesMarks: { 0: "bar", 1: "bar" } });
    const layout = computeComboLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const geo = computeComboHitGeometry(sampleData, spec, layout, DEFAULT_CHART_THEME);

    // When all series are bars, may return "bars" directly instead of "composite"
    expect(geo.type).toBe("bars");
    if (geo.type === "bars") {
      expect(geo.rects.length).toBe(8); // 2 series x 4 categories
    }
  });

  it("handles all-line combo", () => {
    const spec = makeSpec({ seriesMarks: { 0: "line", 1: "line" } });
    const layout = computeComboLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);
    const geo = computeComboHitGeometry(sampleData, spec, layout, DEFAULT_CHART_THEME);

    // When all series are lines, may return "points" directly
    expect(geo.type).toBe("points");
    if (geo.type === "points") {
      expect(geo.markers.length).toBeGreaterThan(0);
    }
  });

  it("handles empty data", () => {
    const data: ParsedChartData = { categories: [], series: [] };
    const spec = makeSpec();
    const layout = computeComboLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const geo = computeComboHitGeometry(data, spec, layout, DEFAULT_CHART_THEME);

    expect(geo.type).toBe("composite");
    if (geo.type === "composite") {
      expect(geo.groups).toHaveLength(0);
    }
  });

  it("handles secondary axis series", () => {
    const data = makeData(
      ["A", "B", "C"],
      [
        { name: "Sales", values: [100, 200, 300] },
        { name: "Margin %", values: [10, 15, 12] },
      ],
    );
    const spec = makeSpec({
      seriesMarks: { 0: "bar", 1: "line" },
      secondaryYAxis: true,
      secondaryAxisSeries: [1],
    });
    const layout = computeComboLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
    const geo = computeComboHitGeometry(data, spec, layout, DEFAULT_CHART_THEME);

    expect(geo.type).toBe("composite");
    if (geo.type === "composite") {
      expect(geo.groups.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Paint
// ============================================================================

describe("paintComboChart", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => { ctx = makeCtx(); });

  it("renders bar + line combo without errors", () => {
    const spec = makeSpec({ seriesMarks: { 0: "bar", 1: "line" } });
    const layout = computeComboLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    expect(() => {
      paintComboChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();

    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("renders bar + area combo", () => {
    const spec = makeSpec({ seriesMarks: { 0: "bar", 1: "area" } });
    const layout = computeComboLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    expect(() => {
      paintComboChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("renders with secondary Y axis", () => {
    const spec = makeSpec({
      seriesMarks: { 0: "bar", 1: "line" },
      secondaryYAxis: true,
      secondaryAxisSeries: [1],
      secondaryAxis: { title: "Percent", gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    });
    const layout = computeComboLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    expect(() => {
      paintComboChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("handles single series", () => {
    const data = makeData(["A", "B", "C"], [{ name: "Sales", values: [10, 20, 30] }]);
    const spec = makeSpec({ seriesMarks: { 0: "bar" } });
    const layout = computeComboLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintComboChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("handles empty data gracefully", () => {
    const data: ParsedChartData = { categories: [], series: [] };
    const spec = makeSpec();
    const layout = computeComboLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintComboChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });

  it("draws title when present", () => {
    const spec = makeSpec();
    spec.title = "Revenue vs Trend";
    const layout = computeComboLayout(600, 400, spec, sampleData, DEFAULT_CHART_THEME);

    paintComboChart(ctx, sampleData, spec, layout, DEFAULT_CHART_THEME);

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const titleCall = calls.find((c: unknown[]) => c[0] === "Revenue vs Trend");
    expect(titleCall).toBeDefined();
  });

  it("handles negative values in bar series", () => {
    const data = makeData(
      ["A", "B", "C"],
      [
        { name: "PnL", values: [100, -50, 75] },
        { name: "Trend", values: [80, 30, 60] },
      ],
    );
    const spec = makeSpec({ seriesMarks: { 0: "bar", 1: "line" } });
    const layout = computeComboLayout(600, 400, spec, data, DEFAULT_CHART_THEME);

    expect(() => {
      paintComboChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    }).not.toThrow();
  });
});
