//! FILENAME: app/extensions/Charts/rendering/__tests__/comboStackedDefault.test.ts
// PURPOSE: "Line and stacked column" with NO seriesMarks (what the Visuals
//          gallery inserts) draws a STACK: every series but the last is a
//          column and the last is the line. The old default (only series 0 a
//          column) left the stack one member long, so the preset drew exactly
//          the clustered picture (canvas-review visuals finding).

import { describe, it, expect } from "vitest";
import type { ChartSpec, ParsedChartData, BarRect, HitGeometry } from "../../types";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { computeComboLayout, computeComboHitGeometry, comboDefaultSeriesMark } from "../comboChartPainter";

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
    // NO seriesMarks: the preset as the gallery inserts it.
    markOptions: { ...markOptions },
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

describe("combo default series marks", () => {
  it("stacked, no seriesMarks: series 0 and 1 are stacked columns and series 2 is the line", () => {
    const { rects } = geometry(spec({ stackMode: "stacked" }));
    expect(rects.some((r) => r.seriesIndex === 2)).toBe(false);
    for (let ci = 0; ci < 3; ci++) {
      const a = rect(rects, 0, ci);
      const b = rect(rects, 1, ci);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y + b.height).toBeCloseTo(a.y, 6);
    }
  });

  it("stacked and clustered presets no longer draw the same picture", () => {
    const stacked = geometry(spec({ stackMode: "stacked" })).rects.map((r) => [r.seriesIndex, r.categoryIndex, Math.round(r.x), Math.round(r.y)].join(","));
    const clustered = geometry(spec({ stackMode: "none" })).rects.map((r) => [r.seriesIndex, r.categoryIndex, Math.round(r.x), Math.round(r.y)].join(","));
    expect(stacked).not.toEqual(clustered);
  });

  it("clustered keeps the old default: series 0 the column, the rest lines", () => {
    const { rects } = geometry(spec({ stackMode: "none" }));
    expect(new Set(rects.map((r) => r.seriesIndex))).toEqual(new Set([0]));
  });

  it("seriesMarks still wins over the default", () => {
    const { rects } = geometry(spec({ stackMode: "stacked", seriesMarks: { 0: "bar", 1: "line", 2: "line" } }));
    expect(new Set(rects.map((r) => r.seriesIndex))).toEqual(new Set([0]));
  });

  it("the rule itself", () => {
    expect([0, 1, 2].map((si) => comboDefaultSeriesMark(si, 3, true))).toEqual(["bar", "bar", "line"]);
    expect([0, 1, 2].map((si) => comboDefaultSeriesMark(si, 3, false))).toEqual(["bar", "line", "line"]);
    expect(comboDefaultSeriesMark(0, 1, true)).toBe("bar");
  });
});
