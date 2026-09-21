//! FILENAME: app/extensions/Charts/rendering/__tests__/furnitureAxisOptions.test.ts
// PURPOSE: The five axis options that round-tripped into saved workbooks with
//          no painter reading them — majorUnit, minorUnit, minorTickMark,
//          crossesAt, crossesAtValue — are read now, and this proves it by
//          painting and inspecting the drawing stream.
//
// WHY A DEAD FIELD IS WORSE THAN A MISSING ONE: ChartFormatPane has a full
// editor for all five. Setting "Major unit: 200" dirtied the document, redrew
// the chart unchanged and saved the number, so the workbook claimed a setting
// the picture never had. That is the "complete-LOOKING but incomplete" shape,
// and the only test that catches it is one that looks at the PIXELS rather
// than at the round trip.
//
// EVERY CASE IS DIFFERENTIAL. "The chart drew some ticks" passes with the
// field ignored; each test here paints twice — once with the option and once
// without — and asserts the two streams differ in the specific way the option
// names.

import { describe, it, expect } from "vitest";
import { drawCartesianAxes, axisTickValues, axisMinorTickValues, axisCrossingY } from "../chartPainterUtils";
import { createBandScale, createLinearScale } from "../scales";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { makeRecordingCtx } from "./dispatch-recordingCtx";
import type { AxisSpec, ChartLayout, ChartSpec } from "../../types";

// ============================================================================
// Fixtures
// ============================================================================

const PLOT = { x: 70, y: 40, width: 420, height: 260 };
const THEME = DEFAULT_CHART_THEME;

function layout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 40, right: 110, bottom: 60, left: 70 },
    plotArea: { ...PLOT },
  };
}

function yScale() {
  return createLinearScale([0, 1000], [PLOT.y + PLOT.height, PLOT.y], { zero: true, nice: false });
}

function xScale() {
  return createBandScale(["Jan", "Feb", "Mar", "Apr"], [PLOT.x, PLOT.x + PLOT.width]);
}

function axis(over: Partial<AxisSpec> = {}): AxisSpec {
  return { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null, ...over };
}

function spec(x: Partial<AxisSpec>, y: Partial<AxisSpec>): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: axis(x),
    yAxis: axis(y),
    legend: { visible: false, position: "right" },
    palette: "default",
  } as ChartSpec;
}

/**
 * Every y-axis tick LABEL the painter drew, in order.
 *
 * Selected by the x it is drawn at (`plotArea.x - 6`, right-aligned against the
 * axis) rather than by a numeric regex: `formatTickValue` abbreviates, so
 * "1000" reaches the canvas as "1.0K" and a regex over digits would silently
 * DROP the last tick — the test would then pass while the painter skipped it.
 */
const Y_LABEL_X = String(PLOT.x - 6);
function yLabels(calls: string[]): string[] {
  return calls
    .filter((c) => c.startsWith("fillText(") && c.slice("fillText(".length, -1).split(",")[1] === Y_LABEL_X)
    .map((c) => c.slice("fillText(".length, -1).split(",")[0]);
}

function paint(s: ChartSpec, lay: ChartLayout = layout()) {
  const rec = makeRecordingCtx();
  drawCartesianAxes(rec.ctx, xScale(), yScale(), lay.plotArea, s, THEME, lay);
  return { calls: rec.calls, layout: lay };
}

// ============================================================================
// majorUnit
// ============================================================================

describe("majorUnit", () => {
  it("pins the tick VALUES, and the default does not produce the same set", () => {
    // 250, not 200: the nice-ticks default for 0..1000 at count 5 IS 200, so a
    // test written against 200 would pass with majorUnit ignored entirely.
    const pinned = axisTickValues(yScale(), axis({ majorUnit: 250 }));
    const auto = axisTickValues(yScale(), axis());
    expect(pinned).toEqual([0, 250, 500, 750, 1000]);
    expect(auto).not.toEqual(pinned);
  });

  it("drives the tick LABELS the painter writes, not only the tick marks", () => {
    const withUnit = paint(spec({}, { majorUnit: 250 }));
    const without = paint(spec({}, {}));
    const drawn = yLabels(withUnit.calls);
    expect(drawn).toHaveLength(5);
    expect(drawn[0]).toBe("0");
    expect(drawn[1]).toBe("250");
    expect(drawn[3]).toBe("750");
    expect(yLabels(without.calls)).not.toEqual(drawn);
  });

  it("ignores a unit that cannot produce ticks instead of hanging", () => {
    expect(axisTickValues(yScale(), axis({ majorUnit: 0 }))).toEqual(axisTickValues(yScale(), axis()));
    expect(axisTickValues(yScale(), axis({ majorUnit: -5 }))).toEqual(axisTickValues(yScale(), axis()));
    expect(axisTickValues(yScale(), axis({ majorUnit: null }))).toEqual(axisTickValues(yScale(), axis()));
    // A microscopic unit is capped rather than run to completion.
    expect(axisTickValues(yScale(), axis({ majorUnit: 1e-6 })).length).toBeLessThanOrEqual(1000);
  });
});

