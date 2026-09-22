//! FILENAME: app/extensions/Charts/rendering/__tests__/furniture2-suppression.test.ts
// PURPOSE: The two spec fields that make "remove THIS furniture" expressible are
//          actually HONOURED by the painters — and, just as importantly, the
//          rects they stop recording disappear too, so the removed thing stops
//          being selectable.
//
// A FIELD WITH NO READER IS A PROMISE THE PRODUCT DOES NOT KEEP. That is not a
// hypothetical here: `LegendSpec.hiddenEntries` was declared, schema-validated,
// documented in the generated reference and honoured end to end, and NOTHING in
// the repository ever wrote an index into it — so the finest act available on a
// legend row was to delete the whole legend. `ErrorBarOptions.seriesFilter` and
// `DataLabelSpec.hiddenPoints` are the same shape of field, added for the same
// reason, so they are pinned at the painter rather than at the resolver alone.
//
// THE RECORD IS PART OF THE BEHAVIOUR. `layout.elements` is what the hit test,
// the selection ladder and the keyboard walk all read. A painter that skipped
// the DRAWING but still recorded the rect would leave a selectable, formattable,
// deletable object over empty pixels.

import { describe, it, expect, vi } from "vitest";
import { paintDataLabels } from "../dataLabelPainter";
import { paintErrorBars } from "../errorBarPainter";
import type {
  ChartLayout,
  ChartSpec,
  DataLabelSpec,
  ErrorBarOptions,
  HitGeometry,
  ParsedChartData,
} from "../../types";
import type { ChartRenderTheme } from "../chartTheme";

// ---------------------------------------------------------------------------
// Doubles and fixtures
// ---------------------------------------------------------------------------

function makeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillText: vi.fn(),
    fillRect: vi.fn(),
    setLineDash: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 40 }),
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt" as CanvasLineCap,
    textAlign: "center" as CanvasTextAlign,
    textBaseline: "middle" as CanvasTextBaseline,
  } as unknown as CanvasRenderingContext2D;
}

const theme = {
  background: "#fff",
  plotBackground: "#fff",
  gridLineColor: "#e0e0e0",
  gridLineWidth: 1,
  axisColor: "#333",
  axisLabelColor: "#666",
  axisTitleColor: "#333",
  titleColor: "#333",
  legendTextColor: "#666",
  fontFamily: "Segoe UI",
  titleFontSize: 14,
  axisTitleFontSize: 11,
  labelFontSize: 10,
  legendFontSize: 10,
  barBorderRadius: 2,
  barGap: 2,
} as ChartRenderTheme;

function layout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 40, right: 20, bottom: 40, left: 50 },
    plotArea: { x: 50, y: 40, width: 530, height: 320 },
  };
}

const data: ParsedChartData = {
  categories: ["A", "B", "C"],
  series: [
    { name: "Sales", values: [100, 200, 300], color: "#4E79A7" },
    { name: "Profit", values: [50, 80, 120], color: "#F28E2B" },
  ],
};

/** Two series x two categories, all comfortably inside the plot area. */
const BARS: HitGeometry = {
  type: "bars",
  rects: [
    { seriesIndex: 0, categoryIndex: 0, x: 100, y: 120, width: 30, height: 140, value: 100, seriesName: "Sales", categoryName: "A" },
    { seriesIndex: 0, categoryIndex: 1, x: 200, y: 100, width: 30, height: 160, value: 200, seriesName: "Sales", categoryName: "B" },
    { seriesIndex: 1, categoryIndex: 0, x: 300, y: 150, width: 30, height: 110, value: 50, seriesName: "Profit", categoryName: "A" },
    { seriesIndex: 1, categoryIndex: 1, x: 400, y: 140, width: 30, height: 120, value: 80, seriesName: "Profit", categoryName: "B" },
  ],
};

function specWith(over: Partial<ChartSpec>): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Sales", sourceIndex: 1, color: null },
      { name: "Profit", sourceIndex: 2, color: null },
    ],
    title: "T",
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "right" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

/** The (series, point) pairs the label painter recorded onto the layout. */
function recordedLabels(lay: ChartLayout): Array<[number, number]> {
  return (lay.elements?.dataLabels ?? []).map((l) => [l.seriesIndex, l.pointIndex]);
}

/** The series indices the error-bar painter recorded, in order. */
function recordedBarSeries(lay: ChartLayout): number[] {
  return (lay.elements?.errorBars ?? []).map((b) => b.seriesIndex);
}

// ===========================================================================

