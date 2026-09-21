//! FILENAME: app/extensions/Charts/rendering/__tests__/furnitureElements.test.ts
// PURPOSE: The four painters that drew furniture nobody could select —
//          trendlines, error bars, data labels and the data table — now RECORD
//          what they drew, and the hit-tester answers Excel's element for it.
//          This file paints for real and then clicks the result.
//
// WHY IT PAINTS RATHER THAN HAND-BUILDING A LAYOUT: a hand-built
// `layout.elements` proves only that `rectContains` works. The defect being
// closed is that the painter never wrote anything down, so the test has to run
// the painter and read what the PAINTER left behind. Every rect asserted here
// came out of a paint call, not out of this file.
//
// THE THREE EXCEL ASYMMETRIES ARE THE POINT, not incidental:
//   - an error-bar hit answers a SERIES and NO point index (Excel has no
//     per-point error bar; answering one would name an object the format pane
//     cannot target),
//   - a data-label hit answers BOTH indices (it is per point),
//   - a trendline is hit by DISTANCE TO THE STROKE, never by its bounding box.
// The bounding-box case has its own test because it is the one that would look
// perfectly fine in a screenshot and make the plot area unclickable.

import { describe, it, expect } from "vitest";
import { paintTrendlines } from "../trendlinePainter";
import { paintErrorBars } from "../errorBarPainter";
import { paintDataLabels } from "../dataLabelPainter";
import { paintDataTable } from "../dataTablePainter";
import { drawLegend } from "../chartPainterUtils";
import { hitTestChartElements, hitTestGeometry } from "../chartHitTesting";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { makeRecordingCtx } from "./dispatch-recordingCtx";
import type {
  ChartLayout,
  ChartSpec,
  HitGeometry,
  ParsedChartData,
  BarRect,
} from "../../types";

// ============================================================================
// Fixtures
// ============================================================================

function layout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 40, right: 110, bottom: 60, left: 70 },
    plotArea: { x: 70, y: 40, width: 420, height: 260 },
  };
}

function data(): ParsedChartData {
  return {
    categories: ["Jan", "Feb", "Mar", "Apr"],
    series: [
      { name: "Sales", values: [10, 20, 30, 40], color: null },
      { name: "Costs", values: [5, 15, 25, 35], color: null },
    ],
  };
}

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Sales", sourceIndex: 1, color: null },
      { name: "Costs", sourceIndex: 2, color: null },
    ],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "right" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

/** Two bars of series 0 and one of series 1, at known pixels. */
function barGeometry(): HitGeometry {
  const bars: BarRect[] = [
    { seriesIndex: 0, categoryIndex: 0, x: 100, y: 200, width: 30, height: 100, value: 10, seriesName: "Sales", categoryName: "Jan" },
    { seriesIndex: 0, categoryIndex: 1, x: 200, y: 140, width: 30, height: 160, value: 20, seriesName: "Sales", categoryName: "Feb" },
    { seriesIndex: 1, categoryIndex: 0, x: 300, y: 240, width: 30, height: 60, value: 5, seriesName: "Costs", categoryName: "Jan" },
  ];
  return { type: "bars", rects: bars };
}

const THEME = DEFAULT_CHART_THEME;

// ============================================================================
// Trendlines
// ============================================================================

