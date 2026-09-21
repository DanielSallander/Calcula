//! FILENAME: app/extensions/Charts/handlers/__tests__/chartTextEditing.test.ts
// PURPOSE: Pin the chart's in-place text editing to the two things that can
//          quietly destroy the user's work, and to the one thing the gesture
//          owes the reader: a double-click has to mean the SAME thing twice.
//
// THE DATA-DESTROYING TRAP, AND WHY THE MOCK CARRIES A RESOLVED SPEC
// ------------------------------------------------------------------
// A chart title may be a cell reference. `resolveSpecReferences` returns a NEW
// spec whose `title` is the RESOLVED STRING, and that resolved spec is what
// reaches the layout and the painters. So a title stored as `=Sheet1!A1` opens
// showing "Revenue" if the editor is seeded from the render spec, and clicking
// away then writes the literal "Revenue" — the link is gone, nothing reports an
// error, and the chart silently stops tracking the cell.
//
// The cached-chart-data double below therefore CARRIES `resolvedSpec` with the
// resolved strings in it, even though the real `CachedChartData` has no such
// field. That is deliberate: the wrong source has to EXIST in the fixture, or
// "the editor shows the formula" is an assertion that could not have failed.
//
// THE EDITOR IS THE REAL ONE
// --------------------------
// `@api/overlayTextEditor` is NOT stubbed — only wrapped, so the options object
// can be inspected. Enter, commit and the live rect are exercised against the
// real <textarea> in the real canvas layer, because the cheap version of this
// test (assert we passed `enterInserts: true`) proves we passed a flag, not
// that Enter types a newline.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  ChartLayout,
  ChartSpec,
  HitGeometry,
  ParsedChartData,
} from "../../types";
import type { OverlayTextEditorOptions } from "@api/overlayTextEditor";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

// The grid is not mounted in a unit test, so the snapshot the editor's layout
// frame reads is supplied here (same shape the Core editor's own test uses).
vi.mock("@core/state/GridContext", () => ({
  getGridStateSnapshot: () => ({
    zoom: 1,
    config: { rowHeaderWidth: 22, colHeaderHeight: 20 },
    displayHeadings: true,
  }),
}));

const store = vi.hoisted(() => ({
  chart: null as { chartId: string; x: number; y: number; spec: ChartSpec } | null,
  updates: [] as Array<{ chartId: string; patch: Partial<ChartSpec> }>,
  invalidated: [] as string[],
  /** Where canvas 0,0 sits in chart-local space; moved to simulate a scroll. */
  originX: 200,
  originY: 100,
  cached: null as unknown,
}));

vi.mock("../../lib/chartStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChartById: (id: string) => (store.chart && store.chart.chartId === id ? store.chart : null),
  updateChartSpec: (chartId: string, patch: Partial<ChartSpec>) => {
    store.updates.push({ chartId, patch });
    if (store.chart && store.chart.chartId === chartId) {
      store.chart.spec = { ...store.chart.spec, ...patch } as ChartSpec;
    }
  },
}));

vi.mock("../../rendering/chartRenderer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedChartData: (id: string) => (store.chart && store.chart.chartId === id ? store.cached : null),
  getChartLocalCoords: (id: string, canvasX: number, canvasY: number) =>
    store.chart && store.chart.chartId === id
      ? { localX: canvasX - store.originX, localY: canvasY - store.originY }
      : null,
  invalidateChartCache: (id: string) => {
    store.invalidated.push(id);
  },
}));

/** Every options object the module handed to the seam, newest last. */
const opened: OverlayTextEditorOptions[] = [];

vi.mock("@api/overlayTextEditor", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/overlayTextEditor")>();
  return {
    ...real,
    openOverlayTextEditor: (opts: OverlayTextEditorOptions) => {
      opened.push(opts);
      return real.openOverlayTextEditor(opts);
    },
  };
});

const mod = await import("../chartTextEditing");
const selection = await import("../selectionHandler");

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CHART_ID = "chart-1";

/**
 * A fully furnished layout. Every rect below has a probe in ELEMENT_PROBES, and
 * they are laid out so no two overlap — a probe that collapsed onto `chartArea`
 * would make the element assertions pass for the wrong reason.
 */
