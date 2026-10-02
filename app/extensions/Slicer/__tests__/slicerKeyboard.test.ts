//! FILENAME: app/extensions/Slicer/__tests__/slicerKeyboard.test.ts
// PURPOSE: The keyboard INSIDE a selected slicer (M8 S7, lib/slicerKeys.ts),
//          driven through the REAL `activate()` (the slicerPressWiring.test.ts
//          style) with the real selection handler, the real object-selection
//          seam, the real renderer geometry and the real @api/announce seam --
//          only the store's backend calls are doubles:
//            - Enter goes in only on ONE selected object that is a slicer
//              (KD1), and every key it claims is consumed: the grid's own
//              keyboard (a BUBBLE listener on the focus container) never hears
//              it, not even an arrow at the edge;
//            - Space / Enter apply the focused item BY VALUE with the slicer's
//              own click rules; Ctrl toggles; Shift selects the run from the
//              last applied item as ONE queued commit; "Select all" clears;
//            - Escape leaves and the slicer stays selected; Alt+C clears, also
//              without going in; Tab is never claimed;
//            - the listener stands down for a claimed key, a key the
//              dispatcher took, a text target, a live cell edit, an unfocused
//              grid, a live content gesture, the slicer's menu and the grip's
//              menu -- one case each;
//            - the focus ends on a deselect, a sheet switch, a delete, a
//              pointer press, a second selected object; a refresh that removes
//              the focused item moves it to the nearest;
//            - every move and every landed filter change is announced.
// CONTEXT: The canvas half (the dispatcher's Escape and nudge bindings stand
//          down) is slicerKeyboardCanvas.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

type Item = { value: string; selected: boolean; hasData: boolean };

const h = vi.hoisted(() => ({
  slicers: new Map<string, Record<string, unknown>>(),
  items: new Map<string, Array<{ value: string; selected: boolean; hasData: boolean }>>(),
  clickItem: vi.fn(async (..._args: unknown[]) => undefined),
  clickRun: vi.fn(async (..._args: unknown[]) => undefined),
  clickClear: vi.fn(async (..._args: unknown[]) => undefined),
  editing: false,
  /** The keybinding dispatcher's stand-in: when set, it takes every key first. */
  dispatcherTakes: false,
  appEvents: new Map<string, Array<() => void>>(),
  redraws: 0,
  /** The slicer a client point lands on (null: another object, a cell, the page). */
  pointAt: "s1" as string | null,
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

vi.mock("../lib/slicerCanvasGeometry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  slicerCanvasBounds: (s: { x: number; y: number; width: number; height: number }) => ({
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
  }),
  clientToSlicerCanvas: (x: number, y: number) => ({ x, y }),
  slicerAtCanvasPoint: () => (h.pointAt === null ? null : h.slicers.get(h.pointAt)),
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestOverlayRedraw: () => {
    h.redraws++;
  },
}));

// Core's own edit is the hoisted flag; an EXTERNAL session (a floating grid's
// cell edit) is the real pick slot, which a test below registers.
vi.mock("@api/editing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/editing")>();
  return {
    ...real,
    getGlobalIsEditing: () => h.editing,
    isCellEditInProgress: () => h.editing || real.isCellEditInProgress(),
  };
});

