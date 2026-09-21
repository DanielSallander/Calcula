//! FILENAME: app/extensions/Charts/rendering/__tests__/points-perPointOverrides.test.ts
// PURPOSE: The five POINT marks (line, area, scatter, radar, bubble) honour a
//          per-data-point override, and only the targeted point changes.
// CONTEXT: The user's report was "I cannot select a single data point and change
//          the color of only this bar" — for most marks that was simply true:
//          only 4 of 18 registered marks touched lib/dataPointOverrides at all,
//          and the ones that did hand-rolled the authoring/painter index
//          translation. These tests paint the SAME chart twice, once with an
//          override and once without, and diff the canvas call stream:
//            - the targeted datum's paint event MUST change, and
//            - every other paint event MUST be byte-identical.
//          A painter that ignores the override fails the first half; a painter
//          that aliases the override onto the wrong datum (or repaints the whole
//          series) fails the second.

import { describe, it, expect } from "vitest";
import { paintLineChart, computeLineLayout, computeLinePointMarkers } from "../lineChartPainter";
import { paintAreaChart, computeAreaLayout, computeAreaPointMarkers } from "../areaChartPainter";
import { paintScatterChart, computeScatterLayout, computeScatterPointMarkers } from "../scatterChartPainter";
import { paintRadarChart, computeRadarLayout, computeRadarPointMarkers } from "../radarChartPainter";
import { paintBubbleChart, computeBubbleLayout, computeBubblePointMarkers } from "../bubbleChartPainter";
import { paintDatumMarker, traceMarkerPath } from "../markerPainter";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { dataPointKey } from "../../lib/dataPointOverrides";
import type {
  ChartSpec,
  ChartLayout,
  DataPointOverride,
  ParsedChartData,
  PointMarker,
} from "../../types";

// ============================================================================
// A recording 2D context
// ============================================================================

interface Call {
  op: string;
  args: number[] | string[];
}

/** One `fill()` or `stroke()`, with the style state and path that produced it. */
interface PaintEvent {
  kind: "fill" | "stroke";
  fillStyle: string;
  strokeStyle: string;
  globalAlpha: number;
  lineWidth: number;
  path: Call[];
}

const PATH_OPS = new Set([
  "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "ellipse", "bezierCurveTo",
]);

function makeCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const push = (op: string, args: number[] | string[] = []) => { calls.push({ op, args }); };
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, font: "" };
  const ctx = {
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v: string) { state.fillStyle = v; push("fillStyle", [v]); },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v: string) { state.strokeStyle = v; push("strokeStyle", [v]); },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v: number) { state.lineWidth = v; push("lineWidth", [v]); },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v: number) { state.globalAlpha = v; push("globalAlpha", [v]); },
    get font() { return state.font; },
    set font(v: string) { state.font = v; push("font", [v]); },
    textAlign: "left",
    textBaseline: "top",
    beginPath: () => push("beginPath"),
    closePath: () => push("closePath"),
    moveTo: (x: number, y: number) => push("moveTo", [x, y]),
    lineTo: (x: number, y: number) => push("lineTo", [x, y]),
    arc: (x: number, y: number, r: number, a: number, b: number) => push("arc", [x, y, r, a, b]),
    rect: (x: number, y: number, w: number, h: number) => push("rect", [x, y, w, h]),
    ellipse: (x: number, y: number, rx: number, ry: number) => push("ellipse", [x, y, rx, ry]),
    bezierCurveTo: (a: number, b: number, c: number, d: number, e: number, f: number) =>
      push("bezierCurveTo", [a, b, c, d, e, f]),
    fill: () => push("fill"),
    stroke: () => push("stroke"),
    fillRect: (x: number, y: number, w: number, h: number) => push("fillRect", [x, y, w, h]),
    fillText: (t: string, x: number, y: number) => push("fillText", [t, String(x), String(y)]),
    clip: () => push("clip"),
    save: () => push("save"),
    restore: () => push("restore"),
    translate: (x: number, y: number) => push("translate", [x, y]),
    rotate: (a: number) => push("rotate", [a]),
    setLineDash: () => push("setLineDash"),
    measureText: (t: string) => ({ width: t.length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** Reduce a raw call stream to the ordered list of fill/stroke paint events. */
function paintEvents(calls: Call[]): PaintEvent[] {
  const events: PaintEvent[] = [];
  let fillStyle = "";
  let strokeStyle = "";
  let lineWidth = 1;
  let globalAlpha = 1;
  let path: Call[] = [];
  for (const c of calls) {
    if (c.op === "fillStyle") { fillStyle = String(c.args[0]); continue; }
    if (c.op === "strokeStyle") { strokeStyle = String(c.args[0]); continue; }
    if (c.op === "lineWidth") { lineWidth = Number(c.args[0]); continue; }
    if (c.op === "globalAlpha") { globalAlpha = Number(c.args[0]); continue; }
    if (c.op === "beginPath") { path = []; continue; }
    if (PATH_OPS.has(c.op)) { path.push(c); continue; }
    if (c.op === "fill" || c.op === "stroke") {
      events.push({ kind: c.op, fillStyle, strokeStyle, globalAlpha, lineWidth, path: [...path] });
    }
  }
  return events;
}

/** A single-arc path centred on (x, y) — i.e. one round marker. */
function isDiscAt(e: PaintEvent, x: number, y: number): boolean {
  return e.path.length === 1
    && e.path[0].op === "arc"
    && Math.abs(Number(e.path[0].args[0]) - x) < 0.5
    && Math.abs(Number(e.path[0].args[1]) - y) < 0.5;
}

/** Any path whose FIRST vertex is (x, y) — covers square/diamond/triangle too. */
function touchesPoint(e: PaintEvent, x: number, y: number): boolean {
  for (const c of e.path) {
    if (c.op === "arc" || c.op === "moveTo") {
      if (Math.abs(Number(c.args[0]) - x) < 0.5 && Math.abs(Number(c.args[1]) - y) < 0.5) return true;
    }
    if (c.op === "rect") {
      const w = Number(c.args[2]);
      const h = Number(c.args[3]);
      if (Math.abs(Number(c.args[0]) + w / 2 - x) < 0.5 && Math.abs(Number(c.args[1]) + h / 2 - y) < 0.5) {
        return true;
      }
    }
  }
  return false;
}

function serialise(e: PaintEvent): string {
  return JSON.stringify([e.kind, e.fillStyle, e.strokeStyle, e.globalAlpha, e.lineWidth, e.path]);
}

/**
 * The whole point of this suite: painting with the override must change the
 * targeted datum's paint events and NOTHING else.
 *
 * Comparing the two streams index-by-index does NOT work — `markerStyle:
 * "none"` removes events and a border adds one, and every later event then
 * shifts and reads as "changed". So the streams are PARTITIONED on whether an
 * event touches the targeted datum, and the non-target partitions are compared
 * in order. Returns the target partition of the AFTER stream.
 */
function diffOnlyAtTarget(
  before: PaintEvent[],
  after: PaintEvent[],
  target: { x: number; y: number },
): { changed: PaintEvent[] } {
  const untouched = (evts: PaintEvent[]) =>
    evts.filter((e) => !touchesPoint(e, target.x, target.y)).map(serialise);
  expect(untouched(after), "a paint event away from the targeted datum changed").toEqual(untouched(before));

  const atTargetBefore = before.filter((e) => touchesPoint(e, target.x, target.y)).map(serialise);
  const changed = after.filter((e) => touchesPoint(e, target.x, target.y));
  expect(changed.map(serialise), "the targeted datum painted identically — the override did nothing")
    .not.toEqual(atTargetBefore);
  return { changed };
}

/**
 * Every OTHER painted datum keeps the exact fill it had. The partition above
 * cannot see this on a line or radar chart, where the series polyline passes
 * through the targeted point and is therefore excluded from the comparison.
 */
function assertOtherDatumsUnchanged(
  before: PaintEvent[],
  after: PaintEvent[],
  markers: PointMarker[],
  target: { x: number; y: number },
): void {
  for (const m of markers) {
    if (Math.abs(m.cx - target.x) < 0.5 && Math.abs(m.cy - target.y) < 0.5) continue;
    const discs = (evts: PaintEvent[]) => evts.filter((e) => isDiscAt(e, m.cx, m.cy)).map(serialise);
    expect(discs(after), `the datum at (${m.cx}, ${m.cy}) changed`).toEqual(discs(before));
  }
}

// ============================================================================
// Fixtures
// ============================================================================

const AXIS = { gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null } as const;

function makeSpec(mark: string, overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 3, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: "Revenue by quarter",
    xAxis: { ...AXIS, title: "Quarter" },
    yAxis: { ...AXIS, gridLines: true, title: "USD" },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...overrides,
  } as unknown as ChartSpec;
}

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["Q1", "Q2", "Q3", "Q4"],
    series: [
      { name: "North", values: [120, 260, 300, 210], color: null },
      { name: "South", values: [90, 140, 180, 160], color: null },
    ],
    ...overrides,
  } as ParsedChartData;
}

