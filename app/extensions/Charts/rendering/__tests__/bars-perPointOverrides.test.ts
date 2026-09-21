//! FILENAME: app/extensions/Charts/rendering/__tests__/bars-perPointOverrides.test.ts
// PURPOSE: Pin the bars group (bar, horizontal bar, waterfall, histogram,
//          pareto) against the user's actual report -- "I cannot select a single
//          data point, a bar for example, and change the color of only this
//          bar". For every one of these marks that was simply TRUE before this
//          work item: drawStackedBars built no override map at all, the whole
//          horizontal-bar painter never mentioned overrides, and waterfall,
//          histogram and pareto never imported lib/dataPointOverrides.
// CONTEXT: The shape of every test here is the same and it is deliberate: paint
//          the chart twice into a RECORDING context, once clean and once with a
//          per-point override on exactly one datum, and diff the two call
//          streams. That catches both halves of the defect at once -- a painter
//          that ignores the override (streams identical, test red) and a painter
//          that applies it to the wrong datum or to all of them (more than one
//          op differs, test red). A test that only asserted "something changed"
//          would pass on a painter that recoloured every bar.

import { describe, it, expect } from "vitest";
import { paintBarChart, computeLayout } from "../barChartPainter";
import { paintHorizontalBarChart, computeHorizontalBarLayout } from "../horizontalBarChartPainter";
import { paintWaterfallChart, computeWaterfallLayout } from "../waterfallChartPainter";
import { paintHistogramChart, computeHistogramLayout } from "../histogramChartPainter";
import { paintParetoChart, computeParetoLayout } from "../paretoChartPainter";
import { DEFAULT_CHART_THEME, getSeriesColor } from "../chartTheme";
import { dataPointKey } from "../../lib/dataPointOverrides";
import type { ChartSpec, ParsedChartData, DataPointOverride } from "../../types";

// ============================================================================
// Recording canvas
// ============================================================================

interface Op {
  op: string;
  args: number[];
  /** Style state AT THE MOMENT OF THE CALL -- the whole point of the recorder. */
  fill: string;
  stroke: string;
  alpha: number;
  lineWidth: number;
}

interface Recorder {
  ctx: CanvasRenderingContext2D;
  ops: Op[];
}

/** Text is exactly 6px per character here, so the stream is deterministic. */
const MOCK_CHAR_PX = 6;

function makeCtx(): Recorder {
  const ops: Op[] = [];
  const ctx = {
    fillStyle: "" as string | CanvasGradient,
    strokeStyle: "" as string | CanvasGradient,
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "top",
  } as Record<string, unknown>;

  /**
   * A PAINT op carries the style state that produced ink. A GEOMETRY op does
   * not: `applyFillStyle` sets fillStyle before `drawRoundedRect` builds its
   * path, so recording the style on every moveTo/lineTo would smear one changed
   * fill across the eleven path ops that follow it and make "exactly one datum
   * differs" unmeasurable.
   */
  const pushPaint = (op: string, args: number[], kind: "fill" | "stroke") => {
    ops.push({
      op,
      args,
      // Only the style the op actually USES. Recording strokeStyle on a fill (or
      // the reverse) would make every op after a changed bar look different
      // because the last-set style leaks forward -- the diff has to point at the
      // datum that changed, not at everything painted after it.
      // A CanvasGradient double stringifies to a stable marker below.
      fill: kind === "fill" ? String(ctx.fillStyle) : "-",
      stroke: kind === "stroke" ? String(ctx.strokeStyle) : "-",
      alpha: ctx.globalAlpha as number,
      lineWidth: kind === "stroke" ? (ctx.lineWidth as number) : -1,
    });
  };
  const pushGeom = (op: string, args: number[]) => {
    ops.push({ op, args, fill: "-", stroke: "-", alpha: -1, lineWidth: -1 });
  };

  for (const name of ["moveTo", "lineTo", "arc", "rect", "translate", "rotate", "quadraticCurveTo"]) {
    ctx[name] = (...args: number[]) => pushGeom(name, args);
  }
  for (const name of ["beginPath", "closePath", "save", "restore", "clip"]) {
    ctx[name] = () => pushGeom(name, []);
  }
  ctx.fillRect = (...args: number[]) => pushPaint("fillRect", args, "fill");
  ctx.strokeRect = (...args: number[]) => pushPaint("strokeRect", args, "stroke");
  ctx.fill = () => pushPaint("fill", [], "fill");
  ctx.stroke = () => pushPaint("stroke", [], "stroke");
  ctx.fillText = (text: string, x: number, y: number) =>
    pushPaint(`fillText:${text}`, [x, y], "fill");
  ctx.setLineDash = (d: number[]) => pushGeom("setLineDash", d);
  ctx.measureText = (t: string) => ({ width: t.length * MOCK_CHAR_PX });
  ctx.createLinearGradient = () => makeGradientDouble("linear");
  ctx.createRadialGradient = () => makeGradientDouble("radial");

  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

/** A CanvasGradient stand-in whose String() names its stops, so the recorder can see it. */
function makeGradientDouble(kind: string): CanvasGradient {
  const stops: string[] = [];
  return {
    addColorStop: (offset: number, color: string) => { stops.push(`${offset}:${color}`); },
    toString: () => `gradient(${kind}:${stops.join("|")})`,
  } as unknown as CanvasGradient;
}

/** Indices at which two op streams differ. Throws the length mismatch first. */
function diffIndices(a: Op[], b: Op[]): number[] {
  expect(b.length).toBe(a.length);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) out.push(i);
  }
  return out;
}