describe("trendline furniture", () => {
  it("records ONE polyline per drawn trendline, with the series and trendline index", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    const s = spec({
      trendlines: [
        { type: "linear", seriesIndex: 0 },
        { type: "movingAverage", seriesIndex: 1, movingAveragePeriod: 2 },
      ],
    });

    paintTrendlines(ctx, data(), s, lay, THEME);

    const recorded = lay.elements?.trendlines ?? [];
    expect(recorded).toHaveLength(2);
    expect(recorded[0].seriesIndex).toBe(0);
    expect(recorded[0].trendlineIndex).toBe(0);
    expect(recorded[1].seriesIndex).toBe(1);
    expect(recorded[1].trendlineIndex).toBe(1);
    // A polyline, in pixels inside the canvas — not a rect, and not data space.
    expect(recorded[0].points.length).toBeGreaterThanOrEqual(2);
    for (const p of recorded[0].points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("records nothing for a trendline that could not be computed", () => {
    // One series, one point: `computeTrendline` refuses (fewer than two pairs)
    // and draws nothing. The recorded list must match the SCREEN, so an entry
    // here would be a clickable trendline that is not there.
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    const thin: ParsedChartData = {
      categories: ["Jan"],
      series: [{ name: "Sales", values: [10], color: null }],
    };
    paintTrendlines(ctx, thin, spec({ trendlines: [{ type: "linear", seriesIndex: 0 }] }), lay, THEME);
    expect(lay.elements?.trendlines).toEqual([]);
  });

  it("is hit on its STROKE and not across its bounding box", () => {
    // A hand-placed polyline so the geometry under test is unambiguous: a
    // diagonal across the plot. Its bounding box is the whole plot.
    const lay = layout();
    lay.elements = {
      family: "cartesian",
      chartArea: { x: 0, y: 0, width: 600, height: 400 },
      measured: [],
      trendlines: [
        { seriesIndex: 0, trendlineIndex: 0, points: [{ x: 80, y: 290 }, { x: 480, y: 50 }] },
      ],
    };

    // ON the line: the midpoint.
    const on = hitTestChartElements(280, 170, lay);
    expect(on.element).toBe("trendline");
    expect(on.seriesIndex).toBe(0);
    expect(on.trendlineIndex).toBe(0);
    // A trendline is per series: it has no point.
    expect(on.pointIndex).toBeUndefined();

    // INSIDE the same bounding box, far from the stroke: the plot area, which
    // would be unreachable if the box were the hit target.
    expect(hitTestChartElements(430, 270, lay).element).toBe("plotArea");
    expect(hitTestChartElements(110, 70, lay).element).toBe("plotArea");
  });
});

// ============================================================================
// Error bars — per series, never per point
// ============================================================================

describe("error-bar furniture", () => {
  const withBars = () => spec({
    markOptions: { errorBars: { enabled: true, type: "custom", value: 4, direction: "both" } },
  });

  it("records one rect per DRAWN bar and keeps each one's series", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    paintErrorBars(ctx, data(), withBars(), lay, THEME, barGeometry());

    const recorded = lay.elements?.errorBars ?? [];
    expect(recorded).toHaveLength(3); // one per bar in the geometry
    expect(recorded.map((e) => e.seriesIndex)).toEqual([0, 0, 1]);
    for (const e of recorded) {
      expect(e.rect.width).toBeGreaterThan(0);
      expect(e.rect.height).toBeGreaterThan(0);
    }
  });

  it("answers the SERIES with no point index — Excel has no per-point error bar", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    paintErrorBars(ctx, data(), withBars(), lay, THEME, barGeometry());

    const third = lay.elements!.errorBars![2];
    const hit = hitTestChartElements(
      third.rect.x + third.rect.width / 2,
      third.rect.y + third.rect.height / 2,
      lay,
    );
    expect(hit.element).toBe("errorBars");
    expect(hit.seriesIndex).toBe(1);
    // THE ASYMMETRY. An absent pointIndex is Excel's PointIndex = -1.
    expect(hit.pointIndex).toBeUndefined();
    expect(hit.categoryIndex).toBeUndefined();
  });

  it("records nothing when error bars are switched off", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    paintErrorBars(ctx, data(), spec(), lay, THEME, barGeometry());
    expect(lay.elements?.errorBars).toBeUndefined();
  });
});

// ============================================================================
// Data labels — per point, and every panel of a composed chart
// ============================================================================

describe("data-label furniture", () => {
  const labelled = () => spec({ dataLabels: { enabled: true, content: ["value"] } });

  it("records a box per label carrying BOTH indices", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    paintDataLabels(ctx, data(), labelled(), lay, THEME, barGeometry());

    const recorded = lay.elements?.dataLabels ?? [];
    expect(recorded).toHaveLength(3);
    expect(recorded.map((l) => [l.seriesIndex, l.pointIndex])).toEqual([[0, 0], [0, 1], [1, 0]]);
  });

  it("is hit per point, and names the point under the cursor", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    paintDataLabels(ctx, data(), labelled(), lay, THEME, barGeometry());

    const second = lay.elements!.dataLabels![1];
    const hit = hitTestChartElements(
      second.rect.x + second.rect.width / 2,
      second.rect.y + second.rect.height / 2,
      lay,
    );
    expect(hit.element).toBe("dataLabel");
    expect(hit.seriesIndex).toBe(0);
    expect(hit.pointIndex).toBe(1);
  });

  it("keeps the labels of EVERY group of a composed chart, not just the last", () => {
    // The recursion used to record per call. With a replace-semantics recorder
    // that would leave only the final group's labels on the layout, and the
    // first panel's labels would be silently unclickable.
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    const composite: HitGeometry = {
      type: "composite",
      groups: [
        { type: "bars", rects: [{ seriesIndex: 0, categoryIndex: 0, x: 90, y: 210, width: 20, height: 80, value: 10, seriesName: "Sales", categoryName: "Jan" }] },
        { type: "bars", rects: [{ seriesIndex: 1, categoryIndex: 3, x: 390, y: 150, width: 20, height: 140, value: 35, seriesName: "Costs", categoryName: "Apr" }] },
      ],
    };
    paintDataLabels(ctx, data(), labelled(), lay, THEME, composite);

    const recorded = lay.elements?.dataLabels ?? [];
    expect(recorded).toHaveLength(2);
    expect(recorded.map((l) => l.seriesIndex)).toEqual([0, 1]);
    expect(recorded.map((l) => l.pointIndex)).toEqual([0, 3]);
  });

  it("a datum still beats the label drawn over it", () => {
    // Settled precedent (insight-overlays 5h): the ladder keeps the click.
    // This pins that the new furniture did not quietly change it.
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    const geom = barGeometry();
    paintDataLabels(ctx, data(), spec({ dataLabels: { enabled: true, position: "center" } }), lay, THEME, geom);

    const inside = lay.elements!.dataLabels![0];
    const hit = hitTestGeometry(
      inside.rect.x + inside.rect.width / 2,
      inside.rect.y + inside.rect.height / 2,
      geom,
      lay,
    );
    expect(hit.element).toBe("datum");
  });
});