// The keybinding dispatcher is a window-CAPTURE keydown installed at
// bootstrap, before any extension activates: on the same target and phase it
// runs FIRST. Its stand-in is bound here, before activate() binds the slicer's.
window.addEventListener(
  "keydown",
  (e) => {
    if (h.dispatcherTakes) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

import type { ExtensionContext } from "@api/contract";
import { AppEvents } from "@api";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { registerAnnouncer } from "@api/announce";
import { registerExternalFormulaTarget } from "@api/editing";
import {
  getSelectionOwner,
  isSelectionOwned,
  onSelectionOwnershipChanged,
  selectionRefusalFor,
} from "@api/selectionOwner";
import { createSlicerSelectionProvider } from "../lib/slicerObjectSelection";
import { getScrollOffset, resetScrollOffsets } from "../rendering/slicerRenderer";
import { noteObjectGripMenuOpen } from "@api/objectPosition";
import extension from "../index";
import { deselectSlicer, isSlicerSelected, selectSlicer } from "../handlers/selectionHandler";
import { closeSlicerContextMenu, handleSlicerContextMenu, isSlicerContextMenuOpen } from "../handlers/slicerContextMenu";
import { beginSlicerContentPress, resetSlicerContentPress } from "../lib/slicerItemDrag";
import {
  SLICER_SELECT_ALL_FOCUS,
  getSlicerKeyFocus,
  resetSlicerKeyFocus,
} from "../lib/slicerKeyFocus";
import { SlicerEvents } from "../lib/slicerEvents";

/** s1 at (100, 50) and s2 at (400, 50): 180 x 240, a 32 px header, three 26 px items 4 px apart. */
function slicerRow(id: string, x: number): Record<string, unknown> {
  return {
    id,
    name: id === "s1" ? "Region" : "Product",
    headerText: null,
    sheetIndex: 0,
    x,
    y: 50,
    width: 180,
    height: 240,
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

function itemsOf(values: string[], selected: string[] | null = null): Item[] {
  return values.map((value) => ({ value, selected: selected === null || selected.includes(value), hasData: true }));
}

function region(id: string, x: number): GridRegion {
  return {
    id: `slicer-${id}`,
    type: "slicer",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x, y: 50, width: 180, height: 240 },
    data: { slicerId: id },
  };
}

const context = {
  invokeBackend: vi.fn(async () => null),
  ui: { dialogs: { register: vi.fn() } },
  grid: { overlays: { register: () => () => {} } },
  events: {
    on: (name: string, cb: () => void) => {
      const list = h.appEvents.get(name) ?? [];
      list.push(cb);
      h.appEvents.set(name, list);
      return () => {};
    },
  },
} as unknown as ExtensionContext;

let container: HTMLDivElement;
let outside: HTMLButtonElement;
let bubbled: string[] = [];
const said: string[] = [];

/** A keydown on `target` (the focused grid container by default), the way the browser dispatches it. */
function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = container): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}
const space = (init: KeyboardEventInit = {}) => key(" ", { code: "Space", ...init });
const altC = () => key("c", { code: "KeyC", altKey: true });

/** Let queued commits land (their `.then` announcements run). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Select s1 alone and go in with Enter. */
function enterS1(): KeyboardEvent {
  selectSlicer("s1", false);
  const e = key("Enter");
  expect(getSlicerKeyFocus()?.slicerId, "fixture: Enter went into the selected slicer").toBe("s1");
  return e;
}

const focusValue = () => getSlicerKeyFocus()?.value;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  container.addEventListener("keydown", (e) => {
    bubbled.push(e.key);
  });
  document.body.appendChild(container);
  outside = document.createElement("button");
  document.body.appendChild(outside);
  registerAnnouncer((m) => {
    said.push(m);
  });
  extension.activate(context);
});

afterAll(() => {
  extension.deactivate?.();
  container.remove();
  outside.remove();
  vi.restoreAllMocks();
});

beforeEach(() => {
  h.slicers.clear();
  h.slicers.set("s1", slicerRow("s1", 100));
  h.slicers.set("s2", slicerRow("s2", 400));
  h.items.clear();
  h.items.set("s1", itemsOf(["North", "South", "West"]));
  h.items.set("s2", itemsOf(["Apples", "Pears"]));
  setGridRegions([region("s1", 100), region("s2", 400)]);
  resetSlicerContentPress();
  closeSlicerContextMenu();
  deselectSlicer();
  resetSlicerKeyFocus();
  resetScrollOffsets();
  h.editing = false;
  h.dispatcherTakes = false;
  h.pointAt = "s1";
  h.clickItem.mockReset().mockImplementation(async () => undefined);
  h.clickRun.mockReset().mockImplementation(async () => undefined);
  h.clickClear.mockReset().mockImplementation(async () => undefined);
  container.focus();
  bubbled = [];
  said.length = 0;
});

// ============================================================================
// Enter goes in (KD1)
// ============================================================================

describe("Enter goes into ONE selected slicer", () => {
  it("goes in on its first item, and the Enter is consumed: the grid container never hears it", () => {
    const e = enterS1();
    expect(getSlicerKeyFocus()).toMatchObject({ slicerId: "s1", value: "North", anchorValue: null });
    expect(e.defaultPrevented, "the Enter was not claimed").toBe(true);
    expect(bubbled, "the grid's own keyboard (a bubble listener) heard the Enter -- it would move the cell cursor").toEqual([]);
    expect(isSlicerSelected("s1"), "going in deselected the slicer").toBe(true);
  });

  it("a FILTERED slicer: the focus starts on its first selected item", () => {
    h.slicers.get("s1")!.selectedItems = ["West"];
    h.items.set("s1", itemsOf(["North", "South", "West"], ["West"]));
    enterS1();
    expect(focusValue()).toBe("West");
  });

  it("with 'Select all' shown and no filter, the focus starts on 'Select all'", () => {
    h.slicers.get("s1")!.showSelectAll = true;
    enterS1();
    expect(focusValue()).toBe(SLICER_SELECT_ALL_FOCUS);
  });

  it("TWO selected objects: Enter is left alone (it is the grid's)", () => {
    selectSlicer("s1", false);
    selectSlicer("s2", true);
    const e = key("Enter");
    expect(getSlicerKeyFocus(), "Enter went into a slicer of a multi-selection").toBeNull();
    expect(e.defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["Enter"]);
  });

  it("control: nothing selected -- Enter is the grid's", () => {
    const e = key("Enter");
    expect(getSlicerKeyFocus()).toBeNull();
    expect(e.defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["Enter"]);
  });

  it("nothing is claimed before Enter went in: a selected slicer's arrows and Space stay the grid's", () => {
    selectSlicer("s1", false);
    expect(key("ArrowDown").defaultPrevented).toBe(false);
    expect(space().defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["ArrowDown", " "]);
    expect(h.clickItem).not.toHaveBeenCalled();
  });

  it("Shift+Enter or Ctrl+Enter does not go in", () => {
    selectSlicer("s1", false);
    key("Enter", { shiftKey: true });
    key("Enter", { ctrlKey: true });
    expect(getSlicerKeyFocus()).toBeNull();
    expect(bubbled).toEqual(["Enter", "Enter"]);
  });
});

