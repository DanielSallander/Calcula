//! FILENAME: app/extensions/Charts/lib/__tests__/paintChartWithContainer.test.ts
// PURPOSE: Risk R4 of WP-C (review R1-3): the chart painters no longer fill a
//          background of their own, so every route that paints a chart WITHOUT
//          Core's `renderOverlayRegion` -- the PNG export, the Insert/Create
//          Chart dialog preview, the chart spec editor window -- must paint the
//          visual container itself, or the chart comes out transparent and
//          frameless. ONE helper (`paintChartWithContainer`) does it for all
//          three, and this test pins, per mark family (bar, pie, card):
//            - the container background is painted FIRST, over the whole box,
//              in the container's colour (a dark preset's too);
//            - the chart itself paints NO full-raster background any more;
//            - the chart is laid out at the CONTENT size, translated to the
//              content origin, inside the content clip;
//            - the border is painted LAST.
// CONTEXT: A PIXEL composite (the spec's "old vs new on white") needs a real
//          canvas, which the unit tier does not have (jsdom; no node-canvas
//          in the tree). The composite is asserted on the ORDERED draw stream
//          instead -- the same facts a pixel diff would see: what covers the
//          box first, in which colour, and that nothing between leaves it
//          uncovered. The dialog preview is driven through the real
//          `ChartPreview` component; the editor window's two paint paths are
//          pinned as source (rendering the whole Monaco window here would test
//          Monaco).

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import * as fs from "fs";
import * as path from "path";
import { paintChartWithContainer } from "../paintChartWithContainer";
import { ChartPreview } from "../../components/ChartPreview";
import { makeRecordingCtx } from "../../rendering/__tests__/dispatch-recordingCtx";
import type { ChartSpec, ChartType, ParsedChartData } from "../../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const W = 400;
const H = 300;

function spec(mark: ChartType, extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: "Sales",
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...extra,
  } as ChartSpec;
}

const data: ParsedChartData = {
  categories: ["Jan", "Feb", "Mar"],
  series: [{ name: "Sales", values: [100, 200, 300], color: null }],
};

/** The index of the first drawing OPERATION (a fill / stroke / text / image) in the stream. */
function firstDraw(calls: string[]): number {
  return calls.findIndex((c) => /^(fill|stroke|fillRect|strokeRect|fillText|drawImage)\(/.test(c));
}

/** The style a property held at stream position `at`. */
function styleAt(calls: string[], prop: string, at: number): string | null {
  for (let i = at; i >= 0; i--) if (calls[i].startsWith(`${prop}=`)) return calls[i].slice(prop.length + 1);
  return null;
}

describe("paintChartWithContainer: one look on every Core-less route", () => {
  for (const mark of ["bar", "pie", "card"] as ChartType[]) {
    describe(mark, () => {
      it("background first over the whole box, the chart at the content rect, the border last", () => {
        const { ctx, calls } = makeRecordingCtx(W, H);
        const out = paintChartWithContainer(ctx, W, H, spec(mark), data);
        // The default chart frame: white, 1 px #d0d0d0 -> content inset by 1.
        expect(out.content).toEqual({ x: 1, y: 1, width: W - 2, height: H - 2 });

        // (1) THE FIRST THING PAINTED is the container background over the
        //     whole outer box, in white: nothing is transparent.
        const first = firstDraw(calls);
        expect(calls[first]).toBe("fill()");
        expect(styleAt(calls, "fillStyle", first)).toBe("#ffffff");
        expect(calls.slice(0, first)).toContain(`rect(0,0,${W},${H})`);

        // (2) The chart is laid out at the CONTENT size and translated to the
        //     content origin, inside the content clip.
        const translate = calls.indexOf("translate(1,1)");
        expect(translate).toBeGreaterThan(first);
        expect(calls.slice(first, translate)).toContain(`rect(1,1,${W - 2},${H - 2})`);
        expect(calls.slice(first, translate)).toContain("clip()");
        expect(out.layout?.width).toBe(W - 2);
        expect(out.layout?.height).toBe(H - 2);

        // (3) The chart's own paint fills NO full-raster background (it used to
        //     be drawChartBackground's fillRect(0,0,w,h) in the theme colour).
        const chartPaint = calls.slice(translate);
        expect(chartPaint).not.toContain(`fillRect(0,0,${W - 2},${H - 2})`);

        // (4) The border is painted LAST, in the chart frame's colour.
        const lastStroke = calls.lastIndexOf("stroke()");
        expect(styleAt(calls, "strokeStyle", lastStroke)).toBe("#d0d0d0");
        expect(calls.slice(lastStroke + 1).some((c) => /^(fill|fillRect|fillText|drawImage)\(/.test(c))).toBe(false);
      });

      it("a dark preset's container background is the colour the box is filled with", () => {
        const { ctx, calls } = makeRecordingCtx(W, H);
        paintChartWithContainer(ctx, W, H, spec(mark, { container: { background: { color: "#1e1e1e" } } }), data);
        expect(styleAt(calls, "fillStyle", firstDraw(calls))).toBe("#1e1e1e");
      });
    });
  }

  it("padding and rounded corners shrink and clip the chart, not the box", () => {
    const { ctx, calls } = makeRecordingCtx(W, H);
    const out = paintChartWithContainer(
      ctx, W, H,
      spec("bar", { container: { padding: { top: 10, right: 10, bottom: 10, left: 10 }, border: { radius: 12 } } }),
      data,
    );
    expect(out.content).toEqual({ x: 11, y: 11, width: W - 22, height: H - 22 });
    expect(calls).toContain("translate(11,11)");
    // The rounded outer path clips the content too.
    expect(calls.filter((c) => c === "clip()").length).toBeGreaterThanOrEqual(2);
  });
});

describe("the dialog preview (ChartPreview) paints the container", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.restoreAllMocks();
  });

  it("is never transparent: the container background is painted first, a dark one too", async () => {
    for (const [extra, colour] of [
      [{}, "#ffffff"],
      [{ container: { background: { color: "#1e1e1e" } } }, "#1e1e1e"],
    ] as Array<[Partial<ChartSpec>, string]>) {
      const rec = makeRecordingCtx(W, H);
      HTMLCanvasElement.prototype.getContext = (() => rec.ctx) as never;
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(W);
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(H);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(React.createElement(ChartPreview, { spec: spec("bar", extra), data }));
      });
      const first = firstDraw(rec.calls);
      expect(rec.calls[first]).toBe("fill()");
      expect(styleAt(rec.calls, "fillStyle", first)).toBe(colour);
      expect(rec.calls).toContain("translate(1,1)");
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
    }
  });
});

describe("the chart spec editor window paints through the same helper", () => {
  it("both of its paint paths call paintChartWithContainer and never paint the raster bare", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../components/ChartSpecEditorApp.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(code.match(/paintChartWithContainer\(ctx, w, h, spec, data\)/g)?.length).toBe(2);
    expect(code).not.toMatch(/\bdispatchPaint\(/);
  });

  it("so does the PNG export (chartRaster.ts)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../chartRaster.ts"), "utf8");
    expect(src).toContain("paintChartWithContainer(ctx, logicalWidth, logicalHeight, spec, data, chartId)");
    expect(src).not.toMatch(/\bdispatchPaint\(/);
  });
});
