//! FILENAME: app/extensions/Charts/rendering/__tests__/radial-datumOverrides.test.ts
// PURPOSE: Prove the "radial" painter group (pie/donut, sunburst, treemap,
//          funnel, box plot, stock) honours per-point DataPointOverrides through
//          the ONE shared resolver, and writes true element rects back onto
//          layout.elements as it paints.
// CONTEXT: The user's report was "I cannot select a single data point and change
//          the color of only this bar". These tests are the counter-proof, and
//          they are written so that a painter reverting to a hand-rolled lookup
//          (or to no lookup at all) goes RED: each one paints twice and asserts
//          that the ONLY difference between the two call streams is the one
//          datum that was overridden.

import { describe, it, expect } from "vitest";
import type { ChartSpec, ParsedChartData, ChartLayout, DataPointOverride } from "../../types";
import { DATA_POINT_KEY_SEPARATOR } from "../../types";
import { DEFAULT_CHART_THEME, PALETTES } from "../chartTheme";
import { computePieLayout, paintPieChart } from "../pieChartPainter";
import { computeSunburstLayout, paintSunburstChart } from "../sunburstChartPainter";
import { computeTreemapLayout, paintTreemapChart } from "../treemapChartPainter";
import { computeFunnelLayout, paintFunnelChart } from "../funnelChartPainter";
import { computeBoxPlotLayout, paintBoxPlotChart } from "../boxPlotChartPainter";
import { computeStockLayout, paintStockChart } from "../stockChartPainter";

// ============================================================================
// A recording 2D context
// ============================================================================
//
// The co-located painter tests use vi.fn() mocks with PLAIN properties, so the
// style in force when a fill happened is lost. Per-point formatting is exactly
// that style, so this context snapshots fillStyle/strokeStyle/lineWidth/alpha at
// every drawing call — the call STREAM, not just the call list.

interface RecordedCall {
  op: string;
  args: unknown[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
}

interface CtxState {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
}

const DRAW_OPS = [
  "fillRect", "strokeRect", "fillText", "strokeText", "beginPath", "moveTo",
  "lineTo", "arc", "closePath", "fill", "stroke", "clip", "rect", "roundRect",
  "quadraticCurveTo", "bezierCurveTo", "setLineDash", "translate", "rotate",
  "scale", "clearRect",
];

/** Gradients are objects; name them so a stream diff stays readable. */
function styleToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "isGradient" in (v as object)) return "<gradient>";
  return String(v);
}

function makeRecordingCtx(width = 600, height = 400): {
  ctx: CanvasRenderingContext2D;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const state: CtxState = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
  };
  const stack: CtxState[] = [];

  const push = (op: string, args: unknown[]): void => {
    calls.push({
      op,
      args,
      fillStyle: styleToString(state.fillStyle),
      strokeStyle: styleToString(state.strokeStyle),
      lineWidth: state.lineWidth,
      globalAlpha: state.globalAlpha,
    });
  };

  const ctx: Record<string, unknown> = {
    save: (): void => {
      stack.push({ ...state });
      push("save", []);
    },
    restore: (): void => {
      const prev = stack.pop();
      if (prev) Object.assign(state, prev);
      push("restore", []);
    },
    measureText: (t: string) => ({
      width: String(t).length * 6,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
    createLinearGradient: () => ({ isGradient: true, addColorStop: (): void => {} }),
    createRadialGradient: () => ({ isGradient: true, addColorStop: (): void => {} }),
    createPattern: () => ({ isGradient: true }),
    canvas: { width, height },
  };

  for (const op of DRAW_OPS) {
    ctx[op] = (...args: unknown[]): void => push(op, args);
  }

  for (const key of Object.keys(state) as Array<keyof CtxState>) {
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (v: never) => {
        state[key] = v;
      },
    });
  }

  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

// ============================================================================
// Stream comparison
// ============================================================================

/** The op sequence alone — geometry and styles stripped. */
function ops(calls: RecordedCall[]): string[] {
  return calls.map((c) => c.op);
}

