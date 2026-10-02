//! FILENAME: app/extensions/Slicer/__tests__/slicerKeyboardCanvas.test.ts
// PURPOSE: The keyboard inside a selected slicer ON A CANVAS (M8 S7), through
//          the REAL keybinding dispatcher, the REAL canvas bindings (Tab /
//          Escape cycling, objectCycling.ts; the arrow nudge, objectNudge.ts)
//          and the REAL Slicer activate():
//            - the dispatcher's window-capture listener runs BEFORE the
//              slicer's, so while the keyboard is inside a slicer its Escape
//              and nudge bindings must stand down -- they ask the slicer's
//              object-selection provider (`ownsKey`), which answers 'Escape'
//              and 'Arrow' while the focus lives (`escapeApplies()` and
//              `nudgeApplies()` are false);
//            - Enter then an arrow moves the focus ring and nudges nothing;
//              Escape leaves (the slicer stays selected), and a second Escape
//              is the canvas's again: it deselects;
//            - Tab after Enter goes on to the next object, and that selection
//              change ends the focus.
//          The controls: outside the slicer the same keys nudge and deselect.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  slicers: new Map<string, Record<string, unknown>>(),
  items: new Map<string, Array<{ value: string; selected: boolean; hasData: boolean }>>(),
  clickItem: vi.fn(async (..._args: unknown[]) => undefined),
  clickRun: vi.fn(async (..._args: unknown[]) => undefined),
  clickClear: vi.fn(async (..._args: unknown[]) => undefined),
  /** The canvas page: editable (not subscribed) and whether its objects are LOCKED. */
  surface: { editable: true, locked: false },
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas", zoom: 1, sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/state", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ surface: "canvas", zoom: 1, sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));
vi.mock("../lib/slicerStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshCache: vi.fn(async () => undefined),
  refreshCacheAndReapplyChangedFilters: vi.fn(async () => undefined),
  getSlicerById: (id: string) => h.slicers.get(id),
  getAllSlicers: () => [...h.slicers.values()],
  getCachedItems: (id: string) => h.items.get(id),
  clickSlicerItem: h.clickItem,
  clickSlicerItemRun: h.clickRun,
  clickSlicerClearFilter: h.clickClear,
}));

import type { ExtensionContext } from "@api/contract";
import { initKeybindings } from "@api/keybindings";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { registerLayoutSurfaceProvider } from "@api/layoutSurface";
import { getSelectedObjectRegions } from "@api/objectSelection";
import { isSelectionOwned } from "@api/selectionOwner";
import { escapeApplies, installCanvasObjectKeyboard } from "../../CanvasSheet/lib/objectCycling";
import {
  hasPendingNudge,
  installCanvasObjectNudge,
  nudgeApplies,
  resetCanvasObjectNudge,
} from "../../CanvasSheet/lib/objectNudge";
import extension from "../index";
import { deselectSlicer, isSlicerSelected, selectSlicer } from "../handlers/selectionHandler";
import { getSlicerKeyFocus, resetSlicerKeyFocus } from "../lib/slicerKeyFocus";
import { SlicerEvents } from "../lib/slicerEvents";

// The shell's order: the dispatcher's window-capture listener is installed at
// bootstrap, before any extension activates -- so it runs FIRST.
initKeybindings();

function slicerRow(id: string, x: number): Record<string, unknown> {
  return {
    id,
    name: id,
    headerText: null,
    sheetIndex: 0,
    x,
    y: 64,
    width: 160,
    height: 176,
    showHeader: true,
    showSelectAll: false,
    arrangement: "vertical",
    columns: 1,
    itemGap: 4,
    itemPadding: 0,
    buttonRadius: 2,
    selectedItems: null,
    selectionMode: "standard",
    forceSelection: false,
    indicateNoData: false,
    stylePreset: "SlicerStyleLight1",
    connectedSources: [],
  };
}

function region(id: string, x: number): GridRegion {
  return {
    id: `slicer-${id}`,
    type: "slicer",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x, y: 64, width: 160, height: 176 },
    data: { slicerId: id },
  };
}

const context = {
  invokeBackend: vi.fn(async () => null),
  ui: { dialogs: { register: vi.fn() } },
  grid: { overlays: { register: () => () => {} } },
  events: { on: () => () => {} },
} as unknown as ExtensionContext;

let container: HTMLDivElement;
const cleanups: Array<() => void> = [];

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  container.dispatchEvent(e);
  return e;
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  document.body.appendChild(container);
  cleanups.push(
    registerLayoutSurfaceProvider({
      get: () => ({
        snapToGrid: false,
        gridSize: 16,
        showGrid: false,
        page: { width: 1200, height: 700 },
        editable: h.surface.editable,
        isLocked: () => h.surface.locked,
      }),
    }),
  );
  cleanups.push(...installCanvasObjectKeyboard("calcula.canvas-sheet"));
  cleanups.push(...installCanvasObjectNudge("calcula.canvas-sheet"));
  extension.activate(context);
});

afterAll(() => {
  extension.deactivate?.();
  while (cleanups.length > 0) cleanups.pop()!();
  container.remove();
  vi.restoreAllMocks();
});

