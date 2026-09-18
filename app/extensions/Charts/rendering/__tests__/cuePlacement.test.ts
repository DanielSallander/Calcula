//! FILENAME: app/extensions/Charts/rendering/__tests__/cuePlacement.test.ts
// PURPOSE: IO-0, the placement spike's exit criterion: a ring anchored at
//          (series name, painter category index, label) lands on the datum that
//          holds the series' maximum, through the same hit geometry the
//          painters compute — on a grouped bar, a stacked bar, a horizontal
//          bar, a line, a pie, small multiples, and a FILTERED chart.
// CONTEXT: The fixtures are the determinism suite's own (chart-determinism
//          .test.ts makeData/makeSpec/makeLayout), so the geometry under test
//          is the geometry that suite already pins. The filtered case is the
//          one the design said would bite: the snapshot an insight is computed
//          on is painter-space, so an index taken from it lands right, while an
//          authoring-space index lands on the wrong category — and the label
//          check refuses it. Both directions are asserted.

import { describe, it, expect } from "vitest";
// Importing chartDispatch runs the built-in mark registrations (module side-effect).
import { dispatchComputeGeometry, dispatchComputeLayout } from "../chartDispatch";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { applyChartFilters } from "../../lib/chartFilters";
import {
  resolveCueTarget,
  resolveCue,
  cueContextOf,
  paintChartCues,
  CUE_RING_PAD,
  CUE_STYLES,
  CUE_EMPHASIS_LINE_WIDTH,
  type CuePaintContext,
} from "../cuePainter";
import type { ChartCue, ChartCueDatumAnchor } from "@api/chartCues";
import type { ParsedChartData, ChartSpec, ChartLayout, HitGeometry, BarRect } from "../../types";

// ============================================================================
// Fixtures (the determinism suite's shapes)
// ============================================================================

const CATEGORIES = ["Jan", "Feb", "Mar", "Apr", "May"];
const SALES = [100, 200, 300, 150, 250]; // max 300 at Mar (index 2)
const COST = [80, 120, 180, 90, 150]; // max 180 at Mar (index 2)

function makeData(
  categories: string[] = CATEGORIES,
  seriesMap: Record<string, number[]> = { Sales: SALES, Cost: COST },
): ParsedChartData {
  return {
    categories,
    series: Object.entries(seriesMap).map(([name, values]) => ({ name, values, color: null })),
  };
}

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    stacking: "none",
    transforms: [],
    encodings: {},
    annotations: [],
    dataPointOverrides: [],
    filters: [],
    gradientFill: null,
    stylePreset: null,
    ...overrides,
  } as ChartSpec;
}

function makeLayout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 40, right: 20, bottom: 40, left: 60 },
    plotArea: { x: 60, y: 40, width: 520, height: 320 },
  };
}

const theme = DEFAULT_CHART_THEME;

function geometryFor(data: ParsedChartData, spec: ChartSpec, layout: ChartLayout = makeLayout()): HitGeometry {
  return dispatchComputeGeometry(data, spec, layout, theme);
}

/** The anchor an insight mapper would hand over for "Sales is highest at Mar". */
function anchor(series = "Sales", categoryIndex = 2, categoryLabel = "Mar"): ChartCueDatumAnchor {
  return { type: "datum", series, categoryIndex, categoryLabel };
}

/** The bar rect at (series, category) in a bars geometry, for comparison. */
function rectAt(geometry: HitGeometry, seriesName: string, categoryIndex: number): BarRect {
  expect(geometry.type).toBe("bars");
  const r = (geometry as { rects: BarRect[] }).rects.find(
    (b) => b.seriesName === seriesName && b.categoryIndex === categoryIndex,
  );
  if (!r) throw new Error(`no rect for ${seriesName}@${categoryIndex}`);
  return r;
}

// ============================================================================
// Cartesian marks
// ============================================================================

