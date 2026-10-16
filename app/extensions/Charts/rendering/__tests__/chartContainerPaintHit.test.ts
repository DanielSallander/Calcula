//! FILENAME: app/extensions/Charts/rendering/__tests__/chartContainerPaintHit.test.ts
// PURPOSE: PAINT == HIT for a chart inside its visual container (WP-C S9a,
//          risk R1): the raster is laid out, painted and hit-tested in the ONE
//          content rect (`visualContentRectFor`), the chart paints no frame of
//          its own (Core paints the container), the Quick Access buttons stay
//          OUTSIDE the object and outside the rounded clip (review R1-2), a
//          BOUND title colour is the colour the title is filled with, and a
//          container binding change drops the raster cache before the regions
//          are re-published (review R2-8).
// CONTEXT: Driven through the real `renderChart`, `hitTestChart`,
//          `findChartAtCanvasPos`, `getChartLocalCoords` and the real chart
//          store; the data reader is doubled (the test decides the data) and
//          OffscreenCanvas is a recording double (jsdom has none).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  read: vi.fn(),
  selected: false,
}));

vi.mock("../../lib/chartDataReader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/chartDataReader")>()),
  readChartDataResolved: (...args: unknown[]) => h.read(...args),
}));
vi.mock("../../handlers/selectionHandler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../handlers/selectionHandler")>()),
  isChartSelected: () => h.selected,
}));

import {
  renderChart,
  hitTestChart,
  findChartAtCanvasPos,
  getChartLocalCoords,
  getCachedChartData,
  invalidateAllChartCaches,
  invalidateChartCache,
  isChartRenderCurrent,
  handleChartMouseMove,
  getHoverState,
  getChartFrameBitmap,
} from "../chartRenderer";
import {
  getChartById,
  loadChartsFromBackend,
  resetChartStore,
  setActiveSheetIndex,
  syncChartRegions,
} from "../../lib/chartStore";
import { chartsBackend } from "../../lib/chartsBackend";
import { getGridRegions, setGridRegions, type GridRegion, type OverlayRenderContext, type OverlayHitTestContext } from "@api/gridOverlays";
import { resetPaintedContainerLayouts, visualContentRect, type ContainerRegion } from "@api/visualContainerPaint";
import { replaceAll, notifyBindingsChanged, resetCache } from "@api/objectBindings/cache";
import { computeQuickAccessButtons } from "../quickAccessButtons";
import { chartTitleBlock, computeCartesianLayout, drawTitle } from "../chartPainterUtils";
import { resolveChartTheme } from "../chartTheme";
import { overlayChartBindings } from "../../lib/chartBindings";
import { installChartContainerResync, resolveChartContainer } from "../../lib/chartObjectFormat";
import { makeRecordingCtx, type RecordingCtx } from "./dispatch-recordingCtx";
import type { ChartSpec, ParsedChartData } from "../../types";

const CHART_ID = "c1";
const OUTER = { x: 100, y: 60, width: 400, height: 300 };
const PAD = 20;