/** Ops present in `b` but not in `a`, by op name. */
function extraOpNames(a: Op[], b: Op[]): string[] {
  const counts = new Map<string, number>();
  for (const o of a) counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  const out: string[] = [];
  for (const o of b) {
    const left = counts.get(o.op) ?? 0;
    if (left === 0) out.push(o.op);
    else counts.set(o.op, left - 1);
  }
  return out;
}

// ============================================================================
// Fixtures
// ============================================================================

const AXIS = {
  title: null,
  gridLines: false,
  showLabels: true,
  labelAngle: 0,
  min: null,
  max: null,
} as const;

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { startRow: 0, startCol: 0, endRow: 3, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { ...AXIS },
    yAxis: { ...AXIS, gridLines: true },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...overrides,
  };
}

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["Jan", "Feb", "Mar"],
    series: [{ name: "Sales", values: [100, 200, 300], color: null }],
    ...overrides,
  };
}

function makeTwoSeriesData(): ParsedChartData {
  return {
    categories: ["Jan", "Feb", "Mar"],
    series: [
      { name: "Sales", values: [100, 200, 300], color: null },
      { name: "Costs", values: [40, 90, 60], color: null },
    ],
  };
}

const W = 600;
const H = 400;
const THEME = DEFAULT_CHART_THEME;
const HOT = "#FF00FF";

/**
 * Paint the same (spec, data) twice -- once clean, once with `overrides` -- and
 * hand back both op streams. `specOverrides` is applied to BOTH so only the
 * dataPointOverrides array differs.
 */
function paintPair(
  paint: (ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec) => void,
  data: ParsedChartData,
  specOverrides: Partial<ChartSpec>,
  overrides: DataPointOverride[],
): { clean: Op[]; hot: Op[] } {
  const a = makeCtx();
  paint(a.ctx, data, makeSpec(specOverrides));
  const b = makeCtx();
  paint(b.ctx, data, makeSpec({ ...specOverrides, dataPointOverrides: overrides }));
  return { clean: a.ops, hot: b.ops };
}

// ============================================================================
// (1) Bar chart -- grouped
// ============================================================================

