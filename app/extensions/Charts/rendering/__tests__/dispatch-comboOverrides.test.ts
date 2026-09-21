//! FILENAME: app/extensions/Charts/rendering/__tests__/dispatch-comboOverrides.test.ts
// PURPOSE: The combo painter must honour per-point DataPointOverrides through
//          the ONE shared resolver, and must change exactly the datum that was
//          overridden — no more, no less.
// CONTEXT: "I cannot select a single data point, a bar for example, and change
//          the color of only this bar." For the combo mark that was literally
//          true: comboChartPainter never imported lib/dataPointOverrides.

import { describe, it, expect } from "vitest";
import { computeComboLayout, paintComboChart } from "../comboChartPainter";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ComboMarkOptions, DataPointOverride, ParsedChartData } from "../../types";
import { DATA_POINT_KEY_SEPARATOR } from "../../types";
import { makeRecordingCtx, streamDiff } from "./dispatch-recordingCtx";

// ============================================================================
// Fixtures
// ============================================================================

function makeData(
  categories: string[],
  seriesData: Array<{ name: string; values: number[] }>,
  extra: Partial<ParsedChartData> = {},
): ParsedChartData {
  return {
    categories,
    series: seriesData.map((s) => ({ ...s, color: null })),
    ...extra,
  };
}

function makeSpec(
  opts?: Partial<ComboMarkOptions>,
  overrides?: DataPointOverride[],
): ChartSpec {
  return {
    mark: "combo",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Trend", sourceIndex: 2, color: null },
    ],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions: opts,
    dataPointOverrides: overrides,
  };
}

const DATA = makeData(
  ["Q1", "Q2", "Q3", "Q4"],
  [
    { name: "Revenue", values: [100, 150, 130, 180] },
    { name: "Trend", values: [110, 125, 140, 160] },
  ],
);

/** Every `arc()` radius in the stream, in paint order. Combo uses arc only for
 *  line/area point markers, so this sequence is the marker pass structure. */
function arcRadii(calls: string[]): number[] {
  return calls
    .filter((c) => c.startsWith("arc("))
    .map((c) => Number(c.slice(4, -1).split(",")[2]));
}

/** Paint once and return the ordered ctx stream. */
function paint(spec: ChartSpec, data: ParsedChartData = DATA): string[] {
  const { ctx, calls } = makeRecordingCtx();
  const layout = computeComboLayout(600, 400, spec, data, DEFAULT_CHART_THEME);
  paintComboChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
  return calls;
}

// ============================================================================
// Bars
// ============================================================================

