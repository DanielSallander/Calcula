//! FILENAME: app/extensions/Charts/rendering/__tests__/dataTableLayout.test.ts
// PURPOSE: The bottom band below a cartesian plot, when a data table is shown.
// CONTEXT: The owner's screenshot (OB-2): the category tick labels
//          "2023 2024 2025 2026" painted large ON TOP OF the data table's own
//          header row, which carries the same four strings small — and the
//          x-axis title painted through the table's series row. The band was
//          computed in two places: computeCartesianLayout reserved a
//          tick-label band and an axis-title band, and dispatchComputeLayout
//          then folded the table's height into margin.bottom afterwards.
//          Nothing re-apportioned, so the labels and the title kept their old
//          offsets and the table was drawn into the same pixels.
//
//          These tests read the ORDERED ctx call stream rather than eyeballing
//          a canvas: "no tick label is painted in the table's band" is a claim
//          about what fillText was called with, and only the stream can settle
//          it. They cover bar, horizontalBar, line and combo, and they pin the
//          table-OFF layout to explicit numbers so this refactor is provably
//          not a plot move.

import { describe, it, expect } from "vitest";
import {
  dispatchComputeLayout,
  dispatchPaint,
  dispatchComputeGeometry,
} from "../chartDispatch";
import {
  computeCartesianLayout,
  rectContains,
  chartShowsDataTable,
  dataTableReplacesXTickLabels,
  specForMarkPaint,
  dataTableBandHeight,
} from "../chartPainterUtils";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { makeRecordingCtx } from "./dispatch-recordingCtx";
import type { ChartSpec, ChartMark, ParsedChartData, HitGeometry } from "../../types";

// ============================================================================
// Fixtures
// ============================================================================

/** The owner's four categories, from the screenshot. */
const CATEGORIES = ["2023", "2024", "2025", "2026"];

const DATA: ParsedChartData = {
  categories: CATEGORIES,
  series: [
    { name: "Revenue", color: null, values: [100, 150, 130, 180] },
    { name: "Trend", color: null, values: [110, 125, 140, 160] },
  ],
};

const THEME = DEFAULT_CHART_THEME;

/** The x-axis title from the screenshot. */
const X_TITLE = "Testar 90is";

function makeSpec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Trend", sourceIndex: 2, color: null },
    ],
    title: "Sales",
    xAxis: { title: X_TITLE, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: "Units", gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...over,
  };
}

const withTable = (over: Partial<ChartSpec> = {}): ChartSpec =>
  makeSpec({ dataTable: { enabled: true }, ...over });

// ============================================================================
// Stream reading
// ============================================================================

interface TextDraw {
  text: string;
  x: number;
  y: number;
}

/**
 * Every `fillText` in the recorded stream, as {text, x, y}.
 *
 * The double formats a call as `fillText(<text>,<x>,<y>)`; the text itself may
 * contain commas, so the LAST two comma-separated fields are the coordinates
 * and everything before them is the string.
 */
function textDraws(calls: string[]): TextDraw[] {
  const out: TextDraw[] = [];
  for (const call of calls) {
    if (!call.startsWith("fillText(")) continue;
    const body = call.slice("fillText(".length, -1);
    const parts = body.split(",");
    const y = Number(parts.pop());
    const x = Number(parts.pop());
    out.push({ text: parts.join(","), x, y });
  }
  return out;
}

/** Paint a chart through the real dispatch and return its layout + stream. */
function paint(spec: ChartSpec, data: ParsedChartData = DATA, width = 600, height = 400) {
  const layout = dispatchComputeLayout(width, height, spec, data, THEME);
  const { ctx, calls } = makeRecordingCtx(width, height);
  dispatchPaint(ctx, data, spec, layout, THEME);
  return { layout, calls, draws: textDraws(calls) };
}

/** The x centre of every category band, read from the chart's own hit geometry. */
function categoryCentersFromGeometry(geom: HitGeometry, n: number): number[] {
  const sums = new Array<number>(n).fill(0);
  const counts = new Array<number>(n).fill(0);
  const walk = (g: HitGeometry): void => {
    if (g.type === "bars") {
      for (const r of g.rects) {
        sums[r.categoryIndex] += r.x + r.width / 2;
        counts[r.categoryIndex] += 1;
      }
    } else if (g.type === "points") {
      for (const m of g.markers) {
        sums[m.categoryIndex] += m.cx;
        counts[m.categoryIndex] += 1;
      }
    } else if (g.type === "composite") {
      g.groups.forEach(walk);
    }
  };
  walk(geom);
  return sums.map((s, i) => (counts[i] === 0 ? NaN : s / counts[i]));
}