describe("bar chart honours a per-point override", () => {
  const paint = (ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec) => {
    paintBarChart(ctx, data, spec, computeLayout(W, H, spec, data, THEME), THEME);
  };

  it("recolours exactly the targeted bar and nothing else", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, {}, [
      { seriesIndex: 0, categoryIndex: 1, color: HOT },
    ]);

    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].op).toBe("fill");
    expect(hot[diff[0]].fill).toBe(HOT);
    expect(clean[diff[0]].fill).toBe(getSeriesColor("default", 0, null));
  });

  it("the targeted bar is the SECOND bar painted, not the first", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, {}, [
      { seriesIndex: 0, categoryIndex: 1, color: HOT },
    ]);
    const fillIdx = clean.map((o, i) => (o.op === "fill" ? i : -1)).filter((i) => i >= 0);
    const diff = diffIndices(clean, hot);
    expect(fillIdx.indexOf(diff[0])).toBe(1);
  });

  it("a per-point opacity changes only that bar's alpha", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, {}, [
      { seriesIndex: 0, categoryIndex: 2, opacity: 0.25 },
    ]);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].alpha).toBe(0.25);
    expect(clean[diff[0]].alpha).toBe(1);
  });

  it("a per-point gradient override replaces the solid fill of one bar", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, {}, [
      {
        seriesIndex: 0,
        categoryIndex: 0,
        gradientFill: {
          type: "linear",
          direction: "topToBottom",
          stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#FFFFFF" }],
        },
      },
    ]);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].fill).toBe("gradient(linear:0:#000000|1:#FFFFFF)");
  });

  it("a per-point border is STROKED -- borderColor/borderWidth used to paint nothing", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, {}, [
      { seriesIndex: 0, categoryIndex: 1, borderColor: "#123456", borderWidth: 3 },
    ]);
    expect(hot.length).toBeGreaterThan(clean.length);
    const strokes = hot.filter((o) => o.op === "stroke" && o.stroke === "#123456");
    expect(strokes).toHaveLength(1);
    expect(strokes[0].lineWidth).toBe(3);
    expect(clean.some((o) => o.stroke === "#123456")).toBe(false);
  });

  it("borderColor alone defaults the width to 1; borderWidth 0 paints no border", () => {
    const data = makeData();
    const only = paintPair(paint, data, {}, [
      { seriesIndex: 0, categoryIndex: 1, borderColor: "#123456" },
    ]);
    expect(only.hot.filter((o) => o.op === "stroke" && o.stroke === "#123456")[0].lineWidth).toBe(1);

    const zero = paintPair(paint, data, {}, [
      { seriesIndex: 0, categoryIndex: 1, borderColor: "#123456", borderWidth: 0 },
    ]);
    expect(diffIndices(zero.clean, zero.hot)).toHaveLength(0);
  });

  it("invertIfNegative repaints a negative datum white and drops its gradient", () => {
    const data = makeData({
      series: [{ name: "Sales", values: [100, -200, 300], color: null }],
    });
    const { clean, hot } = paintPair(paint, data, {}, [
      {
        seriesIndex: 0,
        categoryIndex: 1,
        invertIfNegative: true,
        gradientFill: {
          type: "linear",
          stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#111111" }],
        },
      },
    ]);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].fill).toBe("#FFFFFF");
  });

  it("no override array at all leaves the stream untouched", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, {}, []);
    expect(diffIndices(clean, hot)).toHaveLength(0);
  });
});

// ============================================================================
// (2) Bar chart -- identity and filter translation
// ============================================================================

describe("bar chart override identity", () => {
  const paint = (ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec) => {
    paintBarChart(ctx, data, spec, computeLayout(W, H, spec, data, THEME), THEME);
  };

  it("a key beats a stale index pair -- the row-insert case", () => {
    const data = makeData();
    // The override was written for "Feb" and a row was then inserted above it,
    // so its index pair now names "Jan". The key must win.
    const { clean, hot } = paintPair(paint, data, {}, [
      { seriesIndex: 0, categoryIndex: 0, key: dataPointKey("Sales", "Feb"), color: HOT },
    ]);
    const fillIdx = clean.map((o, i) => (o.op === "fill" ? i : -1)).filter((i) => i >= 0);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(fillIdx.indexOf(diff[0])).toBe(1); // Feb, not Jan
  });

  it("an override is translated to authoring space when a category is hidden", () => {
    // keptCategoryIndices says painter 0 = authoring 1, painter 1 = authoring 2.
    const data = makeData({
      categories: ["Feb", "Mar"],
      series: [{ name: "Sales", values: [200, 300], color: null }],
      keptCategoryIndices: [1, 2],
    });
    const { clean, hot } = paintPair(paint, data, {}, [
      { seriesIndex: 0, categoryIndex: 2, color: HOT },
    ]);
    const fillIdx = clean.map((o, i) => (o.op === "fill" ? i : -1)).filter((i) => i >= 0);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    // Authoring 2 == painter 1. A painter that skipped the translation would
    // have aliased the override onto painter 2, which does not exist here, and
    // the stream would have been identical.
    expect(fillIdx.indexOf(diff[0])).toBe(1);
  });
});

// ============================================================================
// (3) Bar chart -- STACKED (built no override map at all before)
// ============================================================================

