//! FILENAME: app/extensions/Charts/rendering/__tests__/reachability-lineRadarMarkersOff.test.ts
// PURPOSE: The other two marks that can have their per-datum shape switched off.
//          `reachability-areaDefaultMarkers.test.ts` closed the AREA chart, which
//          hides its markers BY DEFAULT. Line and radar default them ON — but a
//          reader who sets `showMarkers: false` re-opens exactly the same hole,
//          and on those two marks the datum then has no shape on screen at all:
//          a line is one polyline, a radar series is one polygon, and the marker
//          IS the datum. So "format this data point" took a colour, wrote it into
//          the spec, dirtied the document and painted nothing.
// CONTEXT: Found while verifying the R-2 wave, which named both files as a
//          one-line adoption each and left them unadopted. The rule lives in
//          `markerReachesDatum` (rendering/markerPainter.ts) and the gate in
//          `specHasDatumOverrides` (lib/dataPointOverrides.ts) — one spelling
//          for three painters, so the next mark that grows a hideable marker
//          copies a call rather than a condition.
//
//          EVERY GRANT HAS A CONTROL. A chart with no override must be
//          byte-identical to before, so each assertion that a marker appeared is
//          partnered by one asserting the call stream did not move: an override
//          naming a datum that is not painted, and a `markerStyle: "none"`
//          override, both leave the stream EQUAL.

import { describe, it, expect } from "vitest";
import type { ChartSpec, ParsedChartData, DataPointOverride } from "../../types";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { computeLineLayout, paintLineChart } from "../lineChartPainter";
import { computeRadarLayout, paintRadarChart } from "../radarChartPainter";
import { makeRecordingCtx, streamDiff } from "./dispatch-recordingCtx";

const THEME = DEFAULT_CHART_THEME;
const WIDTH = 600;
const HEIGHT = 400;

/** Never produced by a palette, so its presence in a stream is unambiguous. */
const OVERRIDE_COLOUR = "#FFCC00";

/** Four categories, because a radar chart refuses to draw fewer than three. */
const CATS = ["A", "B", "C", "D"];

const DATA: ParsedChartData = {
  categories: CATS,
  series: [
    { name: "S1", values: [10, 20, 30, 40], color: null },
    { name: "S2", values: [18, 26, 34, 42], color: null },
  ],
};

