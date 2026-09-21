//! FILENAME: app/extensions/Charts/rendering/__tests__/points-elementRects.test.ts
// PURPOSE: The five point marks write MEASURED element rects back onto
//          layout.elements as they paint, and the rect arithmetic they use
//          agrees exactly with the one drawCartesianAxes uses.
// CONTEXT: line/area/scatter/bubble each draw their own axis titles inline
//          rather than going through drawCartesianAxes, whose equivalent
//          write-back helpers are private. That is two copies of the same
//          geometry, and "three copies had already drifted apart" is a standing
//          hazard in this repo — so the shared helpers live once in
//          markerPainter.ts and THIS test diffs them against drawCartesianAxes's
//          own write-backs for identical inputs. A change to either side that is
//          not mirrored fails here rather than in a hit-test six months later.

import { describe, it, expect } from "vitest";
import { paintLineChart, computeLineLayout } from "../lineChartPainter";
import { paintAreaChart, computeAreaLayout } from "../areaChartPainter";
import { paintScatterChart, computeScatterLayout } from "../scatterChartPainter";
import { paintBubbleChart, computeBubbleLayout } from "../bubbleChartPainter";
import { paintRadarChart, computeRadarLayout } from "../radarChartPainter";
import {
  recordXAxisTitleRect,
  recordYAxisTitleRect,
  recordYLabelBandRect,
  xAxisTitleBaselineY,
  Y_AXIS_TITLE_X,
} from "../markerPainter";
import { drawCartesianAxes, rectContains } from "../chartPainterUtils";
import { createBandScale, createScaleFromSpec } from "../scales";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ChartLayout, ParsedChartData } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

/** Text width in this mock is exactly 6px per character. */
const MOCK_CHAR_PX = 6;

function makeCtx(): CanvasRenderingContext2D {
  const noop = () => undefined;
  return {
    fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, font: "",
    textAlign: "left", textBaseline: "top",
    fillText: noop, fillRect: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, rect: noop, ellipse: noop,
    bezierCurveTo: noop, fill: noop, stroke: noop, clip: noop,
    save: noop, restore: noop, translate: noop, rotate: noop, setLineDash: noop,
    measureText: (t: string) => ({ width: t.length * MOCK_CHAR_PX }),
    createLinearGradient: () => ({ addColorStop: noop }),
  } as unknown as CanvasRenderingContext2D;
}

const AXIS = { gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null } as const;

function makeSpec(mark: string, overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 3, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: "Quarterly revenue",
    xAxis: { ...AXIS, title: "Quarter" },
    yAxis: { ...AXIS, gridLines: true, title: "USD" },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...overrides,
  } as unknown as ChartSpec;
}

const data: ParsedChartData = {
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { name: "North", values: [120, 260, 300, 210], color: null },
    { name: "South", values: [90, 140, 180, 160], color: null },
  ],
} as ParsedChartData;

/** Bubble eats the last series as its size channel. */
const bubbleData: ParsedChartData = {
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { name: "North", values: [120, 260, 300, 210], color: null },
    { name: "South", values: [90, 140, 180, 160], color: null },
    { name: "Weight", values: [10, 40, 25, 60], color: null },
  ],
} as ParsedChartData;

const W = 640;
const H = 420;

interface Case {
  name: string;
  paint: (
    ctx: CanvasRenderingContext2D, d: ParsedChartData, s: ChartSpec, l: ChartLayout,
    t: typeof DEFAULT_CHART_THEME,
  ) => void;
  layoutOf: (
    w: number, h: number, s: ChartSpec, d: ParsedChartData, t: typeof DEFAULT_CHART_THEME,
  ) => ChartLayout;
  spec: ChartSpec;
  data: ParsedChartData;
}

const CARTESIAN: Case[] = [
  {
    name: "line",
    paint: paintLineChart as unknown as Case["paint"],
    layoutOf: computeLineLayout as unknown as Case["layoutOf"],
    spec: makeSpec("line", { markOptions: { showMarkers: true } } as Partial<ChartSpec>),
    data,
  },
  {
    name: "area",
    paint: paintAreaChart as unknown as Case["paint"],
    layoutOf: computeAreaLayout as unknown as Case["layoutOf"],
    spec: makeSpec("area", { markOptions: { showMarkers: true } } as Partial<ChartSpec>),
    data,
  },
  {
    name: "scatter",
    paint: paintScatterChart as unknown as Case["paint"],
    layoutOf: computeScatterLayout as unknown as Case["layoutOf"],
    spec: makeSpec("scatter"),
    data,
  },
  {
    name: "bubble",
    paint: paintBubbleChart as unknown as Case["paint"],
    layoutOf: computeBubbleLayout as unknown as Case["layoutOf"],
    spec: makeSpec("bubble", { markOptions: { sizeSeriesIndex: 2 } } as Partial<ChartSpec>),
    data: bubbleData,
  },
];

function painted(c: Case): ChartLayout {
  const layout = c.layoutOf(W, H, c.spec, c.data, DEFAULT_CHART_THEME);
  c.paint(makeCtx(), c.data, c.spec, layout, DEFAULT_CHART_THEME);
  return layout;
}

