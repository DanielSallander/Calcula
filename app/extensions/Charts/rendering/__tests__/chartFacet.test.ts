//! FILENAME: app/extensions/Charts/rendering/__tests__/chartFacet.test.ts
// PURPOSE: Faceting (spec.facet) — the per-panel fan-out in dispatchPaint over
//          precomputed data.facets. Composed above the painters (like repeat),
//          so this verifies the composition layer (tiling, shared X/Y, guards)
//          in isolation via a custom counting mark + stub ctx.

import { describe, it, expect } from "vitest";
// Importing chartDispatch runs the built-in registrations (module side-effect).
import { dispatchPaint, dispatchComputeGeometry } from "../chartDispatch";
import { registerChartMark } from "../markRegistry";
import { resolveChartTheme } from "../chartTheme";
import type { ChartSpec, ChartType, ParsedChartData, ChartLayout } from "../../types";

const theme = resolveChartTheme(undefined);

/** A canvas stub: paintFaceted only calls these transform/clip primitives. */
const stubCtx = {
  save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {},
} as unknown as CanvasRenderingContext2D;

const layoutFn = (width: number, height: number): ChartLayout => ({
  width, height, margin: { top: 0, right: 0, bottom: 0, left: 0 }, plotArea: { x: 0, y: 0, width, height },
});

function facetSpec(mark: string, overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: mark as ChartType,
    data: "A1:C6",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 1,
    series: [],
    title: "Parent title",
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    facet: { field: "Region" },
    ...overrides,
  };
}

// Two panels with DIFFERENT category sets (to exercise the shared-X union).
const faceted: ParsedChartData = {
  categories: ["Jan", "Feb", "Mar"],
  series: [{ name: "Sales", values: [0, 0, 0], color: null }],
  facets: [
    { value: "North", data: { categories: ["Jan", "Feb"], series: [{ name: "Sales", values: [10, 20], color: null }] } },
    { value: "South", data: { categories: ["Feb", "Mar"], series: [{ name: "Sales", values: [40, 5], color: null }] } },
  ],
};

/** Register a mark that records each panel paint, returns the captured calls. */
function recordingMark(name: string): Array<{ spec: ChartSpec; data: ParsedChartData }> {
  const calls: Array<{ spec: ChartSpec; data: ParsedChartData }> = [];
  registerChartMark(name, {
    meta: { label: name, layoutFamily: "cartesian" },
    paint: (_ctx, d, s) => { calls.push({ spec: s as ChartSpec, data: d as ParsedChartData }); },
    computeLayout: layoutFn,
    computeGeometry: () => ({ type: "bars", rects: [] }),
  });
  return calls;
}