beforeEach(() => {
  h.slicers.clear();
  h.slicers.set("s1", slicerRow("s1", 64));
  h.slicers.set("s2", slicerRow("s2", 320));
  h.items.clear();
  for (const id of ["s1", "s2"]) {
    h.items.set(id, ["North", "South", "West"].map((value) => ({ value, selected: true, hasData: true })));
  }
  setGridRegions([region("s1", 64), region("s2", 320)]);
  h.surface = { editable: true, locked: false };
  h.clickItem.mockReset().mockImplementation(async () => undefined);
  h.clickRun.mockReset().mockImplementation(async () => undefined);
  h.clickClear.mockReset().mockImplementation(async () => undefined);
  resetCanvasObjectNudge();
  deselectSlicer();
  resetSlicerKeyFocus();
  container.focus();
  selectSlicer("s1", false);
});

describe("on a canvas, inside a slicer, the canvas's Escape and nudge stand down", () => {
  it("control: outside the slicer, Escape and the arrows are the canvas's -- an arrow NUDGES the selected slicer", () => {
    expect(escapeApplies()).toBe(true);
    expect(nudgeApplies()).toBe(true);
    const e = key("ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect(hasPendingNudge(), "control: the arrow did not nudge (the probe below would prove nothing)").toBe(true);
    expect(getSlicerKeyFocus()).toBeNull();
    resetCanvasObjectNudge();
  });

  it("inside: escapeApplies() and nudgeApplies() are false; after leaving, true again", () => {
    expect(key("Enter").defaultPrevented, "fixture: Enter went in").toBe(true);
    expect(getSlicerKeyFocus()?.slicerId).toBe("s1");
    expect(escapeApplies(), "the canvas's Escape would DESELECT the slicer the keyboard is inside").toBe(false);
    expect(nudgeApplies(), "the canvas's arrows would NUDGE the slicer the keyboard is inside").toBe(false);
    key("Escape");
    expect(getSlicerKeyFocus()).toBeNull();
    expect(escapeApplies()).toBe(true);
    expect(nudgeApplies()).toBe(true);
  });

  it("Enter, then ArrowDown, through the REAL dispatcher: the focus ring moves and nothing is nudged", () => {
    key("Enter");
    const e = key("ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect(getSlicerKeyFocus()?.value, "the arrow never reached the slicer (the nudge took it)").toBe("South");
    expect(hasPendingNudge(), "the arrow NUDGED the slicer the keyboard is inside").toBe(false);
  });

  it("Escape leaves and keeps the slicer selected; a SECOND Escape is the canvas's and deselects it", () => {
    key("Enter");
    key("Escape");
    expect(getSlicerKeyFocus()).toBeNull();
    expect(isSlicerSelected("s1"), "the first Escape deselected the slicer (the canvas binding took it)").toBe(true);
    const second = key("Escape");
    expect(second.defaultPrevented).toBe(true);
    expect(isSlicerSelected("s1"), "control: the second Escape is the canvas's").toBe(false);
  });

  it("Tab after Enter goes on to the NEXT object, and the focus ends", () => {
    key("Enter");
    const e = key("Tab");
    expect(e.defaultPrevented, "the canvas's Tab binding did not take Tab").toBe(true);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["slicer-s2"]);
    expect(getSlicerKeyFocus(), "the keyboard stayed inside the slicer it Tabbed away from").toBeNull();
  });

  it("a canvas has no cell behind the slicer: the keyboard inside claims no selection there (only a worksheet's hidden active cell needs it)", () => {
    key("Enter");
    expect(getSlicerKeyFocus()?.slicerId, "fixture: inside").toBe("s1");
    expect(isSelectionOwned(), "the canvas's own doors (object copy and paste) were refused while inside").toBe(false);
  });

  it("a refresh that empties the slicer ends the focus AT ONCE: the next arrow NUDGES it (the key is not lost)", () => {
    key("Enter");
    h.items.set("s1", []);
    window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
    expect(getSlicerKeyFocus(), "the focus outlived its items").toBeNull();
    const e = key("ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect(hasPendingNudge(), "the arrow was LOST: the stale focus still owned it, and nothing moved").toBe(true);
    resetCanvasObjectNudge();
  });
});

// Owner decision 2026-09-29 (design: "Only moving and resizing obey the lock"):
// a LOCKED slicer, and a slicer on a SUBSCRIBED (non-editable) canvas page,
// still FILTER. The mouse path has its pin (slicerZoneAt.test.ts); this is the
// keyboard's.
describe.each([
  { name: "a LOCKED slicer", surface: { editable: true, locked: true } },
  { name: "a slicer on a SUBSCRIBED (non-editable) page", surface: { editable: false, locked: false } },
])("$name still filters from the keyboard", ({ surface }) => {
  it("Enter goes in, the arrows move the ring (never a nudge), Space applies ONE item, Alt+C clears", () => {
    h.surface = { ...surface };
    h.slicers.get("s1")!.selectedItems = ["North"];
    expect(key("Enter").defaultPrevented, "Enter did not go into a slicer whose GEOMETRY is locked").toBe(true);
    expect(getSlicerKeyFocus()?.slicerId).toBe("s1");
    const down = key("ArrowDown");
    expect(down.defaultPrevented).toBe(true);
    expect(getSlicerKeyFocus()?.value, "the arrow did not move the focus ring").toBe("South");
    expect(hasPendingNudge(), "an arrow nudged a slicer the keyboard is inside").toBe(false);
    key(" ", { code: "Space" });
    expect(h.clickItem, "Space did not filter: the lock reached the keyboard's filtering").toHaveBeenCalledTimes(1);
    expect(h.clickItem).toHaveBeenCalledWith("s1", "South", false);
    key("c", { code: "KeyC", altKey: true });
    expect(h.clickClear, "Alt+C did not clear").toHaveBeenCalledTimes(1);
  });
});
