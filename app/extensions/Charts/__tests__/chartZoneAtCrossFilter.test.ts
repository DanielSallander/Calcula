//! FILENAME: app/extensions/Charts/__tests__/chartZoneAtCrossFilter.test.ts
// PURPOSE: The cross-filter half of the chart's zone answer (P4 S6,
//          lib/chartZoneAt.ts `crossFilterPressAt`): a press on a datum or a
//          legend entry of a cross-filter SOURCE chart is CONTENT
//          `{cursor:'pointer', part:'crossFilter'}` -- and its background too
//          while the chart holds a selection -- exactly when the chart is a
//          design-query chart with a model connection, on a CANVAS page, outside
//          Design Mode, with a source-capable mark and no `select:"point"`
//          param. The zone matrix: canvas vs worksheet, Design Mode on and off,
//          `select:"point"`, the mark's capability, datum vs empty, range chart.
// CONTEXT: The release grammar is pinned in crossFilterClick.test.ts, the
//          index.ts press/release wiring in chartCrossFilterRelease.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  charts: new Map<string, Record<string, unknown>>(),
  cache: new Map<string, Record<string, unknown>>(),
  /** Sheet indexes that are canvas pages. */
  canvasIndexes: new Set<number>([2]),
}));

vi.mock("../lib/chartStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChartById: (id: string) => h.charts.get(id) ?? null,
  getAllCharts: () => [...h.charts.values()],
}));

vi.mock("../rendering/chartRenderer", () => ({
  getCachedChartData: (id: string) => h.cache.get(id),
  getChartLocalCoords: (id: string, canvasX: number, canvasY: number) => {
    const c = h.charts.get(id) as { x: number; y: number } | undefined;
    return c ? { localX: canvasX - c.x, localY: canvasY - c.y } : null;
  },
}));

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => ({
    pages: [...h.canvasIndexes].map((index) => ({ index, sheetId: `sheet-${index}`, name: `Page ${index}` })),
    sheetIdByIndex: new Map([0, 1, 2, 3].map((i) => [i, `sheet-${i}`])),
    activeIndex: 2,
    version: 1,
  }),
}));

import { setDesignMode } from "@api/designMode";
import { clearCrossFilters, setCrossFilter } from "@api/reportFilters";
import { chartZoneAt } from "../lib/chartZoneAt";
import type { GridRegion, OverlayHitTestContext } from "@api/gridOverlays";

/** The chart at canvas (100, 50), 400 x 300; plot local (60, 40) 300 x 200. */
const C = { x: 100, y: 50, width: 400, height: 300 };
const PLOT = { x: 60, y: 40, width: 300, height: 200 };
/** One bar, chart-local, and a legend entry for series 0. */
const BAR = { x: 100, y: 100, width: 40, height: 140 };
const LEGEND_ITEM = { x: 300, y: 260, width: 60, height: 16 };

const ON_BAR = { x: C.x + BAR.x + 20, y: C.y + BAR.y + 70 };
const ON_LEGEND = { x: C.x + LEGEND_ITEM.x + 10, y: C.y + LEGEND_ITEM.y + 8 };
/** In the plot, off every bar. */
const ON_PLOT_BG = { x: C.x + PLOT.x + 250, y: C.y + PLOT.y + 20 };
/** The outer margin (the title strip). */
const ON_MARGIN = { x: C.x + 200, y: C.y + 10 };

const XF = { kind: "content", cursor: "pointer", part: "crossFilter" };

function chart(over: { sheetIndex?: number; spec?: Record<string, unknown> } = {}): void {
  h.charts.set("c1", {
    chartId: "c1",
    name: "Sales by Region",
    sheetIndex: over.sheetIndex ?? 2,
    ...C,
    spec: {
      mark: "bar",
      data: { type: "designQuery", connectionId: "conn-1", dslText: "ROWS: Geo.Region\nVALUES: [Sales]" },
      ...(over.spec ?? {}),
    },
  });
  h.cache.set("c1", {
    data: { categories: ["East"], series: [{ name: "Sales", values: [5] }] },
    layout: {
      width: C.width,
      height: C.height,
      margin: { top: 40, right: 40, bottom: 60, left: 60 },
      plotArea: PLOT,
      elements: {
        family: "cartesian",
        chartArea: { x: 0, y: 0, width: C.width, height: C.height },
        legendItems: [{ seriesIndex: 0, rect: LEGEND_ITEM }],
        measured: [],
      },
    },
    hitGeometry: {
      type: "bars",
      rects: [{ seriesIndex: 0, categoryIndex: 0, ...BAR, value: 5, seriesName: "Sales", categoryName: "East" }],
    },
  });
}

