//! FILENAME: app/extensions/Charts/rendering/__tests__/dispatch-layoutMutationRects.test.ts
// PURPOSE: Two stages mutate a chart layout AFTER the layout was computed —
//          the combo secondary axis and the pivot field buttons. Every element
//          rect except chartArea and title is a function of margin/plotArea, so
//          each of those mutations must be followed by reflowChartElements
//          BEFORE anything paints. These tests hold each site to that: a rect
//          that is stale by exactly the height that was added is a click that
//          lands on nothing. The data table was a third such site; its band is
//          now part of computeCartesianLayout, and site (b) below holds it to
//          producing the same consistency without the after-the-fact mutation.

import { describe, it, expect } from "vitest";
import { computeComboLayout, paintComboChart } from "../comboChartPainter";
import { dispatchComputeLayout } from "../chartDispatch";
import { adjustLayoutForPivotButtons } from "../chartRenderer";
import {
  computeCartesianElementRects,
  computeCartesianLayout,
  rectContains,
} from "../chartPainterUtils";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type {
  ChartSpec,
  ComboMarkOptions,
  ParsedChartData,
  PivotChartFieldInfo,
} from "../../types";
import { makeRecordingCtx } from "./dispatch-recordingCtx";

// ============================================================================
// Fixtures
// ============================================================================

const DATA: ParsedChartData = {
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { name: "Revenue", color: null, values: [100, 150, 130, 180] },
    { name: "Trend", color: null, values: [110, 125, 140, 160] },
  ],
};

function makeSpec(over: Partial<ChartSpec> = {}, opts?: Partial<ComboMarkOptions>): ChartSpec {
  return {
    mark: "combo",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Trend", sourceIndex: 2, color: null },
    ],
    title: "Revenue vs Trend",
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: "Units", gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "right" },
    palette: "default",
    markOptions: opts,
    ...over,
  };
}

/** The exact rects the CURRENT margins imply — i.e. what a reflow must produce. */
function expectedRects(layout: ReturnType<typeof computeComboLayout>, spec: ChartSpec) {
  return computeCartesianElementRects(layout, spec, DATA, DEFAULT_CHART_THEME);
}

// ============================================================================
// Site (a): comboChartPainter's secondary-axis margin
// ============================================================================