const LAYOUT: ChartLayout = {
  width: 400,
  height: 300,
  margin: { top: 40, right: 20, bottom: 50, left: 60 },
  plotArea: { x: 60, y: 40, width: 320, height: 210 },
  elements: {
    family: "cartesian",
    chartArea: { x: 0, y: 0, width: 400, height: 300 },
    title: { x: 150, y: 8, width: 100, height: 14 },
    xAxisTitle: { x: 180, y: 275, width: 40, height: 11 },
    // Rotated -90deg: TALL and one font-size WIDE, as recordYAxisTitleRect writes it.
    yAxisTitle: { x: 14, y: 120, width: 11, height: 50 },
    xAxisBand: { x: 60, y: 250, width: 320, height: 20 },
    yAxisBand: { x: 30, y: 40, width: 30, height: 210 },
    legend: { x: 330, y: 40, width: 60, height: 40 },
    legendItems: [{ seriesIndex: 0, rect: { x: 332, y: 42, width: 56, height: 12 } }],
    measured: [],
  },
};

const GEOMETRY: HitGeometry = {
  type: "bars",
  rects: [
    {
      seriesIndex: 0,
      categoryIndex: 2,
      x: 70,
      y: 100,
      width: 30,
      height: 140,
      value: 42,
      seriesName: "Sales",
      categoryName: "Mar",
    },
  ],
};

/** chart-local probe points, one per element the double-click must tell apart. */
const PROBE = {
  title: { x: 200, y: 14 },
  xAxisTitle: { x: 200, y: 280 },
  yAxisTitle: { x: 20, y: 140 },
  legendEntry: { x: 350, y: 48 },
  legend: { x: 350, y: 70 },
  datum: { x: 80, y: 150 },
  plotArea: { x: 300, y: 150 },
  xAxis: { x: 200, y: 260 },
  yAxis: { x: 45, y: 100 },
  chartArea: { x: 395, y: 4 },
};

/** chart-local -> canvas, the inverse of the mocked getChartLocalCoords. */
function canvas(p: { x: number; y: number }): { canvasX: number; canvasY: number } {
  return { canvasX: p.x + store.originX, canvasY: p.y + store.originY };
}

function baseSpec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    title: "Revenue by month",
    data: { kind: "range", sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 2 },
    series: [],
    xAxis: { title: "Month", gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: "Amount", gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    ...over,
  } as unknown as ChartSpec;
}

function setChart(spec: ChartSpec, resolved?: Partial<ChartSpec>): void {
  store.chart = { chartId: CHART_ID, x: 10, y: 20, spec };
  store.cached = {
    data: { series: [], categories: [] } as unknown as ParsedChartData,
    layout: LAYOUT,
    hitGeometry: GEOMETRY,
    logicalWidth: 400,
    logicalHeight: 300,
    // NOT a real CachedChartData field. It is here so the WRONG source exists —
    // see the header.
    resolvedSpec: { ...spec, ...resolved },
  };
}

function dblCtx(p: { x: number; y: number }) {
  const c = canvas(p);
  return {
    region: { type: "chart", data: { chartId: CHART_ID } },
    canvasX: c.canvasX,
    canvasY: c.canvasY,
    row: 0,
    col: 0,
  } as unknown as Parameters<typeof mod.handleChartDoubleClick>[0];
}

let layer: HTMLDivElement;
const formatEvents: unknown[] = [];
const onFormat = (e: Event) => formatEvents.push((e as CustomEvent).detail);

beforeEach(() => {
  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);
  opened.length = 0;
  formatEvents.length = 0;
  store.updates.length = 0;
  store.invalidated.length = 0;
  store.originX = 200;
  store.originY = 100;
  setChart(baseSpec());
  mod.setChartDragActive(null);
  selection.resetSelectionHandlerState();
  window.addEventListener("chart:format-element", onFormat);
});

afterEach(() => {
  window.removeEventListener("chart:format-element", onFormat);
  mod.resetChartTextEditing();
  selection.resetSelectionHandlerState();
  document.body.innerHTML = "";
});

// ===========================================================================
// THE TRAP: raw spec for the TEXT, resolved layout for the RECT
// ===========================================================================