describe("stacked bar chart honours a per-point override", () => {
  const paint = (ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec) => {
    paintBarChart(ctx, data, spec, computeLayout(W, H, spec, data, THEME), THEME);
  };
  const STACKED: Partial<ChartSpec> = { markOptions: { stackMode: "stacked" } };

  it("recolours exactly the targeted segment", () => {
    const data = makeTwoSeriesData();
    const { clean, hot } = paintPair(paint, data, STACKED, [
      { seriesIndex: 1, categoryIndex: 2, color: HOT },
    ]);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].fill).toBe(HOT);
    expect(clean[diff[0]].fill).toBe(getSeriesColor("default", 1, null));
  });

  it("percentStacked segments are overridable too", () => {
    const data = makeTwoSeriesData();
    const { clean, hot } = paintPair(
      paint, data, { markOptions: { stackMode: "percentStacked" } },
      [{ seriesIndex: 0, categoryIndex: 0, color: HOT }],
    );
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].fill).toBe(HOT);
  });

  it("a stacked segment's border is stroked", () => {
    const data = makeTwoSeriesData();
    const { clean, hot } = paintPair(paint, data, STACKED, [
      { seriesIndex: 0, categoryIndex: 1, borderColor: "#654321", borderWidth: 2 },
    ]);
    expect(clean.some((o) => o.stroke === "#654321")).toBe(false);
    expect(hot.filter((o) => o.op === "stroke" && o.stroke === "#654321")).toHaveLength(1);
  });
});

// ============================================================================
// (4) Horizontal bar chart (never referenced overrides anywhere)
// ============================================================================

describe("horizontal bar chart honours a per-point override", () => {
  const paint = (ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec) => {
    paintHorizontalBarChart(
      ctx, data, spec, computeHorizontalBarLayout(W, H, spec, data, THEME), THEME,
    );
  };
  const HBAR: Partial<ChartSpec> = { mark: "horizontalBar" };

  it("recolours exactly the targeted bar", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, HBAR, [
      { seriesIndex: 0, categoryIndex: 1, color: HOT },
    ]);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].fill).toBe(HOT);
  });

  it("recolours exactly the targeted STACKED segment", () => {
    const data = makeTwoSeriesData();
    const { clean, hot } = paintPair(
      paint, data, { ...HBAR, markOptions: { stackMode: "stacked" } },
      [{ seriesIndex: 1, categoryIndex: 0, color: HOT }],
    );
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].fill).toBe(HOT);
  });

  it("strokes a per-point border", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, HBAR, [
      { seriesIndex: 0, categoryIndex: 2, borderColor: "#abcdef", borderWidth: 4 },
    ]);
    expect(clean.some((o) => o.stroke === "#abcdef")).toBe(false);
    expect(hot.filter((o) => o.op === "stroke" && o.stroke === "#abcdef")).toHaveLength(1);
  });
});

// ============================================================================
// (5) Waterfall
// ============================================================================

describe("waterfall chart honours a per-point override", () => {
  const waterfallData: ParsedChartData = {
    categories: ["Start", "Q1", "Q2"],
    series: [{ name: "Cash", values: [100, -30, 50], color: null }],
  };
  const paint = (ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec) => {
    paintWaterfallChart(ctx, data, spec, computeWaterfallLayout(W, H, spec, data, THEME), THEME);
  };
  const WF: Partial<ChartSpec> = { mark: "waterfall" };

  it("recolours exactly the targeted bar, leaving the increase/decrease colours alone", () => {
    const { clean, hot } = paintPair(paint, waterfallData, WF, [
      { seriesIndex: 0, categoryIndex: 1, color: HOT },
    ]);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].fill).toBe(HOT);
    expect(clean[diff[0]].fill).toBe("#E53935"); // the decrease default
  });

  it("strokes a per-point border", () => {
    const { clean, hot } = paintPair(paint, waterfallData, WF, [
      { seriesIndex: 0, categoryIndex: 0, borderColor: "#00FF00", borderWidth: 2 },
    ]);
    expect(clean.some((o) => o.stroke === "#00FF00")).toBe(false);
    expect(hot.filter((o) => o.op === "stroke" && o.stroke === "#00FF00")).toHaveLength(1);
  });
});

// ============================================================================
// (6) Histogram
// ============================================================================