// ============================================================================
// minorUnit + minorTickMark
// ============================================================================

describe("minor ticks", () => {
  it("draws none unless minorTickMark asks — a minorUnit alone is not a request", () => {
    const major = axisTickValues(yScale(), axis({ majorUnit: 200 }));
    expect(axisMinorTickValues(yScale(), axis({ majorUnit: 200, minorUnit: 50 }), major)).toEqual([]);
  });

  it("subdivides at minorUnit and never repeats a major tick", () => {
    const a = axis({ majorUnit: 200, minorUnit: 50, minorTickMark: "outside" });
    const major = axisTickValues(yScale(), a);
    const minor = axisMinorTickValues(yScale(), a, major);
    expect(minor).toContain(50);
    expect(minor).toContain(150);
    // 200 is a MAJOR tick; drawing it twice paints a double-width mark.
    expect(minor).not.toContain(200);
    expect(minor.every((v) => !major.includes(v))).toBe(true);
  });

  it("defaults minorUnit to half the major step", () => {
    const a = axis({ majorUnit: 200, minorTickMark: "outside" });
    const minor = axisMinorTickValues(yScale(), a, axisTickValues(yScale(), a));
    expect(minor).toContain(100);
    expect(minor).toContain(300);
  });

  it("actually puts more strokes on the canvas", () => {
    const strokes = (calls: string[]) => calls.filter((c) => c.startsWith("moveTo(")).length;
    const withMinor = paint(spec({}, { majorUnit: 200, minorUnit: 50, minorTickMark: "outside" }));
    const without = paint(spec({}, { majorUnit: 200 }));
    expect(strokes(withMinor.calls)).toBeGreaterThan(strokes(without.calls));
  });
});

// ============================================================================
// crossesAt / crossesAtValue
// ============================================================================

describe("axis crossing", () => {
  it("defaults to the plot's bottom edge", () => {
    expect(axisCrossingY(yScale(), axis(), PLOT)).toBe(PLOT.y + PLOT.height);
    expect(axisCrossingY(yScale(), axis({ crossesAt: "auto" }), PLOT)).toBe(PLOT.y + PLOT.height);
  });

  it("puts the axis where the VALUE maps, and clamps a value off the scale", () => {
    const s = yScale();
    expect(axisCrossingY(s, axis({ crossesAt: "value", crossesAtValue: 500 }), PLOT)).toBeCloseTo(s.scale(500));
    expect(axisCrossingY(s, axis({ crossesAt: "max" }), PLOT)).toBeCloseTo(s.scale(1000));
    // Off the top of the scale: pinned to the plot, never painted outside it.
    expect(axisCrossingY(s, axis({ crossesAt: "value", crossesAtValue: 99999 }), PLOT)).toBe(PLOT.y);
  });

  it("moves the LINE, the tick marks and the tick LABELS together", () => {
    const crossing = yScale().scale(500);
    const moved = paint(spec({}, { crossesAt: "value", crossesAtValue: 500 }));
    const pinned = paint(spec({}, {}));

    // The axis line.
    expect(moved.calls).toContain(`moveTo(${PLOT.x},${crossing + 0.5})`);
    expect(pinned.calls).toContain(`moveTo(${PLOT.x},${PLOT.y + PLOT.height + 0.5})`);

    // The category labels follow it — they are drawn 4px below the line.
    const labelYs = (calls: string[]) =>
      calls.filter((c) => c.startsWith("fillText(Jan,")).map((c) => c.split(",")[2].replace(")", ""));
    expect(labelYs(moved.calls)).toEqual([String(crossing + 4)]);
    expect(labelYs(pinned.calls)).toEqual([String(PLOT.y + PLOT.height + 4)]);
  });

  it("keeps the value axis full height when the category axis crosses mid-plot", () => {
    // The Y line used to stop at the X line. Once the X line can sit in the
    // middle, that would cut the value axis in half.
    const moved = paint(spec({}, { crossesAt: "value", crossesAtValue: 500 }));
    expect(moved.calls).toContain(`lineTo(${PLOT.x - 0.5},${PLOT.y + PLOT.height})`);
  });

  it("records the moved tick-label band, because the layout's estimate is now stale", () => {
    const crossing = yScale().scale(500);
    const moved = paint(spec({}, { crossesAt: "value", crossesAtValue: 500 }));
    const band = moved.layout.elements?.xAxisBand;
    expect(band).toBeDefined();
    expect(band!.y).toBeCloseTo(crossing);

    // And the ordinary chart is left exactly as it was: no write-back, so the
    // layout estimate every existing chart relies on is untouched.
    const pinned = paint(spec({}, {}));
    expect(pinned.layout.elements?.measured ?? []).not.toContain("xAxisBand");
  });
});