describe("seeding the editor", () => {
  it("shows the FORMULA of a cell-linked title, never the resolved value", () => {
    setChart(baseSpec({ title: "=Sheet1!A1" }), { title: "Revenue" });

    const handle = mod.openChartTextEditor(CHART_ID, "title");

    expect(handle).not.toBeNull();
    expect(handle!.getText()).toBe("=Sheet1!A1");
    expect(opened.at(-1)!.initialText).toBe("=Sheet1!A1");
    // The resolved value is reachable in the fixture, so this is a real refusal.
    expect((store.cached as { resolvedSpec: ChartSpec }).resolvedSpec.title).toBe("Revenue");
  });

  it("committing a cell-linked title untouched writes NOTHING", () => {
    setChart(baseSpec({ title: "=Sheet1!A1" }), { title: "Revenue" });

    const handle = mod.openChartTextEditor(CHART_ID, "title")!;
    handle.commit();

    expect(store.updates).toEqual([]);
    expect(store.chart!.spec.title).toBe("=Sheet1!A1");
  });

  it("does the same for BOTH axis titles", () => {
    setChart(
      baseSpec({
        xAxis: { ...baseSpec().xAxis, title: "=Sheet1!B2" },
        yAxis: { ...baseSpec().yAxis, title: "=Sheet1!C3" },
      } as Partial<ChartSpec>),
      { title: "Revenue" },
    );

    expect(mod.openChartTextEditor(CHART_ID, "xAxisTitle")!.getText()).toBe("=Sheet1!B2");
    expect(mod.openChartTextEditor(CHART_ID, "yAxisTitle")!.getText()).toBe("=Sheet1!C3");
  });

  it("asks for Excel's chart-title keying and for formula references", () => {
    mod.openChartTextEditor(CHART_ID, "title");
    const opts = opened.at(-1)!;
    expect(opts.enterInserts).toBe(true);
    expect(opts.acceptsFormulaReferences).toBe(true);
  });
});

// ===========================================================================
// The rect is recomputed, never captured
// ===========================================================================

describe("the editor rect", () => {
  it("is a FUNCTION of the live chart origin, so it follows a scroll", () => {
    const first = mod.chartTextEditorRect(CHART_ID, "title");
    // `originX/Y` is the chart's top-left in CANVAS space, so scrolling the grid
    // right by 60 logical px moves the object 60 px LEFT on the canvas — and the
    // editor has to go with it.
    store.originX = 140;
    store.originY = 40;
    const second = mod.chartTextEditorRect(CHART_ID, "title");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.x - first!.x).toBe(-60);
    expect(second!.y - first!.y).toBe(-60);
    expect(second!.width).toBe(first!.width);
  });

  it("is re-read by the seam every frame, not captured at open", async () => {
    const handle = mod.openChartTextEditor(CHART_ID, "title")!;
    const el = handle.getElement()!;
    const leftAtOpen = el.style.left;

    store.originX = 140;
    store.originY = 40;
    await new Promise((r) => setTimeout(r, 40)); // let a real rAF land

    expect(el.style.left).not.toBe(leftAtOpen);
    expect(el.style.left).toBe(`${mod.chartTextEditorRect(CHART_ID, "title")!.x}px`);
  });

  it("hides (null) while the object is being dragged or resized", () => {
    expect(mod.chartTextEditorRect(CHART_ID, "title")).not.toBeNull();
    mod.setChartDragActive(CHART_ID);
    expect(mod.chartTextEditorRect(CHART_ID, "title")).toBeNull();
    mod.setChartDragActive(null);
    expect(mod.chartTextEditorRect(CHART_ID, "title")).not.toBeNull();
  });

  it("hides when the element has no rect at all (no title to sit on)", () => {
    store.cached = { ...(store.cached as object), layout: { ...LAYOUT, elements: undefined } };
    expect(mod.chartTextEditorRect(CHART_ID, "title")).toBeNull();
  });

  it("un-rotates the y axis title into a horizontal box on the same centre", () => {
    // Tall enough that the minimum width cannot be what produces the answer.
    const rotated = { x: 14, y: 100, width: 11, height: 90 };
    const box = mod.editorBoxForElement("yAxisTitle", rotated);

    // The run of glyphs is the rect's HEIGHT when it is painted rotated.
    expect(box.width).toBe(90 + mod.CHART_TEXT_EDITOR_PAD_X * 2);
    expect(box.height).toBe(11 + mod.CHART_TEXT_EDITOR_PAD_Y * 2);
    expect(box.x + box.width / 2).toBe(rotated.x + rotated.width / 2);
    expect(box.y + box.height / 2).toBe(rotated.y + rotated.height / 2);
  });

  it("keeps a horizontal title horizontal, and never narrower than the minimum", () => {
    const wide = mod.editorBoxForElement("title", { x: 150, y: 8, width: 100, height: 14 });
    expect(wide.width).toBe(100 + mod.CHART_TEXT_EDITOR_PAD_X * 2);

    const tiny = mod.editorBoxForElement("title", { x: 190, y: 8, width: 6, height: 14 });
    expect(tiny.width).toBe(mod.CHART_TEXT_EDITOR_MIN_WIDTH);
    expect(tiny.x + tiny.width / 2).toBe(193);
  });
});

