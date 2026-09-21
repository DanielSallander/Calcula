//! FILENAME: app/extensions/Charts/rendering/__tests__/comboAxisTitles.test.ts
// PURPOSE: A combo chart PAINTS its x-axis title, and writes back the measured
//          rect for it, using the same shared arithmetic every other cartesian
//          painter uses.
// CONTEXT: For as long as comboChartPainter has existed, `drawComboAxes` drew
//          the Y axis title and nothing for the X one — while
//          `computeCartesianLayout` reserved `axisTitleFontSize + 6` of bottom
//          margin for it and `computeCartesianElementRects` produced an
//          `xAxisTitle` rect at that reservation. So the space was given up, the
//          text never appeared, and once element hit-testing landed, a click on
//          that empty strip SELECTED a title the user could not see: the
//          selection ladder answering for a thing that is not on the canvas.
//
//          This file has teeth in two directions. It asserts the GLYPHS (a
//          recording context double catches `fillText`, which a rect-only check
//          would not), and it asserts the RECT equals what the shared helpers
//          produce for this painter's own plot area — so a hand-copied baseline
//          or a hand-copied half-width fails here rather than in a hit test six
//          months later.

import { describe, it, expect } from "vitest";
import { paintComboChart, computeComboLayout } from "../comboChartPainter";
import {
  recordXAxisTitleRect,
  xAxisTitleBaselineY,
} from "../markerPainter";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { makeRecordingCtx } from "./dispatch-recordingCtx";
import type { ChartSpec, ChartLayout, ParsedChartData } from "../../types";

// ============================================================================
// Fixtures
// ============================================================================

/** The recording context double measures text at exactly 7px per character. */
const MOCK_CHAR_PX = 7;

const AXIS = { gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null } as const;

const X_TITLE = "Quarter";
const Y_TITLE = "USD";

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "combo",
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 3, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: "Quarterly revenue",
    xAxis: { ...AXIS, title: X_TITLE },
    yAxis: { ...AXIS, gridLines: true, title: Y_TITLE },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    markOptions: { seriesMarks: { 0: "bar", 1: "line" } },
    ...overrides,
  } as unknown as ChartSpec;
}

const data: ParsedChartData = {
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { name: "North", values: [120, 260, 300, 210], color: null },
    { name: "South", values: [90, 140, 180, 160], color: null },
  ],
} as ParsedChartData;

const W = 640;
const H = 420;

function paint(spec: ChartSpec): { layout: ChartLayout; calls: string[] } {
  const layout = computeComboLayout(W, H, spec, data, DEFAULT_CHART_THEME);
  const { ctx, calls } = makeRecordingCtx(W, H);
  paintComboChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
  return { layout, calls };
}

/** Every `fillText(...)` entry in the stream whose text is exactly `text`. */
function textCalls(calls: string[], text: string): string[] {
  return calls.filter((c) => c.startsWith(`fillText(${text},`));
}

// ============================================================================
// (1) The glyphs
// ============================================================================

