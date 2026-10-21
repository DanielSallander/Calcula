//! FILENAME: app/extensions/Charts/__tests__/chartCrossFilterRelease.test.ts
// PURPOSE: The index.ts wiring of a cross-filter press (P4 S6, DC-8), driven
//          through the REAL `activate()` with the window events Core dispatches
//          for a CONTENT press (`floatingObject:selected`, then
//          `floatingObject:bodyDragStart` with `part: "crossFilter"`) and a real
//          window mouseup:
//            - the press is armed ONLY for that part: a frame press (or another
//              content part) never cross-filters, and a frame click on a
//              selected chart still steps the ladder;
//            - released over ANOTHER datum, or where another object covers the
//              point, it does nothing -- no selection, no cue, no ladder step;
//            - released over the same datum, in order: an UNSELECTED chart
//              becomes selected at OBJECT level and its ladder does not
//              advance; the insight cue is assigned from the PRESS's own record
//              (on an unselected chart -- no pending click ever existed -- and
//              on a selected one, whose pending click the press cleared); then
//              the gesture sets the selection;
//            - Ctrl at the press toggles within the source (Core sends the raw
//              modifiers on bodyDragStart);
//            - a press whose release was never heard acts on nothing later;
//            - the product's chart delete clears the chart's selection.
// CONTEXT: The zone answer is pinned in chartZoneAtCrossFilter.test.ts, the
//          grammar in handlers/__tests__/crossFilterClick.test.ts. Harness and
//          doubles as in chartButtonRelease.test.ts.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

const h = vi.hoisted(() => ({
  charts: new Map<string, Record<string, unknown>>(),
  cache: new Map<string, Record<string, unknown>>(),
  covered: vi.fn((_regionId: string, _x: number, _y: number) => false),
  setSelectedChartCue: vi.fn(),
  storeDelete: vi.fn(async (_id: string) => null as string | null),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  isFloatingRegionCoveredAtClient: (regionId: string, x: number, y: number) => h.covered(regionId, x, y),
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => (cmd === "get_all_styles" ? [] : null)),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

/** One insight cue, on the "2024" series. */
const CUE = { cueId: "q1", anchor: { type: "series", series: "2024" } };
vi.mock("@api/chartCues", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@api/chartCues")>();
  return {
    ...orig,
    getChartOverlay: (id: string) => (id === "c1" ? { cues: [CUE], comments: [] } : orig.getChartOverlay(id)),
    visibleChartCues: (id: string) => (id === "c1" ? [CUE] : orig.visibleChartCues(id)),
    setSelectedChartCue: (...args: unknown[]) => h.setSelectedChartCue(...args),
  };
});

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => ({
    pages: [{ index: 2, sheetId: "sheet-2", name: "Page 1" }],
    sheetIdByIndex: new Map([[2, "sheet-2"]]),
    activeIndex: 2,
    version: 1,
  }),
}));

vi.mock("../lib/chartStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChartById: (id: string) => h.charts.get(id) ?? null,
  getAllCharts: () => [...h.charts.values()],
  deleteChart: (id: string) => {
    h.charts.delete(id);
    return h.storeDelete(id);
  },
}));

vi.mock("../rendering/chartRenderer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedChartData: (id: string) => h.cache.get(id),
  getChartLocalCoords: (id: string, canvasX: number, canvasY: number) => {
    const c = h.charts.get(id) as { x: number; y: number } | undefined;
    return c ? { localX: canvasX - c.x, localY: canvasY - c.y } : null;
  },
}));

const CHARTS: Loader = () => import("..");

/** The chart at canvas (100, 50), 400 x 300; two bars, chart-local. */
const C = { x: 100, y: 50, width: 400, height: 300 };
const BAR_A = { x: 100, y: 100, width: 40, height: 140 }; // East / 2024
const BAR_B = { x: 200, y: 100, width: 40, height: 140 }; // West / 2025
const ON_A = { x: C.x + BAR_A.x + 20, y: C.y + BAR_A.y + 70 };
const ON_B = { x: C.x + BAR_B.x + 20, y: C.y + BAR_B.y + 70 };
/** The chart's body off every bar (a frame press there selects and moves). */
const ON_BODY = { x: C.x + 200, y: C.y + 10 };