const baseSpec = {
  mark: "bar",
  data: { sheetIndex: 0, sheetId: "s0", startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Sales", sourceIndex: 1, color: null }],
  title: "Sales",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
  container: { padding: { top: PAD, right: PAD, bottom: PAD, left: PAD }, border: { radius: 12 } },
} as unknown as ChartSpec;

const data: ParsedChartData = {
  categories: ["Jan", "Feb", "Mar"],
  series: [{ name: "Sales", values: [100, 200, 300], color: null }],
};

/** Every OffscreenCanvas the renderer created, with its recording context. */
let offscreens: Array<{ width: number; height: number; rec: RecordingCtx }> = [];
const savedOffscreen = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;

function installFakeOffscreen(): void {
  class FakeOffscreen {
    rec: RecordingCtx;
    constructor(public width: number, public height: number) {
      this.rec = makeRecordingCtx(width, height);
      offscreens.push({ width, height, rec: this.rec });
    }
    getContext() {
      return this.rec.ctx;
    }
    convertToBlob() {
      return Promise.resolve(new Blob());
    }
  }
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeOffscreen;
}

function chartRegion(): ContainerRegion {
  const r = getGridRegions().find((g) => g.type === "chart");
  if (!r) throw new Error("no chart region published");
  return r as ContainerRegion;
}

function overlayCtx(rec: RecordingCtx): OverlayRenderContext {
  return {
    ctx: rec.ctx,
    region: chartRegion(),
    config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: {},
    canvasWidth: 1600,
    canvasHeight: 900,
  } as unknown as OverlayRenderContext;
}

/** Canvas px of the outer box's top-left (rowHeader 50, colHeader 24, no scroll). */
const OX = 50 + OUTER.x;
const OY = 24 + OUTER.y;

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

async function renderTwice(): Promise<RecordingCtx> {
  renderChart(overlayCtx(makeRecordingCtx(1600, 900)));
  await settle();
  const rec = makeRecordingCtx(1600, 900);
  renderChart(overlayCtx(rec));
  return rec;
}

beforeEach(async () => {
  resetChartStore();
  invalidateAllChartCaches();
  resetPaintedContainerLayouts();
  resetCache();
  setGridRegions([]);
  h.read.mockReset();
  h.read.mockImplementation(async (spec: ChartSpec) => ({ spec, data, unfilteredData: data, diagnostics: [], params: new Map() }));
  h.selected = false;
  offscreens = [];
  installFakeOffscreen();
  chartsBackend.set(async (cmd: string) =>
    cmd === "get_charts"
      ? [
          {
            id: CHART_ID,
            sheetIndex: 0,
            specJson: JSON.stringify({ chartId: CHART_ID, name: "Chart 1", sheetIndex: 0, ...OUTER, spec: baseSpec }),
          },
        ]
      : undefined,
  );
  await loadChartsFromBackend({ stampSheetIds: false });
  setActiveSheetIndex(0);
  syncChartRegions();
});

afterEach(() => {
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = savedOffscreen;
  resetChartStore();
  invalidateAllChartCaches();
  resetCache();
  setGridRegions([]);
});

describe("the raster lives in the CONTENT rect", () => {
  it("padding 20 (+ the 1 px default border): the content rect is the outer box inset by 21", () => {
    const content = visualContentRect(chartRegion());
    expect(content).toEqual({ x: OUTER.x + PAD + 1, y: OUTER.y + PAD + 1, width: OUTER.width - 2 * (PAD + 1), height: OUTER.height - 2 * (PAD + 1) });
  });

  it("the raster is RENDERED at the content size and DRAWN at the content origin, inside a content clip", async () => {
    const content = visualContentRect(chartRegion());
    const rec = await renderTwice();
    // The offscreen raster is the content's size (dpr 1 in jsdom).
    expect(offscreens.some((o) => o.width === content.width && o.height === content.height)).toBe(true);
    const cx = OX + PAD + 1;
    const cy = OY + PAD + 1;
    const draw = rec.calls.find((c) => c.startsWith("drawImage("));
    expect(draw).toBe(`drawImage({obj},${cx},${cy},${content.width},${content.height})`);
    // The content clip is in force when the raster is drawn.
    const drawAt = rec.calls.indexOf(draw!);
    const clipRect = rec.calls.lastIndexOf(`rect(${cx},${cy},${content.width},${content.height})`, drawAt);
    expect(clipRect).toBeGreaterThan(-1);
    expect(rec.calls.slice(clipRect, drawAt)).toContain("clip()");
  });

  it("the chart paints NO frame of its own: no white box fill and no #d0d0d0 stroke (Core paints the container)", async () => {
    const rec = await renderTwice();
    expect(rec.calls).not.toContain("strokeStyle=#d0d0d0");
    expect(rec.calls.some((c) => c.startsWith("strokeRect("))).toBe(false);
    expect(rec.calls.some((c) => c.startsWith(`fillRect(${OX},${OY},`))).toBe(false);
  });

  it("the error placeholder paints no card of its own, only its message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.read.mockReset();
    h.read.mockRejectedValue(new Error("The data sheet is gone."));
    renderChart(overlayCtx(makeRecordingCtx(1600, 900)));
    await settle();
    const card = offscreens[offscreens.length - 1].rec.calls;
    expect(card.some((c) => c.startsWith("fillText(⚠ Chart data error"))).toBe(true);
    expect(card).not.toContain("fillStyle=#ffffff");
    expect(card.some((c) => c.startsWith("strokeRect("))).toBe(false);
  });
});

