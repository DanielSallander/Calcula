//! FILENAME: app/extensions/Charts/rendering/__tests__/markRegistry.test.ts
// PURPOSE: The chart-mark registry registers all built-ins and lets a new mark
//          be added without touching the dispatch switches (B9 dogfooding).

import { describe, it, expect } from "vitest";
// Importing chartDispatch runs the built-in registrations (module side-effect).
import { dispatchPaint, dispatchComputeLayout, dispatchComputeGeometry } from "../chartDispatch";
import { registerChartMark, getChartMark, listChartMarks } from "../markRegistry";
import { resolveChartTheme } from "../chartTheme";
import { isCartesianChart } from "../../types";
import type { ChartSpec, ChartType, ParsedChartData, ChartLayout } from "../../types";

const BUILT_INS: ChartType[] = [
  "bar", "horizontalBar", "line", "area", "scatter", "pie", "donut", "waterfall",
  "combo", "radar", "bubble", "histogram", "funnel", "treemap", "stock", "boxPlot",
  "sunburst", "pareto",
];

const theme = resolveChartTheme(undefined);
const data: ParsedChartData = { categories: ["a", "b"], series: [{ name: "s", values: [1, 2], color: null }] };

function specWithMark(mark: string): ChartSpec {
  return {
    mark: mark as ChartType,
    data: "A1:B3",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "s", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
  };
}

describe("chart mark registry", () => {
  it("registers every built-in mark", () => {
    const marks = listChartMarks();
    for (const m of BUILT_INS) expect(marks).toContain(m);
  });

  it("exposes a complete definition (with meta) for each built-in", () => {
    for (const m of BUILT_INS) {
      const def = getChartMark(m);
      expect(def).toBeDefined();
      expect(typeof def!.paint).toBe("function");
      expect(typeof def!.computeLayout).toBe("function");
      expect(typeof def!.computeGeometry).toBe("function");
      expect(typeof def!.meta.label).toBe("string");
      expect(["cartesian", "radial", "other"]).toContain(def!.meta.layoutFamily);
      expect(def!.meta.builtin).toBe(true);
    }
  });

  it("dispatch routes paint / layout / geometry to a newly registered mark", () => {
    let painted = false;
    let laidOut = false;
    let measured = false;

    registerChartMark("__test_mark__", {
      meta: { label: "Test Mark", layoutFamily: "cartesian" },
      paint: () => { painted = true; },
      computeLayout: (width, height): ChartLayout => {
        laidOut = true;
        return { width, height, margin: { top: 0, right: 0, bottom: 0, left: 0 }, plotArea: { x: 0, y: 0, width, height } };
      },
      computeGeometry: () => {
        measured = true;
        return { type: "bars", rects: [] };
      },
    });

    const spec = specWithMark("__test_mark__");
    const layout = dispatchComputeLayout(100, 80, spec, data, theme);
    expect(laidOut).toBe(true);
    expect(layout.width).toBe(100);

    dispatchComputeGeometry(data, spec, layout, theme);
    expect(measured).toBe(true);

    // dispatchPaint only calls the mark painter here (no error bars/labels/layers).
    dispatchPaint({} as unknown as CanvasRenderingContext2D, data, spec, layout, theme);
    expect(painted).toBe(true);
  });

  it("falls back gracefully for an unregistered mark", () => {
    const spec = specWithMark("__does_not_exist__");
    // Layout falls back to bar; geometry is empty; paint is a no-op (no throw).
    expect(() => dispatchComputeLayout(100, 80, spec, data, theme)).not.toThrow();
    const layout = dispatchComputeLayout(100, 80, spec, data, theme);
    expect(dispatchComputeGeometry(data, spec, layout, theme)).toEqual({ type: "bars", rects: [] });
    expect(() => dispatchPaint({} as unknown as CanvasRenderingContext2D, data, spec, layout, theme)).not.toThrow();
  });
});

describe("isCartesianChart honors registered mark metadata", () => {
  const layoutFn = (width: number, height: number): ChartLayout =>
    ({ width, height, margin: { top: 0, right: 0, bottom: 0, left: 0 }, plotArea: { x: 0, y: 0, width, height } });

  it("keeps built-in classification", () => {
    expect(isCartesianChart("bar")).toBe(true);
    expect(isCartesianChart("line")).toBe(true);
    expect(isCartesianChart("pie")).toBe(false);
    expect(isCartesianChart("radar")).toBe(false);
    expect(isCartesianChart("sunburst")).toBe(false);
  });

  it("uses the registered layoutFamily for custom marks", () => {
    registerChartMark("__custom_radial__", {
      meta: { label: "Custom Radial", layoutFamily: "radial" },
      paint: () => {}, computeLayout: layoutFn, computeGeometry: () => ({ type: "bars", rects: [] }),
    });
    registerChartMark("__custom_cartesian__", {
      meta: { label: "Custom Cartesian", layoutFamily: "cartesian" },
      paint: () => {}, computeLayout: layoutFn, computeGeometry: () => ({ type: "bars", rects: [] }),
    });
    expect(isCartesianChart("__custom_radial__")).toBe(false);
    expect(isCartesianChart("__custom_cartesian__")).toBe(true);
  });

  it("defaults unknown marks to cartesian", () => {
    expect(isCartesianChart("__unregistered_mark__")).toBe(true);
  });
});
