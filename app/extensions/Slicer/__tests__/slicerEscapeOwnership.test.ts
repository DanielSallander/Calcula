//! FILENAME: app/extensions/Slicer/__tests__/slicerEscapeOwnership.test.ts
// PURPOSE: While a slicer's content gesture lives (lib/slicerItemDrag.ts:
//          an item click or run drag, a button press, a scrollbar drag), Escape
//          is the GESTURE's -- it cancels the drag with no commit. The slicer's
//          object-selection provider says so (`ownsKey("Escape")`), so a
//          canvas's Escape binding, which asks the family first and runs
//          earlier (window capture), does not also deselect the slicer under
//          the drag. The timeline's precedent: TimelineSlicer/lib/
//          timelineObjectSelection.ts. Outside a gesture (and with no menu
//          open, and the keyboard not inside the slicer -- M8 S7, whose
//          'Escape' and 'Arrow' ownership slicerKeyboard.test.ts pins) the
//          slicer does not claim Escape, and claims no other key.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  slicer: {
    id: "s1",
    name: "Region",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    showHeader: true,
    showSelectAll: false,
    arrangement: "vertical",
    columns: 1,
    itemGap: 4,
    itemPadding: 0,
    selectedItems: null,
    selectionMode: "standard",
  },
  items: ["North", "South", "West"].map((value) => ({ value, selected: true, hasData: true })),
  commits: 0,
}));

vi.mock("../lib/slicerStore", () => ({
  getSlicerById: (id: string) => (id === "s1" ? h.slicer : undefined),
  getCachedItems: (id: string) => (id === "s1" ? h.items : undefined),
  clickSlicerItem: async () => {
    h.commits++;
  },
  clickSlicerItemRun: async () => {
    h.commits++;
  },
  clickSlicerClearFilter: async () => {
    h.commits++;
  },
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestOverlayRedraw: vi.fn(),
}));

import { createSlicerSelectionProvider } from "../lib/slicerObjectSelection";
import { beginSlicerContentPress, resetSlicerContentPress } from "../lib/slicerItemDrag";

/** The slicer on the canvas at (100, 50); item 1's middle. */
const B = { x: 100, y: 50, width: 180, height: 240 };
const ITEM1 = { x: B.x + 90, y: B.y + 32 + 30 + 13 };

function pressItem(): boolean {
  return beginSlicerContentPress({
    slicerId: "s1",
    regionId: "slicer-s1",
    canvasX: ITEM1.x,
    canvasY: ITEM1.y,
    boundsOf: () => B,
    clientToCanvas: (x, y) => ({ x, y }),
  });
}

beforeEach(() => {
  resetSlicerContentPress();
  h.commits = 0;
});

afterEach(() => {
  resetSlicerContentPress();
});

describe("Escape ownership during a slicer's content gesture", () => {
  it("control: with no gesture and no menu the slicer does not claim Escape", () => {
    expect(createSlicerSelectionProvider().ownsKey?.("Escape")).toBe(false);
  });

  it("while an item drag lives the slicer OWNS Escape, and only Escape", () => {
    const p = createSlicerSelectionProvider();
    expect(pressItem(), "fixture: the press started the gesture").toBe(true);
    expect(p.ownsKey?.("Escape"), "a canvas's Escape would deselect the slicer under the drag").toBe(true);
    expect(p.ownsKey?.("Tab")).toBe(false);
  });

  it("the gesture's end gives Escape back (release)", () => {
    const p = createSlicerSelectionProvider();
    pressItem();
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: ITEM1.x, clientY: ITEM1.y, button: 0 }));
    expect(h.commits, "fixture: the release clicked the item").toBe(1);
    expect(p.ownsKey?.("Escape")).toBe(false);
  });

  it("an Escape that cancels the gesture gives it back too, with no commit", () => {
    const p = createSlicerSelectionProvider();
    pressItem();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(p.ownsKey?.("Escape")).toBe(false);
    expect(h.commits).toBe(0);
  });
});
