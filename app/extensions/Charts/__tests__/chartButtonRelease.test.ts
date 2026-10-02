//! FILENAME: app/extensions/Charts/__tests__/chartButtonRelease.test.ts
// PURPOSE: The chart's own BUTTONS act on RELEASE over the same button
//          (BUG-0258 design phase 4b), driven through the REAL `activate()`
//          with the real window events Core dispatches for a CONTENT press
//          (`floatingObject:selected`, then `floatingObject:bodyDragStart`
//          with the zone's part) and a real window mouseup:
//            - a quick-access button opens its popup at the release over it,
//              never at the press; released 40 px away, or over ANOTHER
//              button, it opens nothing;
//            - a pivot field button acts on the FIRST press of an unselected
//              pivot chart, at its release (the old first-click special case
//              in the selected handler is gone: bodyDragStart owns it);
//            - a widget control steps its param once at the release over the
//              same step, and not when released over the other step;
//            - part 'brush' still starts and finalizes the interval brush;
//            - a 'grip' press arms no pending click (BUG-0258 phase 5's guard);
//            - a button press whose release was never heard acts on nothing
//              later: the next press, or a move with the primary button up,
//              drops it;
//            - Escape and a window blur end a held button press with nothing
//              done -- on an UNSELECTED pivot chart's field button too (its
//              button is live without a selection) -- and the Escape is the
//              press's (default prevented);
//            - a release over the same button where ANOTHER object covers it
//              acts on nothing (Core's occlusion question, asked with the
//              chart's region and the release's client point);
//            - the press holds Core's pointer over the chart (no grip, no
//              resize handle under a held button) and lets go on every end
//              path (BUG-0258 M7 review).
// CONTEXT: The zone answer that makes these presses content is pinned in
//          chartZoneAt.test.ts; the mouseup's press-scoped lifetime in
//          chartMouseupLifetime.test.ts. The extension is activated through
//          the lifecycle harness (insertChartCommand.test.ts's precedent); the
//          chart store and the renderer's cache are doubled at their modules.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

const h = vi.hoisted(() => ({
  charts: new Map<string, Record<string, unknown>>(),
  cache: new Map<string, Record<string, unknown>>(),
  showOverlay: vi.fn(),
  hideOverlay: vi.fn(),
  emitted: [] as unknown[][],
  setBrushMarquee: vi.fn(),
  invalidateChartCache: vi.fn(),
  /** Core's occlusion answer: another object covers this region at this client point. */
  covered: vi.fn((_regionId: string, _x: number, _y: number) => false),
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

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showOverlay: h.showOverlay,
  hideOverlay: h.hideOverlay,
}));

vi.mock("@api/events", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@api/events")>();
  return {
    ...orig,
    emitAppEvent: (...args: unknown[]) => {
      h.emitted.push(args);
      return (orig.emitAppEvent as (...a: unknown[]) => unknown)(...args);
    },
  };
});

vi.mock("../lib/chartStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChartById: (id: string) => h.charts.get(id) ?? null,
  getAllCharts: () => [...h.charts.values()],
}));

// The renderer's cache and its canvas basis: the chart's local point is the
// canvas point minus the chart's position (no gutters, no scroll here).
vi.mock("../rendering/chartRenderer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedChartData: (id: string) => h.cache.get(id),
  getChartLocalCoords: (id: string, canvasX: number, canvasY: number) => {
    const c = h.charts.get(id) as { x: number; y: number } | undefined;
    return c ? { localX: canvasX - c.x, localY: canvasY - c.y } : null;
  },
  setBrushMarquee: h.setBrushMarquee,
  invalidateChartCache: h.invalidateChartCache,
}));

const CHARTS: Loader = () => import("..");

/** The chart at canvas (100, 50), 400 x 300. */
const C = { x: 100, y: 50, width: 400, height: 300 };
/** Two quick-access buttons outside its right edge (absolute canvas px). */
const QA_ELEMENTS = { x: C.x + C.width + 8, y: C.y, width: 26, height: 26 };
const QA_STYLES = { x: C.x + C.width + 8, y: C.y + 30, width: 26, height: 26 };
/** A pivot field button, chart-local. */
const FIELD = { x: 70, y: 260, width: 60, height: 18 };
/** A stepper widget: its - and + steps (absolute canvas px). */
const W = { x: C.x + 8, y: C.y + 8 };
const W_MINUS = { x: W.x, y: W.y, width: 16, height: 22 };
const W_PLUS = { x: W.x + 64, y: W.y, width: 16, height: 22 };