// ============================================================================
// Inside: the arrows
// ============================================================================

describe("inside: the arrows move the focus ring", () => {
  it("ArrowDown twice walks North -> South -> West, each announced with its position and state", () => {
    enterS1();
    key("ArrowDown");
    expect(focusValue()).toBe("South");
    key("ArrowDown");
    expect(focusValue()).toBe("West");
    expect(said).toEqual(["Region: North, 1 of 3, selected", "South, 2 of 3, selected", "West, 3 of 3, selected"]);
    expect(bubbled, "an arrow reached the grid's keyboard (the cell cursor would move)").toEqual([]);
  });

  it("an arrow at the EDGE is still consumed (the grid behind never sees it), and the focus stays", () => {
    enterS1();
    key("End");
    expect(focusValue()).toBe("West");
    const e = key("ArrowDown");
    expect(e.defaultPrevented, "ArrowDown on the last item was returned unclaimed").toBe(true);
    expect(bubbled).toEqual([]);
    expect(focusValue()).toBe("West");
    const up = key("Home");
    expect(up.defaultPrevented).toBe(true);
    expect(focusValue()).toBe("North");
    expect(key("ArrowUp").defaultPrevented, "ArrowUp on the first item was returned unclaimed").toBe(true);
    expect(bubbled).toEqual([]);
  });

  it("the keys SCROLL the items to show the focused one (End to the bottom, Home back to the top)", () => {
    h.items.set(
      "s1",
      itemsOf(Array.from({ length: 20 }, (_, i) => "Region" + i)),
    );
    enterS1();
    expect(getScrollOffset("s1"), "fixture: the list starts at the top").toBe(0);
    key("End");
    expect(focusValue()).toBe("Region19");
    expect(getScrollOffset("s1"), "End moved the focus off screen and did not scroll to it").toBeGreaterThan(0);
    key("Home");
    expect(getScrollOffset("s1")).toBe(0);
  });

  it("every change of the focus repaints (the ring shows, moves and goes), leaving too", () => {
    enterS1();
    h.redraws = 0;
    for (const cb of h.appEvents.get(AppEvents.SHEET_CHANGED) ?? []) cb();
    expect(getSlicerKeyFocus()).toBeNull();
    expect(h.redraws, "the focus ended and nothing repainted: the ring stays on screen").toBeGreaterThan(0);
  });

  it("Tab is NOT claimed: it goes on to the grid (the next object or cell)", () => {
    enterS1();
    const e = key("Tab");
    expect(e.defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["Tab"]);
  });

  it("a key the slicer does not use (a letter) goes on to Core -- whose type-to-edit then REFUSES it: the inside owns the selection", () => {
    enterS1();
    expect(key("x").defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["x"]);
    // Core's type-to-edit (useSpreadsheetEditing) asks this before it opens an
    // entry in its active cell -- hidden behind the slicer on a worksheet.
    expect(isSelectionOwned(), "the letter would open an edit in the cell BEHIND the slicer").toBe(true);
  });
});

// ============================================================================
// Inside: Space / Enter apply
// ============================================================================

