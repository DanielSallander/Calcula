//! FILENAME: app/extensions/Charts/rendering/__tests__/dataTableDerivedViews.test.ts
// PURPOSE: A data table under a mark that plots a DERIVED view of its data must
//          transcribe that view, not the raw rows.
// CONTEXT: Two marks do not plot what they were given:
//
//          HISTOGRAM. Its datums are BINS. `computeHistogramLayout` already laid
//          out against `histogramResolveView` — one "Frequency" series — so the
//          band reserved for the table was (1 + 1) * 18 + 4 = 40px, while
//          `dispatchPaint` handed `paintDataTable` the RAW data and the grid was
//          sized (N + 1) * 18. Three source series made a 72px grid inside a
//          40px band: it painted over the x-axis title, whose own baseline is
//          measured from the REAL table's bottom edge and therefore off the
//          canvas. The header row printed the source-row labels, which name
//          nothing on a histogram, while `specForMarkPaint` had already taken
//          the bin labels away from the painter — so after the data-table work
//          landed, a histogram with a table had NO correct x labelling at all.
//
//          PARETO. It sorts its categories DESCENDING. The table's header row
//          replaced the tick labels that carried that order and printed
//          `data.categories` in SOURCE order, so the tallest bar was labelled
//          with the first source category. Before the data-table work both were
//          drawn and the correct one was at least visible; the fix removed the
//          correct one and kept the wrong one.

import { describe, it, expect } from "vitest";
import { dispatchComputeLayout, dispatchPaint } from "../chartDispatch";
import { chartDataTableView } from "../../lib/dataTableView";
import { histogramResolveView } from "../histogramChartPainter";
import { paretoResolveView } from "../paretoChartPainter";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { makeRecordingCtx } from "./dispatch-recordingCtx";
import type { ChartSpec, ParsedChartData } from "../../types";

const W = 600;
const H = 400;
const THEME = DEFAULT_CHART_THEME;

function makeSpec(mark: string, over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 12, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "S1", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: "Source", gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    dataTable: { enabled: true },
    ...over,
  } as ChartSpec;
}

/** Everything `fillText` was asked to draw, in order. */
function paintedText(spec: ChartSpec, data: ParsedChartData): string[] {
  const { ctx, calls } = makeRecordingCtx(W, H);
  const layout = dispatchComputeLayout(W, H, spec, data, THEME);
  dispatchPaint(ctx, data, spec, layout, THEME);
  return calls
    .filter((c) => c.startsWith("fillText("))
    .map((c) => c.slice("fillText(".length).split(",")[0].replace(/^"|"$/g, ""));
}

// ============================================================================
// Histogram
// ============================================================================

