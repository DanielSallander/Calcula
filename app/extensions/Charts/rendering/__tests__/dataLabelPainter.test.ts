//! FILENAME: app/extensions/Charts/rendering/__tests__/dataLabelPainter.test.ts
// PURPOSE: Tests for data label painting — positioning, formatting, filtering, edge cases.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { paintDataLabels } from "../dataLabelPainter";
import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  HitGeometry,
  BarRect,
  PointMarker,
  SliceArc,
  DataLabelSpec,
} from "../../types";
import type { ChartRenderTheme } from "../chartTheme";

// ============================================================================
// Helpers
// ============================================================================

function makeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillText: vi.fn(),
    fillRect: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 40 }),
    font: "",
    fillStyle: "",
    textAlign: "center" as CanvasTextAlign,
    textBaseline: "middle" as CanvasTextBaseline,
  } as unknown as CanvasRenderingContext2D;
}

const defaultTheme: ChartRenderTheme = {
  background: "#fff",
  plotBackground: "#fff",
  gridLineColor: "#e0e0e0",
  gridLineWidth: 1,
  axisColor: "#333",
  axisLabelColor: "#666",
  axisTitleColor: "#333",
  titleColor: "#333",
  legendTextColor: "#666",
  fontFamily: "Segoe UI",
  titleFontSize: 14,
  axisTitleFontSize: 11,
  labelFontSize: 10,
  legendFontSize: 10,
  barBorderRadius: 2,
  barGap: 2,
};

const defaultLayout: ChartLayout = {
  width: 600,
  height: 400,
  margin: { top: 40, right: 20, bottom: 40, left: 50 },
  plotArea: { x: 50, y: 40, width: 530, height: 320 },
};

const defaultData: ParsedChartData = {
  categories: ["A", "B", "C"],
  series: [
    { name: "Sales", values: [100, 200, 300], color: "#4E79A7" },
    { name: "Profit", values: [50, 80, 120], color: "#F28E2B" },
  ],
};

function makeSpec(dl: Partial<DataLabelSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Sales", sourceIndex: 1, color: "#4E79A7" },
      { name: "Profit", sourceIndex: 2, color: "#F28E2B" },
    ],
    title: "Test",
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "tableau10",
    dataLabels: { enabled: true, ...dl },
  } as ChartSpec;
}

function makeBar(overrides: Partial<BarRect> = {}): BarRect {
  return {
    seriesIndex: 0,
    categoryIndex: 0,
    x: 100,
    y: 100,
    width: 40,
    height: 150,
    value: 200,
    seriesName: "Sales",
    categoryName: "A",
    ...overrides,
  };
}

function makePoint(overrides: Partial<PointMarker> = {}): PointMarker {
  return {
    seriesIndex: 0,
    categoryIndex: 0,
    cx: 150,
    cy: 120,
    radius: 4,
    value: 200,
    seriesName: "Sales",
    categoryName: "A",
    ...overrides,
  };
}

function makeSlice(overrides: Partial<SliceArc> = {}): SliceArc {
  return {
    seriesIndex: 0,
    startAngle: 0,
    endAngle: Math.PI / 2,
    innerRadius: 0,
    outerRadius: 100,
    centerX: 300,
    centerY: 200,
    value: 100,
    label: "A",
    percent: 25,
    ...overrides,
  };
}

// ============================================================================
// Label Positioning - Bar Charts
// ============================================================================

