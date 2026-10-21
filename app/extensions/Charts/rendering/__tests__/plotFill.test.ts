//! FILENAME: app/extensions/Charts/rendering/__tests__/plotFill.test.ts
// PURPOSE: The plot area is TRANSPARENT by default (Power BI semantics), so the
//          visual container's background recolours the whole visual. Every
//          plot fill goes through ONE helper, `fillPlotShape`, which paints
//          nothing -- and touches no `fillStyle` -- when the theme has no plot
//          fill.
// CONTEXT: Owner finding G1 (2026-10-16): "chart background colour does
//          nothing". Part of the cause was `DEFAULT_CHART_THEME.plotBackground =
//          "#fafafa"`, painted over the container on every cartesian chart and
//          every multi-row card row. The guard is REQUIRED, not an
//          optimisation: canvas IGNORES `ctx.fillStyle = ""`, so an unguarded
//          fill paints with whatever the previous drawing left in `fillStyle`
//          (a multi-row card's previous row's accent colour). The double below
//          therefore models that real-canvas rule.
//
//          (iii) is a CENSUS: under `rendering/`, only chartPainterUtils.ts may
//          read `.plotBackground`, so a new painter cannot reintroduce an
//          unconditional fill.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CHART_THEME, type ChartRenderTheme } from "../chartTheme";
import { drawPlotBackground, fillPlotShape, hasPlotFill } from "../chartPainterUtils";
import type { GradientFill } from "../gradientFill";
import { makeRecordingCtx } from "./dispatch-recordingCtx";
import { visualSpec, seriesData } from "../visuals/__tests__/visualTestKit";
import { computeMultiRowCardLayout, paintMultiRowCardChart } from "../visuals/multiRowCardPainter";

const PLOT = { x: 10, y: 20, width: 300, height: 200 };

const GRADIENT: GradientFill = {
  type: "linear",
  direction: "topToBottom",
  stops: [
    { offset: 0, color: "#e8f0fe" },
    { offset: 1, color: "#f8faff" },
  ],
};

function theme(extra: Partial<ChartRenderTheme>): ChartRenderTheme {
  return { ...DEFAULT_CHART_THEME, ...extra };
}

/**
 * The recording double, made faithful to the one canvas rule this file is
 * about: an assignment of "" (or any non-colour string a canvas would reject)
 * to `fillStyle` is IGNORED, so the previous fill stays in force.
 */
