//! FILENAME: app/extensions/Charts/rendering/__tests__/seriesColorCoverage.test.ts
// PURPOSE: One test, parameterised over the MARK REGISTRY, that decides which
//          built-in marks actually PAINT a manual series colour — and asserts
//          that `markReadsSeriesColor` (what the Format pane's series swatch is
//          gated on) says exactly the same thing.
// CONTEXT: The pane refused a series swatch on a pie and a donut, with the right
//          reason: their painters resolve every slice from the palette by
//          CATEGORY and never read `data.series[i].color`. Eight other marks are
//          in the same position and the refusal did not cover them. On a
//          histogram the swatch was live, the write reached `spec.seriesColors`,
//          `applySeriesColorOverrides` copied it onto `data.series[0].color` —
//          and `histogramChartPainter` paints `getSeriesColor(spec.palette, 0,
//          null)`. Nothing changed and the document was dirtied.
//
//          A hand-maintained list of "which marks read it" is a second source of
//          truth that drifts on the first painter change, so the list is DIFFED
//          against what the painters actually do, in both directions: a mark
//          that starts reading the colour and a mark that stops both go red.
//
//          Modelled on dataPointOverrideCoverage.test.ts, which does the same
//          job for per-point overrides, and it shares that file's harness.

import { describe, it, expect } from "vitest";
import type { ChartSpec, ParsedChartData } from "../../types";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { getChartMark, listChartMarks } from "../markRegistry";
import { makeRecordingCtx, streamDiff } from "./dispatch-recordingCtx";
import { markReadsSeriesColor, seriesColourBlindMarks } from "../../lib/chartDataReader";
// Side-effect import: registering the 18 built-in marks IS chartDispatch's job.
import "../chartDispatch";

const THEME = DEFAULT_CHART_THEME;
const WIDTH = 600;
const HEIGHT = 400;

/** Never produced by any palette, so its presence in a stream is unambiguous. */
const SERIES_COLOUR = "#FF00AA";

const BUILTIN_MARKS: string[] = listChartMarks().filter(
  (mark) => getChartMark(mark)?.meta.builtin === true,
);

const CATS = ["A", "B", "C", "D"];

function series(name: string, values: number[]): ParsedChartData["series"][number] {
  return { name, values, color: null };
}

const MULTI: ParsedChartData = {
  categories: CATS,
  series: [
    series("S1", [10, 20, 30, 40]),
    series("S2", [18, 26, 34, 42]),
    series("S3", [14, 22, 38, 46]),
  ],
};

const SINGLE: ParsedChartData = {
  categories: CATS,
  series: [series("Values", [40, 30, 20, 10])],
};

const OHLC: ParsedChartData = {
  categories: ["Mon", "Tue", "Wed", "Thu"],
  series: [
    series("Open", [10, 12, 14, 16]),
    series("High", [15, 17, 19, 21]),
    series("Low", [9, 11, 13, 15]),
    series("Close", [14, 16, 18, 20]),
  ],
};

/** The fixture each mark needs before it paints a series at all. */
const DATA_FOR: Record<string, ParsedChartData> = {
  bar: MULTI, horizontalBar: MULTI, line: MULTI, area: MULTI, scatter: MULTI,
  bubble: MULTI, radar: MULTI, combo: MULTI,
  pie: SINGLE, donut: SINGLE, waterfall: SINGLE, treemap: SINGLE, funnel: SINGLE,
  sunburst: SINGLE, boxPlot: MULTI, stock: OHLC, histogram: SINGLE, pareto: SINGLE,
};

/** Marks that need a spec nudge before they draw their own series marks. */
const SPEC_EXTRA: Record<string, Partial<ChartSpec>> = {
  bubble: { markOptions: { sizeSeriesIndex: 2 } } as Partial<ChartSpec>,
};

function makeSpec(mark: string): ChartSpec {
  return {
    mark,
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 3, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "S1", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    // Legend OFF: every legend swatch is painted from the same resolver, so a
    // legend would let a mark "pass" on a chip beside the plot while the plot
    // itself ignored the colour. The question is what the DATA looks like.
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...SPEC_EXTRA[mark],
  } as ChartSpec;
}

/**
 * `applySeriesColorOverrides` (lib/chartDataReader.ts) writes the manual colour
 * onto the PARSED data, which is the only channel a painter has to it. Painting
 * with and without it is therefore the whole question.
 */
function withSeriesColour(data: ParsedChartData): ParsedChartData {
  return {
    ...data,
    series: data.series.map((s, i) => (i === 0 ? { ...s, color: SERIES_COLOUR } : s)),
  };
}

function paintStream(mark: string, data: ParsedChartData): string[] {
  const def = getChartMark(mark);
  if (!def) throw new Error(`Mark "${mark}" is not registered.`);
  const spec = makeSpec(mark);
  const { ctx, calls } = makeRecordingCtx(WIDTH, HEIGHT);
  const layout = def.computeLayout(WIDTH, HEIGHT, spec, data, THEME);
  def.paint(ctx, data, spec, layout, THEME);
  return calls;
}

/** True when the mark's painted output mentions the manual series colour. */
function paintsTheSeriesColour(mark: string): boolean {
  const data = DATA_FOR[mark];
  const base = paintStream(mark, data);
  const tinted = paintStream(mark, withSeriesColour(data));
  const moved = streamDiff(base, tinted).length > 0;
  const mentioned = tinted.some((entry) => entry.includes(SERIES_COLOUR));
  // Both, or neither: a stream that moved without the colour appearing would be
  // a non-deterministic painter, not a series colour being honoured.
  expect(base.some((entry) => entry.includes(SERIES_COLOUR))).toBe(false);
  expect(moved).toBe(mentioned);
  return mentioned;
}

describe("series colour: the registry is covered", () => {
  it("has a fixture for every built-in mark", () => {
    expect([...BUILTIN_MARKS].sort()).toEqual(Object.keys(DATA_FOR).sort());
  });

  it("every mark the predicate refuses is a registered built-in", () => {
    // A typo in the list would silently offer the swatch again.
    for (const mark of seriesColourBlindMarks()) {
      expect(BUILTIN_MARKS, `"${mark}" is not a built-in mark`).toContain(mark);
    }
  });
});

describe("series colour: markReadsSeriesColor matches what the painters do", () => {
  for (const mark of BUILTIN_MARKS) {
    it(`${mark}: the predicate and the canvas agree`, () => {
      expect(paintsTheSeriesColour(mark)).toBe(markReadsSeriesColor(mark));
    });
  }

  it("the marks that ignore it are exactly the ten we refuse a swatch for", () => {
    const ignored = BUILTIN_MARKS.filter((m) => !paintsTheSeriesColour(m)).sort();
    expect(ignored).toEqual([...seriesColourBlindMarks()].sort());
  });

  it("an UNREGISTERED mark is offered the swatch, not refused", () => {
    // The same asymmetry markOffersPerPointFormatting uses: a mark that never
    // registered cannot be known to decline, and a false refusal told a reader
    // that a bar chart had no series fill whenever the registry was not yet
    // populated.
    expect(markReadsSeriesColor("some.unregistered.mark")).toBe(true);
  });
});