describe("combo secondary axis reflows the element rects", () => {
  const SEC: Partial<ComboMarkOptions> = {
    seriesMarks: { 0: "bar", 1: "line" },
    secondaryYAxis: true,
    secondaryAxisSeries: [1],
  };

  it("the mutation really happens (the sabotage-has-teeth precondition)", () => {
    const plain = computeComboLayout(600, 400, makeSpec(), DATA, DEFAULT_CHART_THEME);
    const sec = computeComboLayout(600, 400, makeSpec({}, SEC), DATA, DEFAULT_CHART_THEME);
    expect(sec.margin.right).toBe(plain.margin.right + 46);
    expect(sec.plotArea.width).toBe(plain.plotArea.width - 46);
  });

  it("every rect matches the FINAL margins, not the pre-mutation ones", () => {
    const spec = makeSpec({}, SEC);
    const layout = computeComboLayout(600, 400, spec, DATA, DEFAULT_CHART_THEME);
    expect(layout.elements).toBeDefined();
    expect(layout.elements).toEqual(expectedRects(layout, spec));
  });

  it("the right-hand legend moved left with the narrowed plot", () => {
    const plain = computeComboLayout(600, 400, makeSpec(), DATA, DEFAULT_CHART_THEME);
    const sec = computeComboLayout(600, 400, makeSpec({}, SEC), DATA, DEFAULT_CHART_THEME);
    // verticalLegendX = plotArea.x + plotArea.width + 16, so a legend rect that
    // did NOT reflow would still sit 46px further right, past the axis.
    expect(sec.elements!.legend!.x).toBe(plain.elements!.legend!.x - 46);
  });

  it("the title rect still contains the painted title pixel after the mutation", () => {
    const spec = makeSpec({}, SEC);
    const layout = computeComboLayout(600, 400, spec, DATA, DEFAULT_CHART_THEME);
    const { ctx, calls } = makeRecordingCtx();
    paintComboChart(ctx, DATA, spec, layout, DEFAULT_CHART_THEME);

    const anchor = titleAnchor(calls, "Revenue vs Trend");
    expect(anchor).not.toBeNull();
    expect(rectContains(layout.elements!.title!, anchor!.x, anchor!.y)).toBe(true);
  });

  it("the y-axis-title rect contains its painted anchor after the mutation", () => {
    const spec = makeSpec({}, SEC);
    const layout = computeComboLayout(600, 400, spec, DATA, DEFAULT_CHART_THEME);
    const { ctx, calls } = makeRecordingCtx();
    paintComboChart(ctx, DATA, spec, layout, DEFAULT_CHART_THEME);

    // drawComboAxes translates to (14, plot vertical centre) and paints at 0,0.
    const t = calls.find((c) => c.startsWith("translate(14,"));
    expect(t).toBeDefined();
    const y = Number(t!.slice("translate(14,".length, -1));
    expect(rectContains(layout.elements!.yAxisTitle!, 14, y)).toBe(true);
    // ...and that rect is MEASURED, not the layout's 0.55em-per-char guess.
    expect(layout.elements!.measured).toContain("yAxisTitle");

    // rectContains(rect, 14, centreY) is true for ANY width and height — 14 is
    // the left edge and centreY the vertical middle — so the containment check
    // above cannot see a wrong BOX. Pin the dimensions: rotated -90deg with a
    // "top" baseline makes the glyph run a TALL box one font-size wide and the
    // MEASURED text width tall (this ctx measures 7px per character).
    const yTitleRect = layout.elements!.yAxisTitle!;
    expect(yTitleRect.width).toBe(DEFAULT_CHART_THEME.axisTitleFontSize);
    expect(yTitleRect.height).toBe("Units".length * 7);
  });

  it("paint records a measured y-label band for the narrowed plot", () => {
    const spec = makeSpec({}, SEC);
    const layout = computeComboLayout(600, 400, spec, DATA, DEFAULT_CHART_THEME);
    const { ctx, calls } = makeRecordingCtx();
    paintComboChart(ctx, DATA, spec, layout, DEFAULT_CHART_THEME);
    const band = layout.elements!.yAxisBand!;
    expect(layout.elements!.measured).toContain("yAxisBand");
    // The band ends at the axis line, whose x is the FINAL plotArea.x.
    expect(band.x + band.width).toBe(layout.plotArea.x);
    expect(band.height).toBe(layout.plotArea.height);

    // `x + width === plotArea.x` holds for ANY width, because x is DERIVED as
    // plotArea.x - width — it is an identity, not a measurement, and a band
    // 37px too wide sails through it. Pin the width to the labels actually
    // painted: y tick labels are right-aligned at plotArea.x - 6, and the band
    // runs from the widest one's left edge to the axis line.
    const labelX = layout.plotArea.x - 6;
    const tickLabels = calls
      .filter((c) => c.startsWith("fillText("))
      .map((c) => c.slice("fillText(".length, -1).split(","))
      .filter((parts) => parts.length === 3 && Number(parts[1]) === labelX)
      .map((parts) => parts[0]);
    expect(tickLabels.length).toBeGreaterThan(0);
    const widest = Math.max(...tickLabels.map((l) => l.length * 7));
    expect(band.width).toBe(widest + 6);
  });
});

/** The (x, y) drawTitle painted at, read back out of the recorded stream. */
function titleAnchor(calls: string[], title: string): { x: number; y: number } | null {
  const call = calls.find((c) => c.startsWith(`fillText(${title},`));
  if (!call) return null;
  const parts = call.slice(`fillText(${title},`.length, -1).split(",");
  return { x: Number(parts[0]), y: Number(parts[1]) };
}

// ============================================================================
// Site (b): the data table's band inside computeCartesianLayout
// ============================================================================
//
// This used to be a post-hoc mutation site like (a) and (c): chartDispatch
// shortened the plot and grew margin.bottom after the mark's computeLayout had
// already reserved a tick-label band. The band is now decided once, inside
// computeCartesianLayout, and the tick labels are not reserved at all while the
// table is on — so what these tests hold is that the plot still shrinks and
// that every rect still matches the final margins. Where the labels and the
// axis title END UP is dataTableLayout.test.ts's business.