/** How many drawing calls used each fill/stroke colour. */
function colourCounts(calls: RecordedCall[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of calls) {
    if (c.op !== "fill" && c.op !== "fillRect" && c.op !== "stroke" && c.op !== "strokeRect") continue;
    const key = c.op === "fill" || c.op === "fillRect" ? c.fillStyle : c.strokeStyle;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Colours whose usage count changed between two runs, as key -> delta. */
function colourDelta(base: RecordedCall[], over: RecordedCall[]): Map<string, number> {
  const a = colourCounts(base);
  const b = colourCounts(over);
  const delta = new Map<string, number>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const d = (b.get(key) ?? 0) - (a.get(key) ?? 0);
    if (d !== 0) delta.set(key, d);
  }
  return delta;
}

/**
 * The core assertion of this file: painting with a colour override on ONE datum
 * must (a) actually change the stream, (b) move exactly N drawing calls off the
 * datum's base colour and onto the override colour, and (c) leave every other
 * colour in the chart untouched.
 */
function expectOnlyTargetRecoloured(
  base: RecordedCall[],
  over: RecordedCall[],
  baseColour: string,
  overrideColour: string,
): void {
  expect(ops(over)).toEqual(ops(base));
  const delta = colourDelta(base, over);
  const gained = delta.get(overrideColour) ?? 0;
  expect(gained).toBeGreaterThan(0);
  expect(delta.get(baseColour)).toBe(-gained);
  expect([...delta.keys()].sort()).toEqual([baseColour, overrideColour].sort());
}

// ============================================================================
// Fixtures
// ============================================================================

const P = PALETTES.default;
/** Palette slot 1 — the datum every "only this one" test targets. */
const TARGET_COLOUR = P[1];
/**
 * The override colour. Deliberately in the SAME brightness class as
 * TARGET_COLOUR (both above the 150 threshold), so the painters that pick a
 * label colour from the fill keep painting the same label colour and the
 * "nothing else changed" assertion stays honest.
 */
const OVERRIDE_COLOUR = "#FFCC00";

function makeSpec(mark: string, overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { startRow: 0, startCol: 0, endRow: 3, endCol: 1, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Values", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...overrides,
  } as ChartSpec;
}

function makeData(
  categories: string[],
  values: number[],
  extra: Partial<ParsedChartData> = {},
): ParsedChartData {
  return {
    categories,
    series: [{ name: "Values", values, color: null }],
    ...extra,
  };
}

const CATS = ["A", "B", "C", "D"];
const VALS = [40, 30, 20, 10];

function pointOverride(o: Partial<DataPointOverride>): DataPointOverride {
  return { seriesIndex: 0, categoryIndex: 1, ...o };
}

/** Paint one mark twice: without overrides and with them. */
function paintPair(
  paint: (ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec, layout: ChartLayout) => void,
  layoutOf: (spec: ChartSpec, data: ParsedChartData) => ChartLayout,
  spec: ChartSpec,
  data: ParsedChartData,
  overrides: DataPointOverride[],
): { base: RecordedCall[]; over: RecordedCall[] } {
  const a = makeRecordingCtx();
  paint(a.ctx, data, spec, layoutOf(spec, data));

  const withOverrides = { ...spec, dataPointOverrides: overrides };
  const b = makeRecordingCtx();
  paint(b.ctx, data, withOverrides, layoutOf(withOverrides, data));

  return { base: a.calls, over: b.calls };
}

// ============================================================================
// Pie / donut
// ============================================================================

describe("pie: per-point overrides", () => {
  const spec = makeSpec("pie");
  const data = makeData(CATS, VALS);
  const layoutOf = (s: ChartSpec, d: ParsedChartData): ChartLayout =>
    computePieLayout(600, 400, s, d, DEFAULT_CHART_THEME);
  const paint = (ctx: CanvasRenderingContext2D, d: ParsedChartData, s: ChartSpec, l: ChartLayout): void =>
    paintPieChart(ctx, d, s, l, DEFAULT_CHART_THEME);

  it("recolours only the overridden slice", () => {
    const { base, over } = paintPair(paint, layoutOf, spec, data, [
      pointOverride({ color: OVERRIDE_COLOUR }),
    ]);
    expectOnlyTargetRecoloured(base, over, TARGET_COLOUR, OVERRIDE_COLOUR);
  });

  it("explodes only the overridden slice, and its label moves with it", () => {
    const { base, over } = paintPair(paint, layoutOf, spec, data, [
      pointOverride({ exploded: 25 }),
    ]);
    expect(ops(over)).toEqual(ops(base));

    // The arcs of the other slices are untouched; slice 1's centre moved.
    const arcsBase = base.filter((c) => c.op === "arc").map((c) => c.args.slice(0, 2).join(","));
    const arcsOver = over.filter((c) => c.op === "arc").map((c) => c.args.slice(0, 2).join(","));
    const moved = arcsBase.filter((v, i) => v !== arcsOver[i]);
    expect(moved.length).toBe(1); // one arc call per slice for a pie (no inner ring)

    // The label follows: exactly one fillText position changed.
    const textBase = base.filter((c) => c.op === "fillText").map((c) => c.args.join(","));
    const textOver = over.filter((c) => c.op === "fillText").map((c) => c.args.join(","));
    expect(textBase.filter((v, i) => v !== textOver[i]).length).toBe(1);
  });

  it("honours an override matched by its identity KEY after a row insert", () => {
    // Authoring wrote the override for "B" (category index 1). A row is then
    // inserted above it, so "B" is now index 2. The index pair alone would
    // recolour "X"; the key keeps the colour on "B".
    const shifted = makeData(["A", "X", "B", "C"], [40, 5, 30, 20]);
    const key = `Values${DATA_POINT_KEY_SEPARATOR}B`;

    const a = makeRecordingCtx();
    paintPieChart(a.ctx, shifted, spec, layoutOf(spec, shifted), DEFAULT_CHART_THEME);

    const keyed = { ...spec, dataPointOverrides: [pointOverride({ key, color: OVERRIDE_COLOUR })] };
    const b = makeRecordingCtx();
    paintPieChart(b.ctx, shifted, keyed, layoutOf(keyed, shifted), DEFAULT_CHART_THEME);

    // Slice 2 ("B") is palette slot 2 — that is the colour that must change,
    // NOT slot 1 ("X"), which is where the stale index points.
    expectOnlyTargetRecoloured(a.calls, b.calls, P[2], OVERRIDE_COLOUR);
  });

  it("does not alias the override onto a neighbour when a category is filtered out", () => {
    // Category 0 is hidden: painter slice 0 IS authoring category 1. A painter
    // that looked the override up by its own loop counter would paint slice 1.
    const filtered = makeData(["B", "C", "D"], [30, 20, 10], { keptCategoryIndices: [1, 2, 3] });

    const a = makeRecordingCtx();
    paintPieChart(a.ctx, filtered, spec, layoutOf(spec, filtered), DEFAULT_CHART_THEME);

    const keyed = { ...spec, dataPointOverrides: [pointOverride({ color: OVERRIDE_COLOUR })] };
    const b = makeRecordingCtx();
    paintPieChart(b.ctx, filtered, keyed, layoutOf(keyed, filtered), DEFAULT_CHART_THEME);

    // Painter slice 0 is drawn with palette slot 0.
    expectOnlyTargetRecoloured(a.calls, b.calls, P[0], OVERRIDE_COLOUR);
  });

  it("applies per-point opacity, border and gradient", () => {
    const withAll = {
      ...spec,
      dataPointOverrides: [
        pointOverride({
          opacity: 0.25,
          borderColor: "#000000",
          borderWidth: 4,
          gradientFill: {
            type: "linear",
            stops: [
              { offset: 0, color: "#111111" },
              { offset: 1, color: "#222222" },
            ],
          },
        }),
      ],
    } as ChartSpec;
    const { ctx, calls } = makeRecordingCtx();
    paintPieChart(ctx, data, withAll, layoutOf(withAll, data), DEFAULT_CHART_THEME);

    const faded = calls.filter((c) => c.op === "fill" && c.globalAlpha === 0.25);
    expect(faded).toHaveLength(1);
    expect(faded[0].fillStyle).toBe("<gradient>");
    const borders = calls.filter((c) => c.op === "stroke" && c.strokeStyle === "#000000");
    expect(borders).toHaveLength(1);
    expect(borders[0].lineWidth).toBe(4);
  });
});

// ============================================================================
// Sunburst
// ============================================================================

describe("sunburst: per-point overrides", () => {
  const spec = makeSpec("sunburst");
  const data = makeData(CATS, VALS);
  const layoutOf = (s: ChartSpec, d: ParsedChartData): ChartLayout =>
    computeSunburstLayout(600, 400, s, d, DEFAULT_CHART_THEME);
  const paint = (ctx: CanvasRenderingContext2D, d: ParsedChartData, s: ChartSpec, l: ChartLayout): void =>
    paintSunburstChart(ctx, d, s, l, DEFAULT_CHART_THEME);

  it("recolours only the overridden ring segment", () => {
    const { base, over } = paintPair(paint, layoutOf, spec, data, [
      pointOverride({ color: OVERRIDE_COLOUR }),
    ]);
    // Sunburst passes every palette colour through its depth-lightening helper,
    // which re-emits the hex in lower case even at depth 0 (amount 0).
    expectOnlyTargetRecoloured(base, over, TARGET_COLOUR.toLowerCase(), OVERRIDE_COLOUR);
  });

  it("an override on a LEAF leaves the aggregate ring above it alone", () => {
    // "Tech > Phones" and "Tech > Laptops" roll up into one inner "Tech" arc.
    // That arc is nobody's data point, so it must keep the palette colour.
    const hier = makeData(
      ["Tech > Phones", "Tech > Laptops", "Wear > Shoes"],
      [30, 20, 10],
    );
    const a = makeRecordingCtx();
    paintSunburstChart(a.ctx, hier, spec, layoutOf(spec, hier), DEFAULT_CHART_THEME);

    // Category 1 is "Tech > Laptops": a depth-1 leaf, so its base fill is the
    // parent's palette colour lightened by one level.
    const leafSpec = {
      ...spec,
      dataPointOverrides: [pointOverride({ color: OVERRIDE_COLOUR })],
    } as ChartSpec;
    const b = makeRecordingCtx();
    paintSunburstChart(b.ctx, hier, leafSpec, layoutOf(leafSpec, hier), DEFAULT_CHART_THEME);

    const delta = colourDelta(a.calls, b.calls);
    expect(delta.get(OVERRIDE_COLOUR)).toBe(1);
    // Exactly one other colour lost exactly one fill: the leaf's own lightened
    // shade. The inner "Tech" arc is painted in the UNlightened palette colour
    // and its count is unchanged, which is the point of this test.
    expect([...delta.entries()].filter(([, d]) => d < 0)).toHaveLength(1);
    expect(delta.get(P[0])).toBeUndefined();
  });
});

// ============================================================================
// Treemap
// ============================================================================

describe("treemap: per-point overrides", () => {
  const spec = makeSpec("treemap");
  const data = makeData(CATS, VALS);
  const layoutOf = (s: ChartSpec, d: ParsedChartData): ChartLayout =>
    computeTreemapLayout(600, 400, s, d, DEFAULT_CHART_THEME);
  const paint = (ctx: CanvasRenderingContext2D, d: ParsedChartData, s: ChartSpec, l: ChartLayout): void =>
    paintTreemapChart(ctx, d, s, l, DEFAULT_CHART_THEME);

  it("recolours only the overridden tile", () => {
    const { base, over } = paintPair(paint, layoutOf, spec, data, [
      pointOverride({ color: OVERRIDE_COLOUR }),
    ]);
    expectOnlyTargetRecoloured(base, over, TARGET_COLOUR, OVERRIDE_COLOUR);
  });

  it("per-point opacity fades the tile but not its label", () => {
    const faded = {
      ...spec,
      dataPointOverrides: [pointOverride({ opacity: 0.3 })],
    } as ChartSpec;
    const { ctx, calls } = makeRecordingCtx();
    paintTreemapChart(ctx, data, faded, layoutOf(faded, data), DEFAULT_CHART_THEME);

    // Rounded tiles fill a path; square ones use fillRect. Accept either.
    const tileFills = calls.filter(
      (c) => (c.op === "fill" || c.op === "fillRect") && c.globalAlpha === 0.3,
    );
    expect(tileFills.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.op === "fillText" && c.globalAlpha !== 1)).toHaveLength(0);
  });

  it("per-point border colour and width beat the mark options", () => {
    const bordered = {
      ...spec,
      markOptions: { tileBorderColor: "#123456", tileBorderWidth: 2 },
      dataPointOverrides: [pointOverride({ borderColor: "#00FF00", borderWidth: 7 })],
    } as ChartSpec;
    const { ctx, calls } = makeRecordingCtx();
    paintTreemapChart(ctx, data, bordered, layoutOf(bordered, data), DEFAULT_CHART_THEME);

    const mine = calls.filter(
      (c) => (c.op === "stroke" || c.op === "strokeRect") && c.strokeStyle === "#00FF00",
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].lineWidth).toBe(7);
    expect(
      calls.filter((c) => (c.op === "stroke" || c.op === "strokeRect") && c.strokeStyle === "#123456"),
    ).toHaveLength(CATS.length - 1);
  });
});