// ============================================================================
// (1) The keys each painter promises to measure
// ============================================================================

describe("measured element rects", () => {
  for (const c of CARTESIAN) {
    it(`${c.name}: records title, legend, both axis titles and the y-label band as MEASURED`, () => {
      const layout = painted(c);
      const els = layout.elements!;
      expect(els).toBeDefined();
      for (const key of ["title", "legend", "xAxisTitle", "yAxisTitle", "yAxisBand"] as const) {
        expect(els.measured, `${c.name} did not measure ${key}`).toContain(key);
        expect(els[key], `${c.name} has no ${key} rect`).toBeDefined();
      }
      // xAxisBand is deliberately NEVER measured: the rotated-label geometry is
      // not cheaply measurable, so it stays a layout estimate.
      expect(els.measured).not.toContain("xAxisBand");
      expect(els.xAxisBand).toBeDefined();
    });

    it(`${c.name}: the MEASURED rects actually replace the layout's estimates`, () => {
      const estimate = c.layoutOf(W, H, c.spec, c.data, DEFAULT_CHART_THEME);
      const before = {
        xAxisTitle: { ...estimate.elements!.xAxisTitle! },
        yAxisTitle: { ...estimate.elements!.yAxisTitle! },
        yAxisBand: { ...estimate.elements!.yAxisBand! },
      };
      c.paint(makeCtx(), c.data, c.spec, estimate, DEFAULT_CHART_THEME);
      const after = estimate.elements!;

      // 6px/char measured vs ~0.55em and ~7px/char estimated: all three move.
      expect(after.xAxisTitle).not.toEqual(before.xAxisTitle);
      expect(after.yAxisTitle).not.toEqual(before.yAxisTitle);
      expect(after.yAxisBand).not.toEqual(before.yAxisBand);

      // and the measured x-axis title is exactly 6px/char wide
      expect(after.xAxisTitle!.width).toBe("Quarter".length * MOCK_CHAR_PX);
    });

    it(`${c.name}: the measured x-axis title box ENDS on the baseline it was painted at`, () => {
      const layout = painted(c);
      const baseline = xAxisTitleBaselineY(layout.plotArea, true);
      const r = layout.elements!.xAxisTitle!;
      expect(r.y + r.height).toBe(baseline);
      expect(r.x + r.width / 2).toBeCloseTo(layout.plotArea.x + layout.plotArea.width / 2, 6);
    });

    it(`${c.name}: the measured y-axis title is a TALL box at x=${Y_AXIS_TITLE_X}`, () => {
      const layout = painted(c);
      const r = layout.elements!.yAxisTitle!;
      expect(r.x).toBe(Y_AXIS_TITLE_X);
      expect(r.width).toBe(DEFAULT_CHART_THEME.axisTitleFontSize);
      expect(r.height).toBe("USD".length * MOCK_CHAR_PX);
      expect(r.y + r.height / 2).toBeCloseTo(layout.plotArea.y + layout.plotArea.height / 2, 6);
    });

    it(`${c.name}: the measured y-label band ends at the axis line`, () => {
      const layout = painted(c);
      const r = layout.elements!.yAxisBand!;
      expect(r.x + r.width).toBe(layout.plotArea.x);
      expect(r.y).toBe(layout.plotArea.y);
      expect(r.height).toBe(layout.plotArea.height);
    });

    it(`${c.name}: the measured title rect contains the point the title was drawn at`, () => {
      const layout = painted(c);
      const r = layout.elements!.title!;
      expect(rectContains(r, layout.width / 2, r.y + 1)).toBe(true);
      expect(rectContains(r, r.x - 1, r.y + 1)).toBe(false);
    });

    it(`${c.name}: legendItems has one rect per painted legend entry`, () => {
      const layout = painted(c);
      const items = layout.elements!.legendItems!;
      expect(items.length).toBeGreaterThan(0);
      expect(items.map((i) => i.seriesIndex)).toEqual(items.map((_, i) => i));
    });
  }
});

// ============================================================================
// (2) THE DRIFT GUARD — our rect maths vs drawCartesianAxes's own
// ============================================================================