describe("inside: Space and Enter apply the focused item with the slicer's own rules", () => {
  it("Space queues ONE click with the focused VALUE -- after a refresh REORDERED the items, the same value", () => {
    enterS1();
    key("ArrowDown");
    expect(focusValue()).toBe("South");
    // A refresh reorders the items: index 1 is now North.
    h.items.set("s1", itemsOf(["West", "North", "South"]));
    const e = space();
    expect(e.defaultPrevented).toBe(true);
    expect(h.clickItem).toHaveBeenCalledTimes(1);
    expect(h.clickItem).toHaveBeenCalledWith("s1", "South", false);
    expect(bubbled, "the Space reached the grid (it would start a cell edit)").toEqual([]);
  });

  it("Ctrl+Space passes ctrl: the item TOGGLES", () => {
    enterS1();
    space({ ctrlKey: true });
    expect(h.clickItem).toHaveBeenCalledWith("s1", "North", true);
  });

  it("Enter inside applies like Space", () => {
    enterS1();
    key("ArrowDown");
    key("Enter");
    expect(h.clickItem).toHaveBeenCalledTimes(1);
    expect(h.clickItem).toHaveBeenCalledWith("s1", "South", false);
  });

  it("Shift+Space selects the run from the last APPLIED item to the focus as ONE queued commit, the focus last", () => {
    enterS1();
    space(); // applies North: the anchor
    key("ArrowDown");
    key("ArrowDown");
    space({ shiftKey: true });
    expect(h.clickItem, "the run was queued one click per item").toHaveBeenCalledTimes(1);
    expect(h.clickRun).toHaveBeenCalledTimes(1);
    expect(h.clickRun).toHaveBeenCalledWith("s1", ["North", "South", "West"], false);

    // Upward: the anchor is West, the focus North -- the focus is the LAST value.
    h.clickRun.mockClear();
    space(); // applies West: the new anchor
    key("Home");
    space({ shiftKey: true });
    expect(h.clickRun).toHaveBeenCalledWith("s1", ["West", "South", "North"], false);
  });

  it("Ctrl+Shift+Space ADDS the run (the drag's Ctrl rule)", () => {
    enterS1();
    space();
    key("ArrowDown");
    space({ shiftKey: true, ctrlKey: true });
    expect(h.clickRun).toHaveBeenCalledWith("s1", ["North", "South"], true);
  });

  it("Shift+Space with nothing applied yet runs from the focused item alone", () => {
    enterS1();
    key("ArrowDown");
    space({ shiftKey: true });
    expect(h.clickRun).toHaveBeenCalledWith("s1", ["South"], false);
  });

  it("Space on 'Select all' clears the filter", () => {
    h.slicers.get("s1")!.showSelectAll = true;
    h.slicers.get("s1")!.selectedItems = ["South"];
    h.items.set("s1", itemsOf(["North", "South", "West"], ["South"]));
    enterS1();
    key("Home");
    expect(focusValue()).toBe(SLICER_SELECT_ALL_FOCUS);
    space();
    expect(h.clickClear).toHaveBeenCalledTimes(1);
    expect(h.clickItem).not.toHaveBeenCalled();
  });

  it("a HELD Space (auto-repeat) applies once: the repeats are consumed and do nothing", () => {
    enterS1();
    space();
    space({ repeat: true });
    space({ repeat: true });
    expect(h.clickItem).toHaveBeenCalledTimes(1);
    expect(bubbled).toEqual([]);
  });

  it("once the commit LANDS, the focused item is announced with its NEW state (not the one before the key)", async () => {
    const all = ["North", "South", "West"];
    h.clickItem.mockImplementation(async (_id: unknown, value: unknown, ctrl: unknown) => {
      // What the store's commit does, AFTER a backend round trip: the new
      // selection, then the refreshed item flags. Ctrl on an unfiltered
      // slicer toggles the item OFF.
      await Promise.resolve();
      const next = ctrl === true ? all.filter((v) => v !== value) : [String(value)];
      h.slicers.get("s1")!.selectedItems = next;
      h.items.set("s1", itemsOf(all, next));
    });
    enterS1();
    key("ArrowDown");
    said.length = 0;
    space({ ctrlKey: true });
    expect(said, "announced before the commit landed (it would say the OLD state)").toEqual([]);
    await flush();
    expect(said).toEqual(["South, 2 of 3, not selected"]);
    said.length = 0;
    key("ArrowUp");
    expect(said).toEqual(["North, 1 of 3, selected"]);
  });

  it("a Shift+Space RUN is announced by its EXTENT once it landed -- display order, and how many of it ended up selected", async () => {
    const all = ["North", "South", "West"];
    let singleMode = false;
    h.clickRun.mockImplementation(async (_id: unknown, values: unknown) => {
      // The store's run commit, after a backend round trip: the run (or, for a
      // 'single' slicer, only its LAST value -- selectionAfterItemRun).
      await Promise.resolve();
      const run = values as string[];
      const next = singleMode ? [run[run.length - 1]] : [...run];
      h.slicers.get("s1")!.selectedItems = next;
      h.items.set("s1", itemsOf(all, next));
    });
    enterS1();
    space(); // applies North: the anchor
    key("ArrowDown");
    key("ArrowDown");
    await flush();
    said.length = 0;
    space({ shiftKey: true });
    expect(said, "announced before the run landed").toEqual([]);
    await flush();
    expect(said, "the run was announced as the focused item alone: its extent was never said").toEqual([
      "North to West, 3 of 3 selected",
    ]);

    // Upward (anchor West, focus North): swept West..North, said in DISPLAY order.
    space(); // applies West: the new anchor
    key("Home");
    await flush();
    said.length = 0;
    singleMode = true;
    space({ shiftKey: true });
    await flush();
    expect(said, "a 'single' slicer took one value of the run: the sentence must count what LANDED").toEqual([
      "North to West, 1 of 3 selected",
    ]);
  });
});

// ============================================================================
// Escape and Alt+C
// ============================================================================

