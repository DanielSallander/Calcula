//! FILENAME: app/extensions/Charts/rendering/__tests__/chartElementRects.test.ts
// PURPOSE: Pin ChartLayout.elements — the rectangles that give a chart title,
//          an axis title and a legend entry an identity they can be hit-tested,
//          selected and edited by.
// CONTEXT: Three things have to hold at once and all three are easy to break:
//          (1) this is a REFACTOR of arithmetic the layout already did, so the
//          plot must not move by a pixel; (2) the layout's rects are ESTIMATES
//          (~7px/char) and the painters' write-backs are MEASURED truth, so the
//          write-back has to actually replace the estimate; (3) several stages
//          mutate margin/plotArea after layout, so reflow has to recompute.

import { describe, it, expect, vi } from "vitest";
import {
  computeCartesianLayout,
  computeRadialLayout,
  drawTitle,
  drawLegend,
  drawCartesianAxes,
  reflowChartElements,
  recordChartElementRect,
  rectContains,
} from "../chartPainterUtils";
import { createBandScale, createScaleFromSpec } from "../scales";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ParsedChartData, ChartLayout } from "../../types";
import type { ChartMarkLayout } from "@api/chartMarks";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Helpers
// ============================================================================

/** Text width in this mock is exactly 6px per character — see MOCK_CHAR_PX. */
const MOCK_CHAR_PX = 6;

interface Recorded {
  fillTexts: Array<{ text: string; x: number; y: number }>;
  fillRects: Array<{ x: number; y: number; w: number; h: number }>;
}

function makeCtx(): { ctx: CanvasRenderingContext2D; rec: Recorded } {
  const rec: Recorded = { fillTexts: [], fillRects: [] };
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "left", textBaseline: "top",
    fillText: (text: string, x: number, y: number) => rec.fillTexts.push({ text, x, y }),
    fillRect: (x: number, y: number, w: number, h: number) => rec.fillRects.push({ x, y, w, h }),
    measureText: (t: string) => ({ width: t.length * MOCK_CHAR_PX }),
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    setLineDash: vi.fn(), closePath: vi.fn(), arc: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, rec };
}

const AXIS = {
  gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null,
} as const;

/** The representative spec the pixel assertions below are computed from. */
function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Revenue", sourceIndex: 1, color: null }],
    title: "Quarterly Revenue",
    xAxis: { ...AXIS, title: "Quarter" },
    yAxis: { ...AXIS, gridLines: true, title: "USD" },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...overrides,
  };
}

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["Q1", "Q2", "Q3", "Q4"],
    series: [{ name: "Revenue", values: [120, -45, 300, 210], color: null }],
    ...overrides,
  };
}

const W = 600;
const H = 400;

// ============================================================================
// (1) The plot did not move
// ============================================================================

describe("layout refactor leaves the plot area alone", () => {
  // Hand-derived from the documented arithmetic, NOT read back from the code:
  //   top    = 12 + (titleFontSize 14 + 8)                         = 34
  //   left   = 16 + max(len("300") * 7, 20) + 4 + (11 + 6)         = 58
  //   bottom = 12 + (labelFontSize 10 + 8) + (11 + 6) + (10 + 16)  = 73
  //   right  = 16
  it("cartesian margins and plot area are exactly the pre-refactor values", () => {
    const layout = computeCartesianLayout(W, H, makeSpec(), makeData(), DEFAULT_CHART_THEME);
    expect(layout.margin).toEqual({ top: 34, right: 16, bottom: 73, left: 58 });
    expect(layout.plotArea).toEqual({ x: 58, y: 34, width: 526, height: 293 });
  });

  //   top = 34, right = 16 + min(3 * 6, 100) + 24 = 58, bottom = 12, left = 16
  it("radial margins and plot area are exactly the pre-refactor values", () => {
    const spec = makeSpec({ mark: "pie", legend: { visible: true, position: "right" } });
    const layout = computeRadialLayout(W, H, spec, makeData(), DEFAULT_CHART_THEME);
    expect(layout.margin).toEqual({ top: 34, right: 58, bottom: 12, left: 16 });
    expect(layout.plotArea).toEqual({ x: 16, y: 34, width: 526, height: 354 });
  });

  it("plot area still equals the margin box for every legend position", () => {
    for (const position of ["top", "bottom", "left", "right"] as const) {
      const layout = computeCartesianLayout(
        W, H, makeSpec({ legend: { visible: true, position } }), makeData(), DEFAULT_CHART_THEME,
      );
      expect(layout.plotArea.x).toBe(layout.margin.left);
      expect(layout.plotArea.y).toBe(layout.margin.top);
      expect(layout.plotArea.width).toBe(W - layout.margin.left - layout.margin.right);
      expect(layout.plotArea.height).toBe(H - layout.margin.top - layout.margin.bottom);
    }
  });
});

