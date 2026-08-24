//! FILENAME: app/extensions/Charts/rendering/__tests__/ordinalCategoricalXAxis.test.ts
// PURPOSE: A declared categorical X scale ("band"/"point") PINS the axis to
//          evenly-spaced categories.
// CONTEXT: This is where an ordinal/nominal encoding channel lands after
//          lowering, and it has to suppress the proportional axis rather than opt
//          into it: on line/area the opt-in test is exactly "xAxis.scale is set",
//          and on scatter/bubble proportional is the default. Without the pin,
//          saying "these labels are ordered categories" would do the opposite of
//          what it says whenever the labels happen to parse as numbers or dates.

import { describe, it, expect } from "vitest";
import { resolveScatterXAxis } from "../chartPainterUtils";
import type { ChartSpec, ParsedChartData, ScaleSpec } from "../../types";

function spec(mark: "line" | "scatter", scale?: ScaleSpec): ChartSpec {
  return {
    mark,
    data: "A1:B4",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Y", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null, scale },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
  };
}

const plotArea = { x: 0, width: 100 };

/** Year-like category labels: the reader types them quantitative, so the axis would
 *  otherwise space 2019, 2020, 2030 by value. */
const yearData: ParsedChartData = {
  categories: ["2019", "2020", "2030"],
  series: [{ name: "Y", values: [1, 2, 3], color: null }],
  categoryField: { type: "quantitative", values: [2019, 2020, 2030] },
};

describe("a declared categorical X scale", () => {
  it("keeps number-like categories evenly spaced on scatter, where proportional is the default", () => {
    const proportional = resolveScatterXAxis(yearData, spec("scatter"), plotArea);
    expect(proportional.numeric).toBe(true); // positive control: this is the default

    const pinned = resolveScatterXAxis(yearData, spec("scatter", { type: "point" }), plotArea);
    expect(pinned.numeric).toBe(false);
    expect(pinned.xOf(1) - pinned.xOf(0)).toBeCloseTo(pinned.xOf(2) - pinned.xOf(1));
  });

  it("does not read as an opt-in on line/area, where any scale opts in", () => {
    const optedIn = resolveScatterXAxis(yearData, spec("line", { type: "linear" }), plotArea, { requireScale: true });
    expect(optedIn.numeric).toBe(true); // positive control: a value scale still opts in

    for (const type of ["band", "point"] as const) {
      const pinned = resolveScatterXAxis(yearData, spec("line", { type }), plotArea, { requireScale: true });
      expect(pinned.numeric, type).toBe(false);
      expect(pinned.xOf(1) - pinned.xOf(0)).toBeCloseTo(pinned.xOf(2) - pinned.xOf(1));
    }
  });

  it("labels the ticks from the categories, not from the numeric domain", () => {
    // Wide enough that the axis's label thinning keeps all three (at 100px the
    // 4-character labels collide and every second one is dropped).
    const pinned = resolveScatterXAxis(yearData, spec("scatter", { type: "band" }), { x: 0, width: 300 });
    expect(pinned.ticks.map((t) => t.label)).toEqual(["2019", "2020", "2030"]);
  });
});