const REGION: GridRegion = {
  id: "chart-c1",
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { ...C },
  data: { chartId: "c1" },
};

function zoneAt(p: { x: number; y: number }) {
  const ctx: OverlayHitTestContext = { region: REGION, canvasX: p.x, canvasY: p.y, row: 0, col: 0, floatingCanvasBounds: { ...C } };
  return chartZoneAt(ctx);
}

function holdSelection(): void {
  setCrossFilter({
    source: { kind: "chart", id: "c1" },
    sourceName: "Sales by Region",
    pageSheetId: "sheet-2",
    connectionId: "conn-1",
    fields: ["Geo.Region"],
    tuples: [["East"]],
  });
}

beforeEach(() => {
  h.charts.clear();
  h.cache.clear();
  h.canvasIndexes = new Set([2]);
  setDesignMode(false);
  clearCrossFilters();
});

afterEach(() => {
  setDesignMode(false);
  clearCrossFilters();
});

describe("a cross-filter source's zone", () => {
  it("a datum and a legend entry of a canvas design-query bar chart, Design Mode OFF: content with a hand", () => {
    chart();
    expect(zoneAt(ON_BAR)).toEqual(XF);
    expect(zoneAt(ON_LEGEND)).toEqual(XF);
  });

  it("Design Mode ON: the datum is frame again (the ladder and the move keep the press)", () => {
    chart();
    setDesignMode(true);
    expect(zoneAt(ON_BAR)).toBeNull();
    expect(zoneAt(ON_LEGEND)).toBeNull();
  });

  it("on a WORKSHEET: frame (cross-filter is canvas only)", () => {
    chart({ sheetIndex: 0 });
    expect(zoneAt(ON_BAR)).toBeNull();
  });

  it("a select:\"point\" param wins: no cross-filter zone (the brush answers when it brushes)", () => {
    chart({ spec: { params: [{ name: "pick", select: "point" }] } });
    expect(zoneAt(ON_BAR)).toBeNull();
    chart({ spec: { params: [{ name: "pick", select: "point", brush: true }] } });
    expect(zoneAt(ON_BAR)).toEqual({ kind: "content", cursor: "crosshair", part: "brush" });
  });

  it("a mark that declares no source capability (a waterfall, a card): frame", () => {
    chart({ spec: { mark: "waterfall" } });
    expect(zoneAt(ON_BAR)).toBeNull();
    chart({ spec: { mark: "card" } });
    expect(zoneAt(ON_BAR)).toBeNull();
  });

  it("a source-only mark (line) is a source too", () => {
    chart({ spec: { mark: "line" } });
    // The bar geometry stands in for the line's markers: the zone asks the hit test, not the mark.
    expect(zoneAt(ON_BAR)).toEqual(XF);
  });

  it("a RANGE chart, a transformed chart: frame", () => {
    chart({ spec: { data: "Sheet1!A1:B5" } });
    expect(zoneAt(ON_BAR)).toBeNull();
    chart({ spec: { transform: [{ filter: "datum.Sales > 0" }] } });
    expect(zoneAt(ON_BAR)).toBeNull();
  });

  it("off every datum with NO selection held: the plot background and the margin are frame (the chart moves)", () => {
    chart();
    expect(zoneAt(ON_PLOT_BG)).toBeNull();
    expect(zoneAt(ON_MARGIN)).toBeNull();
  });

  it("off every datum WHILE the chart holds a selection: the background and the margin are content (a click clears it)", () => {
    chart();
    holdSelection();
    expect(zoneAt(ON_PLOT_BG)).toEqual(XF);
    expect(zoneAt(ON_MARGIN)).toEqual(XF);
    // ...and Design Mode still wins.
    setDesignMode(true);
    expect(zoneAt(ON_PLOT_BG)).toBeNull();
  });

  it("is pure: asking it changes no selection", () => {
    chart();
    holdSelection();
    zoneAt(ON_BAR);
    zoneAt(ON_PLOT_BG);
    expect(zoneAt(ON_BAR)).toEqual(XF);
  });
});
