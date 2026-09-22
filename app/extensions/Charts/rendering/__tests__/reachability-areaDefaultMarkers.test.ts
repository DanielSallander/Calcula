//! FILENAME: app/extensions/Charts/rendering/__tests__/reachability-areaDefaultMarkers.test.ts
// PURPOSE: R-2 gap 1 (design doc chart-interaction.md §6.7). A DEFAULT area
//          chart had no per-point route at all: `showMarkers` defaults to false
//          and an area series is ONE polygon filled from the SERIES colour, so
//          "format this data point" wrote a colour into the spec, dirtied the
//          document, and changed nothing on screen. An OVERRIDDEN datum now
//          gets its marker even when the series shows none.
// CONTEXT: The existing coverage test (dataPointOverrideCoverage.test.ts) had to
//          switch markers ON in its `area` fixture to express the property at
//          all, and said so in a comment. That comment was the bug report. This
//          file tests the DEFAULT chart — the one a reader actually gets.
//
//          THE OTHER HALF IS THE CONTROL. Granting a marker to an overridden
//          datum is only safe if an area chart with no overrides is byte
//          identical to before, so every assertion below that adds a marker has
//          a partner asserting the stream did not move: an override that
//          reaches no painted datum, and a `markerStyle: "none"` override, both
//          leave the call stream EQUAL to the untouched one.

import { describe, it, expect } from "vitest";
import type { ChartSpec, ParsedChartData, DataPointOverride } from "../../types";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { computeAreaLayout, paintAreaChart } from "../areaChartPainter";
import { markerReachesDatum } from "../markerPainter";
import { makeRecordingCtx, streamDiff } from "./dispatch-recordingCtx";

const THEME = DEFAULT_CHART_THEME;
const WIDTH = 600;
const HEIGHT = 400;

/** Never produced by a palette, so its presence in a stream is unambiguous. */
const OVERRIDE_COLOUR = "#FFCC00";

const CATS = ["A", "B", "C", "D"];

const DATA: ParsedChartData = {
  categories: CATS,
  series: [
    { name: "S1", values: [10, 20, 30, 40], color: null },
    { name: "S2", values: [18, 26, 34, 42], color: null },
  ],
};

function makeSpec(extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "area",
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "S1", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...extra,
  } as ChartSpec;
}

function paint(spec: ChartSpec, data: ParsedChartData = DATA): string[] {
  const { ctx, calls } = makeRecordingCtx(WIDTH, HEIGHT);
  paintAreaChart(ctx, data, spec, computeAreaLayout(WIDTH, HEIGHT, spec, data, THEME), THEME);
  return calls;
}

/** How many `arc(...)` calls the stream contains — one marker is two of them
 *  (the shape, then the white hollow core). */
function arcs(stream: string[]): number {
  return stream.filter((c) => c.startsWith("arc(")).length;
}

function mentions(stream: string[], colour: string): boolean {
  return stream.some((entry) => entry.includes(colour));
}

/** An override on ONE datum, named by its authoring index pair. */
function override(seriesIndex: number, categoryIndex: number, extra: Partial<DataPointOverride> = {}): DataPointOverride {
  return { seriesIndex, categoryIndex, color: OVERRIDE_COLOUR, ...extra };
}

// ============================================================================
// The predicate itself
// ============================================================================

describe("markerReachesDatum", () => {
  it("markers OFF: only a datum an override reached gets one", () => {
    expect(markerReachesDatum(false, "none")).toBe(false);
    expect(markerReachesDatum(false, "index")).toBe(true);
    expect(markerReachesDatum(false, "key")).toBe(true);
  });

  it("markers ON: every datum gets one, overridden or not", () => {
    expect(markerReachesDatum(true, "none")).toBe(true);
    expect(markerReachesDatum(true, "index")).toBe(true);
    expect(markerReachesDatum(true, "key")).toBe(true);
  });
});

// ============================================================================
// 1. The DEFAULT area chart paints no markers at all
// ============================================================================

describe("area chart, markers off, no overrides", () => {
  it("paints not one marker", () => {
    // The baseline the whole feature is measured against. An area polygon is
    // traced with lineTo/bezierCurveTo and the chrome with fillRect/fillText,
    // so any arc at all on this chart is a marker.
    expect(arcs(paint(makeSpec()))).toBe(0);
  });

  it("is deterministic (the control for every difference asserted below)", () => {
    expect(streamDiff(paint(makeSpec()), paint(makeSpec()))).toEqual([]);
  });
});

// ============================================================================
// 2. An overridden datum gets a marker WITHOUT markers being switched on
// ============================================================================