describe("DataLabelSpec.hiddenPoints suppresses ONE label", () => {
  const dl = (over: Partial<DataLabelSpec> = {}): ChartSpec =>
    specWith({ dataLabels: { enabled: true, ...over } });

  it("draws every label when nothing is hidden", () => {
    const lay = layout();
    const ctx = makeCtx();
    paintDataLabels(ctx, data, dl(), lay, theme, BARS);
    expect(recordedLabels(lay)).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    expect((ctx.fillText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  it("skips exactly the hidden pair — not its series, not its point index elsewhere", () => {
    // The trap a sloppy match would fall into: hiding (0,1) must not also hide
    // (1,1), and must not hide the whole of series 0.
    const lay = layout();
    const ctx = makeCtx();
    paintDataLabels(ctx, data, dl({ hiddenPoints: [{ seriesIndex: 0, pointIndex: 1 }] }), lay, theme, BARS);
    expect(recordedLabels(lay)).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect((ctx.fillText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it("does not RECORD the hidden label, so it stops being selectable too", () => {
    // Skipping the draw while still recording the rect would leave a clickable,
    // formattable, deletable object over empty pixels.
    const lay = layout();
    paintDataLabels(makeCtx(), data, dl({ hiddenPoints: [{ seriesIndex: 1, pointIndex: 0 }] }), lay, theme, BARS);
    expect(recordedLabels(lay)).not.toContainEqual([1, 0]);
  });

  it("composes with seriesFilter rather than replacing it", () => {
    const lay = layout();
    paintDataLabels(
      makeCtx(),
      data,
      dl({ seriesFilter: [0], hiddenPoints: [{ seriesIndex: 0, pointIndex: 0 }] }),
      lay,
      theme,
      BARS,
    );
    expect(recordedLabels(lay)).toEqual([[0, 1]]);
  });

  it("treats an empty list as 'nothing hidden'", () => {
    const lay = layout();
    paintDataLabels(makeCtx(), data, dl({ hiddenPoints: [] }), lay, theme, BARS);
    expect(recordedLabels(lay)).toHaveLength(4);
  });

  it("uses the radial convention for a pie, where a slice IS its category", () => {
    // `hitTestSliceArcs` reports a slice as seriesIndex === pointIndex, and the
    // label recorder already writes the pair that way. A suppression list that
    // used a different convention would refuse to hide the label the reader
    // selected.
    const slices: HitGeometry = {
      type: "slices",
      arcs: [
        { seriesIndex: 0, startAngle: 0, endAngle: 1, innerRadius: 0, outerRadius: 80, centerX: 300, centerY: 200, value: 10, label: "A", percent: 0.25 },
        { seriesIndex: 1, startAngle: 1, endAngle: 2, innerRadius: 0, outerRadius: 80, centerX: 300, centerY: 200, value: 20, label: "B", percent: 0.5 },
      ],
    };
    const lay = layout();
    paintDataLabels(
      makeCtx(),
      data,
      specWith({ mark: "pie", dataLabels: { enabled: true, hiddenPoints: [{ seriesIndex: 1, pointIndex: 1 }] } }),
      lay,
      theme,
      slices,
    );
    expect(recordedLabels(lay)).toEqual([[0, 0]]);
  });
});

// ===========================================================================

describe("ErrorBarOptions.seriesFilter removes ONE series' bars", () => {
  const bars = (over: Partial<ErrorBarOptions> = {}): ChartSpec =>
    specWith({
      markOptions: { errorBars: { enabled: true, type: "percentage", value: 10, direction: "both", ...over } },
    });

  it("draws bars for every series when there is no filter", () => {
    const lay = layout();
    paintErrorBars(makeCtx(), data, bars(), lay, theme, BARS);
    expect(recordedBarSeries(lay)).toEqual([0, 0, 1, 1]);
  });

  it("draws only the listed series, leaving the rest untouched", () => {
    const lay = layout();
    paintErrorBars(makeCtx(), data, bars({ seriesFilter: [1] }), lay, theme, BARS);
    expect(recordedBarSeries(lay)).toEqual([1, 1]);
  });

  it("an EMPTY filter means none, not all", () => {
    // A filter that listed nothing is reached by removing the last series'
    // bars. Collapsing it back to "all" would make the last Delete undo every
    // previous one.
    const lay = layout();
    paintErrorBars(makeCtx(), data, bars({ seriesFilter: [] }), lay, theme, BARS);
    expect(recordedBarSeries(lay)).toEqual([]);
  });

  it("null is the every-series spelling, so an old spec is unchanged", () => {
    const lay = layout();
    paintErrorBars(makeCtx(), data, bars({ seriesFilter: null }), lay, theme, BARS);
    expect(recordedBarSeries(lay)).toEqual([0, 0, 1, 1]);
  });

  it("filters point geometry the same way it filters bars", () => {
    const points: HitGeometry = {
      type: "points",
      markers: [
        { seriesIndex: 0, categoryIndex: 0, cx: 100, cy: 200, radius: 4, value: 100, seriesName: "Sales", categoryName: "A" },
        { seriesIndex: 1, categoryIndex: 0, cx: 200, cy: 220, radius: 4, value: 50, seriesName: "Profit", categoryName: "A" },
      ],
    };
    const lay = layout();
    paintErrorBars(
      makeCtx(),
      data,
      specWith({
        mark: "line",
        markOptions: { errorBars: { enabled: true, type: "percentage", value: 10, direction: "both", seriesFilter: [0] } },
      }),
      lay,
      theme,
      points,
    );
    expect(recordedBarSeries(lay)).toEqual([0]);
  });

  it("stops RECORDING the filtered series, so its rung disappears from the ladder", () => {
    const lay = layout();
    paintErrorBars(makeCtx(), data, bars({ seriesFilter: [0] }), lay, theme, BARS);
    expect(recordedBarSeries(lay)).not.toContain(1);
  });
});
