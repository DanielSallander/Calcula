//! FILENAME: app/extensions/Controls/__tests__/pageNavigatorDesignPress.test.ts
// PURPOSE: Design Mode's chart-ladder on a Page Navigator, driven through the
//          REAL activate() and the window events Core dispatches (WP-B, D-NAV
//          S7):
//            - a FIRST press selects the whole navigator and no item, even when
//              released on an item;
//            - a plain SECOND press on the already-selected navigator selects
//              the item under it at the release (and describe marks it);
//            - a Ctrl second press selects no item;
//            - a second press dragged past the slop selects no item;
//            - Design Mode ending clears the item;
//            - a RUN-MODE press selects nothing at all;
//            - source pins: the sheet reload clears the item, and the press
//              reads `wasSelected` BEFORE the selection logic runs.
// CONTEXT: The ModelMenu lifecycle harness (buttonRunOnRelease.test.ts's
//          precedent): the canvas layer is a box at (0, 0), zoom 1, headers
//          50 x 24, so the navigator (sheet x 64, y 64, 240 x 40) sits on the
//          canvas at x 114..354, y 88..128, and with the default gap of 8 its
//          two items are x 114..230 and 238..354. The page list is a doubled
//          @api/reportPages snapshot.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

const h = vi.hoisted(() => ({
  snapshot: {
    pages: [
      { sheetId: "id-1", name: "Overview", index: 1, visibility: "visible", isTooltipPage: false },
      { sheetId: "id-2", name: "Sales", index: 2, visibility: "visible", isTooltipPage: false },
    ],
    sheetIdByIndex: new Map([
      [1, "id-1"],
      [2, "id-2"],
    ]),
    activeIndex: 0,
    version: 1,
  },
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_active_sheet") return 0;
    if (cmd === "get_all_styles") return [];
    // The live page list (@api/reportPages, started by activate) reads this.
    if (cmd === "get_sheets") return { sheets: [], activeIndex: 0 };
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({
    surface: "grid",
    zoom: 1,
    displayHeadings: true,
    config: { rowHeaderWidth: 50, colHeaderHeight: 24, defaultCellWidth: 100, defaultCellHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    sheetContext: { activeSheetIndex: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
  }),
}));
vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => h.snapshot,
}));

const CONTROLS: Loader = () => import("..");

const ANCHOR = { sheetIndex: 0, row: 2, col: 1 };
const NAV = `control-0-${ANCHOR.row}-${ANCHOR.col}`;
const B = { x: 64, y: 64, width: 240, height: 40 };
const ITEM_1 = { x: 170, y: 108 };
const ITEM_2 = { x: 300, y: 108 };

async function invokeBackend(command: string): Promise<unknown> {
  if (command === "get_all_controls") {
    const s = (v: number | string) => ({ valueType: "static" as const, value: String(v) });
    return [
      {
        ...ANCHOR,
        metadata: {
          controlType: "pageNavigator",
          properties: {
            embedded: s("false"),
            pinToGrid: s("false"),
            x: s(B.x),
            y: s(B.y),
            width: s(B.width),
            height: s(B.height),
          },
        },
      },
    ];
  }
  return null;
}

let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let overlays: typeof import("@api/gridOverlays");
let designMode: typeof import("../lib/designMode");
let itemSelection: typeof import("../PageNavigator/navigatorItemSelection");
let selection: typeof import("../Button/floatingSelection");
let describeModule: typeof import("../PageNavigator/describe");
let area: HTMLElement;
let layer: HTMLElement;

function fire(name: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Core's press on the navigator, as pressZone dispatches it. */
function corePress(at: { x: number; y: number }, mods: { ctrlKey?: boolean } = {}): void {
  const r = overlays.getGridRegions().find((g) => g.id === NAV);
  if (!r) throw new Error("the navigator published no region");
  const bounds = { x: 50 + B.x, y: 24 + B.y, width: B.width, height: B.height };
  const zone = overlays.resolveFloatingZone({
    region: r,
    canvasX: at.x,
    canvasY: at.y,
    row: 0,
    col: 0,
    floatingCanvasBounds: bounds,
  } as never);
  fire("floatingObject:selected", {
    regionId: r.id,
    regionType: r.type,
    data: r.data,
    zone: zone.kind,
    part: zone.part,
    canvasX: at.x,
    canvasY: at.y,
    ctrlKey: zone.kind === "content" ? false : mods.ctrlKey === true,
    shiftKey: false,
  });
  if (zone.kind === "content") {
    fire("floatingObject:bodyDragStart", {
      regionId: r.id,
      regionType: r.type,
      data: r.data,
      canvasX: at.x,
      canvasY: at.y,
      part: zone.part,
      ctrlKey: mods.ctrlKey === true,
      shiftKey: false,
    });
  }
}

function release(at: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button: 0 }));
}

function box(el: HTMLElement): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 2000, bottom: 2000, width: 2000, height: 2000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

