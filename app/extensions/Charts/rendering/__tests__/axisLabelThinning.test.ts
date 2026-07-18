//! FILENAME: app/extensions/Charts/rendering/__tests__/axisLabelThinning.test.ts
// PURPOSE: X-axis category labels must stay READABLE when categories are many.
//   Regression guard for the "labels look absent" bug: every label used to be
//   truncated to its own (few-px) band, collapsing to overlapped stubs. Now
//   labels auto-thin (draw every Nth, using the freed slots for real text).

import { describe, it, expect } from "vitest";
import { drawCartesianAxes, resolveScatterXAxis } from "../chartPainterUtils";
import { createBandScale, createLinearScale } from "../scales";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ParsedChartData } from "../../types";

// ---------------------------------------------------------------------------
// Mock 2D context that records fillText calls. measureText ≈ 6px per char.
// ---------------------------------------------------------------------------

interface DrawnText {
  text: string;
  x: number;
  y: number;
}

function makeCtx() {
  const texts: DrawnText[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    fillText: (text: string, x: number, y: number) => {
      texts.push({ text, x, y });
    },
    measureText: (t: string) => ({ width: t.length * 6 }),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    setLineDash: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    fillRect: () => {},
    strokeRect: () => {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { startRow: 0, startCol: 0, endRow: 3, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...overrides,
  };
}

const PLOT = { x: 40, y: 20, width: 560, height: 300 };

function categoryNames(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Customer Name ${i + 1}`);
}

/** X labels = drawn texts that are not y-axis ticks (y ticks are numbers). */
function xLabels(texts: DrawnText[]): DrawnText[] {
  return texts.filter((t) => t.text.includes("Customer") || t.text.includes("..."));
}

describe("x-axis label auto-thinning (band scale)", () => {
  it("draws readable (non-stub) labels when there are hundreds of categories", () => {
    const cats = categoryNames(300);
    const { ctx, texts } = makeCtx();
    const xScale = createBandScale(cats, [PLOT.x, PLOT.x + PLOT.width], 0.3);
    const yScale = createLinearScale([0, 100], [PLOT.y + PLOT.height, PLOT.y]);

    drawCartesianAxes(ctx, xScale, yScale, PLOT, makeSpec(), DEFAULT_CHART_THEME);

    const labels = xLabels(texts);
    // Thinning must draw SOME labels...
    expect(labels.length).toBeGreaterThanOrEqual(3);
    // ...but not all 300 overlapping ones.
    expect(labels.length).toBeLessThan(30);
    // Drawn labels carry meaningful text, not 1-2 char stubs.
    const readable = labels.filter((l) => l.text.replace("...", "").length >= 8);
    expect(readable.length).toBe(labels.length);
    // And adjacent drawn labels don't overlap (spacing >= est. text width).
    const xs = labels.map((l) => l.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(60);
    }
  });

  it("still draws every label when categories are few (unchanged behavior)", () => {
    const cats = ["Jan", "Feb", "Mar", "Apr"];
    const { ctx, texts } = makeCtx();
    const xScale = createBandScale(cats, [PLOT.x, PLOT.x + PLOT.width], 0.3);
    const yScale = createLinearScale([0, 100], [PLOT.y + PLOT.height, PLOT.y]);

    drawCartesianAxes(ctx, xScale, yScale, PLOT, makeSpec(), DEFAULT_CHART_THEME);

    const drawn = texts.map((t) => t.text);
    for (const c of cats) expect(drawn).toContain(c);
  });

  it("thins rotated labels by font-height clearance", () => {
    const cats = categoryNames(300);
    const { ctx, texts } = makeCtx();
    const xScale = createBandScale(cats, [PLOT.x, PLOT.x + PLOT.width], 0.3);
    const yScale = createLinearScale([0, 100], [PLOT.y + PLOT.height, PLOT.y]);

    drawCartesianAxes(
      ctx, xScale, yScale, PLOT,
      makeSpec({ xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 45, min: null, max: null } }),
      DEFAULT_CHART_THEME,
    );

    const labels = xLabels(texts);
    expect(labels.length).toBeGreaterThanOrEqual(10);
    expect(labels.length).toBeLessThan(60);
  });
});

describe("x-axis tick auto-thinning (point scale — line/area/scatter)", () => {
  it("emits thinned ticks for many categories", () => {
    const cats = categoryNames(300);
    const data: ParsedChartData = {
      categories: cats,
      series: [{ name: "Sales", values: cats.map((_, i) => i), color: null }],
    };
    const axis = resolveScatterXAxis(data, makeSpec({ mark: "line" }), PLOT, { requireScale: true });
    expect(axis.ticks.length).toBeGreaterThanOrEqual(3);
    expect(axis.ticks.length).toBeLessThan(30);
  });

  it("keeps one tick per category when they fit", () => {
    const cats = ["Q1", "Q2", "Q3", "Q4"];
    const data: ParsedChartData = {
      categories: cats,
      series: [{ name: "Sales", values: [1, 2, 3, 4], color: null }],
    };
    const axis = resolveScatterXAxis(data, makeSpec({ mark: "line" }), PLOT, { requireScale: true });
    expect(axis.ticks.map((t) => t.label)).toEqual(cats);
  });
});