/** Three series over twelve rows — the shape that overran the band by 32px. */
const RAW_3x12: ParsedChartData = {
  categories: Array.from({ length: 12 }, (_v, i) => `Row${i + 1}`),
  series: [
    { name: "A", color: null, values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    { name: "B", color: null, values: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
    { name: "C", color: null, values: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] },
  ],
};

describe("histogram + data table", () => {
  const spec = makeSpec("histogram", { markOptions: { binCount: 5 } } as Partial<ChartSpec>);

  it("the table view IS the binned view, not the raw rows", () => {
    const view = chartDataTableView(spec, RAW_3x12);
    expect(view).toEqual(histogramResolveView(RAW_3x12, spec));
    expect(view.series.map((s) => s.name)).toEqual(["Frequency"]);
  });

  it("the grid fits the band the layout reserved for it", () => {
    const layout = dispatchComputeLayout(W, H, spec, RAW_3x12, THEME);
    const table = layout.elements!.dataTable!;
    const plotBottom = layout.plotArea.y + layout.plotArea.height;

    // One header row + ONE series row, not one per source series.
    expect(table.height).toBe(2 * 18);
    // The whole of it is inside the margin the layout gave up for it.
    expect(table.y).toBeGreaterThanOrEqual(plotBottom);
    expect(table.y + table.height).toBeLessThanOrEqual(H);
  });

  it("NEGATIVE CONTROL: the raw rows would NOT have fitted", () => {
    // The defect in one line: (3 + 1) * 18 = 72 against a 40px band.
    const layout = dispatchComputeLayout(W, H, spec, RAW_3x12, THEME);
    const table = layout.elements!.dataTable!;
    const rawHeight = (RAW_3x12.series.length + 1) * 18;
    expect(rawHeight).toBeGreaterThan(table.height);
    expect(table.y + rawHeight).toBeGreaterThan(layout.elements!.xAxisTitle!.y);
  });

  it("the header row labels the BINS, and no source row label is painted", () => {
    const text = paintedText(spec, RAW_3x12);
    const bins = histogramResolveView(RAW_3x12, spec).categories;
    for (const bin of bins) {
      expect(text, `bin label "${bin}" is nowhere on the chart`).toContain(bin);
    }
    for (const row of RAW_3x12.categories) {
      expect(text, `source row "${row}" labels nothing on a histogram`).not.toContain(row);
    }
  });

  it("each bin label is painted ONCE — the table replaces the axis, it does not double it", () => {
    const text = paintedText(spec, RAW_3x12);
    const bins = histogramResolveView(RAW_3x12, spec).categories;
    for (const bin of bins) {
      expect(text.filter((t) => t === bin).length, `bin "${bin}"`).toBe(1);
    }
  });
});

// ============================================================================
// Pareto
// ============================================================================

/** A=10, B=90, C=50 — the sorted order (B, C, A) is nothing like the source. */
const PARETO_DATA: ParsedChartData = {
  categories: ["A", "B", "C"],
  series: [{ name: "Count", color: null, values: [10, 90, 50] }],
};

describe("pareto + data table", () => {
  const spec = makeSpec("pareto");

  it("the table view is the SORTED view", () => {
    const view = chartDataTableView(spec, PARETO_DATA);
    expect(view).toEqual(paretoResolveView(PARETO_DATA));
    expect(view.categories).toEqual(["B", "C", "A"]);
    expect(view.series[0].values).toEqual([90, 50, 10]);
  });

  it("the header row is painted in the order the BARS are drawn", () => {
    const { ctx, calls } = makeRecordingCtx(W, H);
    const layout = dispatchComputeLayout(W, H, spec, PARETO_DATA, THEME);
    dispatchPaint(ctx, PARETO_DATA, spec, layout, THEME);

    const table = layout.elements!.dataTable!;
    // fillText(text, x, y) — take the header row's cells by their y.
    const header: Array<{ text: string; x: number }> = [];
    for (const call of calls) {
      if (!call.startsWith("fillText(")) continue;
      const parts = call.slice("fillText(".length, -1).split(",").map((p) => p.trim());
      const text = parts[0].replace(/^"|"$/g, "");
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      if (y > table.y && y < table.y + 18) header.push({ text, x });
    }
    header.sort((a, b) => a.x - b.x);
    expect(header.map((h) => h.text)).toEqual(["B", "C", "A"]);
  });

  it("NEGATIVE CONTROL: the SOURCE order would put 'A' under the tallest bar", () => {
    // The defect said in the test: source order is not the painted order, so
    // transcribing it labels every column wrong.
    expect(PARETO_DATA.categories).not.toEqual(paretoResolveView(PARETO_DATA).categories);
    expect(PARETO_DATA.categories[0]).toBe("A");
    expect(paretoResolveView(PARETO_DATA).categories[0]).toBe("B");
  });

  it("the band reserved matches the single-series view", () => {
    const three: ParsedChartData = {
      categories: ["A", "B", "C"],
      series: [
        { name: "Count", color: null, values: [10, 90, 50] },
        { name: "Ignored", color: null, values: [1, 2, 3] },
        { name: "Also ignored", color: null, values: [4, 5, 6] },
      ],
    };
    const layout = dispatchComputeLayout(W, H, spec, three, THEME);
    // A Pareto plots series 0 only, so its table has one series row.
    expect(layout.elements!.dataTable!.height).toBe(2 * 18);
  });
});

// ============================================================================
// Everything else is untouched
// ============================================================================

describe("the other sixteen marks get their data back unchanged", () => {
  const BAR_DATA: ParsedChartData = {
    categories: ["Q1", "Q2"],
    series: [{ name: "Revenue", color: null, values: [3, 4] }],
  };

  for (const mark of ["bar", "line", "area", "pie", "combo", "horizontalBar"]) {
    it(`${mark}: chartDataTableView is identity`, () => {
      expect(chartDataTableView(makeSpec(mark), BAR_DATA)).toBe(BAR_DATA);
    });
  }
});