// ============================================================================
// (2) The layout produces rects at all
// ============================================================================

describe("computeCartesianLayout element rects", () => {
  const layout = computeCartesianLayout(W, H, makeSpec(), makeData(), DEFAULT_CHART_THEME);
  const els = layout.elements!;

  it("records the family and the whole canvas", () => {
    expect(els.family).toBe("cartesian");
    expect(els.chartArea).toEqual({ x: 0, y: 0, width: W, height: H });
    expect(els.measured).toEqual([]);
  });

  it("gives the title a rectangle at all (it had none before)", () => {
    expect(els.title).toBeDefined();
    expect(els.title!.y).toBe(10);
    expect(els.title!.height).toBe(DEFAULT_CHART_THEME.titleFontSize);
    expect(rectContains(els.title!, W / 2, 10)).toBe(true);
  });

  it("puts the axis label bands against the plot edges", () => {
    // x band: directly below the plot, as wide as the plot.
    expect(els.xAxisBand).toEqual({ x: 58, y: 327, width: 526, height: 18 });
    // y band: 25px wide (max(3 chars * 7, 20) + 4), ending at the axis line.
    expect(els.yAxisBand).toEqual({ x: 33, y: 34, width: 25, height: 293 });
  });

  it("puts the x axis title below the label band and the y axis title on its side", () => {
    expect(els.xAxisTitle!.y + els.xAxisTitle!.height).toBe(327 + 30);
    // Rotated -90deg: one font-size WIDE and the text length TALL.
    expect(els.yAxisTitle!.x).toBe(14);
    expect(els.yAxisTitle!.width).toBe(DEFAULT_CHART_THEME.axisTitleFontSize);
    expect(els.yAxisTitle!.height).toBeGreaterThan(els.yAxisTitle!.width);
  });

  it("gives one rect per series in the legend", () => {
    const two = makeData({
      series: [
        { name: "Revenue", values: [120, -45, 300, 210], color: null },
        { name: "Cost", values: [10, 20, 30, 40], color: null },
      ],
    });
    const l = computeCartesianLayout(W, H, makeSpec(), two, DEFAULT_CHART_THEME);
    expect(l.elements!.legendItems).toHaveLength(2);
    expect(l.elements!.legendItems!.map((i) => i.seriesIndex)).toEqual([0, 1]);
    expect(l.elements!.legend).toBeDefined();
  });

  it("omits the rect for an element that is switched off", () => {
    const bare = computeCartesianLayout(
      W, H,
      makeSpec({
        title: null,
        xAxis: { ...AXIS, title: null, showLabels: false },
        yAxis: { ...AXIS, title: null, showLabels: false },
        legend: { visible: false, position: "bottom" },
      }),
      makeData(), DEFAULT_CHART_THEME,
    );
    const e = bare.elements!;
    expect(e.title).toBeUndefined();
    expect(e.xAxisTitle).toBeUndefined();
    expect(e.yAxisTitle).toBeUndefined();
    expect(e.xAxisBand).toBeUndefined();
    expect(e.yAxisBand).toBeUndefined();
    expect(e.legend).toBeUndefined();
  });

  it("radial layouts carry a title and a category legend but no axes", () => {
    const spec = makeSpec({ mark: "pie", legend: { visible: true, position: "right" } });
    const l = computeRadialLayout(W, H, spec, makeData(), DEFAULT_CHART_THEME);
    const e = l.elements!;
    expect(e.family).toBe("radial");
    expect(e.title).toBeDefined();
    expect(e.xAxisBand).toBeUndefined();
    expect(e.yAxisBand).toBeUndefined();
    // One legend entry per CATEGORY (a pie's legend lists slices, not series).
    expect(e.legendItems).toHaveLength(4);
  });
});

// ============================================================================
// (3) The painters write measured truth back
// ============================================================================