describe("combo bars honour per-point overrides", () => {
  const BAR_OPTS: Partial<ComboMarkOptions> = { seriesMarks: { 0: "bar", 1: "bar" } };

  it("an override on one bar changes the stream", () => {
    const plain = paint(makeSpec(BAR_OPTS));
    const styled = paint(
      makeSpec(BAR_OPTS, [{ seriesIndex: 0, categoryIndex: 2, color: "#ff0000" }]),
    );
    expect(styled).not.toEqual(plain);
  });

  it("changes EXACTLY one entry, and that entry is the overridden fill", () => {
    const plain = paint(makeSpec(BAR_OPTS));
    const styled = paint(
      makeSpec(BAR_OPTS, [{ seriesIndex: 0, categoryIndex: 2, color: "#ff0000" }]),
    );
    const diff = streamDiff(plain, styled);
    expect(diff).toHaveLength(1);
    expect(styled[diff[0]]).toBe("fillStyle=#ff0000");
    // ...and the entry it replaced was a fill, not some unrelated call.
    expect(plain[diff[0]]).toMatch(/^fillStyle=/);
    expect(plain[diff[0]]).not.toBe("fillStyle=#ff0000");
  });

  it("an override on a DIFFERENT category changes a DIFFERENT entry", () => {
    const plain = paint(makeSpec(BAR_OPTS));
    const q3 = streamDiff(
      plain,
      paint(makeSpec(BAR_OPTS, [{ seriesIndex: 0, categoryIndex: 2, color: "#ff0000" }])),
    );
    const q1 = streamDiff(
      plain,
      paint(makeSpec(BAR_OPTS, [{ seriesIndex: 0, categoryIndex: 0, color: "#ff0000" }])),
    );
    expect(q3).toHaveLength(1);
    expect(q1).toHaveLength(1);
    expect(q1[0]).not.toBe(q3[0]);
    // Bars are painted category-major, so Q1's bar comes first in the stream.
    expect(q1[0]).toBeLessThan(q3[0]);
  });

  it("an override on the SECOND bar series hits the second bar, not the first", () => {
    const plain = paint(makeSpec(BAR_OPTS));
    const s0 = streamDiff(
      plain,
      paint(makeSpec(BAR_OPTS, [{ seriesIndex: 0, categoryIndex: 1, color: "#ff0000" }])),
    );
    const s1 = streamDiff(
      plain,
      paint(makeSpec(BAR_OPTS, [{ seriesIndex: 1, categoryIndex: 1, color: "#ff0000" }])),
    );
    expect(s0).toHaveLength(1);
    expect(s1).toHaveLength(1);
    expect(s1[0]).toBeGreaterThan(s0[0]);
  });

  it("an override opacity wraps only that bar in a globalAlpha window", () => {
    const plain = paint(makeSpec(BAR_OPTS));
    const styled = paint(
      makeSpec(BAR_OPTS, [{ seriesIndex: 1, categoryIndex: 3, opacity: 0.25 }]),
    );
    // Two extra entries: the alpha set and the reset back to 1.
    expect(styled.length).toBe(plain.length + 2);
    expect(styled.filter((c) => c === "globalAlpha=0.25")).toHaveLength(1);
  });

  it("an override border strokes that bar and nothing else", () => {
    const plain = paint(makeSpec(BAR_OPTS));
    const styled = paint(
      makeSpec(BAR_OPTS, [
        { seriesIndex: 0, categoryIndex: 0, borderColor: "#123456", borderWidth: 3 },
      ]),
    );
    expect(styled).toContain("strokeStyle=#123456");
    expect(plain).not.toContain("strokeStyle=#123456");
    // Exactly one bar gained a stroke: strokeRect / stroke count rises by 1.
    const strokes = (s: string[]) => s.filter((c) => c.startsWith("strokeRect(") || c === "stroke()").length;
    expect(strokes(styled)).toBe(strokes(plain) + 1);
  });

  it("no override leaves the stream byte-identical to the unstyled paint", () => {
    expect(paint(makeSpec(BAR_OPTS, []))).toEqual(paint(makeSpec(BAR_OPTS)));
    expect(
      paint(makeSpec(BAR_OPTS, [{ seriesIndex: 9, categoryIndex: 9, color: "#ff0000" }])),
    ).toEqual(paint(makeSpec(BAR_OPTS)));
  });
});

// ============================================================================
// Line markers
// ============================================================================

