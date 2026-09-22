//! FILENAME: app/extensions/Charts/handlers/__tests__/furniture2-deleteResolver.test.ts
// PURPOSE: What "Delete" does to a selected trendline, a series' error bars, one
//          data label and the data table — the ONE resolver the Delete key, the
//          context menu and the Format pane's Remove buttons all ask.
//
// THE RULE THIS PROGRAMME HAS PAID FOR TWICE: the Delete branch is keyed off
// the SUBJECT, never off whether a write happened. An already-cleared title and
// an already-hidden legend row both answer "nothing changed", and a listener
// that read that as "not mine" let the second press — the "did that work?"
// reflex — destroy the whole chart. So `furnitureDeletePatch` returning null is
// "the spec already looks like that", NOT "this is not mine", and every caller
// consumes the gesture on its own terms. The tests below pin BOTH halves: the
// null cases exist, and they are exactly the idempotent ones.
//
// THE OTHER HALF: two of these four had no spelling at all before this change.
// Error bars are configured chart-wide under `markOptions`, so "remove the bars
// on the series I selected" could only be honoured as `enabled: false` — which
// strips them from every series, the coarser act the finer one is for. Data
// labels had `seriesFilter` and nothing per point. `ErrorBarOptions.seriesFilter`
// and `DataLabelSpec.hiddenPoints` are the narrowest fields that make the finer
// act expressible, and they are mirrored on the schema and the reference table
// because a field the broker gate refuses is a field scripts cannot write.

import { describe, it, expect } from "vitest";
import {
  furnitureDeletePatch,
  furnitureTargetFromSubSelection,
  furnitureTargetFromSubject,
  type FurnitureDeleteTarget,
} from "../../components/ChartContextMenu";
import type { ChartSpec, ErrorBarOptions } from "../../types";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Sales", sourceIndex: 1, color: null },
      { name: "Cost", sourceIndex: 2, color: null },
    ],
    title: "T",
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "right" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

const BARS: ErrorBarOptions = { enabled: true, type: "percentage", value: 10, direction: "both" };

// ===========================================================================

describe("trendline", () => {
  const two = spec({
    trendlines: [
      { type: "linear", seriesIndex: 0 },
      { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 3 },
    ],
  });

  it("removes the one named by the ORDINAL, not the first one on the series", () => {
    // The defect this is the pin for: both trendlines carry seriesIndex 0, so a
    // resolver that matched on the series alone would always take the linear
    // fit — and clicking the moving average and pressing Delete would remove
    // the OTHER line while the one under the cursor stayed.
    const patch = furnitureDeletePatch(two, {
      element: "trendline",
      seriesIndex: 0,
      trendlineIndex: 1,
    });
    expect(patch?.trendlines).toEqual([{ type: "linear", seriesIndex: 0 }]);
  });

  it("falls back to the series' first trendline when no ordinal travelled", () => {
    const patch = furnitureDeletePatch(two, { element: "trendline", seriesIndex: 0 });
    expect(patch?.trendlines).toEqual([
      { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 3 },
    ]);
  });

  it("drops the field entirely when the last one goes, rather than leaving []", () => {
    const one = spec({ trendlines: [{ type: "linear", seriesIndex: 0 }] });
    expect(furnitureDeletePatch(one, { element: "trendline", trendlineIndex: 0 })).toEqual({
      trendlines: undefined,
    });
  });

  it("answers null when there is no trendline for that series", () => {
    expect(furnitureDeletePatch(two, { element: "trendline", seriesIndex: 7 })).toBeNull();
    expect(furnitureDeletePatch(spec(), { element: "trendline", seriesIndex: 0 })).toBeNull();
  });
});

// ===========================================================================