const mid = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const ON_ELEMENTS = mid(QA_ELEMENTS);
const ON_STYLES = mid(QA_STYLES);
const ON_FIELD = { x: C.x + FIELD.x + 10, y: C.y + FIELD.y + 9 };
const ON_MINUS = mid(W_MINUS);
const ON_PLUS = mid(W_PLUS);
const ON_BODY = { x: C.x + 200, y: C.y + 150 };

function seed(): void {
  h.charts.clear();
  h.cache.clear();
  h.charts.set("c1", {
    chartId: "c1",
    sheetIndex: 0,
    ...C,
    spec: {
      mark: "bar",
      data: { type: "pivot", pivotId: "p1" },
      params: [
        { name: "n", value: 3, bind: { input: "stepper", min: 0, max: 10, step: 1 } },
        { name: "pick", select: "point", brush: true },
      ],
    },
  });
  h.cache.set("c1", {
    layout: { plotArea: { x: 60, y: 40, width: 300, height: 200 } },
    data: { categories: [], series: [] },
    quickAccessButtons: [
      { type: "elements", ...QA_ELEMENTS, icon: "+", tooltip: "Chart Elements" },
      { type: "styles", ...QA_STYLES, icon: "b", tooltip: "Chart Styles" },
    ],
    pivotFieldButtons: [{ field: { area: "row", fieldIndex: 0, name: "Region", isFiltered: false }, ...FIELD }],
    widgetControls: [
      {
        paramName: "n",
        bind: { input: "stepper", min: 0, max: 10, step: 1 },
        x: W.x,
        y: W.y,
        width: 80,
        height: 22,
        text: "n: 3",
        current: "3",
        zones: [
          { ...W_MINUS, action: { dir: -1 } },
          { ...W_PLUS, action: { dir: 1 } },
        ],
      },
    ],
  });
}

function fire(name: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

const REGION = { regionId: "chart-c1", regionType: "chart", data: { chartId: "c1" } };

/** Core's frame press on the chart (a click on its body). */
function framePress(at: { x: number; y: number }, part: string | null = null): void {
  fire("floatingObject:selected", { ...REGION, zone: "frame", part, canvasX: at.x, canvasY: at.y, ctrlKey: false, shiftKey: false });
}

/** Core's CONTENT press: `selected` (no modifiers), then `bodyDragStart` with the part. */
function contentPress(part: string, at: { x: number; y: number }): void {
  fire("floatingObject:selected", { ...REGION, zone: "content", part, canvasX: at.x, canvasY: at.y, ctrlKey: false, shiftKey: false });
  fire("floatingObject:bodyDragStart", { ...REGION, part, canvasX: at.x, canvasY: at.y, ctrlKey: false, shiftKey: false });
}

function move(at: { x: number; y: number }, buttons = 1): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: at.x, clientY: at.y, buttons }));
}

function release(at: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button: 0 }));
}