function makeSpec(mark: "line" | "radar", extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
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

/** `markOptions` with the markers switched OFF — the configuration under test. */
const OFF = { markOptions: { showMarkers: false } } as Partial<ChartSpec>;

function paintLine(spec: ChartSpec, data: ParsedChartData = DATA): string[] {
  const { ctx, calls } = makeRecordingCtx(WIDTH, HEIGHT);
  paintLineChart(ctx, data, spec, computeLineLayout(WIDTH, HEIGHT, spec, data, THEME), THEME);
  return calls;
}

function paintRadar(spec: ChartSpec, data: ParsedChartData = DATA): string[] {
  const { ctx, calls } = makeRecordingCtx(WIDTH, HEIGHT);
  paintRadarChart(ctx, data, spec, computeRadarLayout(WIDTH, HEIGHT, spec, data, THEME), THEME);
  return calls;
}

function arcs(stream: string[]): number {
  return stream.filter((c) => c.startsWith("arc(")).length;
}

function mentions(stream: string[], colour: string): boolean {
  return stream.some((entry) => entry.includes(colour));
}

/** An override on ONE datum, named by its authoring index pair. */
function override(
  seriesIndex: number,
  categoryIndex: number,
  extra: Partial<DataPointOverride> = {},
): DataPointOverride {
  return { seriesIndex, categoryIndex, color: OVERRIDE_COLOUR, ...extra };
}

// ============================================================================
// LINE
// ============================================================================

describe("line chart with markers OFF", () => {
  it("paints not one marker when nothing is overridden", () => {
    // A line is traced with moveTo/lineTo and the chrome with fillRect/fillText,
    // so any arc at all on this chart is a marker.
    expect(arcs(paintLine(makeSpec("line", OFF)))).toBe(0);
  });

  it("is deterministic (the control for every difference below)", () => {
    expect(streamDiff(paintLine(makeSpec("line", OFF)), paintLine(makeSpec("line", OFF)))).toEqual([]);
  });

  it("gives an OVERRIDDEN datum its marker, in the reader's colour", () => {
    const base = paintLine(makeSpec("line", OFF));
    const over = paintLine(makeSpec("line", { ...OFF, dataPointOverrides: [override(0, 1)] }));

    // One datum gained a shape: the marker plus its hollow white core.
    expect(arcs(over)).toBe(arcs(base) + 2);
    expect(mentions(base, OVERRIDE_COLOUR)).toBe(false);
    expect(mentions(over, OVERRIDE_COLOUR)).toBe(true);
  });

  it("two overridden datums get two markers, and no others do", () => {
    const base = paintLine(makeSpec("line", OFF));
    const over = paintLine(
      makeSpec("line", { ...OFF, dataPointOverrides: [override(0, 1), override(1, 3)] }),
    );
    expect(arcs(over)).toBe(arcs(base) + 4);
    // Eight datums, two overridden: the other six kept the default of nothing.
    expect(DATA.series.length * DATA.categories.length).toBe(8);
  });

  it("an override that reaches NO painted datum leaves the stream untouched", () => {
    // The sharp control: the loop IS entered here, because the spec carries an
    // override. It fails the moment the loop stops asking whether this datum was
    // the one the reader formatted and simply paints every point.
    const base = paintLine(makeSpec("line", OFF));
    const stray = paintLine(makeSpec("line", { ...OFF, dataPointOverrides: [override(7, 9)] }));
    expect(streamDiff(base, stray)).toEqual([]);
    expect(mentions(stray, OVERRIDE_COLOUR)).toBe(false);
  });

  it('a "none" marker style on the overridden datum still paints nothing', () => {
    const base = paintLine(makeSpec("line", OFF));
    const hidden = paintLine(
      makeSpec("line", {
        ...OFF,
        dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 1, markerStyle: "none" }],
      }),
    );
    expect(streamDiff(base, hidden)).toEqual([]);
  });

  it("markers ON is unchanged — one marker per datum, override or not", () => {
    const on = paintLine(makeSpec("line"));
    expect(arcs(on)).toBe(16); // 8 datums x (shape + hollow core)
    const over = paintLine(makeSpec("line", { dataPointOverrides: [override(0, 1)] }));
    expect(arcs(over)).toBe(arcs(on));
    expect(mentions(on, OVERRIDE_COLOUR)).toBe(false);
    expect(mentions(over, OVERRIDE_COLOUR)).toBe(true);
  });

  it("puts the marker on the datum the reader coloured, not its neighbour, after a filter", () => {
    // Authoring series 1 survives and is painted at painter index 0; authoring
    // series 0 is gone. A painter that used its own loop counter as the override
    // key would mark the surviving series for the hidden one's override.
    const filtered: ParsedChartData = {
      categories: DATA.categories,
      series: DATA.series.slice(1),
      keptSeriesIndices: [1],
    };
    const base = paintLine(makeSpec("line", OFF), filtered);

    const onVisible = paintLine(makeSpec("line", { ...OFF, dataPointOverrides: [override(1, 2)] }), filtered);
    expect(arcs(onVisible)).toBe(arcs(base) + 2);
    expect(mentions(onVisible, OVERRIDE_COLOUR)).toBe(true);

    const onHidden = paintLine(makeSpec("line", { ...OFF, dataPointOverrides: [override(0, 2)] }), filtered);
    expect(streamDiff(base, onHidden)).toEqual([]);
    expect(mentions(onHidden, OVERRIDE_COLOUR)).toBe(false);
  });
});

// ============================================================================
// RADAR
// ============================================================================

describe("radar chart with markers OFF", () => {
  it("is deterministic (the control for every difference below)", () => {
    expect(streamDiff(paintRadar(makeSpec("radar", OFF)), paintRadar(makeSpec("radar", OFF)))).toEqual([]);
  });

  it("gives an OVERRIDDEN vertex its marker, in the reader's colour", () => {
    const base = paintRadar(makeSpec("radar", OFF));
    const over = paintRadar(makeSpec("radar", { ...OFF, dataPointOverrides: [override(0, 1)] }));

    // A radar marker is NOT hollow, so it is one arc rather than two — counted
    // as a difference from the baseline rather than as an absolute, because the
    // radar chrome may legitimately draw arcs of its own.
    expect(arcs(over)).toBe(arcs(base) + 1);
    expect(mentions(base, OVERRIDE_COLOUR)).toBe(false);
    expect(mentions(over, OVERRIDE_COLOUR)).toBe(true);
  });

  it("an override that reaches NO painted vertex leaves the stream untouched", () => {
    const base = paintRadar(makeSpec("radar", OFF));
    const stray = paintRadar(makeSpec("radar", { ...OFF, dataPointOverrides: [override(7, 9)] }));
    expect(streamDiff(base, stray)).toEqual([]);
    expect(mentions(stray, OVERRIDE_COLOUR)).toBe(false);
  });

  it('a "none" marker style on the overridden vertex still paints nothing', () => {
    const base = paintRadar(makeSpec("radar", OFF));
    const hidden = paintRadar(
      makeSpec("radar", {
        ...OFF,
        dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 1, markerStyle: "none" }],
      }),
    );
    expect(streamDiff(base, hidden)).toEqual([]);
  });

  it("markers ON is unchanged — every vertex keeps its marker", () => {
    const on = paintRadar(makeSpec("radar"));
    const off = paintRadar(makeSpec("radar", OFF));
    // 8 vertices, one arc each, and switching them off removes exactly those.
    expect(arcs(on) - arcs(off)).toBe(8);
  });
});