describe("cue placement: bars", () => {
  it("grouped bar: the ring lands on the Sales bar for Mar, the tallest Sales bar", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar", stacking: "none" }));
    const r = resolveCueTarget(g, anchor(), cueContextOf(data));
    expect(r.ok).toBe(true);
    if (!r.ok || r.target.kind !== "rect") throw new Error("expected a rect");
    expect(r.target.rect).toEqual(rectAt(g, "Sales", 2));
    expect(r.target.rect.value).toBe(300);
    expect(r.target.rect.categoryName).toBe("Mar");
    // The tallest bar of its series, in pixels too.
    const salesRects = (g as { rects: BarRect[] }).rects.filter((b) => b.seriesName === "Sales");
    expect(Math.max(...salesRects.map((b) => b.height))).toBe(r.target.rect.height);
  });

  it("grouped bar: a cue on the Cost series lands on the Cost bar, not its neighbour", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar", stacking: "none" }));
    const r = resolveCueTarget(g, anchor("Cost"), cueContextOf(data));
    if (!r.ok || r.target.kind !== "rect") throw new Error("expected a rect");
    expect(r.target.rect.seriesName).toBe("Cost");
    expect(r.target.rect.value).toBe(180);
    // Grouped: the Cost bar sits to the right of the Sales bar in the same group.
    expect(r.target.rect.x).toBeGreaterThan(rectAt(g, "Sales", 2).x);
  });

  it("stacked bar: the ring lands on the Cost SEGMENT of the Mar stack", () => {
    const data = makeData();
    // Stacking is a mark option (`markOptions.stackMode`), not the top-level
    // `stacking` field the determinism suite sets — that one the painter ignores.
    const g = geometryFor(data, makeSpec({ mark: "bar", markOptions: { stackMode: "stacked" } }));
    const r = resolveCueTarget(g, anchor("Cost"), cueContextOf(data));
    if (!r.ok || r.target.kind !== "rect") throw new Error("expected a rect");
    const sales = rectAt(g, "Sales", 2);
    expect(r.target.rect.seriesName).toBe("Cost");
    // Stacked: same x as the Sales segment, sitting on top of it.
    expect(r.target.rect.x).toBe(sales.x);
    expect(r.target.rect.y + r.target.rect.height).toBeCloseTo(sales.y, 6);
  });

  it("horizontal bar: the ring lands on the longest Sales bar", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "horizontalBar" }));
    const r = resolveCueTarget(g, anchor(), cueContextOf(data));
    if (!r.ok || r.target.kind !== "rect") throw new Error("expected a rect");
    expect(r.target.rect.categoryName).toBe("Mar");
    const salesRects = (g as { rects: BarRect[] }).rects.filter((b) => b.seriesName === "Sales");
    expect(Math.max(...salesRects.map((b) => b.width))).toBe(r.target.rect.width);
  });
});

describe("cue placement: line", () => {
  it("the ring lands on the Mar point of the Sales line, the highest point", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "line" }));
    const r = resolveCueTarget(g, anchor(), cueContextOf(data));
    if (!r.ok || r.target.kind !== "point") throw new Error("expected a point");
    expect(r.target.marker.seriesName).toBe("Sales");
    expect(r.target.marker.categoryName).toBe("Mar");
    expect(r.target.marker.value).toBe(300);
    expect(g.type).toBe("points");
    const salesMarkers = (g as { markers: Array<{ seriesName: string; cy: number }> }).markers.filter(
      (m) => m.seriesName === "Sales",
    );
    // Canvas y grows downward: the highest value has the smallest cy.
    expect(Math.min(...salesMarkers.map((m) => m.cy))).toBe(r.target.marker.cy);
  });
});

describe("cue placement: pie", () => {
  it("the cue lands on the Mar slice, the largest, of the first series", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "pie" }));
    const r = resolveCueTarget(g, anchor(), cueContextOf(data));
    if (!r.ok || r.target.kind !== "slice") throw new Error("expected a slice");
    expect(r.target.arc.label).toBe("Mar");
    expect(r.target.arc.value).toBe(300);
    const arcs = (g as { arcs: Array<{ percent: number }> }).arcs;
    expect(Math.max(...arcs.map((a) => a.percent))).toBe(r.target.arc.percent);
  });

  it("a cue about a series the pie does not draw is refused, not put on the first series' slice", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "pie" }));
    const r = resolveCueTarget(g, anchor("Cost"), cueContextOf(data));
    expect(r).toEqual({ ok: false, reason: "series-not-drawn" });
  });
});