// ============================================================================
// The predicates
// ============================================================================

describe("the one data-table predicate", () => {
  it("needs the flag AND something to draw", () => {
    expect(chartShowsDataTable(makeSpec(), DATA)).toBe(false);
    expect(chartShowsDataTable(withTable(), DATA)).toBe(true);
    // paintDataTable refuses both of these, so the layout must refuse them too
    // — otherwise the plot shrinks for a table nobody paints.
    expect(chartShowsDataTable(withTable(), { categories: [], series: [] })).toBe(false);
    expect(chartShowsDataTable(withTable(), { categories: CATEGORIES, series: [] })).toBe(false);
  });

  it("replaces the x tick labels only where the categories are on X", () => {
    for (const mark of ["bar", "line", "area", "combo", "waterfall", "pareto"] as ChartMark[]) {
      expect(dataTableReplacesXTickLabels(withTable({ mark }), DATA), mark).toBe(true);
    }
    // A horizontal bar chart's categories are on Y and its x labels are VALUES,
    // which the table's header row does not repeat. Scatter and bubble the same.
    for (const mark of ["horizontalBar", "scatter", "bubble"] as ChartMark[]) {
      expect(dataTableReplacesXTickLabels(withTable({ mark }), DATA), mark).toBe(false);
    }
  });

  it("specForMarkPaint hands the painters the SAME object when there is no table", () => {
    const spec = makeSpec();
    expect(specForMarkPaint(spec, DATA)).toBe(spec);
  });

  it("specForMarkPaint takes the labels and the title away, and nothing else", () => {
    const spec = withTable();
    const painted = specForMarkPaint(spec, DATA);
    expect(painted.xAxis.showLabels).toBe(false);
    expect(painted.xAxis.title).toBeNull();
    expect({ ...painted, xAxis: null }).toEqual({ ...spec, xAxis: null });
    // The ORIGINAL is untouched: the table painter still needs the real title.
    expect(spec.xAxis.showLabels).toBe(true);
    expect(spec.xAxis.title).toBe(X_TITLE);
  });

  it("keeps a horizontal bar chart's VALUE labels while still reserving the band", () => {
    const spec = withTable({ mark: "horizontalBar" });
    const painted = specForMarkPaint(spec, DATA);
    expect(painted.xAxis.showLabels).toBe(true);
    expect(painted.xAxis.title).toBeNull();
    expect(dataTableBandHeight(spec, DATA)).toBe(58);
  });
});

// ============================================================================
// The table-OFF layout must not have moved
// ============================================================================

describe("with the data table disabled the layout is what it always was", () => {
  // bottom = 12 base
  //        + 18 x tick labels (labelFontSize 10 + 8)
  //        + 17 x axis title  (axisTitleFontSize 11 + 6)
  //        + 26 bottom legend (legendFontSize 10 + 16)
  const BOTTOM_OFF = 12 + 18 + 17 + 26;

  it("pins margin.bottom and the plot height", () => {
    const layout = dispatchComputeLayout(600, 400, makeSpec(), DATA, THEME);
    expect(layout.margin.bottom).toBe(BOTTOM_OFF);
    expect(layout.plotArea.y).toBe(34); // 12 + titleFontSize 14 + 8
    expect(layout.plotArea.height).toBe(400 - 34 - BOTTOM_OFF);
  });

  it("dispatchComputeLayout no longer touches what the mark computed", () => {
    const spec = makeSpec();
    expect(dispatchComputeLayout(600, 400, spec, DATA, THEME))
      .toEqual(computeCartesianLayout(600, 400, spec, DATA, THEME));
  });

  it("an explicit `enabled: false` paints the same stream as no dataTable at all", () => {
    const a = paint(makeSpec());
    const b = paint(makeSpec({ dataTable: { enabled: false } }));
    expect(b.layout).toEqual(a.layout);
    expect(b.calls).toEqual(a.calls);
  });

  it("the x tick labels ARE painted, once each, when there is no table", () => {
    const { draws, layout } = paint(makeSpec());
    for (const c of CATEGORIES) {
      const hits = draws.filter((d) => d.text === c);
      expect(hits, c).toHaveLength(1);
      // Just under the plot, in the band the layout reserved for them.
      expect(hits[0].y).toBeGreaterThanOrEqual(layout.plotArea.y + layout.plotArea.height);
      expect(hits[0].y).toBeLessThan(layout.plotArea.y + layout.plotArea.height + 18);
    }
  });
});