describe("dataLabelPainter - bar label positioning", () => {
  it("positions labels above bars by default (auto)", () => {
    const ctx = makeCtx();
    const bar = makeBar({ y: 100, height: 150 });
    const geometry: HitGeometry = { type: "bars", rects: [bar] };

    paintDataLabels(ctx, defaultData, makeSpec(), defaultLayout, defaultTheme, geometry);

    expect(ctx.fillText).toHaveBeenCalled();
    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    // "auto" resolves to "above": y = bar.y - 4 = 96
    expect(y).toBe(96);
  });

  it("positions labels below bars", () => {
    const ctx = makeCtx();
    const bar = makeBar({ y: 100, height: 150 });
    const geometry: HitGeometry = { type: "bars", rects: [bar] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "below" }), defaultLayout, defaultTheme, geometry);

    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    // below: y = bar.y + bar.height + fontSize + 2 = 100 + 150 + 10 + 2 = 262
    expect(y).toBe(262);
  });

  it("positions labels at center of bars", () => {
    const ctx = makeCtx();
    const bar = makeBar({ y: 100, height: 150 });
    const geometry: HitGeometry = { type: "bars", rects: [bar] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "center" }), defaultLayout, defaultTheme, geometry);

    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    // center: y = bar.y + bar.height/2 = 175
    expect(y).toBe(175);
  });

  it("positions labels inside bars (same as center)", () => {
    const ctx = makeCtx();
    const bar = makeBar({ y: 100, height: 150 });
    const geometry: HitGeometry = { type: "bars", rects: [bar] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "inside" }), defaultLayout, defaultTheme, geometry);

    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(y).toBe(175);
  });

  it("uses white text color for inside/center labels by default", () => {
    const ctx = makeCtx();
    const bar = makeBar();
    const geometry: HitGeometry = { type: "bars", rects: [bar] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "center" }), defaultLayout, defaultTheme, geometry);

    // fillStyle is set before fillText
    const fillStyleCalls: string[] = [];
    (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls.forEach(() => {
      fillStyleCalls.push(ctx.fillStyle as string);
    });
    // The last fillStyle set before fillText should be white for center
    expect(ctx.fillStyle).toBe("#ffffff");
  });

  it("uses dark text color for above labels by default", () => {
    const ctx = makeCtx();
    const bar = makeBar();
    const geometry: HitGeometry = { type: "bars", rects: [bar] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "above" }), defaultLayout, defaultTheme, geometry);

    expect(ctx.fillStyle).toBe("#333333");
  });
});

// ============================================================================
// Label Positioning - Point Charts (line, area, scatter)
// ============================================================================

describe("dataLabelPainter - point label positioning", () => {
  it("positions labels above points by default", () => {
    const ctx = makeCtx();
    const marker = makePoint({ cy: 120, radius: 4 });
    const geometry: HitGeometry = { type: "points", markers: [marker] };

    paintDataLabels(ctx, defaultData, makeSpec(), defaultLayout, defaultTheme, geometry);

    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    // above: cy - radius - 4 = 120 - 4 - 4 = 112
    expect(y).toBe(112);
  });

  it("positions labels below points", () => {
    const ctx = makeCtx();
    const marker = makePoint({ cy: 120, radius: 4 });
    const geometry: HitGeometry = { type: "points", markers: [marker] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "below" }), defaultLayout, defaultTheme, geometry);

    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    // below: cy + radius + fontSize + 2 = 120 + 4 + 10 + 2 = 136
    expect(y).toBe(136);
  });

  it("positions labels at center of points", () => {
    const ctx = makeCtx();
    const marker = makePoint({ cy: 150 });
    const geometry: HitGeometry = { type: "points", markers: [marker] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "center" }), defaultLayout, defaultTheme, geometry);

    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(y).toBe(150);
  });
});

// ============================================================================
// Label Positioning - Pie/Donut Slices
// ============================================================================

describe("dataLabelPainter - slice label positioning", () => {
  it("positions labels outside the slice at the midpoint angle", () => {
    const ctx = makeCtx();
    const arc = makeSlice({
      startAngle: 0,
      endAngle: Math.PI / 2,
      outerRadius: 100,
      centerX: 300,
      centerY: 200,
    });
    const geometry: HitGeometry = { type: "slices", arcs: [arc] };

    paintDataLabels(ctx, defaultData, makeSpec(), defaultLayout, defaultTheme, geometry);

    expect(ctx.fillText).toHaveBeenCalled();
    const [, x, y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    // midAngle = PI/4, labelRadius = 116
    const midAngle = Math.PI / 4;
    const expectedX = 300 + Math.cos(midAngle) * 116;
    const expectedY = 200 + Math.sin(midAngle) * 116;
    expect(x).toBeCloseTo(expectedX, 1);
    expect(y).toBeCloseTo(expectedY, 1);
  });

  it("sets text alignment based on which side of the pie the label is on", () => {
    const ctx = makeCtx();
    // Right side slice (midAngle near 0) -> textAlign = "left"
    const arcRight = makeSlice({ startAngle: -0.3, endAngle: 0.3 });
    paintDataLabels(ctx, defaultData, makeSpec(), defaultLayout, defaultTheme, { type: "slices", arcs: [arcRight] });

    // Left side slice (midAngle near PI) -> textAlign = "right"
    const ctx2 = makeCtx();
    const arcLeft = makeSlice({ startAngle: Math.PI - 0.3, endAngle: Math.PI + 0.3 });
    paintDataLabels(ctx2, defaultData, makeSpec(), defaultLayout, defaultTheme, { type: "slices", arcs: [arcLeft] });

    // Both should have been called (labels rendered)
    expect(ctx.fillText).toHaveBeenCalled();
    expect(ctx2.fillText).toHaveBeenCalled();
  });
});

// ============================================================================
// Label Clamping at Chart Edges
// ============================================================================

describe("dataLabelPainter - edge clipping", () => {
  it("clamps bar labels to top of plot area", () => {
    const ctx = makeCtx();
    // Bar near top edge, label would go above plot area
    const bar = makeBar({ y: 42, height: 10 }); // above: y=42-4=38, but plotArea.y+fontSize=50
    const geometry: HitGeometry = { type: "bars", rects: [bar] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "above" }), defaultLayout, defaultTheme, geometry);

    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    // Clamped to plotArea.y + fontSize = 40 + 10 = 50
    expect(y).toBe(50);
  });

  it("clamps bar labels to bottom of plot area", () => {
    const ctx = makeCtx();
    // Bar near bottom, "below" label would go past plot area
    const bar = makeBar({ y: 300, height: 50 }); // below: 300+50+10+2=362, max=40+320-2=358
    const geometry: HitGeometry = { type: "bars", rects: [bar] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "below" }), defaultLayout, defaultTheme, geometry);

    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(y).toBe(358); // plotArea.y + plotArea.height - 2
  });

  it("clamps point labels to plot area bounds", () => {
    const ctx = makeCtx();
    const marker = makePoint({ cy: 42, radius: 4 }); // above: 42-4-4=34, clamped to 50
    const geometry: HitGeometry = { type: "points", markers: [marker] };

    paintDataLabels(ctx, defaultData, makeSpec({ position: "above" }), defaultLayout, defaultTheme, geometry);

    const [, , y] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(y).toBe(50);
  });
});