describe("cue placement: small multiples (composite geometry)", () => {
  it("finds the Cost panel's Mar bar inside the composite, offset into its cell", () => {
    const data = makeData();
    const spec = makeSpec({ mark: "bar", repeat: { columns: 2 } });
    const layout = dispatchComputeLayout(600, 400, spec, data, theme);
    const g = geometryFor(data, spec, layout);
    expect(g.type).toBe("composite");
    const r = resolveCueTarget(g, anchor("Cost"), cueContextOf(data));
    if (!r.ok || r.target.kind !== "rect") throw new Error("expected a rect");
    expect(r.target.rect.seriesName).toBe("Cost");
    expect(r.target.rect.categoryName).toBe("Mar");
    // The Cost panel is the second cell, so its bar sits in the right half.
    expect(r.target.rect.x).toBeGreaterThan(300);
  });
});

// ============================================================================
// The filtered chart — the case the design said would bite
// ============================================================================

describe("cue placement: filtered chart", () => {
  const data = makeData();
  // Hide Jan. Painter space is now [Feb, Mar, Apr, May]; Mar is painter index 1
  // and authoring index 2.
  const filtered = applyChartFilters(data, { hiddenSeries: [], hiddenCategories: [0] });

  it("the filter really moved Mar from index 2 to index 1", () => {
    expect(filtered.categories).toEqual(["Feb", "Mar", "Apr", "May"]);
    expect(filtered.keptCategoryIndices).toEqual([1, 2, 3, 4]);
  });

  it("a painter-space index (what the snapshot reports) lands on Mar", () => {
    const g = geometryFor(filtered, makeSpec({ mark: "bar" }));
    const r = resolveCueTarget(g, anchor("Sales", 1, "Mar"), cueContextOf(filtered));
    if (!r.ok || r.target.kind !== "rect") throw new Error("expected a rect");
    expect(r.target.rect.categoryName).toBe("Mar");
    expect(r.target.rect.value).toBe(300);
  });

  it("an authoring-space index would land on Apr, and the label check refuses it", () => {
    const g = geometryFor(filtered, makeSpec({ mark: "bar" }));
    // Index 2 in painter space is Apr — a real bar, the WRONG bar.
    expect(rectAt(g, "Sales", 2).categoryName).toBe("Apr");
    const r = resolveCueTarget(g, anchor("Sales", 2, "Mar"), cueContextOf(filtered));
    expect(r).toEqual({ ok: false, reason: "label-mismatch" });
  });

  it("the same holds on a filtered line and a filtered pie", () => {
    const line = geometryFor(filtered, makeSpec({ mark: "line" }));
    expect(resolveCueTarget(line, anchor("Sales", 1, "Mar"), cueContextOf(filtered)).ok).toBe(true);
    expect(resolveCueTarget(line, anchor("Sales", 2, "Mar"), cueContextOf(filtered))).toEqual({
      ok: false,
      reason: "label-mismatch",
    });
    const pie = geometryFor(filtered, makeSpec({ mark: "pie" }));
    expect(resolveCueTarget(pie, anchor("Sales", 1, "Mar"), cueContextOf(filtered)).ok).toBe(true);
    expect(resolveCueTarget(pie, anchor("Sales", 2, "Mar"), cueContextOf(filtered))).toEqual({
      ok: false,
      reason: "label-mismatch",
    });
  });
});

// ============================================================================
// Refusals
// ============================================================================

describe("cue placement: refusals", () => {
  it("a series the chart does not have resolves to nothing", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    expect(resolveCueTarget(g, anchor("Profit"), cueContextOf(data))).toEqual({ ok: false, reason: "no-such-datum" });
  });

  it("a category index past the end resolves to nothing", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    expect(resolveCueTarget(g, anchor("Sales", 9, "Mar"), cueContextOf(data))).toEqual({ ok: false, reason: "no-such-datum" });
  });

  it("a label that no longer matches the datum (the data changed) is refused", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    expect(resolveCueTarget(g, anchor("Sales", 2, "March"), cueContextOf(data))).toEqual({ ok: false, reason: "label-mismatch" });
  });

  it("is deterministic across repeated resolution", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar", markOptions: { stackMode: "stacked" } }));
    const first = JSON.stringify(resolveCueTarget(g, anchor("Cost"), cueContextOf(data)));
    for (let i = 0; i < 50; i++) {
      expect(JSON.stringify(resolveCueTarget(g, anchor("Cost"), cueContextOf(data)))).toBe(first);
    }
  });
});

// ============================================================================
// Painting — the ring is stroked where the datum is, offset into canvas space
// ============================================================================