describe("combo chart x-axis title", () => {
  it("PAINTS the title text when spec.xAxis.title is set", () => {
    const { calls } = paint(makeSpec());
    expect(textCalls(calls, X_TITLE)).toHaveLength(1);
  });

  it("paints nothing when there is no x-axis title", () => {
    const { calls } = paint(makeSpec({ xAxis: { ...AXIS, title: null } } as Partial<ChartSpec>));
    expect(textCalls(calls, X_TITLE)).toHaveLength(0);
    // The Y title is still drawn, so a blanket "nothing is painted" bug cannot
    // pass this pair.
    expect(textCalls(calls, Y_TITLE)).toHaveLength(1);
  });

  it("draws it centred on the plot, below it, and inside the canvas", () => {
    const { layout, calls } = paint(makeSpec());
    const { plotArea } = layout;
    const call = textCalls(calls, X_TITLE)[0];
    const [, xStr, yStr] = call.replace(/^fillText\(|\)$/g, "").split(",");
    const x = Number(xStr);
    const y = Number(yStr);

    expect(x).toBeCloseTo(plotArea.x + plotArea.width / 2, 3);
    expect(y).toBeGreaterThan(plotArea.y + plotArea.height);
    expect(y).toBeLessThanOrEqual(H);
  });

  it("uses the axis-title font and a centred, bottom-aligned baseline", () => {
    const { calls } = paint(makeSpec());
    const at = calls.indexOf(textCalls(calls, X_TITLE)[0]);
    const before = calls.slice(0, at);
    // The last style set of each kind before the fillText is the one in force.
    const last = (key: string): string | undefined =>
      [...before].reverse().find((c) => c.startsWith(`${key}=`));
    expect(last("font")).toBe(
      `font=${DEFAULT_CHART_THEME.axisTitleFontSize}px ${DEFAULT_CHART_THEME.fontFamily}`,
    );
    expect(last("textAlign")).toBe("textAlign=center");
    expect(last("textBaseline")).toBe("textBaseline=bottom");
    expect(last("fillStyle")).toBe(`fillStyle=${DEFAULT_CHART_THEME.axisTitleColor}`);
  });
});

// ============================================================================
// (2) The measured rect, and that it is the SHARED arithmetic
// ============================================================================

describe("combo chart x-axis title rect", () => {
  it("is written back as MEASURED, not left as the layout's estimate", () => {
    const layout = computeComboLayout(W, H, makeSpec(), data, DEFAULT_CHART_THEME);
    const estimate = { ...layout.elements!.xAxisTitle! };
    const { ctx } = makeRecordingCtx(W, H);
    paintComboChart(ctx, data, makeSpec(), layout, DEFAULT_CHART_THEME);

    expect(layout.elements!.measured).toContain("xAxisTitle");
    expect(layout.elements!.xAxisTitle!.width).toBe(X_TITLE.length * MOCK_CHAR_PX);
    // The estimate is a character-count guess; the measurement must replace it.
    expect(layout.elements!.xAxisTitle).not.toEqual(estimate);
  });

  it("equals what the shared helpers produce for this painter's own plot area", () => {
    const spec = makeSpec();
    const { layout } = paint(spec);

    const reference: ChartLayout = {
      ...layout,
      elements: { measured: [] },
    } as unknown as ChartLayout;
    recordXAxisTitleRect(
      reference,
      layout.plotArea,
      X_TITLE.length * MOCK_CHAR_PX,
      xAxisTitleBaselineY(layout.plotArea, true),
      DEFAULT_CHART_THEME.axisTitleFontSize,
    );

    expect(layout.elements!.xAxisTitle).toEqual(reference.elements!.xAxisTitle);
  });

  it("stays unmeasured when there is no title", () => {
    const spec = makeSpec({ xAxis: { ...AXIS, title: null } } as Partial<ChartSpec>);
    const { layout } = paint(spec);
    expect(layout.elements!.measured).not.toContain("xAxisTitle");
    expect(layout.elements!.xAxisTitle).toBeUndefined();
  });

  it("still lands correctly when a secondary axis has reflowed the plot", () => {
    // computeComboLayout narrows the plot by 46px for the secondary axis and
    // re-runs the element reflow; the painted title must follow the NEW centre,
    // not the pre-reflow one.
    const spec = makeSpec({
      markOptions: { seriesMarks: { 0: "bar", 1: "line" }, secondaryYAxis: true, secondaryAxisSeries: [1] },
    } as Partial<ChartSpec>);
    const { layout, calls } = paint(spec);
    const call = textCalls(calls, X_TITLE)[0];
    expect(call).toBeDefined();
    const x = Number(call.replace(/^fillText\(|\)$/g, "").split(",")[1]);
    expect(x).toBeCloseTo(layout.plotArea.x + layout.plotArea.width / 2, 3);
    expect(layout.elements!.xAxisTitle!.x).toBeCloseTo(
      x - (X_TITLE.length * MOCK_CHAR_PX) / 2,
      3,
    );
  });
});