// ============================================================================
// The defect: the same four labels, twice, on top of each other
// ============================================================================

describe.each([
  ["bar", "bar" as ChartMark],
  ["line", "line" as ChartMark],
  ["combo", "combo" as ChartMark],
])("%s chart with a data table", (_name, mark) => {
  it("paints each category EXACTLY once, and that once is inside the table", () => {
    const spec = withTable({ mark });
    const { draws, layout } = paint(spec);
    const table = layout.elements!.dataTable!;
    expect(table).toBeDefined();

    for (const c of CATEGORIES) {
      const hits = draws.filter((d) => d.text === c);
      // Two hits is the defect in the screenshot: the axis label and the
      // table's header cell, the same string twice in overlapping pixels.
      expect(hits, `${c} painted ${hits.length} times`).toHaveLength(1);
      // And the one that survives is the table's header row.
      expect(hits[0].y).toBeGreaterThanOrEqual(table.y);
      expect(hits[0].y).toBeLessThanOrEqual(table.y + 18);
    }
  });

  it("paints NO text at all between the plot's bottom edge and the table", () => {
    const spec = withTable({ mark });
    const { draws, layout } = paint(spec);
    const plotBottom = layout.plotArea.y + layout.plotArea.height;
    const table = layout.elements!.dataTable!;
    // The strip the tick labels used to occupy. Y-axis tick labels are inside
    // the plot's vertical span, so they cannot be caught by this.
    const inGap = draws.filter((d) => d.y > plotBottom && d.y < table.y);
    expect(inGap, `text in the dead strip: ${JSON.stringify(inGap)}`).toEqual([]);
  });

  it("paints no text INSIDE the table's rows except the table's own cells", () => {
    const spec = withTable({ mark });
    const { draws, layout } = paint(spec);
    const table = layout.elements!.dataTable!;
    const inside = draws.filter(
      (d) => d.y >= table.y && d.y <= table.y + table.height,
    );
    // 4 header cells + 2 series x 4 values = 12, and nothing else. The axis
    // title used to land here too (the screenshot shows it between the header
    // row and the values row).
    expect(inside).toHaveLength(12);
    expect(inside.every((d) => d.text !== X_TITLE)).toBe(true);
  });

  it("drops the title BELOW the table and records the box it painted in", () => {
    const spec = withTable({ mark });
    const { draws, layout } = paint(spec);
    const table = layout.elements!.dataTable!;
    const hits = draws.filter((d) => d.text === X_TITLE);
    expect(hits).toHaveLength(1);
    const [title] = hits;

    expect(title.y).toBeGreaterThan(table.y + table.height);
    // ...and it is still on the canvas.
    expect(title.y).toBeLessThanOrEqual(400);

    // The rect must contain the pixel the title was painted at, or a click on
    // the title selects nothing. This is the MEASURED rect: the painter wrote
    // it back after drawing, from a width measured under the title font.
    const rect = layout.elements!.xAxisTitle!;
    expect(rect).toBeDefined();
    expect(rectContains(rect, title.x, title.y)).toBe(true);
    expect(layout.elements!.measured).toContain("xAxisTitle");
  });

  it("offers no x tick-label band to hit-test, because none is painted", () => {
    const { layout } = paint(withTable({ mark }));
    expect(layout.elements!.xAxisBand).toBeUndefined();
  });

  it("the table's columns are centred on the category bands", () => {
    const spec = withTable({ mark });
    const { draws, layout } = paint(spec);
    const geom = dispatchComputeGeometry(DATA, spec, layout, THEME);
    const centers = categoryCentersFromGeometry(geom, CATEGORIES.length);
    for (let i = 0; i < CATEGORIES.length; i++) {
      const cell = draws.find((d) => d.text === CATEGORIES[i])!;
      expect(cell, CATEGORIES[i]).toBeDefined();
      expect(centers[i]).not.toBeNaN();
      // Header cell centre vs the centre of the bars/points it labels.
      expect(Math.abs(cell.x - centers[i]), `${CATEGORIES[i]}: ${cell.x} vs ${centers[i]}`)
        .toBeLessThan(0.51);
    }
  });
});

// ============================================================================
// Horizontal bar: the categories are on Y
// ============================================================================