const W = 640;
const H = 420;

type Painter = (
  ctx: CanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: typeof DEFAULT_CHART_THEME,
) => void;

type LayoutFn = (
  w: number, h: number, spec: ChartSpec, data: ParsedChartData, theme: typeof DEFAULT_CHART_THEME,
) => ChartLayout;

type MarkerFn = (
  data: ParsedChartData, spec: ChartSpec, layout: ChartLayout, theme: typeof DEFAULT_CHART_THEME,
) => PointMarker[];

interface MarkCase {
  name: string;
  paint: Painter;
  layoutOf: LayoutFn;
  markersOf: MarkerFn;
  spec: (overrides?: Partial<ChartSpec>) => ChartSpec;
  data: ParsedChartData;
  /** Painter-space datum the overrides in these tests target. */
  target: { seriesIndex: number; categoryIndex: number };
  /** Authoring indices to write into the override (identity here). */
  authoring: { seriesIndex: number; categoryIndex: number };
  /** Default marker radius the painter uses with no override. */
  radius: number;
}

const lineSpec = (o: Partial<ChartSpec> = {}) =>
  makeSpec("line", { markOptions: { showMarkers: true, markerRadius: 4 }, ...o } as Partial<ChartSpec>);
const areaSpec = (o: Partial<ChartSpec> = {}) =>
  makeSpec("area", { markOptions: { showMarkers: true, markerRadius: 4 }, ...o } as Partial<ChartSpec>);
const scatterSpec = (o: Partial<ChartSpec> = {}) =>
  makeSpec("scatter", { markOptions: { pointSize: 5, pointShape: "circle" }, ...o } as Partial<ChartSpec>);
const radarSpec = (o: Partial<ChartSpec> = {}) =>
  makeSpec("radar", { markOptions: { showMarkers: true, markerRadius: 4 }, ...o } as Partial<ChartSpec>);

/** Bubble consumes the LAST series as the size channel, so it needs three. */
const bubbleData: ParsedChartData = {
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { name: "North", values: [120, 260, 300, 210], color: null },
    { name: "South", values: [90, 140, 180, 160], color: null },
    { name: "Weight", values: [10, 40, 25, 60], color: null },
  ],
} as ParsedChartData;
const bubbleSpec = (o: Partial<ChartSpec> = {}) =>
  makeSpec("bubble", { markOptions: { sizeSeriesIndex: 2 }, ...o } as Partial<ChartSpec>);

const CASES: MarkCase[] = [
  {
    name: "line",
    paint: paintLineChart as unknown as Painter,
    layoutOf: computeLineLayout as unknown as LayoutFn,
    markersOf: computeLinePointMarkers as unknown as MarkerFn,
    spec: lineSpec,
    data: makeData(),
    target: { seriesIndex: 0, categoryIndex: 1 },
    authoring: { seriesIndex: 0, categoryIndex: 1 },
    radius: 4,
  },
  {
    name: "area",
    paint: paintAreaChart as unknown as Painter,
    layoutOf: computeAreaLayout as unknown as LayoutFn,
    markersOf: computeAreaPointMarkers as unknown as MarkerFn,
    spec: areaSpec,
    data: makeData(),
    target: { seriesIndex: 0, categoryIndex: 1 },
    authoring: { seriesIndex: 0, categoryIndex: 1 },
    radius: 4,
  },
  {
    name: "scatter",
    paint: paintScatterChart as unknown as Painter,
    layoutOf: computeScatterLayout as unknown as LayoutFn,
    markersOf: computeScatterPointMarkers as unknown as MarkerFn,
    spec: scatterSpec,
    data: makeData(),
    target: { seriesIndex: 0, categoryIndex: 1 },
    authoring: { seriesIndex: 0, categoryIndex: 1 },
    radius: 5,
  },
  {
    name: "radar",
    paint: paintRadarChart as unknown as Painter,
    layoutOf: computeRadarLayout as unknown as LayoutFn,
    markersOf: computeRadarPointMarkers as unknown as MarkerFn,
    spec: radarSpec,
    data: makeData(),
    target: { seriesIndex: 0, categoryIndex: 1 },
    authoring: { seriesIndex: 0, categoryIndex: 1 },
    radius: 4,
  },
  {
    name: "bubble",
    paint: paintBubbleChart as unknown as Painter,
    layoutOf: computeBubbleLayout as unknown as LayoutFn,
    markersOf: computeBubblePointMarkers as unknown as MarkerFn,
    spec: bubbleSpec,
    data: bubbleData,
    // Painter space for bubble is the VALUE series list; "South" is value
    // series 1 but data.series index 1 as well, so the override authored at
    // series 1 must land on it.
    target: { seriesIndex: 1, categoryIndex: 2 },
    authoring: { seriesIndex: 1, categoryIndex: 2 },
    radius: 0, // data-driven; unused for bubble
  },
];