describe("the data table's band is part of the layout", () => {
  const withTable = (): ChartSpec =>
    makeSpec({
      dataTable: { enabled: true },
    });

  it("the mutation really happens (precondition)", () => {
    const off = dispatchComputeLayout(600, 400, makeSpec(), DATA, DEFAULT_CHART_THEME);
    const on = dispatchComputeLayout(600, 400, withTable(), DATA, DEFAULT_CHART_THEME);
    expect(on.margin.bottom).toBeGreaterThan(off.margin.bottom);
    expect(on.plotArea.height).toBeLessThan(off.plotArea.height);
  });

  it("the table's rect sits under the shortened plot, and the x-label band is gone", () => {
    const off = dispatchComputeLayout(600, 400, makeSpec(), DATA, DEFAULT_CHART_THEME);
    const on = dispatchComputeLayout(600, 400, withTable(), DATA, DEFAULT_CHART_THEME);
    // No tick-label band: the table's header row IS the category labelling, so
    // a band there would be a hit-testable box over an object nobody paints.
    expect(off.elements!.xAxisBand).toBeDefined();
    expect(on.elements!.xAxisBand).toBeUndefined();
    // And the table's own rect follows the plot rather than the old bottom.
    expect(on.elements!.dataTable!.y).toBe(on.plotArea.y + on.plotArea.height + 4);
    expect(on.elements!.dataTable!.y).toBeLessThan(off.plotArea.y + off.plotArea.height);
  });

  it("every rect matches the FINAL margins", () => {
    const spec = withTable();
    const layout = dispatchComputeLayout(600, 400, spec, DATA, DEFAULT_CHART_THEME);
    expect(layout.elements).toEqual(expectedRects(layout, spec));
  });

  it("the reflow cleared `measured`, so paint is free to write truth back", () => {
    const layout = dispatchComputeLayout(600, 400, withTable(), DATA, DEFAULT_CHART_THEME);
    expect(layout.elements!.measured).toEqual([]);
  });

  it("the title rect still contains the painted title pixel after the mutation", () => {
    const spec = withTable();
    const layout = dispatchComputeLayout(600, 400, spec, DATA, DEFAULT_CHART_THEME);
    const { ctx, calls } = makeRecordingCtx();
    paintComboChart(ctx, DATA, spec, layout, DEFAULT_CHART_THEME);
    const anchor = titleAnchor(calls, "Revenue vs Trend");
    expect(anchor).not.toBeNull();
    expect(rectContains(layout.elements!.title!, anchor!.x, anchor!.y)).toBe(true);
  });

  it("a radial mark keeps its family and does not sprout axis bands", () => {
    const pie = makeSpec({
      mark: "pie",
      dataTable: { enabled: true },
    });
    const layout = dispatchComputeLayout(600, 400, pie, DATA, DEFAULT_CHART_THEME);
    expect(layout.elements!.family).toBe("radial");
    expect(layout.elements!.xAxisBand).toBeUndefined();
  });
});

// ============================================================================
// Site (c): chartRenderer's pivot field buttons
// ============================================================================

describe("pivot field buttons reflow the element rects", () => {
  const FIELDS: PivotChartFieldInfo[] = [
    { area: "filter", fieldIndex: 0, name: "Region", isFiltered: false },
    { area: "row", fieldIndex: 1, name: "Quarter", isFiltered: false },
  ];

  function adjusted(spec: ChartSpec) {
    const layout = computeCartesianLayout(600, 400, spec, DATA, DEFAULT_CHART_THEME);
    const before = { top: layout.margin.top, bottom: layout.margin.bottom, y: layout.plotArea.y, h: layout.plotArea.height };
    adjustLayoutForPivotButtons(layout, FIELDS, spec, DATA, DEFAULT_CHART_THEME);
    return { layout, before };
  }

  it("the mutation really happens (precondition)", () => {
    const { layout, before } = adjusted(makeSpec());
    expect(layout.margin.top).toBeGreaterThan(before.top);
    expect(layout.margin.bottom).toBeGreaterThan(before.bottom);
    expect(layout.plotArea.y).toBeGreaterThan(before.y);
    expect(layout.plotArea.height).toBeLessThan(before.h);
  });

  it("every rect matches the FINAL margins", () => {
    const spec = makeSpec();
    const { layout } = adjusted(spec);
    expect(layout.elements).toEqual(expectedRects(layout, spec));
  });

  it("the y-label band moved DOWN with the plot", () => {
    const spec = makeSpec();
    const plain = computeCartesianLayout(600, 400, spec, DATA, DEFAULT_CHART_THEME);
    const { layout } = adjusted(spec);
    expect(layout.elements!.yAxisBand!.y).toBe(layout.plotArea.y);
    expect(layout.elements!.yAxisBand!.y).toBeGreaterThan(plain.elements!.yAxisBand!.y);
  });

  it("the title rect still contains the painted title pixel after the mutation", () => {
    const spec = makeSpec();
    const { layout } = adjusted(spec);
    const { ctx, calls } = makeRecordingCtx();
    paintComboChart(ctx, DATA, spec, layout, DEFAULT_CHART_THEME);
    const anchor = titleAnchor(calls, "Revenue vs Trend");
    expect(anchor).not.toBeNull();
    expect(rectContains(layout.elements!.title!, anchor!.x, anchor!.y)).toBe(true);
  });

  it("no pivot area matched means no margin change and no rect change", () => {
    const spec = makeSpec();
    const layout = computeCartesianLayout(600, 400, spec, DATA, DEFAULT_CHART_THEME);
    const snapshot = JSON.parse(JSON.stringify(layout.elements));
    adjustLayoutForPivotButtons(layout, [], spec, DATA, DEFAULT_CHART_THEME);
    expect(layout.elements).toEqual(snapshot);
  });
});