// ============================================================================
// Funnel
// ============================================================================

describe("funnel: per-point overrides", () => {
  const spec = makeSpec("funnel");
  const data = makeData(CATS, VALS);
  const layoutOf = (s: ChartSpec, d: ParsedChartData): ChartLayout =>
    computeFunnelLayout(600, 400, s, d, DEFAULT_CHART_THEME);
  const paint = (ctx: CanvasRenderingContext2D, d: ParsedChartData, s: ChartSpec, l: ChartLayout): void =>
    paintFunnelChart(ctx, d, s, l, DEFAULT_CHART_THEME);

  it("recolours only the overridden section", () => {
    const { base, over } = paintPair(paint, layoutOf, spec, data, [
      pointOverride({ color: OVERRIDE_COLOUR }),
    ]);
    expectOnlyTargetRecoloured(base, over, TARGET_COLOUR, OVERRIDE_COLOUR);
  });

  it("per-point border replaces the default hairline on that section only", () => {
    const bordered = {
      ...spec,
      dataPointOverrides: [pointOverride({ borderColor: "#00FF00", borderWidth: 3 })],
    } as ChartSpec;
    const { ctx, calls } = makeRecordingCtx();
    paintFunnelChart(ctx, data, bordered, layoutOf(bordered, data), DEFAULT_CHART_THEME);

    const mine = calls.filter((c) => c.op === "stroke" && c.strokeStyle === "#00FF00");
    expect(mine).toHaveLength(1);
    expect(mine[0].lineWidth).toBe(3);
    expect(calls.filter((c) => c.op === "stroke" && c.strokeStyle === "rgba(0,0,0,0.1)")).toHaveLength(
      CATS.length - 1,
    );
  });
});