describe("error bars — per SERIES, from a chart-wide config", () => {
  const withBars = spec({ markOptions: { errorBars: BARS } });

  it("removes ONE series' bars by enumerating the others, never by disabling everything", () => {
    // `enabled: false` here is the coarser act `seriesFilter` exists to avoid:
    // it would strip the bars off the series the reader did NOT select.
    const patch = furnitureDeletePatch(withBars, { element: "errorBars", seriesIndex: 0 });
    const next = (patch?.markOptions as { errorBars: ErrorBarOptions }).errorBars;
    expect(next.enabled).toBe(true);
    expect(next.seriesFilter).toEqual([1]);
  });

  it("narrows an existing filter rather than replacing it", () => {
    const three = spec({
      series: [
        { name: "A", sourceIndex: 1, color: null },
        { name: "B", sourceIndex: 2, color: null },
        { name: "C", sourceIndex: 3, color: null },
      ],
      markOptions: { errorBars: { ...BARS, seriesFilter: [0, 1, 2] } },
    });
    const patch = furnitureDeletePatch(three, { element: "errorBars", seriesIndex: 1 });
    const next = (patch?.markOptions as { errorBars: ErrorBarOptions }).errorBars;
    expect(next.seriesFilter).toEqual([0, 2]);
  });

  it("turns error bars OFF only when the last series' bars are removed", () => {
    const last = spec({ markOptions: { errorBars: { ...BARS, seriesFilter: [1] } } });
    const patch = furnitureDeletePatch(last, { element: "errorBars", seriesIndex: 1 });
    const next = (patch?.markOptions as { errorBars: ErrorBarOptions }).errorBars;
    expect(next.enabled).toBe(false);
    expect(next.seriesFilter).toBeNull();
  });

  it("keeps every other markOption", () => {
    const withMore = spec({ markOptions: { borderRadius: 7, errorBars: BARS } });
    const patch = furnitureDeletePatch(withMore, { element: "errorBars", seriesIndex: 0 });
    expect((patch?.markOptions as { borderRadius: number }).borderRadius).toBe(7);
  });

  it("answers null for a series whose bars are already gone (IDEMPOTENT, not 'not mine')", () => {
    const already = spec({ markOptions: { errorBars: { ...BARS, seriesFilter: [1] } } });
    expect(furnitureDeletePatch(already, { element: "errorBars", seriesIndex: 0 })).toBeNull();
  });

  it("refuses rather than over-reaching when the series are not enumerable", () => {
    // A pivot or design-query chart has an empty `spec.series`, so "all of them
    // except this one" cannot be written. Falling back to `enabled: false`
    // there would strip the bars off every series — the exact trap this field
    // was added to close — so the honest answer is to do nothing.
    const pivotish = spec({ series: [], markOptions: { errorBars: BARS } });
    expect(furnitureDeletePatch(pivotish, { element: "errorBars", seriesIndex: 0 })).toBeNull();
  });

  it("answers null when the chart has no error bars, or none are enabled", () => {
    expect(furnitureDeletePatch(spec(), { element: "errorBars", seriesIndex: 0 })).toBeNull();
    const off = spec({ markOptions: { errorBars: { ...BARS, enabled: false } } });
    expect(furnitureDeletePatch(off, { element: "errorBars", seriesIndex: 0 })).toBeNull();
  });

  it("asks the mark-aware accessor, so a line chart's bars are found too", () => {
    const line = spec({ mark: "line", markOptions: { errorBars: BARS } });
    expect(furnitureDeletePatch(line, { element: "errorBars", seriesIndex: 0 })).not.toBeNull();
    // A mark with no error-bar slot at all answers null rather than writing one.
    const pie = spec({ mark: "pie", markOptions: { errorBars: BARS } });
    expect(furnitureDeletePatch(pie, { element: "errorBars", seriesIndex: 0 })).toBeNull();
  });
});

// ===========================================================================

describe("one data label", () => {
  const labelled = spec({ dataLabels: { enabled: true, position: "above" } });

  it("suppresses THAT point's label and leaves every other one standing", () => {
    const patch = furnitureDeletePatch(labelled, {
      element: "dataLabel",
      seriesIndex: 1,
      pointIndex: 2,
    });
    expect(patch?.dataLabels?.hiddenPoints).toEqual([{ seriesIndex: 1, pointIndex: 2 }]);
    // Labels stay ON for the chart; only one of them is hidden.
    expect(patch?.dataLabels?.enabled).toBe(true);
    expect(patch?.dataLabels?.position).toBe("above");
  });

  it("appends rather than replacing, so repeated Delete peels labels off one at a time", () => {
    const some = spec({
      dataLabels: { enabled: true, hiddenPoints: [{ seriesIndex: 0, pointIndex: 0 }] },
    });
    const patch = furnitureDeletePatch(some, {
      element: "dataLabel",
      seriesIndex: 0,
      pointIndex: 1,
    });
    expect(patch?.dataLabels?.hiddenPoints).toEqual([
      { seriesIndex: 0, pointIndex: 0 },
      { seriesIndex: 0, pointIndex: 1 },
    ]);
  });

  it("answers null for a label already hidden, and for one with no point", () => {
    const some = spec({
      dataLabels: { enabled: true, hiddenPoints: [{ seriesIndex: 0, pointIndex: 1 }] },
    });
    expect(
      furnitureDeletePatch(some, { element: "dataLabel", seriesIndex: 0, pointIndex: 1 }),
    ).toBeNull();
    expect(furnitureDeletePatch(labelled, { element: "dataLabel", seriesIndex: 0 })).toBeNull();
    expect(furnitureDeletePatch(spec(), { element: "dataLabel", seriesIndex: 0, pointIndex: 0 })).toBeNull();
  });
});