function run(c: MarkCase, overrides: DataPointOverride[] | undefined): PaintEvent[] {
  const spec = c.spec(overrides ? ({ dataPointOverrides: overrides } as Partial<ChartSpec>) : {});
  const layout = c.layoutOf(W, H, spec, c.data, DEFAULT_CHART_THEME);
  const { ctx, calls } = makeCtx();
  c.paint(ctx, c.data, spec, layout, DEFAULT_CHART_THEME);
  return paintEvents(calls);
}

function allMarkers(c: MarkCase): PointMarker[] {
  const spec = c.spec();
  const layout = c.layoutOf(W, H, spec, c.data, DEFAULT_CHART_THEME);
  return c.markersOf(c.data, spec, layout, DEFAULT_CHART_THEME);
}

function targetPoint(c: MarkCase): { x: number; y: number } {
  const markers = allMarkers(c);
  const m = markers.find(
    (mk) => mk.seriesIndex === c.target.seriesIndex && mk.categoryIndex === c.target.categoryIndex,
  );
  expect(m, `no hit-geometry marker for ${c.name} ${JSON.stringify(c.target)}`).toBeDefined();
  return { x: m!.cx, y: m!.cy };
}

// ============================================================================
// (1) Every point mark honours a per-point colour, and ONLY that point changes
// ============================================================================

describe("per-point colour override", () => {
  for (const c of CASES) {
    it(`${c.name}: recolours exactly the targeted datum`, () => {
      const pt = targetPoint(c);
      const before = run(c, undefined);
      const after = run(c, [{ ...c.authoring, color: "#FF00FF" }]);

      const { changed } = diffOnlyAtTarget(before, after, pt);
      assertOtherDatumsUnchanged(before, after, allMarkers(c), pt);
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.some((e) => e.fillStyle.toUpperCase() === "#FF00FF")).toBe(true);

      // and nothing anywhere else in the chart picked up the colour
      const strayBefore = before.filter((e) => e.fillStyle.toUpperCase() === "#FF00FF");
      expect(strayBefore).toHaveLength(0);
      const stray = after.filter(
        (e) => e.fillStyle.toUpperCase() === "#FF00FF" && !touchesPoint(e, pt.x, pt.y),
      );
      expect(stray).toHaveLength(0);
    });
  }
});

// ============================================================================
// (2) An override that names NO datum changes nothing
// ============================================================================

describe("an override on a datum that is not painted", () => {
  for (const c of CASES) {
    it(`${c.name}: leaves the whole call stream untouched`, () => {
      const before = run(c, undefined);
      const after = run(c, [{ seriesIndex: 99, categoryIndex: 99, color: "#FF00FF" }]);
      expect(after.map(serialise)).toEqual(before.map(serialise));
    });
  }
});

// ============================================================================
// (3) The marker fields — shape, size, fill, border
// ============================================================================