// ============================================================================
// Box plot
// ============================================================================

describe("box plot: per-point overrides", () => {
  const spec = makeSpec("boxplot");
  const data: ParsedChartData = {
    categories: CATS,
    series: [
      { name: "S1", values: [10, 20, 30, 40], color: null },
      { name: "S2", values: [12, 26, 31, 44], color: null },
      { name: "S3", values: [14, 22, 38, 41], color: null },
    ],
  };
  const layoutOf = (s: ChartSpec, d: ParsedChartData): ChartLayout =>
    computeBoxPlotLayout(600, 400, s, d, DEFAULT_CHART_THEME);
  const paint = (ctx: CanvasRenderingContext2D, d: ParsedChartData, s: ChartSpec, l: ChartLayout): void =>
    paintBoxPlotChart(ctx, d, s, l, DEFAULT_CHART_THEME);

  it("recolours only the overridden box", () => {
    const { base, over } = paintPair(paint, layoutOf, spec, data, [
      pointOverride({ color: OVERRIDE_COLOUR }),
    ]);
    expectOnlyTargetRecoloured(base, over, TARGET_COLOUR, OVERRIDE_COLOUR);
  });

  it("keeps the painter's 0.7 box alpha as the base an override can replace", () => {
    const plain = makeRecordingCtx();
    paintBoxPlotChart(plain.ctx, data, spec, layoutOf(spec, data), DEFAULT_CHART_THEME);
    expect(plain.calls.filter((c) => c.op === "fillRect" && c.globalAlpha === 0.7)).toHaveLength(
      CATS.length,
    );

    const faded = { ...spec, dataPointOverrides: [pointOverride({ opacity: 0.1 })] } as ChartSpec;
    const run = makeRecordingCtx();
    paintBoxPlotChart(run.ctx, data, faded, layoutOf(faded, data), DEFAULT_CHART_THEME);
    expect(run.calls.filter((c) => c.op === "fillRect" && c.globalAlpha === 0.1)).toHaveLength(1);
    expect(run.calls.filter((c) => c.op === "fillRect" && c.globalAlpha === 0.7)).toHaveLength(
      CATS.length - 1,
    );
  });
});