describe("painter write-back replaces the layout estimate", () => {
  it("drawTitle records the box the title is actually painted in", () => {
    const spec = makeSpec();
    const layout = computeCartesianLayout(W, H, spec, makeData(), DEFAULT_CHART_THEME);
    const estimate = { ...layout.elements!.title! };
    const { ctx, rec } = makeCtx();

    drawTitle(ctx, spec.title!, layout, DEFAULT_CHART_THEME);

    const painted = rec.fillTexts.find((t) => t.text === spec.title);
    expect(painted).toBeDefined();

    const rect = layout.elements!.title!;
    // The measured rect CONTAINS the pixel the title is painted at (centre of
    // the glyph run, top baseline) — the whole point of having a rect.
    expect(rectContains(rect, painted!.x, painted!.y)).toBe(true);
    expect(rectContains(rect, painted!.x, painted!.y + DEFAULT_CHART_THEME.titleFontSize / 2)).toBe(true);

    // Measured, not estimated: 17 chars * 6px = 102 wide, centred on 300.
    expect(rect.width).toBe(spec.title!.length * MOCK_CHAR_PX);
    expect(rect.x).toBe(W / 2 - rect.width / 2);
    expect(rect.width).not.toBe(estimate.width);
    expect(layout.elements!.measured).toContain("title");
  });

  it("the legend rects line up with the swatches actually painted", () => {
    const spec = makeSpec();
    const data = makeData({
      series: [
        { name: "Revenue", values: [120, -45, 300, 210], color: null },
        { name: "Cost", values: [10, 20, 30, 40], color: null },
      ],
    });
    const layout = computeCartesianLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const { ctx, rec } = makeCtx();

    drawLegend(ctx, data, spec, layout, DEFAULT_CHART_THEME);

    const items = layout.elements!.legendItems!;
    expect(items).toHaveLength(2);
    // Measured widths: swatch 10 + padding 4 + 6px/char.
    expect(items[0].rect.width).toBe(10 + 4 + "Revenue".length * MOCK_CHAR_PX);
    expect(items[1].rect.width).toBe(10 + 4 + "Cost".length * MOCK_CHAR_PX);

    // Every swatch that was painted sits inside its own entry's rect.
    const swatches = rec.fillRects.filter((r) => r.w === 10 && r.h === 10);
    expect(swatches).toHaveLength(2);
    for (let i = 0; i < swatches.length; i++) {
      expect(rectContains(items[i].rect, swatches[i].x, swatches[i].y)).toBe(true);
      expect(rectContains(items[i].rect, swatches[i].x + 10, swatches[i].y + 10)).toBe(true);
    }
    // ...and every label too.
    const labels = rec.fillTexts.filter((t) => t.text === "Revenue" || t.text === "Cost");
    expect(labels).toHaveLength(2);
    for (let i = 0; i < labels.length; i++) {
      expect(rectContains(items[i].rect, labels[i].x, labels[i].y)).toBe(true);
    }

    expect(layout.elements!.legend!.width).toBeGreaterThan(0);
    expect(layout.elements!.measured).toContain("legend");
  });

  it("drawCartesianAxes writes the axis titles back when handed the layout", () => {
    const spec = makeSpec();
    const data = makeData();
    const layout = computeCartesianLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const estimateX = { ...layout.elements!.xAxisTitle! };
    const { ctx, rec } = makeCtx();
    const pa = layout.plotArea;
    const xScale = createBandScale(data.categories, [pa.x, pa.x + pa.width], 0.3);
    const yScale = createScaleFromSpec(undefined, [0, 300], [pa.y + pa.height, pa.y]);

    drawCartesianAxes(ctx, xScale, yScale, pa, spec, DEFAULT_CHART_THEME, layout);

    const xTitle = layout.elements!.xAxisTitle!;
    expect(xTitle.width).toBe("Quarter".length * MOCK_CHAR_PX);
    expect(xTitle.width).not.toBe(estimateX.width);
    const paintedX = rec.fillTexts.find((t) => t.text === "Quarter")!;
    // Painted with a "bottom" baseline, so the box ends at the paint y.
    expect(rectContains(xTitle, paintedX.x, paintedX.y - 1)).toBe(true);

    const yTitle = layout.elements!.yAxisTitle!;
    expect(yTitle.height).toBe("USD".length * MOCK_CHAR_PX);
    expect(layout.elements!.measured).toEqual(
      expect.arrayContaining(["xAxisTitle", "yAxisTitle", "yAxisBand"]),
    );
  });

  it("omitting the layout paints identically and leaves the estimates alone", () => {
    const spec = makeSpec();
    const data = makeData();
    const withLayout = computeCartesianLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const without = computeCartesianLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const pa = withLayout.plotArea;
    const xScale = createBandScale(data.categories, [pa.x, pa.x + pa.width], 0.3);
    const yScale = createScaleFromSpec(undefined, [0, 300], [pa.y + pa.height, pa.y]);

    const a = makeCtx();
    const b = makeCtx();
    drawCartesianAxes(a.ctx, xScale, yScale, pa, spec, DEFAULT_CHART_THEME, withLayout);
    drawCartesianAxes(b.ctx, xScale, yScale, without.plotArea, spec, DEFAULT_CHART_THEME);

    expect(b.rec.fillTexts).toEqual(a.rec.fillTexts);
    expect(without.elements!.measured).toEqual([]);
  });
});