describe("per-point marker fields", () => {
  const markerCases = CASES.filter((c) => c.name !== "bubble");

  for (const c of markerCases) {
    it(`${c.name}: markerStyle "none" hides that one marker and no other`, () => {
      const pt = targetPoint(c);
      const before = run(c, undefined);
      const after = run(c, [{ ...c.authoring, markerStyle: "none" }]);

      const discsBefore = before.filter((e) => isDiscAt(e, pt.x, pt.y));
      const discsAfter = after.filter((e) => isDiscAt(e, pt.x, pt.y));
      expect(discsBefore.length).toBeGreaterThan(0);
      expect(discsAfter).toHaveLength(0);
      expect(after.length).toBeLessThan(before.length);
      diffOnlyAtTarget(before, after, pt);
    });

    it(`${c.name}: markerSize resizes only that marker`, () => {
      const pt = targetPoint(c);
      const before = run(c, undefined);
      const after = run(c, [{ ...c.authoring, markerSize: 13 }]);

      const radii = after
        .filter((e) => isDiscAt(e, pt.x, pt.y))
        .map((e) => Number(e.path[0].args[2]));
      expect(radii).toContain(13);
      diffOnlyAtTarget(before, after, pt);
    });

    it(`${c.name}: markerFill wins over color for the marker`, () => {
      const pt = targetPoint(c);
      const after = run(c, [{ ...c.authoring, color: "#112233", markerFill: "#00CC66" }]);
      const disc = after.find((e) => isDiscAt(e, pt.x, pt.y) && e.kind === "fill");
      expect(disc?.fillStyle.toUpperCase()).toBe("#00CC66");
    });

    it(`${c.name}: markerBorderColor/Width strokes only that marker`, () => {
      const pt = targetPoint(c);
      const before = run(c, undefined);
      const after = run(c, [{ ...c.authoring, markerBorderColor: "#001122", markerBorderWidth: 3 }]);

      const strokes = after.filter(
        (e) => e.kind === "stroke" && isDiscAt(e, pt.x, pt.y) && e.strokeStyle.toUpperCase() === "#001122",
      );
      expect(strokes).toHaveLength(1);
      expect(strokes[0].lineWidth).toBe(3);
      expect(before.some((e) => e.strokeStyle.toUpperCase() === "#001122")).toBe(false);
      diffOnlyAtTarget(before, after, pt);
    });

    it(`${c.name}: markerStyle "square" replaces the disc with a rect at the same centre`, () => {
      const pt = targetPoint(c);
      const after = run(c, [{ ...c.authoring, markerStyle: "square", markerSize: 6 }]);
      const rects = after.filter(
        (e) => e.path.length === 1 && e.path[0].op === "rect" && touchesPoint(e, pt.x, pt.y),
      );
      expect(rects.length).toBeGreaterThan(0);
      expect(Number(rects[0].path[0].args[2])).toBe(12);
    });
  }

  it("bubble: markerStyle \"none\" hides that one bubble", () => {
    const c = CASES.find((x) => x.name === "bubble")!;
    const pt = targetPoint(c);
    const before = run(c, undefined);
    const after = run(c, [{ ...c.authoring, markerStyle: "none" }]);
    expect(before.filter((e) => isDiscAt(e, pt.x, pt.y)).length).toBeGreaterThan(0);
    expect(after.filter((e) => isDiscAt(e, pt.x, pt.y))).toHaveLength(0);
  });

  it("bubble: markerSize is IGNORED, because the radius encodes the size series", () => {
    const c = CASES.find((x) => x.name === "bubble")!;
    const pt = targetPoint(c);
    const before = run(c, undefined);
    const after = run(c, [{ ...c.authoring, markerSize: 99 }]);
    const radiusOf = (evts: PaintEvent[]) =>
      evts.filter((e) => isDiscAt(e, pt.x, pt.y)).map((e) => Number(e.path[0].args[2]));
    expect(radiusOf(after)).toEqual(radiusOf(before));
    expect(radiusOf(after)).not.toContain(99);
  });
});

// ============================================================================
// (4) Painter -> authoring index translation (the aliasing defect)
// ============================================================================

