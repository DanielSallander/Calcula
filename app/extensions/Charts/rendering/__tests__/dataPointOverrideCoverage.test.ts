//! FILENAME: app/extensions/Charts/rendering/__tests__/dataPointOverrideCoverage.test.ts
// PURPOSE: One test, parameterised over the MARK REGISTRY, that asserts every
//          BUILT-IN mark honours `spec.dataPointOverrides`. Paint the mark once
//          with no override and once with an override on a single datum; the
//          recorded ctx call stream must differ, and the override colour must
//          appear in the second stream and not the first.
// CONTEXT: 13 of the 18 built-in marks shipped IGNORING dataPointOverrides and
//          nothing went red, because every per-point test was written per
//          painter: a painter with no test simply had no test. The per-painter
//          files (bars-perPointOverrides, points-perPointOverrides,
//          radial-datumOverrides, dispatch-comboOverrides) prove the DETAIL —
//          which colour moved where, what the border did. This file proves the
//          COVERAGE: the property holds for every entry in the registry, so a
//          19th built-in mark that forgets the resolver cannot be added
//          silently. The fixture table is asserted to cover the registry exactly,
//          which is the part that makes it a coverage test rather than a list.
//
//          SCOPE — built-ins only (`meta.builtin === true`). `registerChartMark`
//          is public through @api/chartMarks, and a third-party or script-authored
//          mark paints through rendering/sandboxMarkShim.ts: its pixels are an
//          ImageBitmap rendered in a Worker realm and blitted into the plot
//          rectangle, and NOTHING host-side applies dataPointOverrides to those
//          pixels. So, stated explicitly rather than quietly excluded: a CUSTOM
//          MARK DOES NOT GET PER-POINT OVERRIDES — not yet. The spec does reach
//          the worker, so a sandboxed mark could choose to read
//          `spec.dataPointOverrides` itself, but the host cannot make it, cannot
//          check that it did, and this test must not pretend otherwise. An
//          unscoped version of this test would go red the moment any custom mark
//          is registered, which is a false alarm about the mark and a real loss
//          of the guard over the built-ins.

import { describe, it, expect } from "vitest";
import { registerChartMark as apiRegisterChartMark, unregisterChartMark } from "@api/chartMarks";
import type { ChartSpec, ChartLayout, ParsedChartData, DataPointOverride } from "../../types";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { getChartMark, listChartMarks } from "../markRegistry";
import { makeRecordingCtx, streamDiff } from "./dispatch-recordingCtx";
// Side-effect import: registering the 18 built-in marks IS chartDispatch's job,
// and reading the registry is the whole point of this file.
import "../chartDispatch";

const THEME = DEFAULT_CHART_THEME;
const WIDTH = 600;
const HEIGHT = 400;

/**
 * The override colour. Never produced by a palette, so its presence in a call
 * stream is unambiguous evidence that the override reached the canvas.
 */
const OVERRIDE_COLOUR = "#FFCC00";

// ============================================================================
// The registry, scoped to built-ins
// ============================================================================

/**
 * Snapshotted at module load, BEFORE the custom-mark scoping test registers
 * anything, so the parameterised list cannot be perturbed by a test that runs
 * later in this file.
 */
const BUILTIN_MARKS: string[] = listChartMarks().filter(
  (mark) => getChartMark(mark)?.meta.builtin === true,
);

// ============================================================================
// Fixtures
// ============================================================================

const CATS = ["A", "B", "C", "D"];

function series(name: string, values: number[]): ParsedChartData["series"][number] {
  return { name, values, color: null };
}

/** Three plotted series — the fixture for every multi-series mark. */
const MULTI: ParsedChartData = {
  categories: CATS,
  series: [
    series("S1", [10, 20, 30, 40]),
    series("S2", [18, 26, 34, 42]),
    series("S3", [14, 22, 38, 46]),
  ],
};

/** One plotted series, descending — the fixture for the single-datum-per-category marks. */
const SINGLE: ParsedChartData = {
  categories: CATS,
  series: [series("Values", [40, 30, 20, 10])],
};

