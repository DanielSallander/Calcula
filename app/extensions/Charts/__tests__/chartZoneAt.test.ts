//! FILENAME: app/extensions/Charts/__tests__/chartZoneAt.test.ts
// PURPOSE: The chart's ONE zone answer (lib/chartZoneAt.ts, BUG-0258 design
//          phase 2): the plot of a brushable, non-composed chart, off its
//          widgets, is CONTENT with a crosshair -- whether or not the chart is
//          selected; the chart's own BUTTONS (a selected chart's quick-access
//          buttons and widget controls, a pivot chart's field buttons) are
//          CONTENT with a hand (phase 4b: they act on release, and a drag from
//          one never moves the chart); every other point, the widget strip
//          off its controls included, is frame (null). Core asks it on
//          every hover move and ONCE per press BEFORE it selects anything, so
//          it must be pure and must not read the chart's own selection: the
//          S6 claim it replaces gated on `isChartSelected`, which passed on the
//          first press only because Core used to ask AFTER selecting.
// CONTEXT: The brush's press path (bodyDragStart -> brushDrag) is unchanged
//          and pinned elsewhere; this file pins the answer, its purity, what
//          Core makes of it (`resolveFloatingZone`), and that index.ts
//          registers it as the chart's `zoneAt` with no claim beside it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const h = vi.hoisted(() => ({
  charts: new Map<string, Record<string, unknown>>(),
  cache: new Map<string, Record<string, unknown>>(),
  selectChart: vi.fn(),
  isChartSelected: vi.fn(() => false),
  write: vi.fn(),
}));

vi.mock("../lib/chartStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChartById: (id: string) => h.charts.get(id) ?? null,
  moveChart: h.write,
  resizeChart: h.write,
  updateChartSpec: h.write,
  replaceChartSpec: h.write,
  updateChartPlacement: h.write,
  previewChartPlacement: h.write,
  syncChartRegions: h.write,
}));

// The renderer's cache and its canvas basis: the chart's local point is the
// canvas point minus the chart's position (no gutters, no scroll here).
vi.mock("../rendering/chartRenderer", () => ({
  getCachedChartData: (id: string) => h.cache.get(id),
  getChartLocalCoords: (id: string, canvasX: number, canvasY: number) => {
    const c = h.charts.get(id) as { x: number; y: number } | undefined;
    return c ? { localX: canvasX - c.x, localY: canvasY - c.y } : null;
  },
}));

vi.mock("../handlers/selectionHandler", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  selectChart: h.selectChart,
  isChartSelected: h.isChartSelected,
}));

import {
  registerGridOverlay,
  resolveFloatingZone,
  type GridRegion,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import { chartZoneAt } from "../lib/chartZoneAt";

/** The chart sits at canvas (100, 50), 400 x 300; its plot area is local (60, 40) 300 x 200. */
const CHART = { x: 100, y: 50, width: 400, height: 300 };
const PLOT = { x: 60, y: 40, width: 300, height: 200 };
/** A canvas point in the middle of the plot. */
const IN_PLOT = { x: CHART.x + PLOT.x + 150, y: CHART.y + PLOT.y + 100 };
/** A canvas point on the title strip above the plot. */
const ON_TITLE = { x: CHART.x + 200, y: CHART.y + 10 };

function chart(spec: Record<string, unknown> = {}): void {
  h.charts.set("c1", {
    chartId: "c1",
    x: CHART.x,
    y: CHART.y,
    width: CHART.width,
    height: CHART.height,
    spec: { mark: "bar", params: [{ name: "pick", select: "point", brush: true }], ...spec },
  });
  h.cache.set("c1", { layout: { plotArea: PLOT }, data: { categories: [], series: [] } });
}

const REGION: GridRegion = {
  id: "chart-c1",
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: CHART.x, y: CHART.y, width: CHART.width, height: CHART.height },
  data: { chartId: "c1" },
};

function ctx(p: { x: number; y: number }): OverlayHitTestContext {
  return { region: REGION, canvasX: p.x, canvasY: p.y, row: 0, col: 0, floatingCanvasBounds: { ...CHART } };
}

let cleanups: Array<() => void> = [];

beforeEach(() => {
  h.charts.clear();
  h.cache.clear();
  h.selectChart.mockClear();
  h.isChartSelected.mockClear();
  h.isChartSelected.mockReturnValue(false);
  h.write.mockClear();
});

afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