describe("axis rect arithmetic agrees with drawCartesianAxes", () => {
  /** The scales the line painter builds for this fixture, non-stacked. */
  function scalesFor(layout: ChartLayout) {
    const all = data.series.flatMap((s) => s.values);
    const yScale = createScaleFromSpec(
      undefined,
      [Math.min(...all), Math.max(...all)],
      [layout.plotArea.y + layout.plotArea.height, layout.plotArea.y],
    );
    const xScale = createBandScale(
      data.categories,
      [layout.plotArea.x, layout.plotArea.x + layout.plotArea.width],
      0.3,
    );
    return { xScale, yScale };
  }

  it("produces identical xAxisTitle, yAxisTitle and yAxisBand rects", () => {
    const spec = makeSpec("line", { markOptions: { showMarkers: true } } as Partial<ChartSpec>);

    // Reference: the shared cartesian axis painter writes its own rects back.
    const ref = computeLineLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const { xScale, yScale } = scalesFor(ref);
    drawCartesianAxes(makeCtx(), xScale, yScale, ref.plotArea, spec, DEFAULT_CHART_THEME, ref);

    // Ours: the line painter's inline axes through the shared helpers.
    const mine = computeLineLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    paintLineChart(makeCtx(), data, spec, mine, DEFAULT_CHART_THEME);

    expect(mine.plotArea).toEqual(ref.plotArea);
    expect(mine.elements!.xAxisTitle).toEqual(ref.elements!.xAxisTitle);
    expect(mine.elements!.yAxisTitle).toEqual(ref.elements!.yAxisTitle);
    expect(mine.elements!.yAxisBand).toEqual(ref.elements!.yAxisBand);
  });

  it("the helpers themselves reproduce the reference rects from raw measurements", () => {
    const spec = makeSpec("line");
    const ref = computeLineLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const { xScale, yScale } = scalesFor(ref);
    drawCartesianAxes(makeCtx(), xScale, yScale, ref.plotArea, spec, DEFAULT_CHART_THEME, ref);

    const hand: ChartLayout = {
      width: W, height: H, margin: { ...ref.margin }, plotArea: { ...ref.plotArea },
    };
    const baseline = xAxisTitleBaselineY(ref.plotArea, true);
    recordXAxisTitleRect(
      hand, ref.plotArea, "Quarter".length * MOCK_CHAR_PX, baseline, DEFAULT_CHART_THEME.axisTitleFontSize,
    );
    recordYAxisTitleRect(
      hand, ref.plotArea, "USD".length * MOCK_CHAR_PX, DEFAULT_CHART_THEME.axisTitleFontSize,
    );
    const widestTick = Math.max(
      ...yScale.ticks(5)
        .filter((t) => {
          const y = yScale.scale(t);
          return y >= ref.plotArea.y && y <= ref.plotArea.y + ref.plotArea.height;
        })
        .map((t) => String(t).length * MOCK_CHAR_PX),
    );
    recordYLabelBandRect(hand, ref.plotArea, widestTick);

    expect(hand.elements!.xAxisTitle).toEqual(ref.elements!.xAxisTitle);
    expect(hand.elements!.yAxisTitle).toEqual(ref.elements!.yAxisTitle);
    expect(hand.elements!.yAxisBand).toEqual(ref.elements!.yAxisBand);
    expect(hand.elements!.measured.sort()).toEqual(["xAxisTitle", "yAxisBand", "yAxisTitle"]);
  });
});

// ============================================================================
// (3) A titleless / axis-titleless chart records only what it painted
// ============================================================================

describe("nothing is recorded for an element that was not painted", () => {
  it("line: no title and no axis titles means no measured keys for them", () => {
    const spec = makeSpec("line", {
      title: null,
      xAxis: { ...AXIS, title: null },
      yAxis: { ...AXIS, gridLines: true, title: null },
      markOptions: { showMarkers: true },
    } as Partial<ChartSpec>);
    const layout = computeLineLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    paintLineChart(makeCtx(), data, spec, layout, DEFAULT_CHART_THEME);
    const els = layout.elements!;
    expect(els.measured).not.toContain("title");
    expect(els.measured).not.toContain("xAxisTitle");
    expect(els.measured).not.toContain("yAxisTitle");
    expect(els.title).toBeUndefined();
    expect(els.xAxisTitle).toBeUndefined();
    expect(els.yAxisTitle).toBeUndefined();
    // the y-label band is still painted and still measured
    expect(els.measured).toContain("yAxisBand");
  });

  it("line: hiding the y labels leaves the band unmeasured", () => {
    const spec = makeSpec("line", {
      yAxis: { ...AXIS, gridLines: true, title: "USD", showLabels: false },
      markOptions: { showMarkers: true },
    } as Partial<ChartSpec>);
    const layout = computeLineLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    paintLineChart(makeCtx(), data, spec, layout, DEFAULT_CHART_THEME);
    expect(layout.elements!.measured).not.toContain("yAxisBand");
    expect(layout.elements!.yAxisBand).toBeUndefined();
  });
});

// ============================================================================
// (4) Radar is RADIAL and must not sprout axis bands
// ============================================================================

describe("radar", () => {
  it("keeps the radial family and records only title and legend", () => {
    const spec = makeSpec("radar", { markOptions: { showMarkers: true } } as Partial<ChartSpec>);
    const layout = computeRadarLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    expect(layout.elements!.family).toBe("radial");
    paintRadarChart(makeCtx(), data, spec, layout, DEFAULT_CHART_THEME);
    const els = layout.elements!;
    expect(els.family).toBe("radial");
    expect(els.measured.sort()).toEqual(["legend", "title"]);
    expect(els.xAxisBand).toBeUndefined();
    expect(els.yAxisBand).toBeUndefined();
    expect(els.legendItems!.length).toBe(data.series.length);
  });
});