/** Open/High/Low/Close, every period closing up, for the stock mark. */
const OHLC: ParsedChartData = {
  categories: ["Mon", "Tue", "Wed", "Thu"],
  series: [
    series("Open", [10, 12, 14, 16]),
    series("High", [15, 17, 19, 21]),
    series("Low", [9, 11, 13, 15]),
    series("Close", [14, 16, 18, 20]),
  ],
};

/**
 * Which filter the authoring-space test applies to a mark.
 *
 * - "series": hide the LOWEST-index series. Only meaningful for a mark that
 *   paints a datum per (series, category).
 * - "category": hide the LOWEST-index category. The analogue for a mark that
 *   paints one datum per category (pie, waterfall, box plot, ...), whose
 *   resolver call is always `(0, categoryIndex)`.
 * - null: the mark resolves overrides against a DERIVED view of the data, so a
 *   source-row filter has no meaning in its datum space. `noFilterReason` says so.
 */
type FilterKind = "series" | "category" | null;

interface MarkFixture {
  data: ParsedChartData;
  /** Extra spec fields the mark needs before it paints anything per datum. */
  specExtra?: Partial<ChartSpec>;
  /** The AUTHORING-space datum the coverage test overrides. */
  target: { seriesIndex: number; categoryIndex: number };
  filter: FilterKind;
  /** Required when `filter` is null. */
  noFilterReason?: string;
}

const MARK_FIXTURES: Record<string, MarkFixture> = {
  bar: { data: MULTI, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "series" },
  horizontalBar: { data: MULTI, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "series" },
  line: { data: MULTI, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "series" },
  area: {
    data: MULTI,
    // An area series paints ONE polygon and, by default, no per-datum shape at
    // all (`showMarkers ?? false`) — there would be nothing for a per-point
    // override to reach. Markers on is the configuration in which the property
    // is even expressible for this mark.
    specExtra: { markOptions: { showMarkers: true } as ChartSpec["markOptions"] },
    target: { seriesIndex: 0, categoryIndex: 1 },
    filter: "series",
  },
  scatter: { data: MULTI, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "series" },
  bubble: { data: MULTI, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "series" },
  radar: { data: MULTI, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "series" },
  // Series 0 defaults to the BAR in a combo, the rest to lines; both paths
  // resolve per datum, and the target sits on the bar.
  combo: { data: MULTI, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "series" },

  pie: { data: SINGLE, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "category" },
  donut: { data: SINGLE, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "category" },
  waterfall: { data: SINGLE, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "category" },
  treemap: { data: SINGLE, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "category" },
  funnel: { data: SINGLE, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "category" },
  sunburst: { data: SINGLE, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "category" },
  // One box per category, aggregated ACROSS the series, so its datum is
  // (0, categoryIndex) even though the data is multi-series.
  boxPlot: { data: MULTI, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "category" },
  // One candle per period; the four series ARE the datum's OHLC components.
  stock: { data: OHLC, target: { seriesIndex: 0, categoryIndex: 1 }, filter: "category" },

  histogram: {
    data: SINGLE,
    // A histogram's datums are BINS, not source rows. Bin 0 always holds the
    // minimum value, so it is always painted.
    target: { seriesIndex: 0, categoryIndex: 0 },
    filter: null,
    noFilterReason:
      "Overrides resolve against the BINNED view (series \"Frequency\", category = bin index), "
      + "which is the identity computeHistogramBarRects reports. A source-row filter changes which "
      + "values are binned, not which bin an override names, so painter-to-authoring translation "
      + "has nothing to translate.",
  },
  pareto: {
    data: SINGLE,
    target: { seriesIndex: 0, categoryIndex: 1 },
    filter: null,
    noFilterReason:
      "A Pareto RE-ORDERS its categories and resolves overrides against the SORTED view, which is "
      + "exactly the categoryIndex computeParetoBarRects hands the hit-tester. The sorted position "
      + "is its authoring space, so a kept-index map over the source order does not apply.",
  },
};

// ============================================================================
// Helpers
// ============================================================================