interface Call { fn: string; args: unknown[] }

function recordingCtx(): { ctx: CuePaintContext; calls: Call[]; styles: string[]; dashes: number[][] } {
  const calls: Call[] = [];
  const styles: string[] = [];
  const dashes: number[][] = [];
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }); };
  const ctx = {
    save: rec("save"),
    restore: rec("restore"),
    beginPath: rec("beginPath"),
    ellipse: rec("ellipse"),
    arc: rec("arc"),
    stroke: rec("stroke"),
    fill: rec("fill"),
    fillRect: rec("fillRect"),
    fillText: rec("fillText"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    setLineDash: (d: number[]) => { dashes.push([...d]); calls.push({ fn: "setLineDash", args: [d] }); },
    lineWidth: 0,
    globalAlpha: 1,
    fillStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    _stroke: "" as string,
    get strokeStyle() { return this._stroke; },
    set strokeStyle(v: string) { this._stroke = v; styles.push(v); },
  } as unknown as CuePaintContext & { _stroke: string };
  return { ctx, calls, styles, dashes };
}

function cue(a: ChartCueDatumAnchor, polarity: ChartCue["polarity"] = "neutral"): ChartCue {
  return { cueId: `extremes:${a.series}#${a.categoryIndex}`, factId: `extremes:${a.series}`, kind: "ring", polarity, anchor: a };
}

