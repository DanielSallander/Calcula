//! FILENAME: app/extensions/Slicer/__tests__/slicerMenuCanvasEscape.test.ts
// PURPOSE: On a CANVAS, Escape with a slicer's right-click menu open closes
//          THE MENU -- the canvas's Escape binding does not take the key to
//          deselect the slicer behind it (BUG-0196, slicer part).
// CONTEXT: The canvas binding (CanvasSheet lib/objectCycling.ts) runs in the
//          keybinding dispatcher's window-CAPTURE listener and stops the key
//          on a match; the menu listened on `document` (bubble), later on the
//          same path, so it never heard it: Escape deselected the slicer and
//          left its menu open. The binding asks the family first
//          (`objectOwnsKey`), and the Slicer now answers "mine" for Escape
//          while its menu is open (the Floating Range's worked example). The
//          menu consumes the Escape it closes on, and every way the menu
//          closes takes its listeners down.
//          Driven through the real dispatcher, the real canvas binding, the
//          real slicer selection provider and the real menu.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas" }),
}));
vi.mock("@api/state", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ zoom: 1, surface: "canvas", sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));
vi.mock("../lib/slicerCanvasGeometry", () => ({
  slicerAtCanvasPoint: () => ({ id: "s1" }),
}));
vi.mock("../lib/slicerStore", () => ({
  getSlicerById: (id: string) =>
    id === "s1" ? { id: "s1", name: "Region", selectedItems: null, selectionMode: "standard" } : undefined,
  getCachedItems: () => [],
  clickSlicerClearFilter: vi.fn(async () => undefined),
  updateSlicerAsync: vi.fn(async () => undefined),
  deleteSlicerAsync: vi.fn(async () => true),
}));

import { initKeybindings } from "@api/keybindings";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { resetObjectSelectionProviders } from "@api/objectSelection";
import { installCanvasObjectKeyboard } from "../../CanvasSheet/lib/objectCycling";
import { registerSlicerObjectSelection } from "../lib/slicerObjectSelection";
import {
  closeSlicerContextMenu,
  handleSlicerContextMenu,
  isSlicerContextMenuOpen,
} from "../handlers/slicerContextMenu";
import { deselectSlicer, isSlicerSelected, selectSlicer } from "../handlers/selectionHandler";

// The shell's order: the dispatcher's window-capture listener first.
initKeybindings();

const REGION: GridRegion = {
  id: "slicer-s1",
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 40, y: 40, width: 180, height: 240 },
  data: { slicerId: "s1" },
};

let gridContainer: HTMLDivElement;
const cleanups: (() => void)[] = [];

function openMenu(): void {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 });
  expect(handleSlicerContextMenu(e, gridContainer), "fixture: the right-click opened the slicer's menu").toBe(true);
}

function escape(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  gridContainer.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  resetObjectSelectionProviders();
  setGridRegions([REGION]);
  cleanups.push(registerSlicerObjectSelection());
  cleanups.push(...installCanvasObjectKeyboard("calcula.canvas-sheet"));
  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  gridContainer.tabIndex = 0;
  document.body.appendChild(gridContainer);
  gridContainer.focus();
  // The right-click selected the slicer.
  selectSlicer("s1", false);
});

afterEach(() => {
  closeSlicerContextMenu();
  gridContainer.remove();
  while (cleanups.length > 0) cleanups.pop()!();
  setGridRegions([]);
  deselectSlicer();
});

describe("Escape on a canvas with a slicer's menu open", () => {
  it("closes the menu and keeps the slicer selected -- the canvas binding does not take the key", () => {
    openMenu();
    expect(isSlicerContextMenuOpen()).toBe(true);
    escape();
    expect(isSlicerContextMenuOpen(), "the menu never heard Escape: the canvas binding stopped it first").toBe(false);
    expect(isSlicerSelected("s1"), "Escape deselected the slicer behind the open menu").toBe(true);
  });

  it("the menu consumes the Escape it closes on (nothing behind it hears it)", () => {
    openMenu();
    let bubbled = false;
    const onBubble = (): void => {
      bubbled = true;
    };
    gridContainer.addEventListener("keydown", onBubble);
    try {
      escape();
    } finally {
      gridContainer.removeEventListener("keydown", onBubble);
    }
    expect(isSlicerContextMenuOpen()).toBe(false);
    expect(bubbled, "the grid container still heard the menu's Escape").toBe(false);
  });

  it("control: with no menu open, Escape on the canvas deselects the slicer (the binding applies)", () => {
    expect(isSlicerContextMenuOpen()).toBe(false);
    const e = escape();
    expect(isSlicerSelected("s1")).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it("a menu closed another way (an item, a click outside) leaves no listener to eat the next Escape", () => {
    openMenu();
    closeSlicerContextMenu();
    // An Escape meant for something else entirely (a text box outside the grid).
    const input = document.createElement("input");
    document.body.appendChild(input);
    let heard = false;
    input.addEventListener("keydown", () => {
      heard = true;
    });
    try {
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } finally {
      input.remove();
      gridContainer.focus();
    }
    expect(heard, "a stale menu listener ate an unrelated Escape").toBe(true);
    // And the canvas's own Escape is the canvas's again.
    const e = escape();
    expect(isSlicerSelected("s1")).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });
});