describe("dispatchPaint faceting", () => {
  it("paints one panel per facet, titled with the facet value", () => {
    const calls = recordingMark("__facet_count__");
    dispatchPaint(stubCtx, faceted, facetSpec("__facet_count__"), layoutFn(200, 200), theme);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.spec.title)).toEqual(["North", "South"]);
    // Legend off, composition fields stripped per panel.
    for (const c of calls) {
      expect(c.spec.legend.visible).toBe(false);
      expect(c.spec.facet).toBeUndefined();
      expect(c.spec.dataTable).toBeUndefined();
    }
  });

  it("shares the X scale as the ordered union of panel categories", () => {
    const calls = recordingMark("__facet_unionx__");
    dispatchPaint(stubCtx, faceted, facetSpec("__facet_unionx__"), layoutFn(200, 200), theme);
    // Union of ["Jan","Feb"] and ["Feb","Mar"] = ["Jan","Feb","Mar"]; missing -> 0.
    expect(calls[0].data.categories).toEqual(["Jan", "Feb", "Mar"]);
    expect(calls[0].data.series[0].values).toEqual([10, 20, 0]); // North: no Mar
    expect(calls[1].data.series[0].values).toEqual([0, 40, 5]);  // South: no Jan
  });

  it("keeps per-panel categories when sharedXScale is false", () => {
    const calls = recordingMark("__facet_indepx__");
    dispatchPaint(stubCtx, faceted, facetSpec("__facet_indepx__", { facet: { field: "Region", sharedXScale: false } }), layoutFn(200, 200), theme);
    expect(calls[0].data.categories).toEqual(["Jan", "Feb"]);
    expect(calls[1].data.categories).toEqual(["Feb", "Mar"]);
  });

  it("shares one Y domain across panels (covering 0-fills) by default", () => {
    const calls = recordingMark("__facet_sharedy__");
    dispatchPaint(stubCtx, faceted, facetSpec("__facet_sharedy__"), layoutFn(200, 200), theme);
    // Aligned values across panels: 10,20,0,0,40,5 -> min 0, max 40 for every panel.
    for (const c of calls) {
      expect(c.spec.yAxis.min).toBe(0);
      expect(c.spec.yAxis.max).toBe(40);
    }
  });

  it("leaves the Y scale independent when sharedYScale is false", () => {
    const calls = recordingMark("__facet_indepy__");
    dispatchPaint(stubCtx, faceted, facetSpec("__facet_indepy__", { facet: { field: "Region", sharedYScale: false } }), layoutFn(200, 200), theme);
    for (const c of calls) expect(c.spec.yAxis.min).toBeNull();
  });

  it("honors an explicit column count via the shared repeatLayout helper", () => {
    // 2 panels, columns:1 -> stacked; just assert it still paints both (no throw).
    const calls = recordingMark("__facet_cols__");
    dispatchPaint(stubCtx, faceted, facetSpec("__facet_cols__", { facet: { field: "Region", columns: 1 } }), layoutFn(200, 200), theme);
    expect(calls).toHaveLength(2);
  });

  it("takes precedence over repeat when both are set", () => {
    const calls = recordingMark("__facet_wins__");
    const spec = facetSpec("__facet_wins__", { repeat: { columns: 2 } });
    dispatchPaint(stubCtx, faceted, spec, layoutFn(200, 200), theme);
    // Faceted: 2 panels titled by facet value (not repeated per series).
    expect(calls.map((c) => c.spec.title)).toEqual(["North", "South"]);
  });

  it("keeps per-panel categories (no union) when a panel repeats a label", () => {
    // Shared-X union would de-dupe the second "Jan" and drop its row; the safe
    // fallback keeps every row by not aligning when duplicates are present.
    const calls = recordingMark("__facet_dup__");
    const dup: ParsedChartData = {
      categories: [], series: [],
      facets: [
        { value: "North", data: { categories: ["Jan", "Jan", "Feb"], series: [{ name: "Sales", values: [1, 2, 3], color: null }] } },
        { value: "South", data: { categories: ["Jan", "Feb"], series: [{ name: "Sales", values: [4, 5], color: null }] } },
      ],
    };
    dispatchPaint(stubCtx, dup, facetSpec("__facet_dup__"), layoutFn(200, 200), theme);
    expect(calls[0].data.categories).toEqual(["Jan", "Jan", "Feb"]);
    expect(calls[0].data.series[0].values).toEqual([1, 2, 3]);
  });

  it("preserves a typed categoryField (proportional X) instead of aligning", () => {
    // Numeric/temporal X must not be flattened to a nominal union (0-fill would
    // also inject spurious points), so alignment is skipped when typed.
    const calls = recordingMark("__facet_typed__");
    const typed: ParsedChartData = {
      categories: [], series: [],
      facets: [
        { value: "A", data: { categories: ["1", "2"], series: [{ name: "y", values: [10, 20], color: null }], categoryField: { type: "quantitative", values: [1, 2] } } },
        { value: "B", data: { categories: ["3", "4"], series: [{ name: "y", values: [30, 40], color: null }], categoryField: { type: "quantitative", values: [3, 4] } } },
      ],
    };
    dispatchPaint(stubCtx, typed, facetSpec("__facet_typed__"), layoutFn(200, 200), theme);
    expect(calls[0].data.categories).toEqual(["1", "2"]);
    expect(calls[0].data.categoryField).toEqual({ type: "quantitative", values: [1, 2] });
  });

  it("has no per-datum hit geometry while faceting", () => {
    const spec = facetSpec("bar");
    expect(dispatchComputeGeometry(faceted, spec, layoutFn(200, 200), theme)).toEqual({ type: "bars", rects: [] });
  });

  it("falls through to a single chart when facet is set but no panels exist", () => {
    const calls = recordingMark("__facet_empty__");
    const noFacets: ParsedChartData = { categories: ["a"], series: [{ name: "s", values: [1], color: null }] };
    // facet set, but data.facets undefined -> normal single paint (one call).
    dispatchPaint(stubCtx, noFacets, facetSpec("__facet_empty__"), layoutFn(200, 200), theme);
    expect(calls).toHaveLength(1);
    expect(calls[0].spec.title).toBe("Parent title");
    // And geometry falls through to the real mark (empty for this stub mark, not the facet guard).
    expect(() => dispatchComputeGeometry(noFacets, facetSpec("__facet_empty__"), layoutFn(200, 200), theme)).not.toThrow();
  });
});