describe("index translation", () => {
  it("line: an override authored at series 1 lands on the painted series when series 0 is filtered out", () => {
    const spec = lineSpec();
    const filtered = {
      categories: ["Q1", "Q2", "Q3", "Q4"],
      series: [{ name: "South", values: [90, 140, 180, 160], color: null }],
      keptSeriesIndices: [1],
    } as unknown as ParsedChartData;

    const layout = computeLineLayout(W, H, spec, filtered, DEFAULT_CHART_THEME);
    const marker = computeLinePointMarkers(filtered, spec, layout, DEFAULT_CHART_THEME)
      .find((m) => m.seriesIndex === 0 && m.categoryIndex === 2)!;

    const withAuthoring = (() => {
      const s = lineSpec({ dataPointOverrides: [{ seriesIndex: 1, categoryIndex: 2, color: "#FF00FF" }] } as Partial<ChartSpec>);
      const { ctx, calls } = makeCtx();
      paintLineChart(ctx, filtered, s, computeLineLayout(W, H, s, filtered, DEFAULT_CHART_THEME), DEFAULT_CHART_THEME);
      return paintEvents(calls);
    })();

    const hit = withAuthoring.find(
      (e) => isDiscAt(e, marker.cx, marker.cy) && e.fillStyle.toUpperCase() === "#FF00FF",
    );
    expect(hit, "the override authored at series 1 did not reach the only painted series").toBeDefined();
  });

  it("line: a PAINTER-space index 0 override does NOT bleed onto the filtered series", () => {
    const spec = lineSpec({ dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 2, color: "#FF00FF" }] } as Partial<ChartSpec>);
    const filtered = {
      categories: ["Q1", "Q2", "Q3", "Q4"],
      series: [{ name: "South", values: [90, 140, 180, 160], color: null }],
      keptSeriesIndices: [1],
    } as unknown as ParsedChartData;
    const layout = computeLineLayout(W, H, spec, filtered, DEFAULT_CHART_THEME);
    const { ctx, calls } = makeCtx();
    paintLineChart(ctx, filtered, spec, layout, DEFAULT_CHART_THEME);
    expect(paintEvents(calls).some((e) => e.fillStyle.toUpperCase() === "#FF00FF")).toBe(false);
  });

  it("bubble: the override uses the DATA series index, not the value-series loop counter", () => {
    // Size channel is series 0, so valueSeries = [South, Weight] and the loop
    // counter for "South" is 0 while its data index is 1. A painter that
    // resolved on the loop counter would colour the wrong bubble.
    const data: ParsedChartData = {
      categories: ["Q1", "Q2", "Q3", "Q4"],
      series: [
        { name: "Weight", values: [10, 40, 25, 60], color: null },
        { name: "South", values: [90, 140, 180, 160], color: null },
        { name: "North", values: [120, 260, 300, 210], color: null },
      ],
    } as ParsedChartData;
    const spec = makeSpec("bubble", {
      markOptions: { sizeSeriesIndex: 0 },
      dataPointOverrides: [{ seriesIndex: 1, categoryIndex: 2, color: "#FF00FF" }],
    } as Partial<ChartSpec>);
    const layout = computeBubbleLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const markers = computeBubblePointMarkers(data, spec, layout, DEFAULT_CHART_THEME);
    const south = markers.find((m) => m.seriesName === "South" && m.categoryIndex === 2)!;
    const north = markers.find((m) => m.seriesName === "North" && m.categoryIndex === 2)!;

    const { ctx, calls } = makeCtx();
    paintBubbleChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    const evts = paintEvents(calls);

    expect(evts.some((e) => isDiscAt(e, south.cx, south.cy) && e.fillStyle.toUpperCase() === "#FF00FF")).toBe(true);
    expect(evts.some((e) => isDiscAt(e, north.cx, north.cy) && e.fillStyle.toUpperCase() === "#FF00FF")).toBe(false);
  });
});

// ============================================================================
// (5) The identity key beats a stale index
// ============================================================================

describe("identity key", () => {
  it("line: a key-matched override follows the datum when the index has shifted", () => {
    const data = makeData();
    const spec = lineSpec({
      dataPointOverrides: [{
        // stale index — points at Q1, key names Q3
        seriesIndex: 0,
        categoryIndex: 0,
        key: dataPointKey("North", "Q3"),
        color: "#FF00FF",
      }],
    } as Partial<ChartSpec>);
    const layout = computeLineLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const markers = computeLinePointMarkers(data, spec, layout, DEFAULT_CHART_THEME);
    const q3 = markers.find((m) => m.seriesIndex === 0 && m.categoryIndex === 2)!;
    const q1 = markers.find((m) => m.seriesIndex === 0 && m.categoryIndex === 0)!;

    const { ctx, calls } = makeCtx();
    paintLineChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    const evts = paintEvents(calls);

    expect(evts.some((e) => isDiscAt(e, q3.cx, q3.cy) && e.fillStyle.toUpperCase() === "#FF00FF")).toBe(true);
    expect(evts.some((e) => isDiscAt(e, q1.cx, q1.cy) && e.fillStyle.toUpperCase() === "#FF00FF")).toBe(false);
  });
});