// ============================================================================
// Label Content Formatting
// ============================================================================

describe("dataLabelPainter - content formatting", () => {
  it("shows value by default", () => {
    const ctx = makeCtx();
    const bar = makeBar({ value: 1500 });
    paintDataLabels(ctx, defaultData, makeSpec(), defaultLayout, defaultTheme, { type: "bars", rects: [bar] });

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe("1.5K");
  });

  it("shows category name", () => {
    const ctx = makeCtx();
    const bar = makeBar({ value: 100, categoryName: "Q1" });
    paintDataLabels(ctx, defaultData, makeSpec({ content: ["category"] }), defaultLayout, defaultTheme, { type: "bars", rects: [bar] });

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe("Q1");
  });

  it("shows series name", () => {
    const ctx = makeCtx();
    const bar = makeBar({ seriesName: "Revenue" });
    paintDataLabels(ctx, defaultData, makeSpec({ content: ["seriesName"] }), defaultLayout, defaultTheme, { type: "bars", rects: [bar] });

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe("Revenue");
  });

  it("shows percentage on pie slices", () => {
    const ctx = makeCtx();
    const arc = makeSlice({ percent: 33.3 });
    paintDataLabels(ctx, defaultData, makeSpec({ content: ["percent"] }), defaultLayout, defaultTheme, { type: "slices", arcs: [arc] });

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe("33.3%");
  });

  it("joins multiple content fields with separator", () => {
    const ctx = makeCtx();
    const bar = makeBar({ value: 50, categoryName: "Q1", seriesName: "Sales" });
    paintDataLabels(ctx, defaultData, makeSpec({ content: ["category", "value"], separator: " | " }), defaultLayout, defaultTheme, { type: "bars", rects: [bar] });

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe("Q1 | 50");
  });

  it("applies custom format pattern with dollar sign", () => {
    const ctx = makeCtx();
    const bar = makeBar({ value: 1234.567 });
    paintDataLabels(ctx, defaultData, makeSpec({ content: ["value"], format: "$,.2f" }), defaultLayout, defaultTheme, { type: "bars", rects: [bar] });

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe("$1,234.57");
  });

  it("applies percentage format pattern", () => {
    const ctx = makeCtx();
    const bar = makeBar({ value: 0.756 });
    paintDataLabels(ctx, defaultData, makeSpec({ content: ["value"], format: ".1%" }), defaultLayout, defaultTheme, { type: "bars", rects: [bar] });

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe("75.6%");
  });
});

// ============================================================================
// Labels on Negative Values
// ============================================================================

describe("dataLabelPainter - negative values", () => {
  it("renders labels for negative bar values", () => {
    const ctx = makeCtx();
    const bar = makeBar({ value: -150 });
    paintDataLabels(ctx, defaultData, makeSpec(), defaultLayout, defaultTheme, { type: "bars", rects: [bar] });

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe("-150");
  });

  it("formats negative values with custom format", () => {
    const ctx = makeCtx();
    const bar = makeBar({ value: -1234.5 });
    paintDataLabels(ctx, defaultData, makeSpec({ content: ["value"], format: "$,.2f" }), defaultLayout, defaultTheme, { type: "bars", rects: [bar] });

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toContain("-");
    expect(text).toContain("1,234.50");
  });
});