// ============================================================================
// (4) The reflow contract
// ============================================================================

describe("reflowChartElements", () => {
  it("moves the plot-relative rects when a later stage steals the bottom margin", () => {
    const spec = makeSpec();
    const data = makeData();
    const layout = computeCartesianLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const beforeXTitleY = layout.elements!.xAxisTitle!.y;
    const beforeTitle = { ...layout.elements!.title! };

    // Exactly what chartDispatch does for a data table.
    const dtHeight = 60;
    layout.plotArea.height = Math.max(layout.plotArea.height - dtHeight, 40);
    layout.margin.bottom += dtHeight;
    reflowChartElements(layout, spec, data, DEFAULT_CHART_THEME);

    expect(layout.elements!.xAxisTitle!.y).toBe(beforeXTitleY - dtHeight);
    expect(layout.elements!.xAxisBand!.y).toBe(layout.plotArea.y + layout.plotArea.height);
    // The title is anchored to the CANVAS top, so a bottom-margin change must
    // not move it.
    expect(layout.elements!.title).toEqual(beforeTitle);
  });

  it("keeps the family so a radial chart does not grow axis bands", () => {
    const spec = makeSpec({ mark: "pie", legend: { visible: true, position: "right" } });
    const data = makeData();
    const layout = computeRadialLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    layout.margin.top += 30;
    layout.plotArea.y += 30;
    layout.plotArea.height -= 30;
    reflowChartElements(layout, spec, data, DEFAULT_CHART_THEME);
    expect(layout.elements!.family).toBe("radial");
    expect(layout.elements!.xAxisBand).toBeUndefined();
  });

  it("clears the measured flags, because the estimates are back", () => {
    const spec = makeSpec();
    const data = makeData();
    const layout = computeCartesianLayout(W, H, spec, data, DEFAULT_CHART_THEME);
    const { ctx } = makeCtx();
    drawTitle(ctx, spec.title!, layout, DEFAULT_CHART_THEME);
    expect(layout.elements!.measured).toContain("title");
    reflowChartElements(layout, spec, data, DEFAULT_CHART_THEME);
    expect(layout.elements!.measured).toEqual([]);
  });

  it("builds elements from nothing for a hand-rolled layout", () => {
    const bare: ChartLayout = {
      width: 300, height: 200,
      margin: { top: 10, right: 10, bottom: 10, left: 10 },
      plotArea: { x: 10, y: 10, width: 280, height: 180 },
    };
    recordChartElementRect(bare, "title", { x: 1, y: 2, width: 3, height: 4 });
    expect(bare.elements!.chartArea).toEqual({ x: 0, y: 0, width: 300, height: 200 });
    expect(bare.elements!.title).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(bare.elements!.measured).toEqual(["title"]);
  });
});

// ============================================================================
// (5) The @api mirror must not drift
// ============================================================================

describe("ChartMarkLayout mirrors ChartLayout", () => {
  it("is assignable in both directions at compile time", () => {
    const layout = computeCartesianLayout(W, H, makeSpec(), makeData(), DEFAULT_CHART_THEME);
    const asMark: ChartMarkLayout = layout;
    const backAgain: ChartLayout = asMark as ChartLayout;
    expect(asMark.elements!.family).toBe("cartesian");
    expect(backAgain.elements!.chartArea.width).toBe(W);
  });

  it("declares the same element keys in extensions/Charts/types.ts and src/api/chartMarks.ts", () => {
    // src/api cannot import from extensions (the Alien Rule), so the shape is
    // duplicated on purpose. Duplicated shapes drift; this diffs them.
    const typesSrc = fs.readFileSync(path.resolve(__dirname, "../../types.ts"), "utf8");
    const apiSrc = fs.readFileSync(path.resolve(__dirname, "../../../../src/api/chartMarks.ts"), "utf8");
    expect(props(typesSrc, "ChartElementRects")).toEqual(props(apiSrc, "ChartMarkElementRects"));
    expect(props(typesSrc, "ChartElementRect")).toEqual(props(apiSrc, "ChartMarkElementRect"));
    expect(props(typesSrc, "ChartLayout")).toEqual(props(apiSrc, "ChartMarkLayout"));
  });
});

/** Top-level property names of an `export interface`, brace-depth aware. */
function props(src: string, name: string): string[] {
  const m = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`).exec(src);
  if (!m) throw new Error(`interface ${name} not found`);
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(start + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const out: string[] = [];
  let d = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (d === 0) {
      const pm = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
      if (pm) out.push(pm[1]);
    }
    for (const ch of line) { if (ch === "{") d++; else if (ch === "}") d--; }
  }
  return out;
}