// ============================================================================
// (6) The shared marker primitive itself
// ============================================================================

describe("paintDatumMarker", () => {
  it("with no override emits the hollow-circle stream the painters emitted before", () => {
    const { ctx, calls } = makeCtx();
    paintDatumMarker(ctx, 10, 20, { shape: "circle", size: 4, fill: "#4E79A7", hollow: true });
    expect(calls.map((c) => c.op)).toEqual([
      "fillStyle", "beginPath", "arc", "fill",
      "fillStyle", "beginPath", "arc", "fill",
    ]);
    expect(calls[2].args).toEqual([10, 20, 4, 0, Math.PI * 2]);
    expect(calls[4].args).toEqual(["#ffffff"]);
    expect(calls[6].args).toEqual([10, 20, 2, 0, Math.PI * 2]);
  });

  it("paints nothing for shape \"none\" or a non-positive size", () => {
    const a = makeCtx();
    paintDatumMarker(a.ctx, 10, 20, { shape: "none", size: 4, fill: "#000" });
    expect(a.calls).toHaveLength(0);
    const b = makeCtx();
    paintDatumMarker(b.ctx, 10, 20, { shape: "circle", size: 0, fill: "#000" });
    expect(b.calls).toHaveLength(0);
  });

  it("\"cross\" is stroke-only and takes the fill as its ink when no border colour is given", () => {
    const { ctx, calls } = makeCtx();
    paintDatumMarker(ctx, 10, 20, { shape: "cross", size: 5, fill: "#AA0000" });
    const events = paintEvents(calls);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("stroke");
    expect(events[0].strokeStyle).toBe("#AA0000");
    expect(events[0].lineWidth).toBe(2);
    expect(events[0].path.map((c) => c.op)).toEqual(["moveTo", "lineTo", "moveTo", "lineTo"]);
  });

  it("\"star\" traces ten alternating vertices and closes", () => {
    const { ctx, calls } = makeCtx();
    paintDatumMarker(ctx, 100, 100, { shape: "star", size: 10, fill: "#123456" });
    const events = paintEvents(calls);
    expect(events).toHaveLength(1);
    const ops = events[0].path.map((c) => c.op);
    expect(ops.filter((o) => o === "moveTo" || o === "lineTo")).toHaveLength(10);
    expect(ops[ops.length - 1]).toBe("closePath");
    // first vertex is the top point, at the full radius
    expect(Number(events[0].path[0].args[0])).toBeCloseTo(100, 6);
    expect(Number(events[0].path[0].args[1])).toBeCloseTo(90, 6);
  });

  it("restores globalAlpha after an opaque marker so the next datum is unaffected", () => {
    const { ctx, calls } = makeCtx();
    paintDatumMarker(ctx, 1, 2, { shape: "circle", size: 3, fill: "#000", opacity: 0.25 });
    const alphas = calls.filter((c) => c.op === "globalAlpha").map((c) => Number(c.args[0]));
    expect(alphas).toEqual([0.25, 1]);
  });

  it("leaves globalAlpha alone when no opacity is given", () => {
    const { ctx, calls } = makeCtx();
    paintDatumMarker(ctx, 1, 2, { shape: "circle", size: 3, fill: "#000" });
    expect(calls.some((c) => c.op === "globalAlpha")).toBe(false);
  });

  it("does not put a white core inside a non-circular marker", () => {
    const { ctx, calls } = makeCtx();
    paintDatumMarker(ctx, 1, 2, { shape: "diamond", size: 3, fill: "#000", hollow: true });
    expect(calls.filter((c) => c.op === "fillStyle").map((c) => c.args[0])).toEqual(["#000"]);
  });

  it("traceMarkerPath falls back to a circle for an unrecognised shape", () => {
    const { ctx, calls } = makeCtx();
    traceMarkerPath(ctx, "wobble" as never, 5, 6, 7);
    expect(calls.map((c) => c.op)).toEqual(["arc"]);
    expect(calls[0].args).toEqual([5, 6, 7, 0, Math.PI * 2]);
  });
});