describe("histogram honours a per-bin override", () => {
  const histData: ParsedChartData = {
    categories: ["a", "b", "c"],
    series: [{ name: "Values", values: [1, 2, 3], color: null }],
  };
  const paint = (ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec) => {
    paintHistogramChart(ctx, data, spec, computeHistogramLayout(W, H, spec, data, THEME), THEME);
  };
  const HIST: Partial<ChartSpec> = { mark: "histogram", markOptions: { binCount: 3 } };

  it("recolours exactly the targeted bin", () => {
    const { clean, hot } = paintPair(paint, histData, HIST, [
      { seriesIndex: 0, categoryIndex: 1, color: HOT },
    ]);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].fill).toBe(HOT);
  });

  it("an override on a bin index that does not exist changes nothing", () => {
    const { clean, hot } = paintPair(paint, histData, HIST, [
      { seriesIndex: 0, categoryIndex: 9, color: HOT },
    ]);
    expect(diffIndices(clean, hot)).toHaveLength(0);
  });
});

// ============================================================================
// (7) Pareto
// ============================================================================

describe("pareto honours a per-point override in SORTED space", () => {
  const paint = (ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec) => {
    paintParetoChart(ctx, data, spec, computeParetoLayout(W, H, spec, data, THEME), THEME);
  };
  const PARETO: Partial<ChartSpec> = { mark: "pareto" };

  it("recolours exactly the targeted (sorted) bar", () => {
    const data = makeData(); // Jan 100, Feb 200, Mar 300 -> sorted Mar, Feb, Jan
    const { clean, hot } = paintPair(paint, data, PARETO, [
      { seriesIndex: 0, categoryIndex: 1, color: HOT },
    ]);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(hot[diff[0]].fill).toBe(HOT);
    // Sorted position 1 is "Feb", which draws with palette colour 1.
    expect(clean[diff[0]].fill).toBe(getSeriesColor("default", 1, null));
  });

  it("a key names the CATEGORY, so it follows the bar through the sort", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, PARETO, [
      // Index pair names sorted slot 0 ("Mar"); the key names "Jan", which the
      // sort moved to slot 2. The key must win.
      { seriesIndex: 0, categoryIndex: 0, key: dataPointKey("Sales", "Jan"), color: HOT },
    ]);
    const fillIdx = clean.map((o, i) => (o.op === "fill" ? i : -1)).filter((i) => i >= 0);
    const diff = diffIndices(clean, hot);
    expect(diff).toHaveLength(1);
    expect(fillIdx.indexOf(diff[0])).toBe(2);
  });

  it("strokes a per-point border", () => {
    const data = makeData();
    const { clean, hot } = paintPair(paint, data, PARETO, [
      { seriesIndex: 0, categoryIndex: 0, borderColor: "#0000FF", borderWidth: 5 },
    ]);
    expect(clean.some((o) => o.stroke === "#0000FF")).toBe(false);
    expect(hot.filter((o) => o.op === "stroke" && o.stroke === "#0000FF")).toHaveLength(1);
    expect(extraOpNames(clean, hot)).toContain("stroke");
  });
});

// ============================================================================
// (8) Element rects
// ============================================================================