function makeSpec(mark: string, extra: Partial<ChartSpec> = {}): ChartSpec {
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
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...extra,
  } as ChartSpec;
}

/** Lay the mark out and paint it, returning the ordered ctx call stream. */
function paintStream(mark: string, spec: ChartSpec, data: ParsedChartData): string[] {
  const def = getChartMark(mark);
  if (!def) throw new Error(`Mark "${mark}" is not registered.`);
  const { ctx, calls } = makeRecordingCtx(WIDTH, HEIGHT);
  const layout: ChartLayout = def.computeLayout(WIDTH, HEIGHT, spec, data, THEME);
  def.paint(ctx, data, spec, layout, THEME);
  return calls;
}

/** Paint `mark` with exactly one per-point colour override on `datum`. */
function paintWithOverride(
  mark: string,
  fixture: MarkFixture,
  data: ParsedChartData,
  datum: { seriesIndex: number; categoryIndex: number },
): string[] {
  const override: DataPointOverride = { ...datum, color: OVERRIDE_COLOUR };
  return paintStream(mark, makeSpec(mark, { ...fixture.specExtra, dataPointOverrides: [override] }), data);
}

/** Drop the lowest-index SERIES, recording the painter -> authoring map. */
function hideFirstSeries(d: ParsedChartData): ParsedChartData {
  return {
    categories: d.categories,
    series: d.series.slice(1),
    keptSeriesIndices: d.series.map((_s, i) => i).slice(1),
  };
}

/** Drop the lowest-index CATEGORY, recording the painter -> authoring map. */
function hideFirstCategory(d: ParsedChartData): ParsedChartData {
  return {
    categories: d.categories.slice(1),
    series: d.series.map((s) => ({ ...s, values: s.values.slice(1) })),
    keptCategoryIndices: d.categories.map((_c, i) => i).slice(1),
  };
}

/** Does any entry in the stream mention the override colour? */
function mentions(stream: string[], colour: string): boolean {
  return stream.some((entry) => entry.includes(colour));
}

// ============================================================================
// The fixture table must cover the registry
// ============================================================================

describe("dataPointOverrides: registry coverage", () => {
  it("registers at least the 18 built-in marks", () => {
    expect(BUILTIN_MARKS.length).toBeGreaterThanOrEqual(18);
  });

  it("has a fixture for EVERY built-in mark, and no fixture for anything else", () => {
    // This is the assertion that turns a list of tests into a coverage test: a
    // 19th built-in mark fails here until someone decides what its datum is.
    expect([...BUILTIN_MARKS].sort()).toEqual(Object.keys(MARK_FIXTURES).sort());
  });

  it("only the derived-datum marks opt out of the authoring-space test, with a reason", () => {
    const optedOut = Object.entries(MARK_FIXTURES)
      .filter(([, f]) => f.filter === null)
      .map(([mark]) => mark)
      .sort();
    expect(optedOut).toEqual(["histogram", "pareto"]);
    for (const mark of optedOut) {
      expect(MARK_FIXTURES[mark].noFilterReason?.length ?? 0).toBeGreaterThan(40);
    }
  });

  it("excludes a CUSTOM mark: a sandboxed mark cannot be made to honour overrides", () => {
    const id = "test.perPointCustomMark";
    apiRegisterChartMark(id, {
      meta: { label: "Custom", layoutFamily: "cartesian" },
      paint: () => {},
      computeLayout: (width: number, height: number) => ({
        width,
        height,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        plotArea: { x: 0, y: 0, width, height },
      }),
      computeGeometry: () => ({ type: "bars", rects: [] }),
    });
    try {
      expect(listChartMarks()).toContain(id);
      const builtinNow = listChartMarks().filter((m) => getChartMark(m)?.meta.builtin === true);
      expect(builtinNow).not.toContain(id);
      expect(builtinNow.sort()).toEqual([...BUILTIN_MARKS].sort());
    } finally {
      unregisterChartMark(id);
    }
    expect(listChartMarks()).not.toContain(id);
  });
});