describe("horizontal bar chart with a data table", () => {
  // DECISION: Excel still draws the table at the bottom with one column per
  // category, so we do too — the table is a SUMMARY of the plotted numbers,
  // not a second copy of whichever axis happens to be horizontal. What changes
  // is that the x tick labels here are VALUES: the table's header row does not
  // repeat them, so they stay. Only the x-axis TITLE moves below the table,
  // because the table now occupies the space it used to sit in.
  const spec = () => withTable({ mark: "horizontalBar" });

  it("keeps the value tick labels and puts the table BELOW their band", () => {
    const { draws, layout } = paint(spec());
    const table = layout.elements!.dataTable!;
    const plotBottom = layout.plotArea.y + layout.plotArea.height;
    // 18px of tick-label band (labelFontSize 10 + 8) THEN the 4px gap. This is
    // the second half of OB-2: drawHorizontalAxes paints its value labels at
    // plotBottom + 4, which is exactly where the table's header row would have
    // gone if the band were not reserved.
    expect(table.y).toBe(plotBottom + 18 + 4);
    const valueLabels = draws.filter((d) => d.y > plotBottom && d.y < table.y);
    expect(valueLabels.length).toBeGreaterThan(0);
    expect(valueLabels.every((d) => !CATEGORIES.includes(d.text))).toBe(true);
  });

  it("still has its x tick-label band, because the labels are still painted", () => {
    const { layout } = paint(spec());
    expect(layout.elements!.xAxisBand).toBeDefined();
  });

  it("each category is drawn once on the Y axis and once in the table header", () => {
    const { draws, layout } = paint(spec());
    const table = layout.elements!.dataTable!;
    for (const c of CATEGORIES) {
      const hits = draws.filter((d) => d.text === c);
      expect(hits, c).toHaveLength(2);
      // One beside the plot (the category axis), one in the header row. They
      // are nowhere near each other, which is the whole difference from OB-2.
      const inHeader = hits.filter((h) => h.y >= table.y && h.y <= table.y + 18);
      expect(inHeader, c).toHaveLength(1);
    }
  });

  it("drops the title below the table here too", () => {
    const { draws, layout } = paint(spec());
    const table = layout.elements!.dataTable!;
    const [title] = draws.filter((d) => d.text === X_TITLE);
    expect(title).toBeDefined();
    expect(title.y).toBeGreaterThan(table.y + table.height);
    expect(rectContains(layout.elements!.xAxisTitle!, title.x, title.y)).toBe(true);
  });
});

// ============================================================================
// The band arithmetic
// ============================================================================