describe("Escape leaves; Alt+C clears", () => {
  it("Escape leaves the items, consumed, and the slicer STAYS selected; the next Escape is not the slicer's", () => {
    enterS1();
    said.length = 0;
    const e = key("Escape");
    expect(getSlicerKeyFocus()).toBeNull();
    expect(e.defaultPrevented).toBe(true);
    expect(bubbled).toEqual([]);
    expect(isSlicerSelected("s1"), "Escape deselected the slicer").toBe(true);
    expect(said).toEqual(["Left Region"]);
    const again = key("Escape");
    expect(again.defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["Escape"]);
  });

  it("Alt+C on ONE selected slicer clears its filter WITHOUT going in, and says so once it is clear", async () => {
    h.slicers.get("s1")!.selectedItems = ["South"];
    h.clickClear.mockImplementation(async () => {
      h.slicers.get("s1")!.selectedItems = null;
    });
    selectSlicer("s1", false);
    const e = altC();
    expect(e.defaultPrevented).toBe(true);
    expect(bubbled).toEqual([]);
    expect(h.clickClear).toHaveBeenCalledTimes(1);
    expect(h.clickClear).toHaveBeenCalledWith("s1");
    expect(getSlicerKeyFocus(), "Alt+C went in").toBeNull();
    await flush();
    expect(said).toEqual(["Filter cleared"]);
  });

  it("Alt+C inside clears too", () => {
    h.slicers.get("s1")!.selectedItems = ["South"];
    h.items.set("s1", itemsOf(["North", "South", "West"], ["South"]));
    enterS1();
    const e = altC();
    expect(e.defaultPrevented).toBe(true);
    expect(h.clickClear).toHaveBeenCalledTimes(1);
  });

  it("Alt+C on an UNFILTERED slicer is not claimed -- merely selected or inside -- and says nothing (there is no filter to clear; the timeline's rule)", async () => {
    selectSlicer("s1", false);
    const outsideKey = altC();
    expect(outsideKey.defaultPrevented, "Alt+C was claimed on a slicer that filters nothing").toBe(false);
    enterS1();
    said.length = 0;
    const insideKey = altC();
    expect(insideKey.defaultPrevented, "Alt+C was claimed inside a slicer that filters nothing").toBe(false);
    await flush();
    expect(h.clickClear, "a clear was queued for a slicer that filters nothing").not.toHaveBeenCalled();
    expect(said, "'Filter cleared' was said when nothing changed").toEqual([]);
  });

  it("AltGr+C (Ctrl+Alt+C: a CHARACTER on Polish or Czech layouts) is not Alt+C: never claimed, the filter untouched", async () => {
    h.slicers.get("s1")!.selectedItems = ["South"];
    h.items.set("s1", itemsOf(["North", "South", "West"], ["South"]));
    selectSlicer("s1", false);
    const outsideKey = key("c", { code: "KeyC", ctrlKey: true, altKey: true });
    expect(outsideKey.defaultPrevented, "AltGr+C was taken as Alt+C on a selected slicer").toBe(false);
    enterS1();
    bubbled = [];
    const insideKey = key("c", { code: "KeyC", ctrlKey: true, altKey: true });
    expect(insideKey.defaultPrevented, "AltGr+C was taken as Alt+C inside the slicer").toBe(false);
    expect(bubbled).toEqual(["c"]);
    await flush();
    expect(h.clickClear, "AltGr+C cleared the filter").not.toHaveBeenCalled();
  });

  it("control: with nothing selected Alt+C is not claimed", () => {
    const e = altC();
    expect(e.defaultPrevented).toBe(false);
    expect(h.clickClear).not.toHaveBeenCalled();
  });
});

// ============================================================================
// The gates
// ============================================================================