// ============================================================================
// Data table — one object
// ============================================================================

describe("data-table furniture", () => {
  it("records the grid box and is hit as ONE object", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    paintDataTable(ctx, data(), spec({ dataTable: { enabled: true } }), lay, THEME);

    const rect = lay.elements?.dataTable;
    expect(rect).toBeDefined();
    expect(rect!.x).toBe(lay.plotArea.x);
    expect(rect!.width).toBe(lay.plotArea.width);
    expect(rect!.y).toBeGreaterThan(lay.plotArea.y + lay.plotArea.height);

    const hit = hitTestChartElements(rect!.x + 10, rect!.y + rect!.height / 2, lay);
    expect(hit.element).toBe("dataTable");
    // ONE object: no cell identity comes back, because Excel has none either.
    expect(hit.seriesIndex).toBeUndefined();
    expect(hit.pointIndex).toBeUndefined();
  });

  it("records nothing when there is nothing to draw", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    const empty: ParsedChartData = { categories: [], series: [] };
    paintDataTable(ctx, empty, spec({ dataTable: { enabled: true } }), lay, THEME);
    expect(lay.elements?.dataTable).toBeUndefined();
  });
});

// ============================================================================
// A deleted legend ENTRY
// ============================================================================

describe("legend entries deleted individually", () => {
  it("removes the ROW and keeps the surviving entries' ORIGINAL indices", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    const threeSeries: ParsedChartData = {
      categories: ["Jan"],
      series: [
        { name: "Sales", values: [10], color: null },
        { name: "Costs", values: [5], color: null },
        { name: "Margin", values: [5], color: null },
      ],
    };

    drawLegend(ctx, threeSeries, spec({ legend: { visible: true, position: "right", hiddenEntries: [1] } }), lay, THEME);

    const items = lay.elements?.legendItems ?? [];
    expect(items).toHaveLength(2);
    // RENUMBERING WOULD SELECT THE WRONG SERIES: after hiding series 1, the
    // second surviving row is still series 2.
    expect(items.map((i) => i.seriesIndex)).toEqual([0, 2]);
    // And the rows closed up — the second one sits where the first did not.
    expect(items[1].rect.y).toBeGreaterThan(items[0].rect.y);
  });

  it("paints the surviving rows' own names, so no row shows its neighbour's label", () => {
    const lay = layout();
    const { ctx, calls } = makeRecordingCtx();
    const threeSeries: ParsedChartData = {
      categories: ["Jan"],
      series: [
        { name: "Sales", values: [10], color: null },
        { name: "Costs", values: [5], color: null },
        { name: "Margin", values: [5], color: null },
      ],
    };

    drawLegend(ctx, threeSeries, spec({ legend: { visible: true, position: "right", hiddenEntries: [1] } }), lay, THEME);

    const texts = calls.filter((c) => c.startsWith("fillText(")).join("|");
    expect(texts).toContain("Sales");
    expect(texts).toContain("Margin");
    expect(texts).not.toContain("Costs");
  });

  it("hiding every entry leaves no legend to click", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    drawLegend(ctx, data(), spec({ legend: { visible: true, position: "right", hiddenEntries: [0, 1] } }), lay, THEME);
    expect(lay.elements?.legend).toBeUndefined();
    expect(lay.elements?.legendItems).toEqual([]);
  });

  it("a hidden entry hits the series it names, not the row above it", () => {
    const lay = layout();
    const { ctx } = makeRecordingCtx();
    const threeSeries: ParsedChartData = {
      categories: ["Jan"],
      series: [
        { name: "Sales", values: [10], color: null },
        { name: "Costs", values: [5], color: null },
        { name: "Margin", values: [5], color: null },
      ],
    };
    drawLegend(ctx, threeSeries, spec({ legend: { visible: true, position: "right", hiddenEntries: [1] } }), lay, THEME);

    const row = lay.elements!.legendItems![1];
    const hit = hitTestChartElements(row.rect.x + 2, row.rect.y + row.rect.height / 2, lay);
    expect(hit.element).toBe("legendEntry");
    expect(hit.seriesIndex).toBe(2);
  });
});
