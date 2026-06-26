//! FILENAME: app/extensions/Charts/rendering/__tests__/chartRepeat.test.ts
// PURPOSE: Small multiples (spec.repeat) — grid math + the per-series fan-out in
//          dispatchPaint. Composed above the painters, so the renderer/painters
//          stay untouched; this verifies the composition layer in isolation.

import { describe, it, expect } from "vitest";
// Importing chartDispatch runs the built-in registrations (module side-effect).
import { dispatchPaint, dispatchComputeGeometry, repeatLayout } from "../chartDispatch";
import { registerChartMark } from "../markRegistry";
import { resolveChartTheme } from "../chartTheme";
import type { ChartSpec, ChartType, ParsedChartData, ChartLayout, AxisSpec } from "../../types";

const theme = resolveChartTheme(undefined);

/** A canvas stub: paintRepeated only calls these transform/clip primitives. */
const stubCtx = {
  save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {},
} as unknown as CanvasRenderingContext2D;

const layoutFn = (width: number, height: number): ChartLayout => ({
  width, height, margin: { top: 0, right: 0, bottom: 0, left: 0 }, plotArea: { x: 0, y: 0, width, height },
});

function repeatSpec(mark: string, overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: mark as ChartType,
    data: "A1:D4",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: "Parent title",
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    repeat: {},
    ...overrides,
  };
}

const threeSeries: ParsedChartData = {
  categories: ["a", "b"],
  series: [
    { name: "Revenue", values: [1, 2], color: null },
    { name: "Cost", values: [10, 20], color: null },
    { name: "Profit", values: [3, 4], color: null },
  ],
};

describe("repeatLayout", () => {
  it("tiles into ~square grid when columns is omitted", () => {
    expect(repeatLayout(4, undefined, 200, 200)).toEqual([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 100, y: 0, width: 100, height: 100 },
      { x: 0, y: 100, width: 100, height: 100 },
      { x: 100, y: 100, width: 100, height: 100 },
    ]);
  });

  it("honors an explicit column count (partial last row)", () => {
    expect(repeatLayout(3, 2, 200, 100)).toEqual([
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 100, y: 0, width: 100, height: 50 },
      { x: 0, y: 50, width: 100, height: 50 },
    ]);
  });

  it("never makes more columns than cells", () => {
    expect(repeatLayout(2, 5, 200, 100)).toEqual([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 100, y: 0, width: 100, height: 100 },
    ]);
  });

  it("returns nothing for a non-positive count", () => {
    expect(repeatLayout(0, 2, 200, 100)).toEqual([]);
  });
});

describe("dispatchPaint small multiples", () => {
  it("paints one sub-chart per series", () => {
    const seen: AxisSpec[] = [];
    let title: string | null = "parent";
    registerChartMark("__repeat_count__", {
      meta: { label: "Repeat Count", layoutFamily: "cartesian" },
      paint: (_ctx, _d, s) => { seen.push((s as ChartSpec).yAxis); title = (s as ChartSpec).title; },
      computeLayout: layoutFn,
      computeGeometry: () => ({ type: "bars", rects: [] }),
    });

    const spec = repeatSpec("__repeat_count__", { repeat: { columns: 2 } });
    const layout = layoutFn(200, 200);
    dispatchPaint(stubCtx, threeSeries, spec, layout, theme);

    expect(seen).toHaveLength(3);
    // Each sub-chart is titled with its series name (last paint = "Profit").
    expect(title).toBe("Profit");
  });

  it("shares one Y domain across panels by default", () => {
    const mins: Array<number | null> = [];
    const maxs: Array<number | null> = [];
    registerChartMark("__repeat_shared__", {
      meta: { label: "Repeat Shared", layoutFamily: "cartesian" },
      paint: (_ctx, _d, s) => { mins.push((s as ChartSpec).yAxis.min); maxs.push((s as ChartSpec).yAxis.max); },
      computeLayout: layoutFn,
      computeGeometry: () => ({ type: "bars", rects: [] }),
    });

    const spec = repeatSpec("__repeat_shared__");
    dispatchPaint(stubCtx, threeSeries, spec, layoutFn(200, 200), theme);

    // Global min/max across all series values: 1 .. 20, identical for every panel.
    expect(mins).toEqual([1, 1, 1]);
    expect(maxs).toEqual([20, 20, 20]);
  });

  it("threads the parent selection into every panel (linked cross-panel highlight)", () => {
    const seen: Array<ParsedChartData> = [];
    registerChartMark("__repeat_sel__", {
      meta: { label: "Repeat Sel", layoutFamily: "cartesian" },
      paint: (_ctx, d) => { seen.push(d as ParsedChartData); },
      computeLayout: layoutFn,
      computeGeometry: () => ({ type: "bars", rects: [] }),
    });

    const selection = { p: { on: "category" as const, values: ["a"] } };
    const spec = repeatSpec("__repeat_sel__", { repeat: { columns: 2 } });
    dispatchPaint(stubCtx, { ...threeSeries, selection }, spec, layoutFn(200, 200), theme);

    expect(seen).toHaveLength(3);
    for (const panel of seen) expect(panel.selection).toBe(selection);
  });

  it("leaves each panel's Y scale independent when sharedYScale is false", () => {
    const mins: Array<number | null> = [];
    registerChartMark("__repeat_indep__", {
      meta: { label: "Repeat Indep", layoutFamily: "cartesian" },
      paint: (_ctx, _d, s) => { mins.push((s as ChartSpec).yAxis.min); },
      computeLayout: layoutFn,
      computeGeometry: () => ({ type: "bars", rects: [] }),
    });

    const spec = repeatSpec("__repeat_indep__", { repeat: { sharedYScale: false } });
    dispatchPaint(stubCtx, threeSeries, spec, layoutFn(200, 200), theme);

    // Parent yAxis.min (null) flows through untouched to every panel.
    expect(mins).toEqual([null, null, null]);
  });

  it("composes per-panel hit geometry while repeating (cross-panel selection)", () => {
    const spec = repeatSpec("bar", { repeat: { columns: 2 } });
    const geo = dispatchComputeGeometry(threeSeries, spec, layoutFn(200, 200), theme);
    // One composite group per series panel (3 series -> 3 panels).
    expect(geo.type).toBe("composite");
    if (geo.type !== "composite") throw new Error("expected composite");
    expect(geo.groups).toHaveLength(3);
    // Every panel yields hit-testable bars (each panel is a single series x 2 cats).
    for (const g of geo.groups) {
      expect(g.type).toBe("bars");
      if (g.type === "bars") expect(g.rects.length).toBeGreaterThan(0);
    }
    // Panels are offset into chart-local space: at columns:2 the 2nd panel starts
    // at x>=100 (right column), so some bar must lie in the right half.
    const allRects = geo.groups.flatMap((g) => (g.type === "bars" ? g.rects : []));
    expect(allRects.some((r) => r.x >= 100)).toBe(true);
    // ...and some in the left column (x < 100).
    expect(allRects.some((r) => r.x < 100)).toBe(true);
  });

  it("paints nothing (no throw) when there are no series", () => {
    const spec = repeatSpec("bar");
    const empty: ParsedChartData = { categories: [], series: [] };
    expect(() => dispatchPaint(stubCtx, empty, spec, layoutFn(200, 200), theme)).not.toThrow();
  });
});