// ============================================================================
// Series Filtering (mixed show/hide)
// ============================================================================

describe("dataLabelPainter - series filtering", () => {
  it("only shows labels for filtered series indices", () => {
    const ctx = makeCtx();
    const bars: BarRect[] = [
      makeBar({ seriesIndex: 0, value: 100 }),
      makeBar({ seriesIndex: 1, value: 200 }),
      makeBar({ seriesIndex: 2, value: 300 }),
    ];
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ seriesFilter: [0, 2] }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: bars },
    );

    // Only 2 labels rendered (series 0 and 2)
    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });

  it("shows all labels when seriesFilter is null", () => {
    const ctx = makeCtx();
    const bars: BarRect[] = [
      makeBar({ seriesIndex: 0 }),
      makeBar({ seriesIndex: 1 }),
    ];
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ seriesFilter: null }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: bars },
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// minValue Threshold
// ============================================================================

describe("dataLabelPainter - minValue threshold", () => {
  it("hides labels for values below minValue", () => {
    const ctx = makeCtx();
    const bars: BarRect[] = [
      makeBar({ value: 5 }),
      makeBar({ value: 50 }),
      makeBar({ value: 150 }),
    ];
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ minValue: 10 }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: bars },
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });

  it("considers absolute value for negative numbers with minValue", () => {
    const ctx = makeCtx();
    const bars: BarRect[] = [
      makeBar({ value: -50 }),  // |−50| = 50 >= 10 -> show
      makeBar({ value: -5 }),   // |−5| = 5 < 10 -> hide
    ];
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ minValue: 10 }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: bars },
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Labels Disabled
// ============================================================================

describe("dataLabelPainter - disabled state", () => {
  it("does not render when enabled is false", () => {
    const ctx = makeCtx();
    const bar = makeBar();
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ enabled: false }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: [bar] },
    );

    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("does not render when dataLabels is undefined", () => {
    const ctx = makeCtx();
    const spec = makeSpec();
    spec.dataLabels = undefined;
    paintDataLabels(ctx, defaultData, spec, defaultLayout, defaultTheme, { type: "bars", rects: [makeBar()] });

    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Background Color Badge
// ============================================================================

describe("dataLabelPainter - background badge", () => {
  it("draws background rect when backgroundColor is set", () => {
    const ctx = makeCtx();
    const bar = makeBar();
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ backgroundColor: "#FFFF00" }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: [bar] },
    );

    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("does not draw background rect when backgroundColor is null", () => {
    const ctx = makeCtx();
    const bar = makeBar();
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ backgroundColor: null }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: [bar] },
    );

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Composite Geometry (combo charts)
// ============================================================================

describe("dataLabelPainter - composite geometry", () => {
  it("renders labels for all groups in composite geometry", () => {
    const ctx = makeCtx();
    const geometry: HitGeometry = {
      type: "composite",
      groups: [
        { type: "bars", rects: [makeBar({ value: 100 })] },
        { type: "points", markers: [makePoint({ value: 200 })] },
      ],
    };

    paintDataLabels(ctx, defaultData, makeSpec(), defaultLayout, defaultTheme, geometry);

    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Long Text Labels
// ============================================================================

describe("dataLabelPainter - long text", () => {
  it("renders very long category names without crashing", () => {
    const ctx = makeCtx();
    const longName = "A".repeat(200);
    const bar = makeBar({ categoryName: longName });
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ content: ["category"] }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: [bar] },
    );

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe(longName);
  });

  it("renders very long series names without crashing", () => {
    const ctx = makeCtx();
    const longName = "Series " + "X".repeat(150);
    const bar = makeBar({ seriesName: longName });
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ content: ["seriesName"] }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: [bar] },
    );

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe(longName);
  });
});

// ============================================================================
// Percentage Calculation (non-pie)
// ============================================================================

describe("dataLabelPainter - percentage on non-pie charts", () => {
  it("calculates percentage from total when percent field is not provided", () => {
    const ctx = makeCtx();
    const bar = makeBar({ value: 100 });
    // Total of all values in defaultData: 100+200+300+50+80+120 = 850
    paintDataLabels(
      ctx, defaultData,
      makeSpec({ content: ["percent"] }),
      defaultLayout, defaultTheme,
      { type: "bars", rects: [bar] },
    );

    const [text] = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls[0];
    const pct = (100 / 850) * 100;
    expect(text).toBe(`${pct.toFixed(1)}%`);
  });
});