describe("the capture surface (Animation's GIF export) gets the frame the reader sees", () => {
  it("getChartFrameBitmap composes the raster INSIDE its container: background, raster at the content rect, border", async () => {
    await renderTwice();
    const before = offscreens.length;
    await getChartFrameBitmap(CHART_ID);
    expect(offscreens.length).toBe(before + 1);
    const frame = offscreens[offscreens.length - 1];
    expect([frame.width, frame.height]).toEqual([OUTER.width, OUTER.height]);
    const calls = frame.rec.calls;
    const firstFill = calls.indexOf("fill()");
    expect(firstFill).toBeGreaterThan(-1);
    expect(calls.slice(0, firstFill)).toContain("fillStyle=#ffffff");
    const draw = calls.findIndex((c) => c.startsWith("drawImage("));
    expect(calls[draw]).toBe(`drawImage({obj},${PAD + 1},${PAD + 1},${OUTER.width - 2 * (PAD + 1)},${OUTER.height - 2 * (PAD + 1)})`);
    expect(draw).toBeGreaterThan(firstFill);
    expect(calls.lastIndexOf("stroke()")).toBeGreaterThan(draw);
  });
});

describe("hit == paint", () => {
  function hitCtx(x: number, y: number): OverlayHitTestContext {
    return {
      region: chartRegion(),
      canvasX: x,
      canvasY: y,
      row: 0,
      col: 0,
      floatingCanvasBounds: { x: OX, y: OY, width: OUTER.width, height: OUTER.height },
    } as unknown as OverlayHitTestContext;
  }

  it("findChartAtCanvasPos and hitTestChart answer the SAME rect: the outer box, padding band included", async () => {
    await renderTwice(); // caches the viewport the pointer maths reads
    const band = { x: OX + 5, y: OY + 5 }; // in the padding band
    const inside = { x: OX + 200, y: OY + 150 };
    const outside = { x: OX - 5, y: OY + 150 };
    for (const p of [band, inside]) {
      expect(findChartAtCanvasPos(p.x, p.y)).toBe(CHART_ID);
      expect(hitTestChart(hitCtx(p.x, p.y))).toBe(true);
    }
    expect(findChartAtCanvasPos(outside.x, outside.y)).toBeNull();
    expect(hitTestChart(hitCtx(outside.x, outside.y))).toBe(false);
  });

  it("chart-local coordinates are relative to the CONTENT origin -- where the layout was drawn", async () => {
    await renderTwice();
    expect(getChartLocalCoords(CHART_ID, OX + PAD + 1, OY + PAD + 1)).toEqual({ localX: 0, localY: 0 });
    expect(getChartLocalCoords(CHART_ID, OX + 100, OY + 50)).toEqual({ localX: 100 - PAD - 1, localY: 50 - PAD - 1 });
  });

  it("hover hits a bar where it is PAINTED (content origin), and the padding band hovers nothing", async () => {
    await renderTwice();
    const cached = getCachedChartData(CHART_ID)!;
    expect(cached.hitGeometry.type).toBe("bars");
    const bar = (cached.hitGeometry as { type: "bars"; rects: Array<{ x: number; y: number; width: number; height: number }> }).rects[0];
    // 2 px inside the bar's RIGHT edge: measured from the outer origin instead
    // of the content origin, the same canvas point would land 21 px further
    // right -- in the gap after the bar.
    const px = OX + PAD + 1 + bar.x + bar.width - 2;
    const py = OY + PAD + 1 + bar.y + bar.height / 2;
    handleChartMouseMove(px, py);
    expect(getHoverState()?.hitResult.type).toBe("bar");
    // The band is the chart's FRAME: no element is hovered there.
    handleChartMouseMove(OX + 3, OY + 150);
    expect(getHoverState()).toBeNull();
  });
});

