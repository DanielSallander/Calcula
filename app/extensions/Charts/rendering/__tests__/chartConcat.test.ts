//! FILENAME: app/extensions/Charts/rendering/__tests__/chartConcat.test.ts
// PURPOSE: Concatenation (spec.concat) — the per-panel fan-out in dispatchPaint
//          over precomputed data.concat. Each panel is a FULL independent chart
//          (own spec + data), painted recursively via dispatchPaint. Verified in
//          isolation with custom recording marks + a stub ctx.

import { describe, it, expect } from "vitest";
import { dispatchPaint, dispatchComputeGeometry } from "../chartDispatch";
import { registerChartMark } from "../markRegistry";
import { resolveChartTheme } from "../chartTheme";
import type { ChartSpec, ChartType, ParsedChartData, ChartLayout } from "../../types";

const theme = resolveChartTheme(undefined);

const stubCtx = {
  save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {},
} as unknown as CanvasRenderingContext2D;

const layoutFn = (width: number, height: number): ChartLayout => ({
  width, height, margin: { top: 0, right: 0, bottom: 0, left: 0 }, plotArea: { x: 0, y: 0, width, height },
});

/** A complete child ChartSpec (concat panels are full, independent charts). */
function childSpec(mark: string, title: string): ChartSpec {
  return {
    mark: mark as ChartType,
    data: "Sheet1!A1:B3",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: title, sourceIndex: 1, color: null }],
    title,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
  };
}

const dataA: ParsedChartData = { categories: ["x"], series: [{ name: "a", values: [1], color: null }] };
const dataB: ParsedChartData = { categories: ["y"], series: [{ name: "b", values: [2], color: null }] };

/** Container parsed-data carrying two resolved concat panels. */
function concatData(specA: ChartSpec, specB: ChartSpec): ParsedChartData {
  return {
    categories: [], series: [],
    concat: [{ spec: specA, data: dataA }, { spec: specB, data: dataB }],
  };
}

/** Container spec (its own mark only matters on the no-panels fall-through). */
function containerSpec(charts: ChartSpec[], columns?: number, mark = "__concat_rec__"): ChartSpec {
  return { ...childSpec(mark, "container"), concat: { charts, columns } };
}

function recordingMark(name: string): Array<{ title: string | null; mark: string; data: ParsedChartData }> {
  const calls: Array<{ title: string | null; mark: string; data: ParsedChartData }> = [];
  registerChartMark(name, {
    meta: { label: name, layoutFamily: "cartesian" },
    paint: (_ctx, d, s) => { const sp = s as ChartSpec; calls.push({ title: sp.title, mark: sp.mark, data: d as ParsedChartData }); },
    computeLayout: layoutFn,
    computeGeometry: () => ({ type: "bars", rects: [] }),
  });
  return calls;
}

describe("dispatchPaint concatenation", () => {
  it("paints each child as a full chart with its own spec + data", () => {
    const calls = recordingMark("__concat_rec__");
    const a = childSpec("__concat_rec__", "A");
    const b = childSpec("__concat_rec__", "B");
    dispatchPaint(stubCtx, concatData(a, b), containerSpec([a, b]), layoutFn(200, 200), theme);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.title)).toEqual(["A", "B"]);
    expect(calls[0].data.categories).toEqual(["x"]);
    expect(calls[1].data.categories).toEqual(["y"]);
  });

  it("lets panels use different marks (independent specs)", () => {
    const barCalls = recordingMark("__concat_bar__");
    const lineCalls = recordingMark("__concat_line__");
    const a = childSpec("__concat_bar__", "Bars");
    const b = childSpec("__concat_line__", "Line");
    dispatchPaint(stubCtx, concatData(a, b), containerSpec([a, b]), layoutFn(200, 200), theme);
    expect(barCalls).toHaveLength(1);
    expect(lineCalls).toHaveLength(1);
    expect(barCalls[0].mark).toBe("__concat_bar__");
    expect(lineCalls[0].mark).toBe("__concat_line__");
  });

  it("takes precedence over facet and repeat when several are set", () => {
    const calls = recordingMark("__concat_wins__");
    const a = childSpec("__concat_wins__", "A");
    const b = childSpec("__concat_wins__", "B");
    const data: ParsedChartData = {
      categories: [], series: [],
      concat: [{ spec: a, data: dataA }, { spec: b, data: dataB }],
      facets: [{ value: "F", data: dataA }],
    };
    const spec: ChartSpec = { ...containerSpec([a, b]), facet: { field: "Region" }, repeat: { columns: 2 } };
    dispatchPaint(stubCtx, data, spec, layoutFn(200, 200), theme);
    // Concat won: two panels titled by child spec, not one facet panel.
    expect(calls.map((c) => c.title)).toEqual(["A", "B"]);
  });

  it("honors the container column count (no throw)", () => {
    const calls = recordingMark("__concat_cols__");
    const a = childSpec("__concat_cols__", "A");
    const b = childSpec("__concat_cols__", "B");
    dispatchPaint(stubCtx, concatData(a, b), containerSpec([a, b], 1), layoutFn(200, 200), theme);
    expect(calls).toHaveLength(2);
  });

  it("has no per-datum hit geometry while concatenating", () => {
    const a = childSpec("bar", "A");
    const b = childSpec("bar", "B");
    expect(dispatchComputeGeometry(concatData(a, b), containerSpec([a, b]), layoutFn(200, 200), theme)).toEqual({ type: "bars", rects: [] });
  });

  it("falls through to a single chart when concat is set but no panels exist", () => {
    const calls = recordingMark("__concat_empty__");
    const single: ParsedChartData = { categories: ["a"], series: [{ name: "s", values: [1], color: null }] };
    dispatchPaint(stubCtx, single, containerSpec([], undefined, "__concat_empty__"), layoutFn(200, 200), theme);
    // No data.concat -> normal single paint of the container spec.
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe("container");
  });
});