describe("area chart, markers off, one datum overridden", () => {
  it("paints exactly one marker, in the override colour", () => {
    const base = paint(makeSpec());
    const over = paint(makeSpec({ dataPointOverrides: [override(0, 1)] }));

    // Exactly one datum gained a shape: the marker and its hollow core.
    expect(arcs(over)).toBe(arcs(base) + 2);

    // ...and the colour the reader picked is on the canvas, not merely in the
    // spec. This is the assertion the shipped behaviour failed.
    expect(mentions(base, OVERRIDE_COLOUR)).toBe(false);
    expect(mentions(over, OVERRIDE_COLOUR)).toBe(true);
    expect(streamDiff(base, over)).not.toEqual([]);
  });

  it("two overridden datums get two markers", () => {
    const base = paint(makeSpec());
    const over = paint(makeSpec({ dataPointOverrides: [override(0, 1), override(1, 3)] }));
    expect(arcs(over)).toBe(arcs(base) + 4);
  });

  it("honours the override's marker shape, size and border, not just its colour", () => {
    // `markerBorderColor`, NOT `borderColor`: the resolver keeps the two apart
    // because a datum's own outline and its MARKER's outline are different
    // Excel settings, and the point painters read the marker* half.
    const over = paint(
      makeSpec({
        dataPointOverrides: [
          override(0, 1, { markerStyle: "diamond", markerSize: 9, markerBorderColor: "#123456", markerBorderWidth: 3 }),
        ],
      }),
    );
    // A diamond is four lineTo segments from a moveTo, never an arc — so the
    // resolved SHAPE reached the canvas, not merely the resolved colour.
    expect(arcs(over)).toBe(arcs(paint(makeSpec())));
    expect(mentions(over, OVERRIDE_COLOUR)).toBe(true);
    expect(mentions(over, "#123456")).toBe(true);
  });
});

// ============================================================================
// 3. THE CONTROL — nothing else moved
// ============================================================================

describe("area chart with no REACHED override is byte-identical", () => {
  it("an override naming a datum that is not painted changes nothing", () => {
    // The sharp control. The marker loop IS entered here (the spec carries an
    // override), so this fails the moment the loop stops asking whether the
    // datum was actually reached and paints every point instead.
    const base = paint(makeSpec());
    const stray = paint(makeSpec({ dataPointOverrides: [override(7, 9)] }));
    expect(streamDiff(base, stray)).toEqual([]);
    expect(mentions(stray, OVERRIDE_COLOUR)).toBe(false);
  });

  it('an override of markerStyle "none" paints nothing', () => {
    // "none" is the one marker style that means "hide just this one". Granting
    // a marker to an overridden datum must not override that.
    const base = paint(makeSpec());
    const hidden = paint(makeSpec({ dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 1, markerStyle: "none" }] }));
    expect(streamDiff(base, hidden)).toEqual([]);
  });

  it("the un-overridden datums of an overridden chart are still bare", () => {
    // Eight datums, one override: exactly one marker, so seven points kept the
    // default. Counting rather than diffing, because the stream legitimately
    // moves where the one marker was inserted.
    const over = paint(makeSpec({ dataPointOverrides: [override(0, 1)] }));
    expect(arcs(over) - arcs(paint(makeSpec()))).toBe(2);
    expect(DATA.series.length * DATA.categories.length).toBe(8);
  });
});

// ============================================================================
// 4. Markers ON is untouched
// ============================================================================

describe("area chart with markers ON", () => {
  const MARKERS_ON = { markOptions: { showMarkers: true } } as Partial<ChartSpec>;

  it("paints one marker per datum", () => {
    const on = paint(makeSpec(MARKERS_ON));
    // 8 datums x (shape + hollow core).
    expect(arcs(on)).toBe(16);
  });

  it("still honours a per-point override on top of them", () => {
    const on = paint(makeSpec(MARKERS_ON));
    const over = paint(makeSpec({ ...MARKERS_ON, dataPointOverrides: [override(0, 1)] }));
    expect(arcs(over)).toBe(arcs(on));
    expect(mentions(on, OVERRIDE_COLOUR)).toBe(false);
    expect(mentions(over, OVERRIDE_COLOUR)).toBe(true);
  });
});

// ============================================================================
// 5. Markers off, and a lower-index series hidden by a filter
// ============================================================================

describe("area chart, markers off, override survives a filter", () => {
  /** Drop the lowest-index series, recording the painter -> authoring map. */
  const FILTERED: ParsedChartData = {
    categories: DATA.categories,
    series: DATA.series.slice(1),
    keptSeriesIndices: [1],
  };

  it("the marker appears on the datum the reader coloured, not its neighbour", () => {
    const base = paint(makeSpec(), FILTERED);

    // Authoring series 1 SURVIVED the filter and is now painted at painter
    // index 0. It must gain the marker.
    const onVisible = paint(makeSpec({ dataPointOverrides: [override(1, 2)] }), FILTERED);
    expect(arcs(onVisible)).toBe(arcs(base) + 2);
    expect(mentions(onVisible, OVERRIDE_COLOUR)).toBe(true);

    // Authoring series 0 is HIDDEN. A painter that looked the override up by
    // its own loop counter would put a marker on the surviving series here.
    const onHidden = paint(makeSpec({ dataPointOverrides: [override(0, 2)] }), FILTERED);
    expect(streamDiff(base, onHidden)).toEqual([]);
    expect(mentions(onHidden, OVERRIDE_COLOUR)).toBe(false);
  });
});
