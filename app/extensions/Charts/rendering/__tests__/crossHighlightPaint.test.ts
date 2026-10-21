//! FILENAME: app/extensions/Charts/rendering/__tests__/crossHighlightPaint.test.ts
// PURPOSE: Pin the cross-filter paint passes (P4, S5): a bar / column draws the
//          faded whole and then the highlighted portion, a pie / donut an
//          inner arc at the area-proportional radius, scatter / bubble dim a
//          point with nothing under the highlight, and a SOURCE chart fades
//          the datums its own selection does not hold.
// CONTEXT: THE BASELINE. With neither `highlightValues` nor `crossFilterSelf`
//          present, every painter must draw exactly what it drew before P4.
//          The "unchanged call log" block below is a SNAPSHOT of each
//          painter's ordered canvas stream (calls AND style sets), recorded
//          against the painters BEFORE the highlight passes were added: a
//          painter whose plain path moved by one call, one alpha set or one
//          coordinate fails it.

import { describe, it, expect } from "vitest";
import "../chartDispatch";
import { getChartMark } from "@api/chartMarks";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ParsedChartData, ChartMarkType } from "../../types";
import { makeRecordingCtx } from "./dispatch-recordingCtx";

// ============================================================================
// Fixtures
// ============================================================================

function makeSpec(mark: ChartMarkType, overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { startRow: 0, startCol: 0, endRow: 3, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...overrides,
  } as ChartSpec;
}

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["East", "West", "North"],
    series: [
      { name: "Sales", values: [100, 200, -50], color: null },
      { name: "Cost", values: [40, 80, 30], color: null },
    ],
    ...overrides,
  };
}

/** Paint `mark` into a recording context; the ordered stream of calls and style sets. */
function paint(mark: ChartMarkType, data: ParsedChartData, spec: ChartSpec = makeSpec(mark)): string[] {
  const def = getChartMark(mark);
  if (!def) throw new Error(`mark ${mark} is not registered`);
  const { ctx, calls } = makeRecordingCtx(600, 400);
  const layout = def.computeLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
  def.paint(ctx, data, spec, layout, DEFAULT_CHART_THEME);
  return calls;
}

const STACKED: Partial<ChartSpec> = { markOptions: { stackMode: "stacked" } } as Partial<ChartSpec>;

const BASELINE_CASES: Array<{ name: string; mark: ChartMarkType; spec?: Partial<ChartSpec> }> = [
  { name: "bar (clustered)", mark: "bar" },
  { name: "bar (stacked)", mark: "bar", spec: STACKED },
  { name: "horizontalBar (clustered)", mark: "horizontalBar" },
  { name: "horizontalBar (stacked)", mark: "horizontalBar", spec: STACKED },
  { name: "pie", mark: "pie" },
  { name: "donut", mark: "donut" },
  { name: "scatter", mark: "scatter" },
  { name: "bubble", mark: "bubble" },
];

// ============================================================================
// The plain path is unchanged
// ============================================================================

describe("no highlight, no own selection: the painters' call log is unchanged", () => {
  for (const c of BASELINE_CASES) {
    it(c.name, () => {
      expect(paint(c.mark, makeData(), makeSpec(c.mark, c.spec))).toMatchSnapshot();
    });
  }
});

// ============================================================================
// The highlight and own-selection passes
// ============================================================================

/** The alpha in force at every fill (`fill()` / `fillRect(...)`) of a stream, in order. */
function fillAlphas(calls: readonly string[]): number[] {
  let alpha = 1;
  const out: number[] = [];
  for (const c of calls) {
    if (c.startsWith("globalAlpha=")) alpha = Number(c.slice("globalAlpha=".length));
    else if (c === "fill()" || c.startsWith("fillRect(")) out.push(alpha);
  }
  return out;
}

// Series x category, aligned with makeData(): Sales [100, 200, -50], Cost [40, 80, 30].
const HIGHLIGHT = [
  [50, 200, -25], // half, whole, half of a NEGATIVE bar (mirrors)
  [0, 80, 30], // nothing, whole, whole
];