// ============================================================================
// Stock
// ============================================================================

describe("stock: per-point overrides", () => {
  const spec = makeSpec("stock");
  // Four series = OHLC. Every period closes UP, so every candle shares one
  // colour and a single overridden candle is unambiguous in the delta.
  const data: ParsedChartData = {
    categories: ["Mon", "Tue", "Wed", "Thu"],
    series: [
      { name: "Open", values: [10, 12, 14, 16], color: null },
      { name: "High", values: [15, 17, 19, 21], color: null },
      { name: "Low", values: [9, 11, 13, 15], color: null },
      { name: "Close", values: [14, 16, 18, 20], color: null },
    ],
  };
  const layoutOf = (s: ChartSpec, d: ParsedChartData): ChartLayout =>
    computeStockLayout(600, 400, s, d, DEFAULT_CHART_THEME);
  const paint = (ctx: CanvasRenderingContext2D, d: ParsedChartData, s: ChartSpec, l: ChartLayout): void =>
    paintStockChart(ctx, d, s, l, DEFAULT_CHART_THEME);

  it("recolours only the overridden candle", () => {
    const { base, over } = paintPair(paint, layoutOf, spec, data, [
      pointOverride({ color: OVERRIDE_COLOUR }),
    ]);
    expectOnlyTargetRecoloured(base, over, "#4CAF50", OVERRIDE_COLOUR);
  });

  it("overrides the OHLC-bar style too, not just candlesticks", () => {
    const bars = { ...spec, markOptions: { style: "ohlc" } } as ChartSpec;
    const { base, over } = paintPair(paint, layoutOf, bars, data, [
      pointOverride({ color: OVERRIDE_COLOUR }),
    ]);
    expectOnlyTargetRecoloured(base, over, "#4CAF50", OVERRIDE_COLOUR);
  });
});