// ============================================================================
// 1. Every built-in mark honours a per-point override
// ============================================================================

describe("dataPointOverrides: every built-in mark honours one", () => {
  for (const mark of BUILTIN_MARKS) {
    it(`${mark}: painting with an override on one datum changes the call stream`, () => {
      const fixture = MARK_FIXTURES[mark];
      expect(fixture, `no fixture for built-in mark "${mark}"`).toBeDefined();

      const base = paintStream(mark, makeSpec(mark, fixture.specExtra), fixture.data);
      const over = paintWithOverride(mark, fixture, fixture.data, fixture.target);

      // The stream must actually move. A painter that never calls the resolver
      // produces byte-identical output and lands here.
      expect(base.length).toBeGreaterThan(0);
      expect(streamDiff(base, over)).not.toEqual([]);

      // ...and it must move BECAUSE of the override, not because the paint is
      // non-deterministic: the override colour is in the second stream only.
      expect(mentions(base, OVERRIDE_COLOUR)).toBe(false);
      expect(mentions(over, OVERRIDE_COLOUR)).toBe(true);
    });

    it(`${mark}: painting twice with the same input is deterministic`, () => {
      // The control for the test above. Without it, a painter whose output
      // varies run to run would "pass" the difference assertion for free.
      const fixture = MARK_FIXTURES[mark];
      expect(fixture, `no fixture for built-in mark "${mark}"`).toBeDefined();
      const a = paintStream(mark, makeSpec(mark, fixture.specExtra), fixture.data);
      const b = paintStream(mark, makeSpec(mark, fixture.specExtra), fixture.data);
      expect(streamDiff(a, b)).toEqual([]);
    });
  }
});

// ============================================================================
// 2. The override is keyed in AUTHORING space, not painter space
// ============================================================================

describe("dataPointOverrides: authoring space survives a filter", () => {
  // `?.` deliberately: a built-in with NO fixture is reported by the coverage
  // assertion above as a clean diff of mark names. Indexing it blindly here
  // would instead blow up at COLLECTION time and print "no tests" — a crash
  // that hides which mark is missing.
  const filtered = BUILTIN_MARKS.filter((m) => MARK_FIXTURES[m]?.filter != null);

  for (const mark of filtered) {
    const fixture = MARK_FIXTURES[mark];
    const kind = fixture.filter as "series" | "category";
    const hidden = kind === "series" ? "series" : "category";

    it(`${mark}: an override lands on the datum the user coloured with a lower-index ${hidden} hidden`, () => {
      const data = kind === "series" ? hideFirstSeries(fixture.data) : hideFirstCategory(fixture.data);

      // Authoring index 1 is the datum that SURVIVED the filter and is now
      // painted at painter index 0. Authoring index 0 is the hidden one.
      const visible = kind === "series"
        ? { seriesIndex: 1, categoryIndex: fixture.target.categoryIndex }
        : { seriesIndex: fixture.target.seriesIndex, categoryIndex: 1 };
      const hiddenDatum = kind === "series"
        ? { seriesIndex: 0, categoryIndex: fixture.target.categoryIndex }
        : { seriesIndex: fixture.target.seriesIndex, categoryIndex: 0 };

      const base = paintStream(mark, makeSpec(mark, fixture.specExtra), data);
      const onVisible = paintWithOverride(mark, fixture, data, visible);
      const onHidden = paintWithOverride(mark, fixture, data, hiddenDatum);

      // The user coloured a datum that is still on screen: it must recolour.
      expect(streamDiff(base, onVisible)).not.toEqual([]);
      expect(mentions(onVisible, OVERRIDE_COLOUR)).toBe(true);

      // The user coloured a datum that is now HIDDEN: nothing may change. This
      // is the sharp end. A painter that looks the override up by its own loop
      // counter paints authoring datum 0 at painter position 0 — which is the
      // NEIGHBOUR that took the hidden datum's place — and goes red here.
      expect(streamDiff(base, onHidden)).toEqual([]);
      expect(mentions(onHidden, OVERRIDE_COLOUR)).toBe(false);
    });
  }
});