describe("the chart's zone", () => {
  it("an UNSELECTED brushable chart's plot is content with a crosshair (the first press brushes)", () => {
    chart();
    expect(h.isChartSelected()).toBe(false);
    expect(chartZoneAt(ctx(IN_PLOT))).toEqual({ kind: "content", cursor: "crosshair", part: "brush" });
  });

  it("the plot's edges are in; the title above it is frame", () => {
    chart();
    expect(chartZoneAt(ctx({ x: CHART.x + PLOT.x, y: CHART.y + PLOT.y }))?.kind).toBe("content");
    expect(chartZoneAt(ctx({ x: CHART.x + PLOT.x + PLOT.width, y: CHART.y + PLOT.y + PLOT.height }))?.kind).toBe(
      "content",
    );
    expect(chartZoneAt(ctx(ON_TITLE))).toBeNull();
    expect(chartZoneAt(ctx({ x: CHART.x + PLOT.x - 1, y: IN_PLOT.y }))).toBeNull();
  });

  it("the widget strip OFF its controls is frame, not the brush", () => {
    chart();
    h.cache.set("c1", {
      layout: { plotArea: PLOT },
      data: { categories: [], series: [] },
      widgetControls: [{ paramName: "n", bind: { input: "stepper" }, x: IN_PLOT.x - 10, y: IN_PLOT.y - 10, width: 20, height: 20, zones: [] }],
    });
    h.isChartSelected.mockReturnValue(true);
    expect(chartZoneAt(ctx(IN_PLOT))).toBeNull();
    // Beside the widget the plot is still the brush's.
    expect(chartZoneAt(ctx({ x: IN_PLOT.x + 40, y: IN_PLOT.y }))?.kind).toBe("content");
  });

  it("a SELECTED chart's widget CONTROL (a +/- step, an option) is content with a HAND; unselected, nothing is there", () => {
    chart({ params: undefined });
    const CONTROL = { x: CHART.x + 8, y: CHART.y + 8, width: 80, height: 22 };
    h.cache.set("c1", {
      layout: { plotArea: PLOT },
      data: { categories: [], series: [] },
      widgetControls: [
        {
          paramName: "n",
          bind: { input: "stepper" },
          ...CONTROL,
          text: "n: 3",
          current: "3",
          zones: [
            { x: CONTROL.x, y: CONTROL.y, width: 16, height: 22, action: { dir: -1 } },
            { x: CONTROL.x + 64, y: CONTROL.y, width: 16, height: 22, action: { dir: 1 } },
          ],
        },
      ],
    });
    h.isChartSelected.mockReturnValue(true);
    expect(chartZoneAt(ctx({ x: CONTROL.x + 5, y: CONTROL.y + 5 }))).toEqual({ kind: "content", cursor: "pointer", part: "widget" });
    expect(chartZoneAt(ctx({ x: CONTROL.x + 70, y: CONTROL.y + 5 }))).toEqual({ kind: "content", cursor: "pointer", part: "widget" });
    // The label between the steps is the strip, not a control: frame.
    expect(chartZoneAt(ctx({ x: CONTROL.x + 40, y: CONTROL.y + 5 }))).toBeNull();
    // The renderer keeps the last positions after a deselect: they are not painted then.
    h.isChartSelected.mockReturnValue(false);
    expect(chartZoneAt(ctx({ x: CONTROL.x + 5, y: CONTROL.y + 5 }))).toBeNull();
  });

  it("a COMPOSED chart (repeat / facet / concat) has no interval brush: frame", () => {
    chart({ repeat: { row: ["a", "b"] } });
    expect(chartZoneAt(ctx(IN_PLOT))).toBeNull();
  });

  it("a chart with no brush param, or a mark the point selection does not support, is frame", () => {
    chart({ params: [{ name: "pick", select: "point" }] });
    expect(chartZoneAt(ctx(IN_PLOT))).toBeNull();
    chart({ mark: "line" });
    expect(chartZoneAt(ctx(IN_PLOT))).toBeNull();
    chart({ params: undefined });
    expect(chartZoneAt(ctx(IN_PLOT))).toBeNull();
  });

  it("an unknown chart, or one whose layout is not cached yet, is frame", () => {
    expect(chartZoneAt(ctx(IN_PLOT))).toBeNull();
    chart();
    h.cache.delete("c1");
    expect(chartZoneAt(ctx(IN_PLOT))).toBeNull();
    expect(chartZoneAt({ ...ctx(IN_PLOT), region: { ...REGION, data: {} } })).toBeNull();
  });

  it("a SELECTED chart's quick-access buttons (outside its right edge) are CONTENT with a HAND; unselected, nothing is there", () => {
    chart();
    const BTN = { x: CHART.x + CHART.width + 8, y: CHART.y, width: 24, height: 24 };
    h.cache.set("c1", {
      layout: { plotArea: PLOT },
      data: { categories: [], series: [] },
      quickAccessButtons: [{ type: "elements", ...BTN, icon: "+", tooltip: "Chart Elements" }],
    });
    const onButton = { x: BTN.x + 12, y: BTN.y + 12 };
    h.isChartSelected.mockReturnValue(true);
    expect(chartZoneAt(ctx(onButton))).toEqual({ kind: "content", cursor: "pointer", part: "quickAccess" });
    // The renderer keeps the last positions after a deselect: they are not painted then.
    h.isChartSelected.mockReturnValue(false);
    expect(chartZoneAt(ctx(onButton))).toBeNull();
  });

  it("a pivot chart's FIELD buttons are CONTENT with a hand -- on a chart with no brush too, and before a brushable plot", () => {
    const FIELD = { x: 70, y: 50, width: 60, height: 18 };
    for (const spec of [{ params: undefined }, {}]) {
      chart(spec);
      h.cache.set("c1", {
        layout: { plotArea: PLOT },
        data: { categories: [], series: [] },
        // Local coordinates, inside the plot area here on purpose.
        pivotFieldButtons: [{ ...FIELD, area: "row", fieldIndex: 0, name: "Region" }],
      });
      const onField = { x: CHART.x + FIELD.x + 10, y: CHART.y + FIELD.y + 9 };
      expect(chartZoneAt(ctx(onField)), JSON.stringify(spec)).toEqual({ kind: "content", cursor: "pointer", part: "fieldButton" });
    }
    // Beside the button a brushable plot is still the brush's.
    expect(chartZoneAt(ctx(IN_PLOT))?.kind).toBe("content");
  });

  it("is PURE: hundreds of hover answers select nothing and write nothing", () => {
    chart();
    for (let i = 0; i < 200; i++) {
      chartZoneAt(ctx({ x: CHART.x + (i % 40) * 10, y: CHART.y + Math.floor(i / 40) * 60 }));
    }
    expect(h.selectChart).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe("what Core makes of it (resolveFloatingZone)", () => {
  function useSurface(s: Partial<LayoutSurface>): void {
    const surface: LayoutSurface = {
      snapToGrid: false,
      gridSize: 25,
      showGrid: false,
      page: { width: 1280, height: 720 },
      editable: true,
      ...s,
    };
    cleanups.push(registerLayoutSurfaceProvider({ get: () => surface }));
  }

  beforeEach(() => {
    cleanups.push(registerGridOverlay({ type: "chart", render: () => {}, zoneAt: chartZoneAt }));
  });

  it("the hover over a brushable plot is a crosshair; the rest of the chart is 'move'", () => {
    chart();
    expect(resolveFloatingZone(ctx(IN_PLOT))).toEqual({ kind: "content", part: "brush", cursor: "crosshair", canMove: true });
    expect(resolveFloatingZone(ctx(ON_TITLE))).toEqual({ kind: "frame", part: null, cursor: "move", canMove: true });
  });

  it("the bars of a NON-brushable chart are frame with no pointer of their own: 'move' (a drag there moves the chart), 'default' locked -- never a hand", () => {
    chart({ params: undefined });
    expect(resolveFloatingZone(ctx(IN_PLOT))).toEqual({ kind: "frame", part: null, cursor: "move", canMove: true });
    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(ctx(IN_PLOT))).toMatchObject({ kind: "frame", cursor: "default", canMove: false });
  });

  it("a button's hand survives the lock: it is content (it acts on release), so the lock never reaches it", () => {
    useSurface({ isLocked: () => true });
    chart();
    const FIELD = { x: 70, y: 50, width: 60, height: 18 };
    h.cache.set("c1", {
      layout: { plotArea: PLOT },
      data: { categories: [], series: [] },
      pivotFieldButtons: [{ ...FIELD, area: "row", fieldIndex: 0, name: "Region" }],
    });
    expect(resolveFloatingZone(ctx({ x: CHART.x + FIELD.x + 5, y: CHART.y + FIELD.y + 5 }))).toMatchObject({
      kind: "content",
      part: "fieldButton",
      cursor: "pointer",
    });
  });

  it("an unlocked chart's quick-access button is content with a hand (a drag from it is the button's, never a move)", () => {
    chart();
    const BTN = { x: CHART.x + CHART.width + 8, y: CHART.y, width: 24, height: 24 };
    h.cache.set("c1", {
      layout: { plotArea: PLOT },
      data: { categories: [], series: [] },
      quickAccessButtons: [{ type: "elements", ...BTN, icon: "+", tooltip: "Chart Elements" }],
    });
    h.isChartSelected.mockReturnValue(true);
    expect(resolveFloatingZone(ctx({ x: BTN.x + 12, y: BTN.y + 12 }))).toMatchObject({
      kind: "content",
      part: "quickAccess",
      cursor: "pointer",
    });
  });

  it("on a LOCKED canvas the plot still brushes (reading the report), and the frame shows 'default'", () => {
    useSurface({ isLocked: () => true });
    chart();
    expect(resolveFloatingZone(ctx(IN_PLOT))).toMatchObject({ kind: "content", cursor: "crosshair" });
    expect(resolveFloatingZone(ctx(ON_TITLE))).toMatchObject({ kind: "frame", cursor: "default", canMove: false });
  });
});

describe("index.ts registers it as the chart's ONE answer", () => {
  const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8").replace(/\/\/.*$/gm, "");
  const at = src.indexOf('type: "chart"');
  const block = src.slice(src.lastIndexOf("register({", at), src.indexOf("}),", at));

  it("zoneAt: chartZoneAt, and no claimsBodyDrag or getCursor beside it", () => {
    expect(at, "the chart registration is gone").toBeGreaterThan(0);
    expect(block).toMatch(/zoneAt\s*:\s*chartZoneAt\b/);
    expect(block).not.toMatch(/claimsBodyDrag\s*:/);
    expect(block).not.toMatch(/getCursor\s*:/);
  });

  it("the brush still takes Core's content press", () => {
    expect(src).toMatch(/addEventListener\("floatingObject:bodyDragStart",\s*handleBodyDragStart\)/);
  });
});