describe("cue painting", () => {
  // A BAR gets a BOX, not an oval. An ellipse around a rectangle leaves four
  // wedges of background inside the mark while its sides cut across the bar's,
  // which is what made the cues hard to read on the owner's own chart.
  it("strokes a box around the resolved bar, translated by the chart's canvas origin", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    const rect = rectAt(g, "Sales", 2);
    const { ctx, calls } = recordingCtx();

    const drawn = paintChartCues(ctx, 1000, 500, g, data, [cue(anchor())]);

    expect(drawn).toBe(1);
    expect(calls.some((c) => c.fn === "ellipse"), "a bar is not round").toBe(false);

    // Five points: four corners and back to the first, so all four sides stroke.
    const path = calls.filter((c) => c.fn === "moveTo" || c.fn === "lineTo").map((c) => c.args as number[]);
    const left = 1000 + rect.x - CUE_RING_PAD;
    const right = 1000 + rect.x + rect.width + CUE_RING_PAD;
    const top = 500 + rect.y - CUE_RING_PAD;
    const bottom = 500 + rect.y + rect.height + CUE_RING_PAD;
    expect(path).toHaveLength(5);
    const corners: Array<[number, number]> = [
      [left, top], [right, top], [right, bottom], [left, bottom], [left, top],
    ];
    path.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(corners[i][0], 6);
      expect(y).toBeCloseTo(corners[i][1], 6);
    });
    expect(calls.filter((c) => c.fn === "stroke")).toHaveLength(1);
  });

  it("strokes a circle around the resolved line point and an arc along the resolved slice", () => {
    const data = makeData();
    const line = geometryFor(data, makeSpec({ mark: "line" }));
    const marker = (line as { markers: Array<{ seriesName: string; categoryIndex: number; cx: number; cy: number }> }).markers.find(
      (m) => m.seriesName === "Sales" && m.categoryIndex === 2,
    )!;
    let rec = recordingCtx();
    expect(paintChartCues(rec.ctx, 10, 20, line, data, [cue(anchor())])).toBe(1);
    let arc = rec.calls.find((c) => c.fn === "arc")!;
    expect((arc.args as number[])[0]).toBeCloseTo(10 + marker.cx, 6);
    expect((arc.args as number[])[1]).toBeCloseTo(20 + marker.cy, 6);

    const pie = geometryFor(data, makeSpec({ mark: "pie" }));
    const slice = (pie as { arcs: Array<{ label: string; centerX: number; centerY: number; outerRadius: number; startAngle: number; endAngle: number }> }).arcs.find(
      (a) => a.label === "Mar",
    )!;
    rec = recordingCtx();
    expect(paintChartCues(rec.ctx, 10, 20, pie, data, [cue(anchor())])).toBe(1);
    arc = rec.calls.find((c) => c.fn === "arc")!;
    const [ax, ay, ar, a0, a1] = arc.args as number[];
    expect(ax).toBeCloseTo(10 + slice.centerX, 6);
    expect(ay).toBeCloseTo(20 + slice.centerY, 6);
    expect(ar).toBeCloseTo(slice.outerRadius + CUE_RING_PAD, 6);
    expect(a0).toBe(slice.startAngle);
    expect(a1).toBe(slice.endAngle);
  });

  it("draws nothing for a cue that does not resolve, and says so in the count", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    const { ctx, calls } = recordingCtx();
    const drawn = paintChartCues(ctx, 0, 0, g, data, [cue(anchor("Sales", 2, "March")), cue(anchor("Profit"))]);
    expect(drawn).toBe(0);
    expect(calls.some((c) => c.fn === "ellipse" || c.fn === "arc" || c.fn === "stroke")).toBe(false);
  });

  it("emphasis on a SERIES strokes every datum of that series and nothing else", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    const r = resolveCue(g, { type: "series", series: "Cost" }, cueContextOf(data));
    if (!r.ok || r.shape.kind !== "many") throw new Error("expected many targets");
    expect(r.shape.targets).toHaveLength(5);
    for (const t of r.shape.targets) expect(t.kind === "rect" && t.rect.seriesName).toBe("Cost");

    const { ctx, calls } = recordingCtx();
    const drawn = paintChartCues(ctx, 0, 0, g, data, [
      { cueId: "leader#0", factId: "leader", kind: "emphasis", polarity: "good", anchor: { type: "series", series: "Cost" } },
    ]);
    expect(drawn).toBe(1);
    expect(calls.filter((c) => c.fn === "beginPath")).toHaveLength(5); // one box per bar
    expect(calls.filter((c) => c.fn === "moveTo")).toHaveLength(5);
    expect(calls.filter((c) => c.fn === "ellipse")).toHaveLength(0);
    expect(calls.filter((c) => c.fn === "stroke")).toHaveLength(5);
    expect(ctx.lineWidth).toBe(CUE_EMPHASIS_LINE_WIDTH);
    // A series the chart does not have is refused.
    expect(resolveCue(g, { type: "series", series: "Profit" }, cueContextOf(data))).toEqual({ ok: false, reason: "no-such-datum" });
  });

  it("a band over a span fills the x-extent of exactly those categories, over the plot's data extent", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    const r = resolveCue(g, { type: "span", series: "Sales", from: 2, to: 4 }, cueContextOf(data));
    if (!r.ok || r.shape.kind !== "xspan") throw new Error("expected an x-span");
    const mar = rectAt(g, "Sales", 2);
    const may = rectAt(g, "Sales", 4);
    expect(r.shape.x0).toBe(mar.x);
    expect(r.shape.x1).toBe(may.x + may.width);
    // Feb's bar lies outside the band.
    expect(rectAt(g, "Sales", 1).x + rectAt(g, "Sales", 1).width).toBeLessThanOrEqual(r.shape.x0);

    const { ctx, calls } = recordingCtx();
    paintChartCues(ctx, 100, 50, g, data, [
      { cueId: "cp#0", factId: "cp", kind: "band", polarity: "attention", anchor: { type: "span", series: "Sales", from: 2, to: 4 } },
    ]);
    const fill = calls.find((c) => c.fn === "fillRect")!;
    expect((fill.args as number[])[0]).toBeCloseTo(100 + mar.x, 6);
    expect((fill.args as number[])[2]).toBeCloseTo(may.x + may.width - mar.x, 6);
    expect(ctx.globalAlpha).toBe(1); // restored after the translucent fill
  });

  it("a callout rings the datum and writes its description above it", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "line" }));
    const { ctx, calls } = recordingCtx();
    paintChartCues(ctx, 0, 0, g, data, [
      { cueId: "t#0", factId: "t", kind: "callout", polarity: "good", anchor: anchor("Sales", 4, "May"), description: "Sales rising" },
    ]);
    const text = calls.find((c) => c.fn === "fillText")!;
    expect(text.args[0]).toBe("Sales rising");
    const marker = (g as { markers: Array<{ seriesName: string; categoryIndex: number; cx: number; cy: number }> }).markers.find(
      (m) => m.seriesName === "Sales" && m.categoryIndex === 4,
    )!;
    expect(text.args[1]).toBeCloseTo(marker.cx, 6);
    expect(text.args[2] as number).toBeLessThan(marker.cy);
  });

  it("a level anchor is refused with needs-scale until IO-3a draws it through the rule painter", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    expect(resolveCue(g, { type: "level", series: "Sales", value: 180 }, cueContextOf(data))).toEqual({ ok: false, reason: "needs-scale" });
    const { ctx, calls } = recordingCtx();
    expect(paintChartCues(ctx, 0, 0, g, data, [{ cueId: "f#0", factId: "f", kind: "rule", polarity: "attention", anchor: { type: "level", value: 180 } }])).toBe(0);
    expect(calls.some((c) => c.fn === "stroke" || c.fn === "fillRect")).toBe(false);
  });

  it("a band on a pie is refused: a wedge has no x-extent worth a band", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "pie" }));
    expect(resolveCue(g, { type: "span", series: "Sales", from: 1, to: 2 }, cueContextOf(data))).toEqual({ ok: false, reason: "not-drawable" });
  });

  it("draws with the DOCUMENT's style when one is declared, and with the defaults when it is cleared", async () => {
    const { setDocumentOverlayStyle, normalizeOverlayStyle } = await import("@api/insightStyle");
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    try {
      setDocumentOverlayStyle(normalizeOverlayStyle({ polarity: { bad: { color: "#800000", dash: [1, 1] } }, lineWidth: 4 }));
      const { ctx, styles, dashes } = recordingCtx();
      paintChartCues(ctx, 0, 0, g, data, [cue(anchor("Sales"), "bad"), cue(anchor("Cost"), "good")]);
      expect(styles).toEqual(["#800000", CUE_STYLES.good.stroke]); // bad restyled, good untouched
      expect(dashes[0]).toEqual([1, 1]);
      expect(ctx.lineWidth).toBe(4);
    } finally {
      setDocumentOverlayStyle(null);
    }
    const { ctx, styles } = recordingCtx();
    paintChartCues(ctx, 0, 0, g, data, [cue(anchor("Sales"), "bad")]);
    expect(styles).toEqual([CUE_STYLES.bad.stroke]);
  });

  it("colour and dash follow polarity, so shape carries the meaning where colour cannot", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    const { ctx, styles, dashes } = recordingCtx();
    paintChartCues(ctx, 0, 0, g, data, [
      cue(anchor("Sales"), "good"),
      cue(anchor("Cost"), "bad"),
      cue(anchor("Sales", 0, "Jan"), "attention"),
      cue(anchor("Cost", 0, "Jan"), "neutral"),
    ]);
    expect(styles).toEqual([CUE_STYLES.good.stroke, CUE_STYLES.bad.stroke, CUE_STYLES.attention.stroke, CUE_STYLES.neutral.stroke]);
    // Solid, solid, dashed, dotted — then the trailing reset.
    expect(dashes.slice(0, 4)).toEqual([[], [], [6, 4], [2, 3]]);
    expect(dashes[dashes.length - 1]).toEqual([]);
    expect(new Set(styles).size).toBe(4);
  });
});