// ===========================================================================

describe("the data table", () => {
  it("turns it off, keeping the rest of its options for when it comes back", () => {
    const withTable = spec({ dataTable: { enabled: true, showLegendKeys: false } });
    expect(furnitureDeletePatch(withTable, { element: "dataTable" })).toEqual({
      dataTable: { enabled: false, showLegendKeys: false },
    });
  });

  it("answers null when it is already off or absent", () => {
    expect(furnitureDeletePatch(spec(), { element: "dataTable" })).toBeNull();
    const off = spec({ dataTable: { enabled: false } });
    expect(furnitureDeletePatch(off, { element: "dataTable" })).toBeNull();
  });
});

// ===========================================================================

describe("the two derivations name the SAME target", () => {
  // One resolver, two callers: the Delete key derives its target from the
  // selection ladder and the context menu derives it from the right-clicked
  // element. A second copy of "what does deleting this mean" would drift the
  // first time one of these fields learned a new way to disappear.
  it("the ladder's rung and the right-clicked subject agree, field for field", () => {
    const cases: Array<{
      sub: Parameters<typeof furnitureTargetFromSubSelection>[0];
      subject: Parameters<typeof furnitureTargetFromSubject>[0];
      expected: FurnitureDeleteTarget;
    }> = [
      {
        sub: { level: "element", elementId: "trendline", seriesIndex: 1, trendlineIndex: 2 },
        subject: { element: "trendline", name: "Trendline", identity: null, seriesIndex: 1, trendlineIndex: 2 },
        expected: { element: "trendline", seriesIndex: 1, trendlineIndex: 2 },
      },
      {
        sub: { level: "element", elementId: "errorBars", seriesIndex: 3 },
        subject: { element: "errorBars", name: "Error Bars", identity: null, seriesIndex: 3 },
        expected: { element: "errorBars", seriesIndex: 3 },
      },
      {
        // The ladder spells the label's point `categoryIndex` and the menu
        // spells it `pointIndex` — the same index under two names, because each
        // surface already had a name for it. The adapters are where that stops.
        sub: { level: "element", elementId: "dataLabel", seriesIndex: 0, categoryIndex: 4 },
        subject: { element: "dataLabel", name: "Data Label", identity: null, seriesIndex: 0, pointIndex: 4 },
        expected: { element: "dataLabel", seriesIndex: 0, pointIndex: 4 },
      },
      {
        sub: { level: "element", elementId: "dataTable" },
        subject: { element: "dataTable", name: "Data Table", identity: null },
        expected: { element: "dataTable" },
      },
    ];
    for (const c of cases) {
      expect(furnitureTargetFromSubSelection(c.sub)).toEqual(c.expected);
      expect(furnitureTargetFromSubject(c.subject)).toEqual(c.expected);
    }
  });

  it("answers null for every rung that is NOT one of the four", () => {
    // The Delete listener enters its furniture branch on
    // `isFurnitureDeleteElement`; an adapter that answered a target for
    // `plotArea` would reopen the destructive route that branch closed.
    expect(furnitureTargetFromSubSelection({ level: "chart" })).toBeNull();
    expect(furnitureTargetFromSubSelection({ level: "element", elementId: "plotArea" })).toBeNull();
    expect(furnitureTargetFromSubSelection({ level: "element", elementId: "title" })).toBeNull();
    expect(
      furnitureTargetFromSubject({ element: "plotArea", name: "Plot Area", identity: null }),
    ).toBeNull();
  });
});