describe("the bottom band with a data table", () => {
  // bottom = 12 base
  //        +  0 x tick labels (the table replaces them)
  //        + 58 the table     (3 rows x 18 + 4 gap)
  //        + 17 x axis title
  //        + 26 bottom legend
  const BOTTOM_ON = 12 + 0 + 58 + 17 + 26;

  it("pins the band and leaves room below the table for the title", () => {
    const layout = dispatchComputeLayout(600, 400, withTable(), DATA, THEME);
    expect(layout.margin.bottom).toBe(BOTTOM_ON);
    const plotBottom = layout.plotArea.y + layout.plotArea.height;
    const table = layout.elements!.dataTable!;
    expect(table.y).toBe(plotBottom + 4);
    expect(table.height).toBe(54);
    expect(table.x).toBe(layout.plotArea.x);
    expect(table.width).toBe(layout.plotArea.width);
    // The title's glyph box starts 4px below the table's bottom edge and is one
    // axis-title font tall; the reserved band must still cover it. That 4 + the
    // font size used to be a flat 16, which put a 20px title 4px INSIDE the
    // table's last row — the same fixed-literal-versus-theme-font defect the
    // tick-label band had.
    const estimate = layout.elements!.xAxisTitle!;
    expect(estimate.y).toBe(table.y + table.height + 4);
    expect(estimate.y + estimate.height).toBe(
      table.y + table.height + 4 + THEME.axisTitleFontSize,
    );
    expect(estimate.y + estimate.height).toBeLessThanOrEqual(400 - 26);
  });

  it("grows by exactly one row per extra series", () => {
    const three: ParsedChartData = {
      categories: CATEGORIES,
      series: [...DATA.series, { name: "Plan", color: null, values: [90, 95, 100, 105] }],
    };
    const two = dispatchComputeLayout(600, 400, withTable(), DATA, THEME);
    const withThree = dispatchComputeLayout(600, 400, withTable(), three, THEME);
    expect(withThree.margin.bottom - two.margin.bottom).toBe(18);
  });

  it("survives the pivot field buttons' relayout", async () => {
    // adjustLayoutForPivotButtons mutates margin/plotArea AGAIN and reflows.
    // If the table's rect were not derived from the plot area like every other
    // element, it would be left behind by exactly FIELD_BTN_MARGIN.
    const { adjustLayoutForPivotButtons } = await import("../chartRenderer");
    const spec = withTable();
    const layout = dispatchComputeLayout(600, 400, spec, DATA, THEME);
    adjustLayoutForPivotButtons(
      layout,
      [{ area: "row", fieldIndex: 0, name: "Year", isFiltered: false }],
      spec,
      DATA,
      THEME,
    );
    const table = layout.elements!.dataTable!;
    expect(table.y).toBe(layout.plotArea.y + layout.plotArea.height + 4);
    expect(layout.elements!.xAxisBand).toBeUndefined();
  });

  it("a radial mark reserves the band too and records the table's rect", () => {
    const layout = dispatchComputeLayout(600, 400, withTable({ mark: "pie" }), DATA, THEME);
    expect(layout.elements!.family).toBe("radial");
    expect(layout.elements!.xAxisBand).toBeUndefined();
    expect(layout.elements!.dataTable!.y)
      .toBe(layout.plotArea.y + layout.plotArea.height + 4);
  });

  it("a radial mark never grows an x-axis title under its table", () => {
    // A pie has no x axis: pieChartPainter never reads spec.xAxis at all, and
    // computeRadialLayout reserves no band for a title and estimates no rect
    // for one. But `xAxis.title` SURVIVES a mark change — switch a bar chart
    // with an axis title to a pie and the string is still in the spec — so a
    // table stage that painted it from the spec alone would put a stray
    // caption below the table, in a band nobody reserved, over the bottom
    // legend or off the canvas entirely. The title is a cartesian element and
    // is drawn only where one exists.
    for (const mark of ["pie", "donut", "radar", "funnel", "treemap", "sunburst"] as const) {
      const r = paint(withTable({ mark: mark as ChartMark }));
      expect(r.draws.filter((d) => d.text === X_TITLE), mark).toHaveLength(0);
      expect(r.layout.elements!.xAxisTitle, mark).toBeUndefined();
      expect(r.layout.elements!.measured.includes("xAxisTitle"), mark).toBe(false);
    }
    // Positive control on the same fixture: the cartesian mark DOES draw it,
    // so a green result above cannot come from the title never being set.
    const bar = paint(withTable());
    expect(bar.draws.filter((d) => d.text === X_TITLE)).toHaveLength(1);
  });

  it("a faceted chart draws no table at all, and a concat CHILD draws its own", () => {
    // Documented, not aspirational: `panelSubSpec` strips `dataTable` from
    // every facet/repeat panel, and dispatchPaint returns as soon as the panels
    // are tiled — so a faceted chart shows no table anywhere, and there is no
    // band for a tick label to collide with. A concat child is a COMPLETE
    // chart painted through dispatchPaint again, so its own table (and its own
    // suppression) work exactly as an un-composed chart's do.
    const faceted = withTable({ facet: { field: "Region" } });
    const facetData: ParsedChartData = {
      ...DATA,
      facets: [
        { value: "North", data: DATA },
        { value: "South", data: DATA },
      ],
    };
    const f = paint(faceted, facetData);
    // Every category is painted twice — once per panel's axis — and never as a
    // table header, because no panel has a table.
    for (const c of CATEGORIES) {
      expect(f.draws.filter((d) => d.text === c), c).toHaveLength(2);
    }

    const concatData: ParsedChartData = {
      ...DATA,
      concat: [{ spec: withTable(), data: DATA }],
    };
    const k = paint(makeSpec({ concat: { columns: 1 } }), concatData);
    for (const c of CATEGORIES) {
      expect(k.draws.filter((d) => d.text === c), c).toHaveLength(1);
    }
  });

  it("reserves nothing when there is nothing to draw", () => {
    const empty: ParsedChartData = { categories: CATEGORIES, series: [] };
    const off = dispatchComputeLayout(600, 400, makeSpec(), empty, THEME);
    const on = dispatchComputeLayout(600, 400, withTable(), empty, THEME);
    expect(on.margin.bottom).toBe(off.margin.bottom);
    expect(on.elements!.dataTable).toBeUndefined();
    // ...and the tick labels survive, because no header row replaces them.
    expect(on.elements!.xAxisBand).toBeDefined();
  });
});