function seed(): void {
  h.charts.clear();
  h.cache.clear();
  h.charts.set("c1", {
    chartId: "c1",
    name: "Sales",
    sheetIndex: 2,
    ...C,
    spec: { mark: "bar", data: { type: "designQuery", connectionId: "conn-1", dslText: "" } },
  });
  h.cache.set("c1", {
    data: {
      categories: ["East", "West"],
      series: [
        { name: "2024", values: [1, 2] },
        { name: "2025", values: [3, 4] },
      ],
      categoryMembers: [[{ field: "Geo.Region", key: "East" }], [{ field: "Geo.Region", key: "West" }]],
      seriesMembers: [[{ field: "Date.Year", key: "2024" }], [{ field: "Date.Year", key: "2025" }]],
    },
    layout: {
      width: C.width,
      height: C.height,
      margin: { top: 40, right: 40, bottom: 60, left: 60 },
      plotArea: { x: 60, y: 40, width: 300, height: 200 },
    },
    hitGeometry: {
      type: "bars",
      rects: [
        { seriesIndex: 0, categoryIndex: 0, ...BAR_A, value: 1, seriesName: "2024", categoryName: "East" },
        { seriesIndex: 1, categoryIndex: 1, ...BAR_B, value: 4, seriesName: "2025", categoryName: "West" },
      ],
    },
  });
}

function fire(name: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

const REGION = { regionId: "chart-c1", regionType: "chart", data: { chartId: "c1" } };

function framePress(at: { x: number; y: number }): void {
  fire("floatingObject:selected", { ...REGION, zone: "frame", part: null, canvasX: at.x, canvasY: at.y, ctrlKey: false, shiftKey: false });
}

/** Core's CONTENT press: `selected` (no modifiers), then `bodyDragStart` with the part and the RAW modifiers. */
function contentPress(part: string, at: { x: number; y: number }, ctrlKey = false): void {
  fire("floatingObject:selected", { ...REGION, zone: "content", part, canvasX: at.x, canvasY: at.y, ctrlKey: false, shiftKey: false });
  fire("floatingObject:bodyDragStart", { ...REGION, part, canvasX: at.x, canvasY: at.y, ctrlKey, shiftKey: false });
}

function release(at: { x: number; y: number }, button = 0): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button }));
}

type Selection = typeof import("../handlers/selectionHandler");
type ReportFilters = typeof import("@api/reportFilters");

let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let selection: Selection;
let rf: ReportFilters;
let host: HTMLElement;

beforeAll(async () => {
  host = document.createElement("div");
  host.appendChild(document.createElement("canvas"));
  document.body.appendChild(host);
  const harness = await loadHarness(CHARTS);
  ext = harness.ext;
  await ext.activate(harness.context);
  await settle();
  selection = await import("../handlers/selectionHandler");
  rf = await import("@api/reportFilters");
});

afterAll(async () => {
  await ext.deactivate?.();
  await settle();
  host.remove();
});

beforeEach(() => {
  seed();
  release({ x: -500, y: -500 });
  selection.deselectChart();
  rf.clearCrossFilters();
  h.covered.mockReset();
  h.covered.mockImplementation(() => false);
  h.setSelectedChartCue.mockClear();
  h.storeDelete.mockClear();
});

const held = () => rf.getCrossFilters().find((s) => s.source.id === "c1") ?? null;

function selectTheChart(): void {
  framePress(ON_BODY);
  selection.consumePendingClick();
  release({ x: -500, y: -500 });
  expect(selection.isChartSelected("c1"), "precondition: the chart is selected").toBe(true);
  expect(selection.getSubSelection().level).toBe("chart");
}