// ============================================================================
// Level anchors: a rule on the value axis (IO-6 follow-up)
// ============================================================================

describe("level anchors", () => {
  const level = (value: number, series?: string): ChartCue => ({
    cueId: `outliers:Sales#${value}`, factId: "outliers:Sales", kind: "rule", polarity: "attention", description: "Outlier fence for Sales",
    anchor: { type: "level", ...(series ? { series } : {}), value },
  });

  it("is refused without a value scale, and resolves to a line at the chrome Y scale's row with one", async () => {
    const data = makeData();
    const spec = makeSpec({ mark: "bar" });
    const layout = makeLayout();
    const g = geometryFor(data, spec, layout);
    expect(resolveCue(g, level(180, "Sales").anchor, cueContextOf(data))).toEqual({ ok: false, reason: "needs-scale" });

    const { buildChromeYScale } = await import("../chartPainterUtils");
    const expectedY = buildChromeYScale(spec, data, [layout.plotArea.y + layout.plotArea.height, layout.plotArea.y]).scale(180);
    const r = resolveCue(g, level(180, "Sales").anchor, cueContextOf(data, { spec, layout, data }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.shape.kind).toBe("yline");
      if (r.shape.kind === "yline") {
        expect(r.shape.y).toBeCloseTo(expectedY, 6);
        expect(r.shape.x0).toBe(layout.plotArea.x);
        expect(r.shape.x1).toBe(layout.plotArea.x + layout.plotArea.width);
      }
    }
  });

  it("refuses a value outside the plot, a series not drawn, and any level on a pie", () => {
    const data = makeData();
    const spec = makeSpec({ mark: "bar" });
    const layout = makeLayout();
    const g = geometryFor(data, spec, layout);
    const scaled = cueContextOf(data, { spec, layout, data });
    expect(resolveCue(g, level(1e9, "Sales").anchor, scaled)).toEqual({ ok: false, reason: "not-drawable" });
    expect(resolveCue(g, level(180, "Nope").anchor, scaled)).toEqual({ ok: false, reason: "no-such-datum" });
    const pie = makeSpec({ mark: "pie" });
    expect(resolveCue(geometryFor(data, pie, layout), level(180, "Sales").anchor, cueContextOf(data, { spec: pie, layout, data }))).toEqual({ ok: false, reason: "needs-scale" });
  });

  it("paints a rule as one horizontal line across the plot with its description at the right", () => {
    const data = makeData();
    const spec = makeSpec({ mark: "bar" });
    const layout = makeLayout();
    const g = geometryFor(data, spec, layout);
    const { ctx, calls } = recordingCtx();
    expect(paintChartCues(ctx, 100, 50, g, data, [level(180, "Sales")], null, { spec, layout, data })).toBe(1);
    const move = calls.find((c) => c.fn === "moveTo")!;
    const line = calls.find((c) => c.fn === "lineTo")!;
    expect((move.args as number[])[0]).toBeCloseTo(100 + layout.plotArea.x, 6);
    expect((line.args as number[])[0]).toBeCloseTo(100 + layout.plotArea.x + layout.plotArea.width, 6);
    expect((move.args as number[])[1]).toBeCloseTo((line.args as number[])[1], 6);
    expect(calls.find((c) => c.fn === "fillText")?.args[0]).toBe("Outlier fence for Sales");
    // Without the scale the same cue paints nothing, and says so by count.
    expect(paintChartCues(recordingCtx().ctx, 100, 50, g, data, [level(180, "Sales")])).toBe(0);
  });
});