function canvasFaithfulCtx() {
  const { ctx, calls } = makeRecordingCtx(600, 400);
  const faithful = new Proxy(ctx as unknown as Record<string, unknown>, {
    get(t, prop) {
      const v = (t as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
    set(t, prop, value) {
      if (prop === "fillStyle" && (value === "" || value === undefined)) return true; // ignored, as canvas does
      (t as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx: faithful, calls };
}

function count(calls: string[], prefix: string): number {
  return calls.filter((c) => c.startsWith(prefix)).length;
}

/** The `fillStyle` in force at every `fill()` call, in order ("{obj}" = a gradient). */
function fillStylesAtFill(calls: string[]): string[] {
  let current = "";
  const out: string[] = [];
  for (const c of calls) {
    if (c.startsWith("fillStyle=")) current = c.slice("fillStyle=".length);
    else if (c === "fill()") out.push(current);
  }
  return out;
}

// ============================================================================
// (i) drawPlotBackground
// ============================================================================

describe("(i) drawPlotBackground paints the plot fill only when the theme sets one", () => {
  it("the DEFAULT theme paints nothing and touches no fillStyle", () => {
    const { ctx, calls } = makeRecordingCtx();
    drawPlotBackground(ctx, PLOT, DEFAULT_CHART_THEME);
    expect(count(calls, "fillRect(")).toBe(0);
    expect(count(calls, "fillStyle=")).toBe(0);
  });

  it("a solid colour paints one fillRect over the plot area in that colour", () => {
    const { ctx, calls } = makeRecordingCtx();
    drawPlotBackground(ctx, PLOT, theme({ plotBackground: "#ff0000" }));
    expect(count(calls, "fillRect(")).toBe(1);
    expect(calls).toContain("fillStyle=#ff0000");
    expect(calls).toContain(`fillRect(${PLOT.x},${PLOT.y},${PLOT.width},${PLOT.height})`);
  });

  it("a 2-stop gradient paints one fillRect with a gradient, even with no plot colour", () => {
    const { ctx, calls } = makeRecordingCtx();
    drawPlotBackground(ctx, PLOT, theme({ plotBackground: "", plotBackgroundGradient: GRADIENT }));
    expect(count(calls, "fillRect(")).toBe(1);
    expect(count(calls, "createLinearGradient(")).toBe(1);
    expect(calls).toContain("fillStyle={obj}");
  });

  it('"transparent" paints nothing', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawPlotBackground(ctx, PLOT, theme({ plotBackground: "transparent" }));
    expect(count(calls, "fillRect(")).toBe(0);
  });

  it("a one-stop gradient is no gradient (applyFillStyle's own rule)", () => {
    const one: GradientFill = { ...GRADIENT, stops: [GRADIENT.stops[0]] };
    expect(hasPlotFill(theme({ plotBackground: "", plotBackgroundGradient: one }))).toBe(false);
  });

  it("fillPlotShape with a path fills the PATH, not the rect, and reports what it did", () => {
    const { ctx, calls } = makeRecordingCtx();
    const drew = fillPlotShape(ctx, theme({ plotBackground: "#00ff00" }), PLOT, (c) => c.rect(1, 2, 3, 4));
    expect(drew).toBe(true);
    expect(calls).toEqual(["fillStyle=#00ff00", "rect(1,2,3,4)", "fill()"]);
    const none = makeRecordingCtx();
    expect(fillPlotShape(none.ctx, DEFAULT_CHART_THEME, PLOT, (c) => c.rect(1, 2, 3, 4))).toBe(false);
    expect(none.calls).toEqual([]);
  });
});

// ============================================================================
// (ii) Multi-row card row cards
// ============================================================================

describe("(ii) the multi-row card's row cards", () => {
  const DATA = seriesData(["North", "South", "East"], [{ name: "Sales", values: [1, 2, 3], color: "#FF00AA" }]);

  function paint(t: ChartRenderTheme) {
    const spec = visualSpec("multiRowCard");
    const { ctx, calls } = canvasFaithfulCtx();
    const layout = computeMultiRowCardLayout(600, 400, spec, DATA, t);
    paintMultiRowCardChart(ctx, DATA, spec, layout, t);
    return calls;
  }

  it("with the default theme no row card is filled (the visual's background shows)", () => {
    const calls = paint(DEFAULT_CHART_THEME);
    expect(count(calls, "fill()")).toBe(0);
    // The accent bars are still there.
    expect(count(calls, "fillRect(")).toBe(3);
  });

  it("(ii-b) a plot GRADIENT with an empty plot colour fills every row card with the gradient, never the accent", () => {
    const calls = paint(theme({ plotBackground: "", plotBackgroundGradient: GRADIENT }));
    const styles = fillStylesAtFill(calls);
    expect(styles).toHaveLength(3);
    for (const s of styles) {
      expect(s).toBe("{obj}");
      expect(s).not.toBe("#FF00AA");
    }
  });

  it("a solid plot colour fills every row card in that colour", () => {
    const calls = paint(theme({ plotBackground: "#123456" }));
    expect(fillStylesAtFill(calls)).toEqual(["#123456", "#123456", "#123456"]);
  });
});

// ============================================================================
// (iii) Census: the one reader of `.plotBackground` under rendering/
// ============================================================================

describe("(iii) census: only chartPainterUtils.ts reads .plotBackground under Charts/rendering/", () => {
  const RENDERING = path.resolve(__dirname, "..");

  function walk(dir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full, out);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }

  it("scans the painters and finds no other reader", () => {
    const files: string[] = [];
    walk(RENDERING, files);
    const scanned = files.filter((f) => path.basename(f) !== "chartTheme.ts");
    // A census over nothing proves nothing.
    expect(scanned.length).toBeGreaterThan(10);
    expect(scanned.map((f) => path.basename(f))).toContain("multiRowCardPainter.ts");
    expect(scanned.map((f) => path.basename(f))).toContain("chartPainterUtils.ts");

    const offenders: string[] = [];
    for (const file of scanned) {
      if (path.basename(file) === "chartPainterUtils.ts") continue;
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/\.plotBackground\b(?!Gradient)/.test(line)) {
          offenders.push(`${path.relative(RENDERING, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, "fill the plot through fillPlotShape (chartPainterUtils.ts)").toEqual([]);
  });
});