describe("the Quick Access buttons stay outside the object (review R1-2)", () => {
  it("a SELECTED chart with radius 12 paints its three buttons right of the OUTER box, after the content clip ended", async () => {
    h.selected = true;
    const rec = await renderTwice();
    const expected = computeQuickAccessButtons(OX, OY, OUTER.width, OUTER.height, CHART_ID);
    expect(expected).toHaveLength(3);
    expect(getCachedChartData(CHART_ID)!.quickAccessButtons).toEqual(expected);
    for (const b of expected) expect(b.x).toBeGreaterThan(OX + OUTER.width);
    // The rounded content clip was popped before the buttons were drawn: count
    // save/restore depth at the first draw at a button's x.
    const firstButtonDraw = rec.calls.findIndex((c) => new RegExp(`\\(${expected[0].x}(\\.\\d+)?,`).test(c));
    expect(firstButtonDraw).toBeGreaterThan(-1);
    let depth = 0;
    for (const c of rec.calls.slice(0, firstButtonDraw)) {
      if (c === "save()") depth++;
      if (c === "restore()") depth--;
    }
    // Only renderChart's own cell-area clip is open (+ any save the button
    // painter made for itself) -- never the content clip.
    const contentClipOpen = rec.calls
      .slice(0, firstButtonDraw)
      .lastIndexOf(`rect(${OX + PAD + 1},${OY + PAD + 1},${OUTER.width - 2 * (PAD + 1)},${OUTER.height - 2 * (PAD + 1)})`);
    const restoresAfterClip = rec.calls.slice(contentClipOpen, firstButtonDraw).filter((c) => c === "restore()").length;
    expect(restoresAfterClip).toBeGreaterThanOrEqual(1);
    expect(depth).toBeGreaterThanOrEqual(1);
  });
});

