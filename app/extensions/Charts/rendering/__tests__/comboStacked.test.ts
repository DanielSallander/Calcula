//! FILENAME: app/extensions/Charts/rendering/__tests__/comboStacked.test.ts
// PURPOSE: Power BI's "Line and stacked column": a combo whose BAR series stack
//          (ComboMarkOptions.stackMode "stacked") while its lines stay lines.
//          Before this, combo bars were always side by side
//          (`barX = groupX + bi * (barWidth + barGap)`), so the variant had no
//          spelling at all.
// CONTEXT: The painter and the hit geometry read ONE bar layout
//          (`comboBarRects`), so what is clicked is what is painted; this file
//          checks both, on the recording context.

import { describe, it, expect } from "vitest";
import type { ChartSpec, ParsedChartData, BarRect, HitGeometry } from "../../types";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { computeComboLayout, computeComboHitGeometry, paintComboChart } from "../comboChartPainter";
import { makeRecordingCtx, streamDiff } from "./dispatch-recordingCtx";

const THEME = DEFAULT_CHART_THEME;

const DATA: ParsedChartData = {
  categories: ["Q1", "Q2", "Q3"],
  series: [
    { name: "North", values: [10, 20, 30], color: null },
    { name: "South", values: [5, 15, 25], color: null },
    { name: "Margin", values: [12, 22, 40], color: null },
  ],
};

function spec(markOptions: Record<string, unknown>): ChartSpec {
  return {
    mark: "combo",
    data: "Sheet1!A1:D4",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    // Series 0 and 1 are columns, series 2 the line.
    markOptions: { seriesMarks: { 0: "bar", 1: "bar", 2: "line" }, ...markOptions },
  } as ChartSpec;
}

function barsOf(g: HitGeometry): BarRect[] {
  if (g.type === "bars") return g.rects;
  if (g.type === "composite") return g.groups.flatMap(barsOf);
  return [];
}

function rect(rects: BarRect[], si: number, ci: number): BarRect {
  const r = rects.find((x) => x.seriesIndex === si && x.categoryIndex === ci);
  if (!r) throw new Error(`no bar for ${si},${ci}`);
  return r;
}

function geometry(s: ChartSpec, d: ParsedChartData = DATA) {
  const layout = computeComboLayout(600, 400, s, d, THEME);
  return { layout, rects: barsOf(computeComboHitGeometry(d, s, layout, THEME)) };
}

describe("combo stackMode: stacked columns under a line", () => {
  it("stacked: the bars of one category share x and width, the second on top of the first", () => {
    const { rects } = geometry(spec({ stackMode: "stacked" }));
    for (let ci = 0; ci < 3; ci++) {
      const a = rect(rects, 0, ci);
      const b = rect(rects, 1, ci);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.width).toBeCloseTo(a.width, 6);
      // b sits directly on a: its bottom edge is a's top edge.
      expect(b.y + b.height).toBeCloseTo(a.y, 6);
    }
  });

  it("stacked: the value axis grows to hold the whole stack (55 at Q3), not just the tallest series", () => {
    const { rects, layout } = geometry(spec({ stackMode: "stacked" }));
    const top = rect(rects, 1, 2);
    expect(top.y).toBeGreaterThanOrEqual(layout.plotArea.y - 1e-6);
    // Q3's stack (30 + 25) is the tallest bar in the plot.
    const q3 = rect(rects, 0, 2).height + top.height;
    const q1 = rect(rects, 0, 0).height + rect(rects, 1, 0).height;
    expect(q3 / q1).toBeCloseTo(55 / 15, 1);
  });

  it("clustered (the default and 'none'): side by side, as before", () => {
    for (const opts of [{}, { stackMode: "none" }]) {
      const { rects } = geometry(spec(opts));
      const a = rect(rects, 0, 1);
      const b = rect(rects, 1, 1);
      expect(b.x).toBeGreaterThan(a.x + a.width - 1e-6);
      expect(b.y + b.height).toBeCloseTo(a.y + a.height, 6); // same baseline
    }
  });

  it("a negative value stacks DOWN from zero, apart from the positive stack", () => {
    const d: ParsedChartData = {
      categories: ["Q1"],
      series: [
        { name: "A", values: [10], color: null },
        { name: "B", values: [-4], color: null },
        { name: "L", values: [3], color: null },
      ],
    };
    const { rects } = geometry(spec({ stackMode: "stacked" }), d);
    const a = rect(rects, 0, 0);
    const b = rect(rects, 1, 0);
    // B hangs below A's baseline instead of being stacked on its top.
    expect(b.y).toBeCloseTo(a.y + a.height, 6);
  });

  it("the line series is not stacked and still has its markers", () => {
    const layout = computeComboLayout(600, 400, spec({ stackMode: "stacked" }), DATA, THEME);
    const g = computeComboHitGeometry(DATA, spec({ stackMode: "stacked" }), layout, THEME);
    expect(g.type).toBe("composite");
    if (g.type !== "composite") return;
    const points = g.groups.find((x) => x.type === "points");
    expect(points && points.type === "points" ? points.markers.map((m) => m.seriesIndex) : []).toEqual([2, 2, 2]);
  });

  it("paint draws every bar where the hit geometry says it is", () => {
    const s = spec({ stackMode: "stacked" });
    const { layout, rects } = geometry(s);
    const { ctx, calls } = makeRecordingCtx(600, 400);
    paintComboChart(ctx, DATA, s, layout, THEME);
    const r = THEME.barBorderRadius;
    const round = (v: number): string => String(Math.round(v * 10000) / 10000);
    for (const b of rects) {
      // drawRoundedRect starts at (x + r, y); a short bar is a plain fillRect.
      const rounded = `moveTo(${round(b.x + r)},${round(b.y)})`;
      const plain = `fillRect(${round(b.x)},${round(b.y)},${round(b.width)},${round(b.height)})`;
      expect(calls.includes(rounded) || calls.includes(plain), `bar ${b.seriesIndex},${b.categoryIndex}`).toBe(true);
    }
  });

  it("stacked and clustered paint differently (the option reaches the canvas)", () => {
    const paint = (s: ChartSpec): string[] => {
      const layout = computeComboLayout(600, 400, s, DATA, THEME);
      const { ctx, calls } = makeRecordingCtx(600, 400);
      paintComboChart(ctx, DATA, s, layout, THEME);
      return calls;
    };
    expect(streamDiff(paint(spec({ stackMode: "stacked" })), paint(spec({ stackMode: "none" })))).not.toEqual([]);
  });
});
