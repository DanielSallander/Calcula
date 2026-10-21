//! FILENAME: app/extensions/Charts/rendering/__tests__/chartMarkCrossFilterDeclarations.test.ts
// PURPOSE: The built-in marks' cross-filter declarations (P4 spec 2.3), asked
//          through the public capability (@api/chartMarks chartMarkCrossFilter)
//          over EVERY registered built-in mark -- so a mark added later
//          without a declaration is a filter-only target that is never a
//          source (fail closed), and this table says so out loud.

import { describe, it, expect } from "vitest";
import "../chartDispatch";
import { chartMarkCrossFilter, getChartMarkMeta, listChartMarks } from "@api/chartMarks";

const HIGHLIGHT = { source: true, canHighlight: true };
const SOURCE_ONLY = { source: true, canHighlight: false };
const NEITHER = { source: false, canHighlight: false };

/** Spec 2.3: every mark not named here declares nothing. */
const DECLARED: Record<string, { source: boolean; canHighlight: boolean }> = {
  bar: HIGHLIGHT,
  horizontalBar: HIGHLIGHT,
  pie: HIGHLIGHT,
  donut: HIGHLIGHT,
  scatter: HIGHLIGHT,
  bubble: HIGHLIGHT,
  line: SOURCE_ONLY,
  area: SOURCE_ONLY,
};

describe("built-in marks declare their part in cross-filtering", () => {
  const builtins = listChartMarks().filter((m) => getChartMarkMeta(m)?.builtin === true);

  it("the built-in list is the one the table speaks about (no mark lost)", () => {
    for (const m of Object.keys(DECLARED)) expect(builtins).toContain(m);
    // The tiles are built in, and declare nothing.
    for (const m of ["card", "multiRowCard", "kpi", "gauge"]) expect(builtins).toContain(m);
  });

  for (const mark of [
    "bar", "horizontalBar", "pie", "donut", "scatter", "bubble", "line", "area",
    "card", "multiRowCard", "kpi", "gauge", "waterfall", "combo", "radar", "histogram",
    "funnel", "treemap", "stock", "boxPlot", "sunburst", "pareto",
  ]) {
    it(`${mark}: ${JSON.stringify(DECLARED[mark] ?? NEITHER)}`, () => {
      expect(chartMarkCrossFilter(mark)).toEqual(DECLARED[mark] ?? NEITHER);
    });
  }

  it("every registered built-in answers exactly its declaration (or neither)", () => {
    for (const m of builtins) expect(chartMarkCrossFilter(m)).toEqual(DECLARED[m] ?? NEITHER);
  });

  it("an unknown mark is neither (fail closed)", () => {
    expect(chartMarkCrossFilter("no-such-mark")).toEqual(NEITHER);
  });
});