// ===========================================================================
// Typing
// ===========================================================================

describe("typing in the editor", () => {
  function keydown(el: HTMLElement, key: string): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  }

  it("Enter does NOT commit — it falls through to the textarea's own newline", () => {
    const handle = mod.openChartTextEditor(CHART_ID, "title")!;
    const el = handle.getElement()!;

    const e = keydown(el, "Enter");

    // Not prevented === the browser inserts the newline itself. That is the
    // whole of `enterInserts`; jsdom does not run the native insertion, so the
    // honest assertion is that nothing stopped it.
    expect(e.defaultPrevented).toBe(false);
    expect(handle.isOpen()).toBe(true);
    expect(store.updates).toEqual([]);
  });

  it("a commit produces exactly ONE spec write", () => {
    const handle = mod.openChartTextEditor(CHART_ID, "title")!;
    handle.setText("Quarterly revenue");
    handle.commit();

    expect(store.updates).toEqual([{ chartId: CHART_ID, patch: { title: "Quarterly revenue" } }]);
    expect(store.invalidated).toEqual([CHART_ID]);
    expect(handle.isOpen()).toBe(false);
    expect(mod.getActiveChartTextEdit()).toBeNull();
  });

  it("an x axis title commits into xAxis.title and keeps the axis's other fields", () => {
    const handle = mod.openChartTextEditor(CHART_ID, "xAxisTitle")!;
    handle.setText("Month of sale");
    handle.commit();

    expect(store.updates).toHaveLength(1);
    const patch = store.updates[0].patch as { xAxis: { title: string; gridLines: boolean } };
    expect(patch.xAxis.title).toBe("Month of sale");
    expect(patch.xAxis.gridLines).toBe(false);
  });

  it("a y axis title commits into yAxis.title", () => {
    const handle = mod.openChartTextEditor(CHART_ID, "yAxisTitle")!;
    handle.setText("SEK");
    handle.commit();

    const patch = store.updates[0].patch as { yAxis: { title: string; gridLines: boolean } };
    expect(patch.yAxis.title).toBe("SEK");
    expect(patch.yAxis.gridLines).toBe(true);
  });

  it("clearing the box removes the title — spec.title === null is reachable", () => {
    const handle = mod.openChartTextEditor(CHART_ID, "title")!;
    handle.setText("   ");
    handle.commit();

    expect(store.updates).toEqual([{ chartId: CHART_ID, patch: { title: null } }]);
  });

  it("an untouched edit writes nothing at all", () => {
    mod.openChartTextEditor(CHART_ID, "title")!.commit();
    expect(store.updates).toEqual([]);
  });

  it("a cancelled edit writes nothing and lets go of the session", () => {
    const handle = mod.openChartTextEditor(CHART_ID, "title")!;
    handle.setText("thrown away");
    handle.cancel();

    expect(store.updates).toEqual([]);
    expect(mod.getActiveChartTextEdit()).toBeNull();
  });

  it("deactivation DISCARDS a half-typed title rather than committing it", () => {
    const handle = mod.openChartTextEditor(CHART_ID, "title")!;
    handle.setText("half typed");
    mod.resetChartTextEditing();

    expect(store.updates).toEqual([]);
    expect(handle.isOpen()).toBe(false);
  });
});