// ============================================================================
// Selection: ONE cue is heavier, not every cue of its fact
// ============================================================================

describe("the selected cue", () => {
  /** A context that captures ctx.lineWidth as each stroke is issued. */
  function widthRecordingCtx(): { ctx: CuePaintContext; widths: number[] } {
    const widths: number[] = [];
    const ctx = {
      save: () => undefined, restore: () => undefined, beginPath: () => undefined,
      ellipse: () => undefined, arc: () => undefined, fill: () => undefined,
      fillRect: () => undefined, fillText: () => undefined,
      moveTo: () => undefined, lineTo: () => undefined, setLineDash: () => undefined,
      stroke() { widths.push((this as { lineWidth: number }).lineWidth); },
      lineWidth: 0, globalAlpha: 1, fillStyle: "", strokeStyle: "",
      font: "", textAlign: "left", textBaseline: "alphabetic",
    } as unknown as CuePaintContext;
    return { ctx, widths };
  }

  // `extremes` rings the highest bar AND the lowest under ONE fact id. Drawing
  // both heavier tells the reader they picked something they did not, and it is
  // the same confusion that put a comment on the wrong bar.
  it("is heavier alone, even when its fact owns another cue", () => {
    const data = makeData();
    const g = geometryFor(data, makeSpec({ mark: "bar" }));
    const highest: ChartCue = { ...cue(anchor("Sales", 4, "May")), cueId: "extremes:Sales#0" };
    const lowest: ChartCue = { ...cue(anchor("Sales", 0, "Jan")), cueId: "extremes:Sales#1" };
    expect(highest.factId).toBe(lowest.factId);

    const { ctx, widths } = widthRecordingCtx();
    expect(paintChartCues(ctx, 0, 0, g, data, [highest, lowest], lowest.cueId)).toBe(2);
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeLessThan(widths[1]); // the highest plain, the lowest heavier

    // And with nothing selected, neither is.
    const plain = widthRecordingCtx();
    paintChartCues(plain.ctx, 0, 0, g, data, [highest, lowest], null);
    expect(plain.widths[0]).toBe(plain.widths[1]);
    expect(plain.widths[0]).toBe(widths[0]);
  });
});