describe("the listener stands down", () => {
  it("for a CLAIMED key (a surface stacked on the grid)", () => {
    selectSlicer("s1", false);
    const claimed = document.createElement("div");
    claimed.setAttribute("data-pointer-claim", "test-form");
    claimed.tabIndex = 0;
    container.appendChild(claimed);
    try {
      claimed.focus();
      const e = key("Enter", {}, claimed);
      expect(getSlicerKeyFocus()).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    } finally {
      claimed.remove();
      container.focus();
    }
  });

  it("for a key the dispatcher already TOOK (defaultPrevented)", () => {
    selectSlicer("s1", false);
    h.dispatcherTakes = true;
    key("Enter");
    expect(getSlicerKeyFocus()).toBeNull();
  });

  it("for a TEXT target (an input inside the grid)", () => {
    selectSlicer("s1", false);
    const input = document.createElement("input");
    container.appendChild(input);
    try {
      input.focus();
      const e = key("Enter", {}, input);
      expect(getSlicerKeyFocus()).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    } finally {
      input.remove();
      container.focus();
    }
  });

  it("while a CELL EDIT is live", () => {
    selectSlicer("s1", false);
    h.editing = true;
    const e = key("Enter");
    expect(getSlicerKeyFocus()).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  it("while a FLOATING GRID's cell edit is live (an external session: parked, the keyboard on the grid container)", () => {
    // Inside already, then the edit starts: the slicer's keys stand down too.
    enterS1();
    const off = registerExternalFormulaTarget({
      isExpectingReference: () => true,
      insertReference: () => undefined,
      session: {} as never,
    });
    try {
      const down = key("ArrowDown");
      expect(focusValue(), "an arrow moved the slicer's focus in the middle of a floating grid's cell edit").toBe("North");
      expect(down.defaultPrevented, "the edit's arrow was taken").toBe(false);
      resetSlicerKeyFocus();
      const e = key("Enter");
      expect(getSlicerKeyFocus(), "Enter went into the slicer instead of committing the floating grid's edit").toBeNull();
      expect(e.defaultPrevented, "the edit's Enter was taken").toBe(false);
    } finally {
      off();
    }
  });

  it("while the GRID IS NOT FOCUSED (a ribbon button, a task pane)", () => {
    selectSlicer("s1", false);
    outside.focus();
    try {
      const e = key("Enter", {}, outside);
      expect(getSlicerKeyFocus(), "Enter went into the slicer from outside the grid").toBeNull();
      expect(e.defaultPrevented, "a key aimed at a button outside the grid was taken").toBe(false);
    } finally {
      container.focus();
    }
  });

  it("while a slicer CONTENT GESTURE is live (a held item drag)", () => {
    selectSlicer("s1", false);
    expect(
      beginSlicerContentPress({
        slicerId: "s1",
        regionId: "slicer-s1",
        canvasX: 190,
        canvasY: 50 + 32 + 13,
        boundsOf: () => ({ x: 100, y: 50, width: 180, height: 240 }),
        clientToCanvas: (x, y) => ({ x, y }),
      }),
      "fixture: the press started a gesture",
    ).toBe(true);
    try {
      const e = key("Enter");
      expect(getSlicerKeyFocus()).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    } finally {
      resetSlicerContentPress();
    }
  });

  it("while the slicer's right-click MENU is open -- its Escape closes the menu, and the keyboard stays inside", () => {
    enterS1();
    expect(
      handleSlicerContextMenu(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 150 }), container),
      "fixture: the right-click opened the menu",
    ).toBe(true);
    expect(isSlicerContextMenuOpen()).toBe(true);
    key("Escape");
    expect(isSlicerContextMenuOpen(), "the slicer took the menu's Escape (the menu listens later, on document)").toBe(false);
    expect(getSlicerKeyFocus()?.slicerId, "the menu's Escape also left the items").toBe("s1");
    // And with the menu open, Enter does not go in.
    key("Escape");
    handleSlicerContextMenu(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 150 }), container);
    try {
      key("Enter");
      expect(getSlicerKeyFocus()).toBeNull();
    } finally {
      closeSlicerContextMenu();
    }
  });

  it("while an object's GRIP MENU is open", () => {
    selectSlicer("s1", false);
    const closed = noteObjectGripMenuOpen();
    try {
      const e = key("Enter");
      expect(getSlicerKeyFocus()).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    } finally {
      closed();
    }
    key("Enter");
    expect(getSlicerKeyFocus()?.slicerId, "control: with the menu closed Enter goes in").toBe("s1");
  });
});

// ============================================================================
// The focus ends
// ============================================================================