describe("combo line markers honour per-point overrides", () => {
  const LINE_OPTS: Partial<ComboMarkOptions> = { seriesMarks: { 0: "line", 1: "line" } };

  it("a colour override recolours exactly one marker", () => {
    const plain = paint(makeSpec(LINE_OPTS));
    const styled = paint(
      makeSpec(LINE_OPTS, [{ seriesIndex: 1, categoryIndex: 2, color: "#00aa00" }]),
    );
    const diff = streamDiff(plain, styled);
    expect(diff).toHaveLength(1);
    expect(styled[diff[0]]).toBe("fillStyle=#00aa00");
  });

  it("a markerSize override resizes the outer disc AND its white core", () => {
    const plain = paint(makeSpec(LINE_OPTS));
    const styled = paint(
      makeSpec(LINE_OPTS, [{ seriesIndex: 0, categoryIndex: 1, markerSize: 10 }]),
    );
    const diff = streamDiff(plain, styled);
    // One arc in the outer pass, one in the white-core pass.
    expect(diff).toHaveLength(2);
    expect(styled[diff[0]]).toMatch(/^arc\([^,]+,[^,]+,10,/);
    expect(styled[diff[1]]).toMatch(/^arc\([^,]+,[^,]+,5,/);
  });

  it('markerStyle "none" removes that one marker from both passes', () => {
    const plain = paint(makeSpec(LINE_OPTS));
    const styled = paint(
      makeSpec(LINE_OPTS, [{ seriesIndex: 0, categoryIndex: 3, markerStyle: "none" }]),
    );
    const arcs = (s: string[]) => s.filter((c) => c.startsWith("arc(")).length;
    expect(arcs(plain) - arcs(styled)).toBe(2);
  });

  it("the white-core pass still runs AFTER every outer disc", () => {
    // Load-bearing z-order: interleaving the passes would let a neighbouring
    // marker's outer disc paint over an already drawn core. `arc` is used only
    // by the markers here, so the radii sequence IS the pass structure: four
    // outer discs then four cores, per line series.
    const radii = arcRadii(paint(makeSpec(LINE_OPTS)));
    expect(radii).toEqual([4, 4, 4, 4, 2, 2, 2, 2, 4, 4, 4, 4, 2, 2, 2, 2]);
  });

  it("an override keeps the two-pass order rather than interleaving", () => {
    const radii = arcRadii(
      paint(makeSpec(LINE_OPTS, [{ seriesIndex: 0, categoryIndex: 1, markerSize: 10 }])),
    );
    expect(radii).toEqual([4, 10, 4, 4, 2, 5, 2, 2, 4, 4, 4, 4, 2, 2, 2, 2]);
  });
});

// ============================================================================
// The painter -> authoring index translation
// ============================================================================

describe("combo resolves overrides in AUTHORING space", () => {
  // Authoring series 0 is filtered out; painter series 0 IS authoring series 1.
  const FILTERED = makeData(
    ["Q1", "Q2", "Q3", "Q4"],
    [{ name: "Trend", values: [110, 125, 140, 160] }],
    { keptSeriesIndices: [1] },
  );
  const OPTS: Partial<ComboMarkOptions> = { seriesMarks: { 0: "bar" } };

  it("an override authored against the SURVIVING series still lands", () => {
    const plain = paint(makeSpec(OPTS), FILTERED);
    const styled = paint(
      makeSpec(OPTS, [{ seriesIndex: 1, categoryIndex: 0, color: "#ff0000" }]),
      FILTERED,
    );
    const diff = streamDiff(plain, styled);
    expect(diff).toHaveLength(1);
    expect(styled[diff[0]]).toBe("fillStyle=#ff0000");
  });

  it("an override authored against the HIDDEN series does not alias onto it", () => {
    const plain = paint(makeSpec(OPTS), FILTERED);
    const styled = paint(
      makeSpec(OPTS, [{ seriesIndex: 0, categoryIndex: 0, color: "#ff0000" }]),
      FILTERED,
    );
    expect(styled).toEqual(plain);
  });

  it("a hidden CATEGORY shifts the override the same way", () => {
    const catFiltered = makeData(
      ["Q2", "Q3"],
      [{ name: "Revenue", values: [150, 130] }],
      { keptCategoryIndices: [1, 2] },
    );
    const plain = paint(makeSpec(OPTS), catFiltered);
    const authored = paint(
      makeSpec(OPTS, [{ seriesIndex: 0, categoryIndex: 2, color: "#ff0000" }]),
      catFiltered,
    );
    const naive = paint(
      makeSpec(OPTS, [{ seriesIndex: 0, categoryIndex: 1, color: "#ff0000" }]),
      catFiltered,
    );
    const diffAuthored = streamDiff(plain, authored);
    const diffNaive = streamDiff(plain, naive);
    expect(diffAuthored).toHaveLength(1);
    expect(diffNaive).toHaveLength(1);
    // Authoring index 2 is the SECOND painted bar; a painter that skipped the
    // translation would have coloured the first.
    expect(diffAuthored[0]).toBeGreaterThan(diffNaive[0]);
  });

  it("a key-matched override survives a category insert that shifts the index", () => {
    // The override names ("Revenue", "Q3") by key but carries a now-stale index.
    const styled = paint(
      makeSpec(OPTS, [
        {
          seriesIndex: 0,
          categoryIndex: 0,
          key: `Revenue${DATA_POINT_KEY_SEPARATOR}Q3`,
          color: "#ff0000",
        },
      ]),
      DATA,
    );
    const plain = paint(makeSpec(OPTS), DATA);
    const diff = streamDiff(plain, styled);
    expect(diff).toHaveLength(1);
    const byIndex = streamDiff(
      plain,
      paint(makeSpec(OPTS, [{ seriesIndex: 0, categoryIndex: 0, color: "#ff0000" }]), DATA),
    );
    // Q3 is the third bar, not the first: the key beat the stale index.
    expect(diff[0]).toBeGreaterThan(byIndex[0]);
  });
});