describe("title alignment: the title rect is recorded where it is painted", () => {
  for (const align of ["left", "right"] as const) {
    it(`align ${align}`, () => {
      const spec = { ...baseSpec, container: { title: { align } } } as ChartSpec;
      const theme = resolveChartTheme(spec.config, resolveChartContainer(null, spec));
      const layout = computeCartesianLayout(400, 300, spec, data, theme);
      const { ctx, calls } = makeRecordingCtx(400, 300);
      drawTitle(ctx, spec.title, layout, theme);
      const painted = calls.find((c) => c.startsWith("fillText(Sales,"))!;
      const [, xs] = /fillText\(Sales,([\d.]+),/.exec(painted)!;
      const rect = layout.elements!.title!;
      const w = "Sales".length * 7; // the recording ctx measures 7 px per char
      expect(rect.width).toBe(w);
      if (align === "left") {
        expect(Number(xs)).toBe(16);
        expect(rect.x).toBe(16);
      } else {
        expect(Number(xs)).toBe(400 - 16);
        expect(rect.x).toBe(400 - 16 - w);
      }
      expect(calls).toContain(`textAlign=${align}`);
    });
  }

  it("the layout reserves exactly the band drawTitle paints (title + subtitle + divider + spacing)", () => {
    const spec = {
      ...baseSpec,
      container: { subtitle: { show: true, text: "by month" }, divider: { show: true, width: 2 } },
    } as ChartSpec;
    const theme = resolveChartTheme(spec.config, resolveChartContainer(null, spec));
    const block = chartTitleBlock(spec.title, theme, 400);
    expect(block.title).not.toBeNull();
    expect(block.subtitle).not.toBeNull();
    expect(block.divider).not.toBeNull();
    // 14 (title) + 8 + 10 (subtitle) + 8 + 2 (divider) + 8
    expect(block.band).toBe(14 + 8 + 10 + 8 + 2 + 8);
    const layout = computeCartesianLayout(400, 300, spec, data, theme);
    expect(layout.margin.top).toBe(12 + block.band);
  });
});

describe("a BOUND title colour is painted, and a container binding change drops the raster (review R2-8)", () => {
  const ref = { kind: "chart" as const, id: CHART_ID };
  function bind(path: string, value: unknown): void {
    replaceAll(
      [{ object: ref, path, formula: "=A1", displayFormula: "=A1", model: null, resolved: null } as never],
      [{ object: ref, path, value, display: String(value), error: null, pending: false } as never],
    );
  }

  it("the overlaid spec's theme colour reaches drawTitle's fill", () => {
    bind("/spec/config/theme/titleColor", "#ff00aa");
    const spec = getChartById(CHART_ID)!.spec;
    const painted = overlayChartBindings(CHART_ID, spec);
    expect(painted.config?.theme?.titleColor).toBe("#ff00aa");
    // The container resolves the same bound value (the pane's Title card shows it).
    expect(resolveChartContainer(CHART_ID, spec).title.color).toBe("#ff00aa");
    const theme = resolveChartTheme(painted.config, resolveChartContainer(CHART_ID, spec));
    const layout = computeCartesianLayout(400, 300, painted, data, theme);
    const { ctx, calls } = makeRecordingCtx(400, 300);
    drawTitle(ctx, painted.title, layout, theme);
    const fill = calls.indexOf("fillStyle=#ff00aa");
    expect(fill).toBeGreaterThan(-1);
    expect(calls.findIndex((c, i) => i > fill && c.startsWith("fillText(Sales,"))).toBeGreaterThan(fill);
  });

  it("a container binding change invalidates the chart's raster BEFORE the regions are re-published", async () => {
    await renderTwice();
    expect(isChartRenderCurrent(CHART_ID)).toBe(true);
    const order: string[] = [];
    const off = installChartContainerResync({
      invalidate: (id) => {
        order.push(`invalidate:${id}`);
        invalidateChartCache(id);
      },
      invalidateAll: () => order.push("invalidateAll"),
      sync: () => {
        order.push(`sync:current=${isChartRenderCurrent(CHART_ID)}`);
        syncChartRegions();
      },
      redraw: () => order.push("redraw"),
    });
    bind("/spec/container/border/radius", 4);
    notifyBindingsChanged({ objects: [ref], reload: false });
    off();
    expect(order).toEqual([`invalidate:${CHART_ID}`, "sync:current=false", "redraw"]);
    // And the re-published region carries the bound value.
    expect((chartRegion() as ContainerRegion).container!.border.radius).toBe(4);
  });

  it("a binding change of ANOTHER kind re-publishes nothing", () => {
    const order: string[] = [];
    const off = installChartContainerResync({
      invalidate: () => order.push("invalidate"),
      invalidateAll: () => order.push("invalidateAll"),
      sync: () => order.push("sync"),
      redraw: () => order.push("redraw"),
    });
    notifyBindingsChanged({ objects: [{ kind: "slicer", id: "s1" }], reload: false });
    off();
    expect(order).toEqual([]);
  });
});

describe("the region publisher", () => {
  it("every published chart region carries a container beside floating", () => {
    const r: GridRegion & { container?: unknown } = chartRegion();
    expect(r.floating).toBeDefined();
    expect(r.container).toBeDefined();
  });
});