describe("the focus ends", () => {
  it("on a DESELECT (a click on a cell, the canvas's Escape)", () => {
    enterS1();
    deselectSlicer();
    expect(getSlicerKeyFocus()).toBeNull();
  });

  it("when a SECOND object joins the selection", () => {
    enterS1();
    selectSlicer("s2", true);
    expect(getSlicerKeyFocus()).toBeNull();
  });

  it("on a SHEET SWITCH", () => {
    enterS1();
    for (const cb of h.appEvents.get(AppEvents.SHEET_CHANGED) ?? []) cb();
    expect(getSlicerKeyFocus()).toBeNull();
  });

  it("when the slicer is DELETED", () => {
    enterS1();
    window.dispatchEvent(new CustomEvent(SlicerEvents.SLICER_DELETED, { detail: { slicerId: "s1" } }));
    expect(getSlicerKeyFocus()).toBeNull();
  });

  it("on the next POINTER PRESS on an object (Core's press events)", () => {
    enterS1();
    window.dispatchEvent(
      new CustomEvent("floatingObject:selected", {
        detail: { regionId: "slicer-s1", regionType: "slicer", data: { slicerId: "s1" }, zone: "frame", part: null, canvasX: 190, canvasY: 60, ctrlKey: false },
      }),
    );
    expect(getSlicerKeyFocus(), "a press on the slicer's frame kept the keyboard inside").toBeNull();
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));

    enterS1();
    window.dispatchEvent(
      new CustomEvent("floatingObject:bodyDragStart", {
        detail: { regionId: "slicer-s2", regionType: "slicer", data: { slicerId: "s2" }, canvasX: 490, canvasY: 95, part: "item" },
      }),
    );
    expect(getSlicerKeyFocus(), "a content press kept the keyboard inside").toBeNull();
    resetSlicerContentPress();
  });

  it("a refresh that REMOVES the focused item moves the focus to the nearest one", () => {
    enterS1();
    key("ArrowDown");
    expect(focusValue()).toBe("South");
    h.items.set("s1", itemsOf(["North", "West"]));
    space();
    expect(h.clickItem).toHaveBeenCalledWith("s1", "West", false);
    expect(focusValue()).toBe("West");
  });

  it("a refresh that removes EVERY item ends the focus AT ONCE, and says so -- not silently at the next key", () => {
    enterS1();
    said.length = 0;
    h.items.set("s1", []);
    window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
    expect(getSlicerKeyFocus(), "the focus outlived its items until the next key").toBeNull();
    expect(said).toEqual(["Left Region"]);
  });

  it("control: a refresh that keeps the focused item keeps the focus, and says nothing", () => {
    enterS1();
    key("ArrowDown");
    said.length = 0;
    h.items.set("s1", itemsOf(["West", "North", "South"]));
    window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
    expect(focusValue()).toBe("South");
    expect(said).toEqual([]);
  });

  it("a key that still finds the focus STALE (a change no refresh announced) ends it, says so, and is CONSUMED -- it was typed for the inside", () => {
    enterS1();
    said.length = 0;
    h.items.set("s1", []);
    const e = key("ArrowDown");
    expect(getSlicerKeyFocus()).toBeNull();
    expect(e.defaultPrevented, "the stale focus passed the arrow on: the cell cursor moves and nothing is said").toBe(true);
    expect(bubbled).toEqual([]);
    expect(said).toEqual(["Left Region"]);
  });

  it("the stale-focus key: a LETTER is consumed too (the cell behind must not take it), Tab and a bare Shift are not", () => {
    enterS1();
    h.items.set("s1", []);
    const shift = key("Shift", { shiftKey: true });
    expect(shift.defaultPrevented, "a bare modifier ended the focus").toBe(false);
    expect(getSlicerKeyFocus(), "a bare modifier is never the slicer's key").not.toBeNull();
    const letter = key("x");
    expect(getSlicerKeyFocus()).toBeNull();
    expect(letter.defaultPrevented, "the letter reached the cell behind the slicer").toBe(true);
    enterS1Again();
    h.items.set("s1", []);
    const tab = key("Tab");
    expect(getSlicerKeyFocus()).toBeNull();
    expect(tab.defaultPrevented, "Tab was swallowed").toBe(false);
  });

  it("a RIGHT press anywhere but the focused slicer ends the focus -- another object's or the grid's menu then owns Escape", () => {
    enterS1();
    h.pointAt = null; // a cell, another object, the page
    container.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 700, clientY: 400, bubbles: true, cancelable: true }));
    expect(getSlicerKeyFocus(), "the keyboard stayed inside the slicer under another menu").toBeNull();
    const esc = key("Escape");
    expect(esc.defaultPrevented, "the first Escape left the slicer instead of closing the menu").toBe(false);
    expect(bubbled).toEqual(["Escape"]);
  });

  it("a right press ON the focused slicer keeps the keyboard inside (its own menu takes the keys while open)", () => {
    enterS1();
    h.pointAt = "s1";
    container.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 150, clientY: 150, bubbles: true, cancelable: true }));
    expect(getSlicerKeyFocus()?.slicerId, "a right press on the slicer itself ended the focus").toBe("s1");
    h.pointAt = "s2";
    container.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 450, clientY: 150, bubbles: true, cancelable: true }));
    expect(getSlicerKeyFocus(), "a right press on ANOTHER slicer kept the keyboard inside the first").toBeNull();
  });
});

/** Go into s1 again after a test emptied it (its items back first). */
function enterS1Again(): void {
  h.items.set("s1", itemsOf(["North", "South", "West"]));
  enterS1();
}

// ============================================================================
// The cell BEHIND the slicer (a worksheet): unreachable while the keyboard is inside
// ============================================================================