// ===========================================================================
// The double-click
// ===========================================================================

describe("double-click resolution", () => {
  it("tells all ten elements apart, and each probe hits a DIFFERENT one", () => {
    const seen = new Map<string, string>();
    for (const [name, p] of Object.entries(PROBE)) {
      const c = canvas(p);
      const action = mod.resolveChartDoubleClick(CHART_ID, c.canvasX, c.canvasY);
      const id = action.kind === "editText" ? action.elementId : action.kind === "format" ? action.elementId : "none";
      seen.set(name, id);
    }
    expect(Object.fromEntries(seen)).toEqual({
      title: "title",
      xAxisTitle: "xAxisTitle",
      yAxisTitle: "yAxisTitle",
      legendEntry: "legendEntry",
      legend: "legend",
      datum: "datum",
      plotArea: "plotArea",
      xAxis: "xAxis",
      yAxis: "yAxis",
      chartArea: "chartArea",
    });
    expect(new Set(seen.values()).size).toBe(Object.keys(PROBE).length);
  });

  it("the three text elements open the editor; everything else asks for Format", () => {
    for (const name of ["title", "xAxisTitle", "yAxisTitle"] as const) {
      const c = canvas(PROBE[name]);
      expect(mod.resolveChartDoubleClick(CHART_ID, c.canvasX, c.canvasY).kind).toBe("editText");
    }
    for (const name of ["legendEntry", "legend", "datum", "plotArea", "xAxis", "yAxis", "chartArea"] as const) {
      const c = canvas(PROBE[name]);
      expect(mod.resolveChartDoubleClick(CHART_ID, c.canvasX, c.canvasY).kind).toBe("format");
    }
  });

  it("opens the editor on the title, on a chart that was not selected", () => {
    const took = mod.handleChartDoubleClick(dblCtx(PROBE.title));

    expect(took).toBe(true);
    expect(mod.getActiveChartTextEdit()).toEqual({ chartId: CHART_ID, elementId: "title" });
    expect(selection.getSubSelection()).toEqual({ level: "element", elementId: "title" });
    expect(formatEvents).toEqual([]);
  });

  it("emits ONE format request for a non-text element, with the selection it just made", () => {
    const took = mod.handleChartDoubleClick(dblCtx(PROBE.yAxis));

    expect(took).toBe(true);
    expect(formatEvents).toEqual([
      { chartId: CHART_ID, elementId: "yAxis", seriesIndex: undefined, axisType: "y" },
    ]);
    expect(selection.getSubSelection()).toEqual({ level: "axis", axisType: "y" });
    expect(mod.getActiveChartTextEdit()).toBeNull();
  });

  // THE STATE-DEPENDENCE TRAP, made deliberate: the two clicks inside a
  // double-click advance the ladder once on a fresh chart and twice on an
  // already-selected one, and by the time dblclick arrives both have run. So
  // the gesture STATES its answer instead of nudging the ladder.
  it("gives the SAME answer on a datum whatever was selected first", () => {
    const answers: unknown[] = [];

    // (a) nothing selected
    mod.handleChartDoubleClick(dblCtx(PROBE.datum));
    answers.push(selection.getSubSelection());

    // (b) the chart is selected and the ladder has already climbed to a point
    selection.resetSelectionHandlerState();
    selection.selectChart(CHART_ID);
    selection.setSubSelection(CHART_ID, { level: "dataPoint", seriesIndex: 0, categoryIndex: 2 });
    mod.handleChartDoubleClick(dblCtx(PROBE.datum));
    answers.push(selection.getSubSelection());

    // (c) an axis was selected
    selection.resetSelectionHandlerState();
    selection.selectChart(CHART_ID);
    selection.setSubSelection(CHART_ID, { level: "axis", axisType: "x" });
    mod.handleChartDoubleClick(dblCtx(PROBE.datum));
    answers.push(selection.getSubSelection());

    expect(answers[0]).toEqual({ level: "series", seriesIndex: 0 });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(formatEvents).toHaveLength(3);
    expect(formatEvents.every((d) => (d as { elementId: string }).elementId === "datum")).toBe(true);
  });

  it("a double-click INSIDE the open editor neither re-enters nor closes it", () => {
    const handle = mod.handleChartDoubleClick(dblCtx(PROBE.title))
      ? mod.getActiveChartTextEdit()
      : null;
    expect(handle).not.toBeNull();

    const rect = mod.chartTextEditorRect(CHART_ID, "title")!;
    const inside = {
      region: { type: "chart", data: { chartId: CHART_ID } },
      canvasX: rect.x + rect.width / 2,
      canvasY: rect.y + rect.height / 2,
      row: 0,
      col: 0,
    } as unknown as Parameters<typeof mod.handleChartDoubleClick>[0];

    const openedBefore = opened.length;
    const took = mod.handleChartDoubleClick(inside);

    expect(took).toBe(true);
    expect(opened.length).toBe(openedBefore); // no second session
    expect(mod.getActiveChartTextEdit()).toEqual({ chartId: CHART_ID, elementId: "title" });
    expect(formatEvents).toEqual([]);
  });

  it("refuses the gesture when there is nothing cached to hit-test", () => {
    store.cached = null;
    expect(mod.handleChartDoubleClick(dblCtx(PROBE.title))).toBe(false);
  });
});