describe("bars-group element rects", () => {
  it("bar chart writes MEASURED axis-title and y-band rects back while painting", () => {
    const spec = makeSpec({
      title: "Revenue",
      xAxis: { ...AXIS, title: "Month" },
      yAxis: { ...AXIS, gridLines: true, title: "USD" },
    });
    const data = makeData();
    const layout = computeLayout(W, H, spec, data, THEME);
    expect(layout.elements?.measured).toEqual([]);

    const { ctx } = makeCtx();
    paintBarChart(ctx, data, spec, layout, THEME);

    const measured = layout.elements?.measured ?? [];
    for (const key of ["xAxisTitle", "yAxisTitle", "yAxisBand", "title", "legend"]) {
      expect(measured).toContain(key);
    }
    // "Month" is 5 chars at 6px in this mock -> 30px, not the 0.55em estimate.
    expect(layout.elements?.xAxisTitle?.width).toBe(30);
  });

  it("the horizontal-bar relayout derives its OWN rects from the NEW left margin", () => {
    const spec = makeSpec({ mark: "horizontalBar" });
    const data = makeData();
    const plain = computeLayout(W, H, spec, data, THEME);
    const layout = computeHorizontalBarLayout(W, H, spec, data, THEME);

    expect(layout.plotArea.x).toBe(plain.plotArea.x + 60);
    const els = layout.elements;
    expect(els).toBeDefined();
    expect(els!.family).toBe("cartesian");
    // Every band is a function of the CURRENT plot area. Inheriting the parent's
    // rects would leave these 60px to the left of where the chart is painted.
    expect(els!.xAxisBand!.x).toBe(layout.plotArea.x);
    expect(els!.yAxisBand!.x + els!.yAxisBand!.width).toBe(layout.plotArea.x);
    expect(els!.chartArea).toEqual({ x: 0, y: 0, width: W, height: H });
  });

  it("horizontal bar measures its axis titles while painting", () => {
    const spec = makeSpec({
      mark: "horizontalBar",
      xAxis: { ...AXIS, title: "Amount" },
      yAxis: { ...AXIS, title: "Month" },
    });
    const data = makeData();
    const layout = computeHorizontalBarLayout(W, H, spec, data, THEME);
    const { ctx } = makeCtx();
    paintHorizontalBarChart(ctx, data, spec, layout, THEME);

    expect(layout.elements?.measured).toContain("xAxisTitle");
    expect(layout.elements?.measured).toContain("yAxisTitle");
    expect(layout.elements?.xAxisTitle?.width).toBe(6 * "Amount".length);
  });

  it("the pareto layout REFLOWS after it widens the right margin", () => {
    const spec = makeSpec({ mark: "pareto", legend: { visible: true, position: "right" } });
    const data = makeData();
    const layout = computeParetoLayout(W, H, spec, data, THEME);

    const els = layout.elements;
    expect(els).toBeDefined();
    // A stale (pre-reflow) legend rect would sit 50px further right, on top of
    // the percentage axis.
    expect(els!.legend!.x).toBe(layout.plotArea.x + layout.plotArea.width + 16);
    expect(els!.xAxisBand!.width).toBe(layout.plotArea.width);
  });

  it("the pareto legend records its own rects -- it is not drawLegendItems'", () => {
    const spec = makeSpec({ mark: "pareto" });
    const data = makeData();
    const layout = computeParetoLayout(W, H, spec, data, THEME);
    const { ctx } = makeCtx();
    paintParetoChart(ctx, data, spec, layout, THEME);

    expect(layout.elements?.measured).toContain("legend");
    const items = layout.elements?.legendItems ?? [];
    expect(items).toHaveLength(2); // the bar series + "Cumulative %"
    expect(items[0].seriesIndex).toBe(0);
    expect(items[1].seriesIndex).toBe(1);
    // The entries tile left-to-right inside the legend box.
    expect(items[0].rect.x).toBe(layout.elements!.legend!.x);
    expect(items[1].rect.x).toBeGreaterThan(items[0].rect.x);
    const box = layout.elements!.legend!;
    expect(items[1].rect.x + items[1].rect.width).toBeLessThanOrEqual(box.x + box.width + 0.001);
  });

  it("the waterfall legend records its own rects", () => {
    const spec = makeSpec({ mark: "waterfall" });
    const data: ParsedChartData = {
      categories: ["Start", "Q1", "Q2"],
      series: [{ name: "Cash", values: [100, -30, 50], color: null }],
    };
    const layout = computeWaterfallLayout(W, H, spec, data, THEME);
    const { ctx } = makeCtx();
    paintWaterfallChart(ctx, data, spec, layout, THEME);

    expect(layout.elements?.measured).toContain("legend");
    const items = layout.elements?.legendItems ?? [];
    expect(items).toHaveLength(2); // Increase + Decrease; no totals in this spec
    expect(items[0].rect.width).toBe(10 + 4 + 6 * "Increase".length);
  });

  it("the histogram measures its y tick-label band", () => {
    const spec = makeSpec({ mark: "histogram", markOptions: { binCount: 3 } });
    const data: ParsedChartData = {
      categories: ["a", "b", "c"],
      series: [{ name: "Values", values: [1, 2, 3], color: null }],
    };
    const layout = computeHistogramLayout(W, H, spec, data, THEME);
    const { ctx } = makeCtx();
    paintHistogramChart(ctx, data, spec, layout, THEME);

    expect(layout.elements?.measured).toContain("yAxisBand");
    const band = layout.elements!.yAxisBand!;
    expect(band.x + band.width).toBe(layout.plotArea.x);
  });
});