describe("bar / column: the faded whole, then the highlighted portion", () => {
  it("clustered: two fills per highlighted datum (0.4 then 1.0), one faded fill where nothing is highlighted", () => {
    const plain = paint("bar", makeData());
    expect(fillAlphas(plain)).toEqual([1, 1, 1, 1, 1, 1]);

    const calls = paint("bar", makeData({ highlightValues: HIGHLIGHT }));
    // Datums in paint order (category outer, series inner):
    // (East,Sales) .5 | (East,Cost) 0 | (West,Sales) 1 | (West,Cost) 1 | (North,Sales) .5 | (North,Cost) 1
    expect(fillAlphas(calls)).toEqual([0.4, 1, 0.4, 0.4, 1, 0.4, 1, 0.4, 1, 0.4, 1]);
    // The alpha is left at 1 after every datum, as the plain path leaves it.
    expect(calls.filter((c) => c.startsWith("globalAlpha=")).at(-1)).toBe("globalAlpha=1");
  });

  it("the portion grows from the bar's own baseline: half of East/Sales tops out at mid-bar, half of a negative bar hangs from zero", () => {
    const calls = paint("bar", makeData({ highlightValues: HIGHLIGHT }));
    // East/Sales spans y 155.2..298.4 (the plain snapshot); its half portion spans 226.8..298.4.
    expect(calls).toContain("moveTo(63.8846,226.8)");
    // North/Sales (-50) spans y 298.4..370; its half portion spans 298.4..334.2, from the zero line DOWN.
    expect(calls).toContain("quadraticCurveTo(492.5,334.2,490.5,334.2)");
  });

  it("stacked: every segment takes the same two passes", () => {
    const calls = paint("bar", makeData({ highlightValues: HIGHLIGHT }), makeSpec("bar", STACKED));
    expect(fillAlphas(calls)).toEqual([0.4, 1, 0.4, 0.4, 1, 0.4, 1, 0.4, 1, 0.4, 1]);
  });

  it("horizontal bar (clustered and stacked): the same passes", () => {
    for (const spec of [makeSpec("horizontalBar"), makeSpec("horizontalBar", STACKED)]) {
      const calls = paint("horizontalBar", makeData({ highlightValues: HIGHLIGHT }), spec);
      expect(fillAlphas(calls)).toEqual([0.4, 1, 0.4, 0.4, 1, 0.4, 1, 0.4, 1, 0.4, 1]);
    }
  });

  it("a SOURCE fades the datums its own selection does not hold (one faded fill each), and keeps the held one at full strength", () => {
    const datums = [
      [true, false, false],
      [false, false, false],
    ];
    const calls = paint(
      "bar",
      makeData({ crossFilterSelf: { categories: [true, false, false], series: [true, false], datums } }),
    );
    expect(fillAlphas(calls)).toEqual([1, 0.4, 0.4, 0.4, 0.4, 0.4]);
  });
});

describe("pie / donut: the faded slice, then an inner arc holding the highlighted share of its AREA", () => {
  const PIE_HIGHLIGHT = [[25, 200, 0]];

  it("pie: a quarter of a slice is the arc at radius R * sqrt(1/4) = R / 2", () => {
    const calls = paint("pie", makeData({ highlightValues: PIE_HIGHLIGHT }));
    // The plain slice 0 is arc(300,200,188,...): the quarter's arc is at 94.
    expect(calls).toContain("arc(300,200,94,-1.5621,0.5149)");
    // Slice 1 is wholly highlighted: its inner arc is the whole radius.
    const slice1 = calls.filter((c) => c === "arc(300,200,188,0.5323,4.6862)");
    expect(slice1).toHaveLength(2);
    // Each slice: the faded whole (0.4), then the arc at full strength.
    expect(fillAlphas(calls)).toEqual([0.4, 1, 0.4, 1]);
  });

  it("donut: the arc's radius keeps the ring's area proportion (not its depth)", () => {
    const calls = paint("donut", makeData({ highlightValues: PIE_HIGHLIGHT }));
    // Inner radius 94 (0.5 x 188); a quarter of the ring's area ends at
    // sqrt(94^2 + 0.25 * (188^2 - 94^2)) = 124.3503.
    expect(calls).toContain("arc(300,200,124.3503,-1.5621,0.5149)");
    expect(fillAlphas(calls)).toEqual([0.4, 1, 0.4, 1]);
  });
});

describe("scatter / bubble: a point the highlight does not reach is dimmed", () => {
  it("scatter: exactly the points with nothing under the highlight are painted at 0.25", () => {
    const calls = paint("scatter", makeData({ highlightValues: [[0, 200, -50], [40, 0, 0]] }));
    // Points in paint order (series outer): S/East dim, S/West, S/North, C/East, C/West dim, C/North dim.
    expect(fillAlphas(calls)).toEqual([0.25, 1, 1, 1, 0.25, 0.25]);
  });

  it("bubble: the dimmed alpha multiplies the bubble's own opacity", () => {
    const plain = paint("bubble", makeData());
    expect(fillAlphas(plain)).toEqual([0.7, 0.7, 0.7]);
    const calls = paint("bubble", makeData({ highlightValues: [[100, 0, 0], [40, 80, 30]] }));
    expect(fillAlphas(calls)).toEqual([0.7, 0.175, 0.175]);
  });

  it("a source scatter dims what its own selection does not hold", () => {
    const datums = [
      [false, true, false],
      [false, false, false],
    ];
    const calls = paint("scatter", makeData({ crossFilterSelf: { categories: [false, true, false], datums } }));
    expect(fillAlphas(calls)).toEqual([0.25, 1, 0.25, 0.25, 0.25, 0.25]);
  });
});