beforeAll(async () => {
  area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  box(area);
  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  box(layer);
  document.body.appendChild(area);
  document.body.appendChild(layer);
  const harness = await loadHarness(CONTROLS, { invokeBackend });
  ext = harness.ext;
  await ext.activate(harness.context);
  await settle();
  overlays = await import("@api/gridOverlays");
  const { floatingControlZoneAt } = await import("../lib/controlZoneAt");
  overlays.registerGridOverlay({ type: "floating-control", render: () => {}, zoneAt: floatingControlZoneAt });
  designMode = await import("../lib/designMode");
  itemSelection = await import("../PageNavigator/navigatorItemSelection");
  selection = await import("../Button/floatingSelection");
  describeModule = await import("../PageNavigator/describe");
  expect(overlays.getGridRegions().some((g) => g.id === NAV), "precondition: the navigator is loaded").toBe(true);
});

afterAll(async () => {
  await ext.deactivate?.();
  await settle();
  area.remove();
  layer.remove();
});

beforeEach(async () => {
  release({ x: -500, y: -500 });
  designMode.setDesignMode(true);
  await settle();
  selection.deselectFloatingControl();
  itemSelection.setSelectedNavigatorItem(null);
});

describe("Design Mode: first press selects the navigator, a second press its item", () => {
  it("a FIRST press selects the whole navigator -- no item, even released on an item", async () => {
    corePress(ITEM_1);
    release(ITEM_1);
    await settle();
    expect(selection.isFloatingControlSelected(NAV)).toBe(true);
    expect(itemSelection.getSelectedNavigatorItem(), "a first press selected an item").toBeNull();
  });

  it("a plain SECOND press selects the item under it at the release", async () => {
    corePress(ITEM_1);
    release(ITEM_1);
    corePress(ITEM_2);
    expect(itemSelection.getSelectedNavigatorItem(), "the item was selected on the PRESS").toBeNull();
    release({ x: ITEM_2.x + 1, y: ITEM_2.y });
    await settle();
    expect(itemSelection.getSelectedNavigatorItem()).toEqual({ controlId: NAV, itemKey: "id-2" });
    expect(selection.isFloatingControlSelected(NAV), "the navigator stays selected").toBe(true);
    expect(describeModule.describePageNavigator(NAV)?.items.map((i) => i.selected)).toEqual([false, true]);
  });

  it("a Ctrl second press selects no item", async () => {
    corePress(ITEM_1);
    release(ITEM_1);
    corePress(ITEM_1, { ctrlKey: true });
    release(ITEM_1);
    await settle();
    expect(itemSelection.getSelectedNavigatorItem()).toBeNull();
  });

  it("a second press dragged past the slop selects no item", async () => {
    corePress(ITEM_1);
    release(ITEM_1);
    corePress(ITEM_1);
    release({ x: ITEM_1.x + 20, y: ITEM_1.y });
    await settle();
    expect(itemSelection.getSelectedNavigatorItem()).toBeNull();
  });

  it("Design Mode ending clears the item (and deselects the navigator)", async () => {
    corePress(ITEM_1);
    release(ITEM_1);
    corePress(ITEM_1);
    release(ITEM_1);
    expect(itemSelection.getSelectedNavigatorItem()).toEqual({ controlId: NAV, itemKey: "id-1" });
    designMode.setDesignMode(false);
    await settle();
    expect(itemSelection.getSelectedNavigatorItem()).toBeNull();
    expect(selection.isFloatingControlSelected(NAV)).toBe(false);
  });

  it("RUN MODE: a press selects nothing -- neither the navigator nor an item", async () => {
    designMode.setDesignMode(false);
    await settle();
    corePress(ITEM_1);
    release({ x: -500, y: -500 });
    corePress(ITEM_1);
    release({ x: -500, y: -500 });
    await settle();
    expect(selection.isFloatingControlSelected(NAV)).toBe(false);
    expect(itemSelection.getSelectedNavigatorItem()).toBeNull();
  });
});

describe("index.ts wiring (source pins)", () => {
  const code = readFileSync(resolve(__dirname, "../index.ts"), "utf8").replace(/\/\/.*$/gm, "");

  it("handleFloatingSelected reads wasSelected BEFORE the selection logic, and arms on it", () => {
    const at = code.indexOf("const handleFloatingSelected = (e: Event) => {");
    expect(at).toBeGreaterThan(0);
    const body = code.slice(at, code.indexOf('window.addEventListener("floatingObject:selected", handleFloatingSelected);', at));
    const read = body.indexOf("const wasSelected = isFloatingControlSelected(controlId);");
    expect(read, "wasSelected is not read").toBeGreaterThan(0);
    expect(read).toBeLessThan(body.indexOf("selectFloatingControl(controlId)"));
    expect(body).toContain("armNavigatorItemClick(controlId, parseNavItemPart(detail.part)");
  });

  it("a sheet reload clears the item selection", () => {
    const at = code.indexOf("const reloadForSheetChange = () => {");
    expect(at).toBeGreaterThan(0);
    const body = code.slice(at, code.indexOf("context.events.on(AppEvents.SHEET_CHANGED, reloadForSheetChange)", at));
    expect(body).toContain("setSelectedNavigatorItem(null);");
  });

  it("the selection's lifetime is the extension's", () => {
    expect(code).toContain("cleanupFns.push(startNavigatorItemSelection());");
  });
});