// ============================================================================
// Element rects (the foundations contract)
// ============================================================================

describe("radial group: element rects written back as painted", () => {
  const titled = makeSpec("pie", {
    title: "Quarterly mix",
    legend: { visible: true, position: "right" },
  });
  const data = makeData(CATS, VALS);

  const radial: Array<[string, (ctx: CanvasRenderingContext2D, l: ChartLayout, s: ChartSpec) => void, (s: ChartSpec) => ChartLayout]> = [
    [
      "pie",
      (ctx, l, s) => paintPieChart(ctx, data, s, l, DEFAULT_CHART_THEME),
      (s) => computePieLayout(600, 400, s, data, DEFAULT_CHART_THEME),
    ],
    [
      "sunburst",
      (ctx, l, s) => paintSunburstChart(ctx, data, s, l, DEFAULT_CHART_THEME),
      (s) => computeSunburstLayout(600, 400, s, data, DEFAULT_CHART_THEME),
    ],
    [
      "treemap",
      (ctx, l, s) => paintTreemapChart(ctx, data, s, l, DEFAULT_CHART_THEME),
      (s) => computeTreemapLayout(600, 400, s, data, DEFAULT_CHART_THEME),
    ],
    [
      "funnel",
      (ctx, l, s) => paintFunnelChart(ctx, data, s, l, DEFAULT_CHART_THEME),
      (s) => computeFunnelLayout(600, 400, s, data, DEFAULT_CHART_THEME),
    ],
  ];

  for (const [name, paint, layoutOf] of radial) {
    it(`${name} measures its title and legend`, () => {
      const spec = { ...titled, mark: name } as ChartSpec;
      const layout = layoutOf(spec);

      // Stage 1: the layout carries ESTIMATES, flagged as unmeasured.
      expect(layout.elements?.family).toBe("radial");
      expect(layout.elements?.measured).toEqual([]);
      const estimatedTitle = layout.elements?.title;
      expect(estimatedTitle).toBeDefined();

      // Stage 2: painting overwrites what it can measure.
      const { ctx } = makeRecordingCtx();
      paint(ctx, layout, spec);

      const els = layout.elements!;
      expect(els.measured).toContain("title");
      expect(els.measured).toContain("legend");
      // measureText here is 6px/char; the estimate is 0.55em of a 14px title.
      expect(els.title!.width).toBe("Quarterly mix".length * 6);
      expect(els.title!.width).not.toBe(estimatedTitle!.width);
      expect(els.legendItems).toHaveLength(CATS.length);
      // A radial mark must not sprout axis bands.
      expect(els.xAxisBand).toBeUndefined();
      expect(els.yAxisBand).toBeUndefined();
    });
  }

  it("box plot and stock measure their axis titles through drawCartesianAxes", () => {
    const axisSpec = makeSpec("boxplot", {
      title: "Spread",
      xAxis: { title: "Region", gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
      yAxis: { title: "Revenue", gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    });
    const boxData: ParsedChartData = {
      categories: CATS,
      series: [
        { name: "S1", values: [10, 20, 30, 40], color: null },
        { name: "S2", values: [12, 26, 31, 44], color: null },
      ],
    };
    const layout = computeBoxPlotLayout(600, 400, axisSpec, boxData, DEFAULT_CHART_THEME);
    expect(layout.elements?.family).toBe("cartesian");
    expect(layout.elements?.measured).toEqual([]);

    const box = makeRecordingCtx();
    paintBoxPlotChart(box.ctx, boxData, axisSpec, layout, DEFAULT_CHART_THEME);
    expect(layout.elements!.measured).toEqual(
      expect.arrayContaining(["yAxisBand", "xAxisTitle", "yAxisTitle", "title"]),
    );
    // The rotated y-axis title is a TALL box one font-size wide.
    expect(layout.elements!.yAxisTitle!.width).toBe(DEFAULT_CHART_THEME.axisTitleFontSize);
    expect(layout.elements!.yAxisTitle!.height).toBe("Revenue".length * 6);

    const stockSpec = { ...axisSpec, mark: "stock" } as ChartSpec;
    const stockData: ParsedChartData = {
      categories: ["Mon", "Tue", "Wed", "Thu"],
      series: [
        { name: "Open", values: [10, 12, 14, 16], color: null },
        { name: "High", values: [15, 17, 19, 21], color: null },
        { name: "Low", values: [9, 11, 13, 15], color: null },
        { name: "Close", values: [14, 16, 18, 20], color: null },
      ],
    };
    const stockLayout = computeStockLayout(600, 400, stockSpec, stockData, DEFAULT_CHART_THEME);
    const stock = makeRecordingCtx();
    paintStockChart(stock.ctx, stockData, stockSpec, stockLayout, DEFAULT_CHART_THEME);
    expect(stockLayout.elements!.measured).toEqual(
      expect.arrayContaining(["yAxisBand", "xAxisTitle", "yAxisTitle", "title"]),
    );
  });
});