describe("while the keyboard is inside, the worksheet's hidden active cell is out of reach", () => {
  const SENTENCE = (action: string) =>
    `${action} is not available while the keyboard is inside a slicer. Press Escape to leave it. Nothing was changed.`;

  it("inside, the slicer OWNS the selection: every door that writes Core's active cell -- type-to-edit (a character, F2, Backspace), Delete, Alt+Down -- refuses with the slicer's sentence; nothing types into the slicer", () => {
    selectSlicer("s1", false);
    expect(isSelectionOwned(), "control: a merely SELECTED slicer claims nothing yet").toBe(false);
    key("Enter");
    expect(getSlicerKeyFocus()?.slicerId, "fixture: inside").toBe("s1");
    expect(isSelectionOwned(), "a typed character, F2, Delete or Alt+Down would act on the cell BEHIND the slicer").toBe(true);
    expect(getSelectionOwner()?.receivesTyping?.() ?? false, "nothing of the slicer takes typing").toBe(false);
    for (const action of ["Edit Cell", "Clear Contents", "Open the In-Cell List"]) {
      expect(selectionRefusalFor(action)).toBe(SENTENCE(action));
    }
    // The slicer's own listener leaves those keys to Core, whose doors ask the claim.
    for (const k of ["x", "F2", "Backspace"]) expect(key(k).defaultPrevented, `${k} was taken by the slicer`).toBe(false);
    key("Escape");
    expect(isSelectionOwned(), "the claim outlived the focus: Core's grid never gets its selection back").toBe(false);
  });

  it("the claim ends with every end of the focus -- and the ownership listeners (a contextual tab) hear it start and end", async () => {
    const heard: boolean[] = [];
    const off = onSelectionOwnershipChanged((owned) => heard.push(owned));
    const settle = async () => {
      for (let i = 0; i < 3; i++) await Promise.resolve();
    };
    try {
      // The SELECTION change settles first (it prompts a re-ask of its own), so
      // only the keyboard's own change can tell the listeners below.
      selectSlicer("s1", false);
      await settle();
      expect(heard, "control: selecting the slicer is no claim").toEqual([]);
      key("Enter");
      await settle();
      expect(heard, "going in was not announced to the ownership listeners").toEqual([true]);
      key("Escape");
      await settle();
      expect(heard, "leaving with Escape (no selection change) was not announced").toEqual([true, false]);
      key("Enter");
      deselectSlicer();
      await settle();
      expect(isSelectionOwned()).toBe(false);
      enterS1Again();
      for (const cb of h.appEvents.get(AppEvents.SHEET_CHANGED) ?? []) cb();
      expect(isSelectionOwned(), "a sheet switch left the claim behind").toBe(false);
    } finally {
      off();
    }
  });
});

// ============================================================================
// Ownership on a canvas (the provider the canvas bindings ask)
// ============================================================================

describe("the slicer owns Escape and the arrows while the keyboard is inside", () => {
  it("ownsKey('Escape') and ownsKey('Arrow') are true inside, false after leaving; Tab never", () => {
    const p = createSlicerSelectionProvider();
    selectSlicer("s1", false);
    expect(p.ownsKey?.("Arrow"), "control: outside, the arrows nudge").toBe(false);
    expect(p.ownsKey?.("Escape")).toBe(false);
    key("Enter");
    expect(p.ownsKey?.("Arrow"), "a canvas would NUDGE the slicer instead of moving the focus").toBe(true);
    expect(p.ownsKey?.("Escape"), "a canvas would DESELECT the slicer instead of leaving the items").toBe(true);
    expect(p.ownsKey?.("Tab")).toBe(false);
    key("Escape");
    expect(p.ownsKey?.("Arrow")).toBe(false);
    expect(p.ownsKey?.("Escape")).toBe(false);
  });

  // BUG-0270: a SELECTED slicer is deleted by the generic Delete
  // (ObjectPosition lib/selectedObjectKeys.ts), which stands down while a
  // family owns the key. Inside, Delete is refused by the inside claim -- it
  // must never delete the slicer the keyboard is in.
  it("ownsKey('Delete') is true inside, false while merely selected and after leaving", () => {
    const p = createSlicerSelectionProvider();
    selectSlicer("s1", false);
    expect(p.ownsKey?.("Delete"), "control: a selected slicer's Delete is the generic object Delete").toBe(false);
    key("Enter");
    expect(p.ownsKey?.("Delete"), "Delete INSIDE the slicer would delete the slicer").toBe(true);
    key("Escape");
    expect(p.ownsKey?.("Delete")).toBe(false);
  });

  // BUG-0270 review (finding 10): the two other branches of the slicer's
  // Delete ownership had no test that failed when they broke. Its menu takes no
  // focus (the grid keeps the keyboard), and a held item drag is under the
  // pointer: Delete in either must not delete the slicer.
  it("ownsKey('Delete') is true while the slicer's right-click MENU is open, and not once it closed", () => {
    const p = createSlicerSelectionProvider();
    selectSlicer("s1", false);
    expect(
      handleSlicerContextMenu(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 150 }), container),
      "fixture: the right-click opened the menu",
    ).toBe(true);
    try {
      expect(p.ownsKey?.("Delete"), "Delete with the menu open deleted the slicer behind it").toBe(true);
    } finally {
      closeSlicerContextMenu();
    }
    expect(p.ownsKey?.("Delete"), "the menu closed but the slicer still refuses its Delete").toBe(false);
  });

  it("ownsKey('Delete') is true while a slicer CONTENT GESTURE is live (a held item drag)", () => {
    const p = createSlicerSelectionProvider();
    selectSlicer("s1", false);
    expect(
      beginSlicerContentPress({
        slicerId: "s1",
        regionId: "slicer-s1",
        canvasX: 190,
        canvasY: 50 + 32 + 13,
        boundsOf: () => ({ x: 100, y: 50, width: 180, height: 240 }),
        clientToCanvas: (x, y) => ({ x, y }),
      }),
      "fixture: the press started a gesture",
    ).toBe(true);
    try {
      expect(p.ownsKey?.("Delete"), "Delete during a held item drag deleted the slicer under it").toBe(true);
    } finally {
      resetSlicerContentPress();
    }
    expect(p.ownsKey?.("Delete"), "control: the gesture ended").toBe(false);
  });
});