describe("a cross-filter press acts at its release over the SAME datum", () => {
  it("UNSELECTED chart: selected at object level, the cue assigned from the press, then the selection set", () => {
    expect(selection.isChartSelected("c1")).toBe(false);
    contentPress("crossFilter", ON_A);
    expect(held(), "the press acted before its release").toBeNull();
    release(ON_A);
    expect(selection.isChartSelected("c1")).toBe(true);
    expect(selection.getSubSelection().level, "the ladder advanced past object level").toBe("chart");
    expect(h.setSelectedChartCue).toHaveBeenCalledWith("c1", "q1");
    expect(held()).toMatchObject({ fields: ["Geo.Region", "Date.Year"], tuples: [["East", "2024"]], pageSheetId: "sheet-2" });
  });

  it("SELECTED chart: the press cleared the pending click; the cue still comes from the press record; the ladder stays", () => {
    selectTheChart();
    contentPress("crossFilter", ON_B);
    expect(selection.consumePendingClick(), "the cross-filter press left a pending ladder click armed").toBeNull();
    release(ON_B);
    // The cue on the PRESSED datum: B carries no cue, so the cue is cleared (never left on A's).
    expect(h.setSelectedChartCue).toHaveBeenCalledWith("c1", null);
    expect(selection.getSubSelection().level).toBe("chart");
    expect(held()?.tuples).toEqual([["West", "2025"]]);
  });

  it("released over ANOTHER datum: nothing -- no selection, no cue", () => {
    contentPress("crossFilter", ON_A);
    release(ON_B);
    expect(held()).toBeNull();
    expect(h.setSelectedChartCue).not.toHaveBeenCalled();
  });

  it("released where another object COVERS the point: nothing (Core's occlusion question)", () => {
    h.covered.mockImplementation((regionId, x, y) => regionId === "chart-c1" && x === ON_A.x && y === ON_A.y);
    contentPress("crossFilter", ON_A);
    release(ON_A);
    expect(h.covered).toHaveBeenCalledWith("chart-c1", ON_A.x, ON_A.y);
    expect(held()).toBeNull();
  });

  it("a secondary-button release does nothing", () => {
    contentPress("crossFilter", ON_A);
    release(ON_A, 1);
    expect(held()).toBeNull();
  });

  it("Ctrl at the press toggles within the source (a second datum is ADDED)", () => {
    contentPress("crossFilter", ON_A);
    release(ON_A);
    contentPress("crossFilter", ON_B, true);
    release(ON_B);
    expect(held()?.tuples).toEqual([
      ["East", "2024"],
      ["West", "2025"],
    ]);
    // A plain click on A now narrows to it.
    contentPress("crossFilter", ON_A);
    release(ON_A);
    expect(held()?.tuples).toEqual([["East", "2024"]]);
    // ...and on the sole selected datum, clears it.
    contentPress("crossFilter", ON_A);
    release(ON_A);
    expect(held()).toBeNull();
  });
});

describe("the press is armed only for its part", () => {
  it("a FRAME click on a selected chart over a bar steps the ladder and never cross-filters", () => {
    selectTheChart();
    // The pending click reads the extension's own pointer basis (the last move).
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: ON_A.x, clientY: ON_A.y, buttons: 0 }));
    framePress(ON_A);
    release(ON_A);
    expect(held()).toBeNull();
    expect(selection.getSubSelection().level, "the frame click no longer steps the ladder").not.toBe("chart");
  });

  it("another content part (a quick-access button press) never cross-filters", () => {
    contentPress("quickAccess", ON_A);
    release(ON_A);
    expect(held()).toBeNull();
  });

  it("a press whose release was never heard acts on nothing at a later release", () => {
    contentPress("crossFilter", ON_A);
    // The primary button is UP on a move: the release was lost.
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: ON_A.x, clientY: ON_A.y, buttons: 0 }));
    release(ON_A);
    expect(held()).toBeNull();
  });
});

describe("deleting the chart clears its selection", () => {
  it("the product's delete (a landed one) drops the chart's cross-filter selection", async () => {
    contentPress("crossFilter", ON_A);
    release(ON_A);
    expect(held()).not.toBeNull();
    (window as unknown as { __CALCULA_CHARTS__: { deleteChart: (id: string) => boolean } }).__CALCULA_CHARTS__.deleteChart("c1");
    await settle();
    expect(h.storeDelete).toHaveBeenCalledWith("c1");
    expect(held(), "a deleted chart still filters its page").toBeNull();
  });

  it("a REFUSED delete keeps the chart's selection", async () => {
    contentPress("crossFilter", ON_A);
    release(ON_A);
    h.storeDelete.mockImplementationOnce(async () => "The sheet protects its objects");
    (window as unknown as { __CALCULA_CHARTS__: { deleteChart: (id: string) => boolean } }).__CALCULA_CHARTS__.deleteChart("c1");
    await settle();
    expect(held()).not.toBeNull();
  });
});
