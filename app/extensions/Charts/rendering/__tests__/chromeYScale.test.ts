//! FILENAME: app/extensions/Charts/rendering/__tests__/chromeYScale.test.ts
// PURPOSE: Feature 2 review fix — buildChromeYScale must honor a sandboxed mark's
//          declared yDomain (or a user-pinned yAxis.min/max) VERBATIM (no zero
//          injection, no nice rounding), so the host-drawn Y axis lines up with the
//          values the worker mapped into the plot. Without an explicit domain it
//          falls back to the data extent with the engine's default zero+nice.

import { describe, it, expect } from "vitest";
import { buildChromeYScale } from "../chartPainterUtils";
import type { ChartSpec, ParsedChartData } from "../../types";

const data: ParsedChartData = { categories: ["a", "b"], series: [{ name: "S", values: [20, 80], color: null }] };

function specWith(y: Partial<ChartSpec["yAxis"]>): ChartSpec {
  return {
    mark: "sandbox:x", data: "A1:B3", hasHeaders: true, seriesOrientation: "columns",
    categoryIndex: 0, series: [{ name: "S", sourceIndex: 1, color: null }], title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null, ...y },
    legend: { visible: false, position: "bottom" }, palette: "default",
  } as unknown as ChartSpec;
}

const RANGE: [number, number] = [300, 0]; // inverted (pixel space)

describe("buildChromeYScale", () => {
  it("honors a declared yDomain VERBATIM (no zero-injection, no nice-rounding)", () => {
    const scale = buildChromeYScale(specWith({}), data, RANGE, [10, 90]);
    expect(scale.domain).toEqual([10, 90]);
  });

  it("honors user-pinned yAxis.min/max verbatim", () => {
    const scale = buildChromeYScale(specWith({ min: 10, max: 90 }), data, RANGE);
    expect(scale.domain).toEqual([10, 90]);
  });

  it("an explicit-domain scale maps its endpoints to the range edges (bars align)", () => {
    const scale = buildChromeYScale(specWith({}), data, RANGE, [10, 90]);
    // 10 -> bottom (300), 90 -> top (0): the host ticks span exactly the mark's domain.
    expect(scale.scale(10)).toBeCloseTo(300);
    expect(scale.scale(90)).toBeCloseTo(0);
  });

  it("falls back to the data extent with zero-injection + nice rounding when no hint", () => {
    const scale = buildChromeYScale(specWith({}), data, RANGE);
    // data is [20,80]; auto domain injects zero and nice-rounds -> starts at 0.
    expect(scale.domain[0]).toBe(0);
    expect(scale.domain[1]).toBeGreaterThanOrEqual(80);
  });
});