// ===========================================================================
// The slow-click route, and Delete
// ===========================================================================

describe("the slow single-click route", () => {
  const titleHit = { element: "title" as const, type: "none" as const };

  it("does nothing on the FIRST click — the title is only selected", () => {
    selection.selectChart(CHART_ID);
    expect(mod.maybeEnterTextEditOnClick(CHART_ID, titleHit)).toBe(false);
    expect(mod.getActiveChartTextEdit()).toBeNull();
  });

  it("opens the editor on the SECOND click of an already-selected title", () => {
    selection.selectChart(CHART_ID);
    selection.setSubSelection(CHART_ID, { level: "element", elementId: "title" });

    expect(mod.maybeEnterTextEditOnClick(CHART_ID, titleHit)).toBe(true);
    expect(mod.getActiveChartTextEdit()).toEqual({ chartId: CHART_ID, elementId: "title" });
  });

  it("does not fire for a DIFFERENT element than the one selected", () => {
    selection.selectChart(CHART_ID);
    selection.setSubSelection(CHART_ID, { level: "element", elementId: "xAxisTitle" });
    expect(mod.maybeEnterTextEditOnClick(CHART_ID, titleHit)).toBe(false);
  });
});

describe("Delete over a selected title", () => {
  it("clears the title and leaves the chart alone", () => {
    selection.selectChart(CHART_ID);
    selection.setSubSelection(CHART_ID, { level: "element", elementId: "title" });

    expect(mod.handleChartTextDelete(CHART_ID)).toBe(true);
    expect(store.updates).toEqual([{ chartId: CHART_ID, patch: { title: null } }]);
  });

  it("clears an axis title too", () => {
    selection.selectChart(CHART_ID);
    selection.setSubSelection(CHART_ID, { level: "element", elementId: "yAxisTitle" });

    expect(mod.handleChartTextDelete(CHART_ID)).toBe(true);
    expect((store.updates[0].patch as { yAxis: { title: null } }).yAxis.title).toBeNull();
  });

  it("declines when the selection is not a text element, so the chart is deleted", () => {
    selection.selectChart(CHART_ID);
    selection.setSubSelection(CHART_ID, { level: "series", seriesIndex: 0 });
    expect(mod.handleChartTextDelete(CHART_ID)).toBe(false);

    selection.setSubSelection(CHART_ID, { level: "element", elementId: "legend" });
    expect(mod.handleChartTextDelete(CHART_ID)).toBe(false);

    expect(store.updates).toEqual([]);
  });

  it("declines a second time — an already-absent title is not a write", () => {
    selection.selectChart(CHART_ID);
    selection.setSubSelection(CHART_ID, { level: "element", elementId: "title" });
    expect(mod.handleChartTextDelete(CHART_ID)).toBe(true);
    store.updates.length = 0;
    expect(mod.handleChartTextDelete(CHART_ID)).toBe(false);
    expect(store.updates).toEqual([]);
  });
});