function escape(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

/** The quick-access popup overlay was shown (handleQuickAccessButtonClick's observable effect). */
const popupShows = () => h.showOverlay.mock.calls.filter((c) => c[0] === "chart:quickAccessPopup");
/** The pivot header-filter menu was asked for (handlePivotFieldButtonClick's observable effect). */
const headerFilterMenus = () => h.emitted.filter((a) => a[0] === "app:pivot-open-header-filter-menu");

type Selection = typeof import("../handlers/selectionHandler");
type Popup = typeof import("../rendering/quickAccessButtons");
type Widgets = typeof import("../handlers/chartWidgetValues");

let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let overlays: typeof import("@api/gridOverlays");
let selection: Selection;
let popup: Popup;
let widgets: Widgets;
let host: HTMLElement;

beforeAll(async () => {
  // The grid <canvas>'s parent is Charts' coordinate basis: a jsdom box at
  // (0, 0), zoom 1 (no grid state), so client px = canvas px here.
  host = document.createElement("div");
  host.appendChild(document.createElement("canvas"));
  document.body.appendChild(host);
  const harness = await loadHarness(CHARTS);
  ext = harness.ext;
  await ext.activate(harness.context);
  await settle();
  // The SAME module instances the activated extension holds (loaded after the harness's reset).
  selection = await import("../handlers/selectionHandler");
  overlays = await import("@api/gridOverlays");
  popup = await import("../rendering/quickAccessButtons");
  widgets = await import("../handlers/chartWidgetValues");
});

afterAll(async () => {
  await ext.deactivate?.();
  await settle();
  host.remove();
});

beforeEach(() => {
  seed();
  // A release left over from the previous test is heard by nobody.
  release({ x: -500, y: -500 });
  popup.closePopup();
  selection.deselectChart();
  widgets.clearAllWidgetValues();
  h.showOverlay.mockClear();
  h.hideOverlay.mockClear();
  h.setBrushMarquee.mockClear();
  h.invalidateChartCache.mockClear();
  h.covered.mockReset();
  h.covered.mockImplementation(() => false);
  h.emitted.length = 0;
});

/** Select the chart by a click on its body (the quick-access buttons and widgets exist only then). */
function selectTheChart(): void {
  framePress(ON_BODY);
  selection.consumePendingClick();
  release({ x: -500, y: -500 });
  expect(selection.isChartSelected("c1"), "precondition: the chart is selected").toBe(true);
}

describe("a quick-access button acts at its RELEASE over the same button", () => {
  it("the press opens nothing; the release over the button opens its popup once", () => {
    selectTheChart();
    contentPress("quickAccess", ON_ELEMENTS);
    expect(popupShows(), "the quick-access button acted on the PRESS").toHaveLength(0);
    move({ x: ON_ELEMENTS.x + 1, y: ON_ELEMENTS.y + 1 });
    release({ x: ON_ELEMENTS.x + 1, y: ON_ELEMENTS.y + 1 });
    expect(popupShows()).toHaveLength(1);
    expect((popupShows()[0][1] as { data: { buttonType: string } }).data.buttonType).toBe("elements");
  });

  it("released 40 px away (a drag from the button): nothing opens", () => {
    selectTheChart();
    contentPress("quickAccess", ON_ELEMENTS);
    move({ x: ON_ELEMENTS.x + 20, y: ON_ELEMENTS.y });
    move({ x: ON_ELEMENTS.x + 40, y: ON_ELEMENTS.y });
    release({ x: ON_ELEMENTS.x + 40, y: ON_ELEMENTS.y });
    expect(popupShows(), "a release off the button opened its popup").toHaveLength(0);
  });

  it("pressed on one button and released on ANOTHER: neither acts", () => {
    selectTheChart();
    contentPress("quickAccess", ON_ELEMENTS);
    move(ON_STYLES);
    release(ON_STYLES);
    expect(popupShows(), "a release over a DIFFERENT quick-access button acted").toHaveLength(0);
  });

  it("the press takes the pending click: its release is not ALSO a click on the chart", () => {
    selectTheChart();
    contentPress("quickAccess", ON_ELEMENTS);
    expect(selection.consumePendingClick(), "the button press left a pending sub-selection click armed").toBeNull();
  });
});

describe("a pivot field button acts at the release -- on the FIRST press of an unselected chart too", () => {
  it("unselected: selected, then bodyDragStart, then a release on the button asks for its filter menu once", () => {
    expect(selection.isChartSelected("c1")).toBe(false);
    contentPress("fieldButton", ON_FIELD);
    expect(selection.isChartSelected("c1"), "the press did not select the chart").toBe(true);
    expect(headerFilterMenus(), "the field button acted on the PRESS").toHaveLength(0);
    release(ON_FIELD);
    expect(headerFilterMenus()).toHaveLength(1);
    expect(headerFilterMenus()[0][1]).toMatchObject({ pivotId: "p1", zone: "row", fieldIndex: 0 });
  });

  it("released off the button: no menu", () => {
    contentPress("fieldButton", ON_FIELD);
    move({ x: ON_FIELD.x, y: ON_FIELD.y - 50 });
    release({ x: ON_FIELD.x, y: ON_FIELD.y - 50 });
    expect(headerFilterMenus()).toHaveLength(0);
  });
});

describe("a widget control steps its param at the release over the same step", () => {
  it("+ released on + steps once; - pressed and released on + steps nothing", () => {
    selectTheChart();
    contentPress("widget", ON_PLUS);
    expect(widgets.getWidgetValue("c1", "n"), "the widget stepped on the PRESS").toBeUndefined();
    release(ON_PLUS);
    expect(widgets.getWidgetValue("c1", "n")).toBe(4);

    contentPress("widget", ON_MINUS);
    move(ON_PLUS);
    release(ON_PLUS);
    expect(widgets.getWidgetValue("c1", "n"), "a release over the OTHER step acted").toBe(4);
  });
});

describe("the brush and the grip", () => {
  it("part 'brush' still starts the brush at the press and finalizes it at the release", () => {
    move({ x: C.x + 200, y: C.y + 150 }, 0);
    contentPress("brush", { x: C.x + 200, y: C.y + 150 });
    expect(h.setBrushMarquee.mock.calls.at(-1)?.[0]).toMatchObject({ chartId: "c1", width: 0, height: 0 });
    release({ x: C.x + 240, y: C.y + 170 });
    expect(h.setBrushMarquee.mock.calls.at(-1)?.[0], "the brush was not finalized").toBeNull();
    expect(h.invalidateChartCache).toHaveBeenCalledWith("c1");
    expect(popupShows()).toHaveLength(0);
  });

  it("a 'grip' press on a selected chart arms no pending click; a plain frame press does (the control)", () => {
    selectTheChart();
    framePress(ON_BODY, "grip");
    expect(selection.consumePendingClick(), "a GRIP press armed a click on the chart").toBeNull();
    framePress(ON_BODY);
    expect(selection.consumePendingClick(), "control: a frame press on a selected chart arms its click").not.toBeNull();
  });
});

describe("a button press whose release was never heard acts on nothing later", () => {
  it("the next press (of any object) drops it: a later release over the button opens nothing", () => {
    selectTheChart();
    contentPress("quickAccess", ON_ELEMENTS);
    // The release never came; the next press is another family's.
    fire("floatingObject:selected", { regionId: "slicer-s1", regionType: "slicer", data: { slicerId: "s1" }, zone: "frame", part: null });
    release(ON_ELEMENTS);
    expect(popupShows(), "a stale button press acted at an unrelated release").toHaveLength(0);
  });

  it("a move with the primary button UP drops it", () => {
    selectTheChart();
    contentPress("quickAccess", ON_ELEMENTS);
    move({ x: ON_ELEMENTS.x + 1, y: ON_ELEMENTS.y }, 0);
    release(ON_ELEMENTS);
    expect(popupShows(), "a press whose release was never heard acted").toHaveLength(0);
  });
});

describe("Escape and a window blur end a held button press with nothing done (M7 review)", () => {
  it("an UNSELECTED pivot chart's field button: press, Escape, release on the same button -- no menu; the Escape is the press's", () => {
    expect(selection.isChartSelected("c1")).toBe(false);
    contentPress("fieldButton", ON_FIELD);
    const e = escape();
    expect(e.defaultPrevented, "the held press did not take its Escape").toBe(true);
    release(ON_FIELD);
    expect(headerFilterMenus(), "Escape did not cancel the field button: its release still opened the menu").toHaveLength(0);
  });

  it("a quick-access button: press, Escape, release on it -- no popup", () => {
    selectTheChart();
    contentPress("quickAccess", ON_ELEMENTS);
    escape();
    release(ON_ELEMENTS);
    expect(popupShows()).toHaveLength(0);
  });

  it("a window blur ends it the same way", () => {
    selectTheChart();
    contentPress("quickAccess", ON_ELEMENTS);
    window.dispatchEvent(new Event("blur"));
    release(ON_ELEMENTS);
    expect(popupShows(), "a blur did not cancel the button press").toHaveLength(0);
  });

  it("with no press held, an Escape is not taken here (the chart's own Escape still runs)", () => {
    selectTheChart();
    const e = escape();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("a release over the same button where ANOTHER object covers it acts on nothing", () => {
  it("covered there: no popup (the question names the chart's region and the release point); uncovered: the control opens", () => {
    selectTheChart();
    h.covered.mockImplementation((regionId, x, y) => regionId === "chart-c1" && x === ON_ELEMENTS.x && y === ON_ELEMENTS.y);
    contentPress("quickAccess", ON_ELEMENTS);
    release(ON_ELEMENTS);
    expect(h.covered).toHaveBeenCalledWith("chart-c1", ON_ELEMENTS.x, ON_ELEMENTS.y);
    expect(popupShows(), "a release over an object covering the button opened its popup").toHaveLength(0);
    contentPress("quickAccess", ON_ELEMENTS);
    release({ x: ON_ELEMENTS.x + 1, y: ON_ELEMENTS.y });
    expect(popupShows()).toHaveLength(1);
  });
});

describe("a held button press holds Core's pointer over the chart, and lets go on every end path", () => {
  const ends: Array<[string, () => void]> = [
    ["its release", () => release(ON_ELEMENTS)],
    ["Escape", () => void escape()],
    ["a window blur", () => window.dispatchEvent(new Event("blur"))],
    ["a move with the primary button up", () => move(ON_ELEMENTS, 0)],
    ["the next press", () => fire("floatingObject:selected", { regionId: "slicer-s1", regionType: "slicer", data: { slicerId: "s1" }, zone: "frame", part: null })],
  ];
  for (const [name, end] of ends) {
    it(`held ('pointer': no grip, no handle answers under it); let go after ${name}`, () => {
      selectTheChart();
      overlays.clearContentGestureCursor();
      contentPress("quickAccess", ON_ELEMENTS);
      expect(overlays.contentGestureCursorFor("chart-c1"), "a chart-button press does not hold Core's pointer").toBe("pointer");
      expect(overlays.isContentGestureHeld()).toBe(true);
      end();
      expect(overlays.contentGestureCursorFor("chart-c1"), `the hold outlived ${name}`).toBeNull();
      expect(overlays.isContentGestureHeld()).toBe(false);
    });
  }
});

describe("a MIDDLE press on the plot (Core hands it over as part 'brush')", () => {
  it("its release ends the brush with NOTHING selected (no finalize, no refresh of the chart); the primary control finalizes", () => {
    move({ x: C.x + 200, y: C.y + 150 }, 0);
    contentPress("brush", { x: C.x + 200, y: C.y + 150 });
    h.invalidateChartCache.mockClear();
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: C.x + 240, clientY: C.y + 170, button: 1, buttons: 0 }));
    expect(h.setBrushMarquee.mock.calls.at(-1)?.[0], "the marquee outlived the middle release").toBeNull();
    expect(h.invalidateChartCache, "a middle click finalized the brush (it selects, and may write a param cell)").not.toHaveBeenCalled();
    // The control: the same brush released with the primary button finalizes.
    contentPress("brush", { x: C.x + 200, y: C.y + 150 });
    release({ x: C.x + 240, y: C.y + 170 });
    expect(h.invalidateChartCache).toHaveBeenCalledWith("c1");
  });
});

// LAST: it deactivates the extension (afterAll's deactivate is then a no-op).
describe("deactivation", () => {
  it("a button press still held when the extension deactivates is ended: its hold let go, its Escape not taken", async () => {
    selectTheChart();
    overlays.clearContentGestureCursor();
    contentPress("quickAccess", ON_ELEMENTS);
    expect(overlays.contentGestureCursorFor("chart-c1")).toBe("pointer");
    await ext.deactivate?.();
    await settle();
    expect(overlays.contentGestureCursorFor("chart-c1"), "deactivation left the button press holding Core's pointer").toBeNull();
    const e = escape();
    expect(e.defaultPrevented, "a deactivated extension still took an Escape").toBe(false);
  });
});
