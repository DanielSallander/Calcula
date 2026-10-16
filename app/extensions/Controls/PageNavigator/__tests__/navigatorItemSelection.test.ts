//! FILENAME: app/extensions/Controls/PageNavigator/__tests__/navigatorItemSelection.test.ts
// PURPOSE: Design Mode's second rung on a Page Navigator (WP-B, D-NAV S7):
//          PageNavigator/navigatorItemSelection.ts selects ONE ITEM only when
//          the armed second press was a CLICK on that item:
//            - a release 2 px away over the same item selects it;
//            - a drag of an UNLOCKED navigator (Core's moveComplete) selects
//              nothing;
//            - a drag of an IMMOVABLE navigator -- no moveComplete ever, the
//              release 40 px away -- selects nothing (the session measures the
//              drag itself; the sabotage target);
//            - a release within the slop but over the NEIGHBOUR item (narrow
//              items) selects nothing;
//            - a gap press selects "no item" (the whole navigator again);
//            - a release of another mouse button selects nothing;
//            - the selection drops when its navigator leaves the Controls
//              selection and when its page leaves the list;
//            - Escape (grid focused) with an item selected clears the item and
//              keeps the navigator selected, and the keydown listener is gone
//              after; Escape typed outside the grid does nothing;
//            - Controls' provider owns Escape ONLY while an item is selected,
//              and never Delete;
//            - describePageNavigatorView marks the selected item, and only for
//              its own navigator, and never a key that is no longer an item.
// CONTEXT: Client == canvas here; the navigator's canvas box is x 100..340,
//          y 50..90, so with the default gap of 8 its two items are x
//          100..216 and 224..340. The page list is a doubled @api/reportPages
//          snapshot; the selection set is the REAL Controls one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReportPage, ReportPagesSnapshot } from "@api/reportPages";

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  pageListeners: [] as Array<(s: unknown) => void>,
  gridFocused: true,
  bounds: { x: 100, y: 50, width: 240, height: 40 },
  props: undefined as unknown,
}));

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReportPagesSnapshot: () => h.snapshot,
  onReportPagesChanged: (cb: (s: unknown) => void) => {
    h.pageListeners.push(cb);
    return () => {
      h.pageListeners = h.pageListeners.filter((l) => l !== cb);
    };
  },
}));
vi.mock("@api/keybindings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGridFocused: () => h.gridFocused,
}));
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestOverlayRedraw: () => {},
}));
vi.mock("../../lib/controlHitTest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  floatingControlCanvasPoint: (_regionId: string, x: number, y: number) => ({
    point: { x, y },
    bounds: h.bounds,
  }),
}));
vi.mock("../navigatorCache", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPageNavigatorProps: () => h.props,
}));
vi.mock("../../lib/controlApi", () => ({ resolveControlProperties: async () => ({}) }));

import {
  NAV_CLICK_SLOP_PX,
  armNavigatorItemClick,
  cancelNavigatorItemClick,
  getSelectedNavigatorItem,
  onSelectedNavigatorItemChange,
  resetNavigatorItemSelection,
  setSelectedNavigatorItem,
  startNavigatorItemSelection,
} from "../navigatorItemSelection";
import { describePageNavigatorView } from "../describe";
import { readPageNavigatorProps } from "../navigatorModel";
import { createControlSelectionProvider } from "../../lib/controlObjectSelection";
import {
  deselectFloatingControl,
  isFloatingControlSelected,
  selectFloatingControl,
} from "../../Button/floatingSelection";

const NAV = "control-1-0-3";
const OTHER = "control-1-4-4";
const ITEM_1 = { x: 150, y: 70 };
const ITEM_2 = { x: 300, y: 70 };
const GAP = { x: 220, y: 70 };

function page(index: number, name: string): ReportPage {
  return { sheetId: `id-${index}`, name, index, visibility: "visible", isTooltipPage: false };
}

function useCanvases(pages: ReportPage[]): void {
  h.snapshot = {
    pages,
    sheetIdByIndex: new Map(pages.map((p) => [p.index, p.sheetId])),
    activeIndex: 1,
    version: 1,
  } satisfies ReportPagesSnapshot;
}

function release(at: { x: number; y: number }, button = 0): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button }));
}

function moveComplete(regionId: string): void {
  window.dispatchEvent(new CustomEvent("floatingObject:moveComplete", { detail: { regionId, x: 0, y: 0 } }));
}

function escape(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

let stop: (() => void) | null = null;

beforeEach(() => {
  h.gridFocused = true;
  h.bounds = { x: 100, y: 50, width: 240, height: 40 };
  h.pageListeners = [];
  h.props = undefined;
  useCanvases([page(1, "Overview"), page(2, "Sales")]);
  resetNavigatorItemSelection();
  deselectFloatingControl();
  selectFloatingControl(NAV);
  stop = startNavigatorItemSelection();
});

afterEach(() => {
  stop?.();
  stop = null;
  deselectFloatingControl();
});

describe("the armed second press selects an item only on a CLICK", () => {
  it("a release 2 px away over the same item selects it", () => {
    armNavigatorItemClick(NAV, "id-1", ITEM_1);
    release({ x: ITEM_1.x + 2, y: ITEM_1.y - 2 });
    expect(getSelectedNavigatorItem()).toEqual({ controlId: NAV, itemKey: "id-1" });
    expect(isFloatingControlSelected(NAV), "the navigator stays selected").toBe(true);
  });

  it("a drag of an UNLOCKED navigator: Core's moveComplete cancels -- no item", () => {
    armNavigatorItemClick(NAV, "id-1", ITEM_1);
    moveComplete(NAV);
    // Even a release back on the press point selects nothing now.
    release(ITEM_1);
    expect(getSelectedNavigatorItem()).toBeNull();
  });

  it("a moveComplete for ANOTHER region does not cancel", () => {
    armNavigatorItemClick(NAV, "id-1", ITEM_1);
    moveComplete(OTHER);
    release(ITEM_1);
    expect(getSelectedNavigatorItem()).toEqual({ controlId: NAV, itemKey: "id-1" });
  });

  it("a drag of an IMMOVABLE navigator (no moveComplete ever, release 40 px away) selects nothing", () => {
    // Locked page: Core armed no move, so no moveComplete comes. The release
    // is still over item 1 (wide item) -- only the slop check can refuse it.
    h.bounds = { x: 0, y: 50, width: 1000, height: 40 };
    armNavigatorItemClick(NAV, "id-1", { x: 100, y: 70 });
    release({ x: 140, y: 70 });
    expect(getSelectedNavigatorItem(), "a 40 px drag selected an item").toBeNull();
  });

  it(`the slop is ${NAV_CLICK_SLOP_PX} px on each axis: 3 px is a click, 4 px is not`, () => {
    armNavigatorItemClick(NAV, "id-1", ITEM_1);
    release({ x: ITEM_1.x + 4, y: ITEM_1.y });
    expect(getSelectedNavigatorItem()).toBeNull();
    armNavigatorItemClick(NAV, "id-1", ITEM_1);
    release({ x: ITEM_1.x, y: ITEM_1.y + 3 });
    expect(getSelectedNavigatorItem()).toEqual({ controlId: NAV, itemKey: "id-1" });
  });

  it("a release within the slop but over the NEIGHBOUR item (narrow items) selects nothing", () => {
    // Items 10 px wide with no gap: x 100..110 and 110..120 (the shared edge is item 1's).
    h.bounds = { x: 100, y: 50, width: 20, height: 40 };
    h.props = readPageNavigatorProps({ gap: "0" });
    armNavigatorItemClick(NAV, "id-1", { x: 109, y: 70 });
    release({ x: 111, y: 70 });
    expect(getSelectedNavigatorItem()).toBeNull();
  });

  it("a gap press selects no item: the whole navigator again", () => {
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-2" });
    armNavigatorItemClick(NAV, null, GAP);
    release(GAP);
    expect(getSelectedNavigatorItem()).toBeNull();
    expect(isFloatingControlSelected(NAV)).toBe(true);
  });

  it("a second press on ANOTHER item re-targets the selection", () => {
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-1" });
    armNavigatorItemClick(NAV, "id-2", ITEM_2);
    release(ITEM_2);
    expect(getSelectedNavigatorItem()).toEqual({ controlId: NAV, itemKey: "id-2" });
  });

  it("a release of another mouse button selects nothing, and the session is gone", () => {
    armNavigatorItemClick(NAV, "id-1", ITEM_1);
    release(ITEM_1, 1);
    expect(getSelectedNavigatorItem()).toBeNull();
    release(ITEM_1);
    expect(getSelectedNavigatorItem(), "the mouseup listener outlived its press").toBeNull();
  });

  it("cancelNavigatorItemClick drops the armed press", () => {
    armNavigatorItemClick(NAV, "id-1", ITEM_1);
    cancelNavigatorItemClick();
    release(ITEM_1);
    expect(getSelectedNavigatorItem()).toBeNull();
  });

  it("a navigator no longer selected at the release gets no item", () => {
    armNavigatorItemClick(NAV, "id-1", ITEM_1);
    deselectFloatingControl();
    release(ITEM_1);
    expect(getSelectedNavigatorItem()).toBeNull();
  });
});

describe("the item selection is dropped when it stops being true", () => {
  it("its navigator leaves the selection (a cell click, Tab, a Ctrl toggle)", () => {
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-1" });
    selectFloatingControl(OTHER);
    expect(getSelectedNavigatorItem()).toBeNull();
  });

  it("its page leaves the list", () => {
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-2" });
    useCanvases([page(1, "Overview")]);
    for (const l of h.pageListeners) l(h.snapshot);
    expect(getSelectedNavigatorItem()).toBeNull();
  });

  it("a page-list change that keeps the page keeps the selection", () => {
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-2" });
    useCanvases([page(1, "Overview"), page(2, "Sales renamed"), page(3, "New")]);
    for (const l of h.pageListeners) l(h.snapshot);
    expect(getSelectedNavigatorItem()).toEqual({ controlId: NAV, itemKey: "id-2" });
  });

  it("the cleanup (deactivation) clears it and cancels an armed press", () => {
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-1" });
    armNavigatorItemClick(NAV, "id-2", ITEM_2);
    stop?.();
    stop = null;
    expect(getSelectedNavigatorItem()).toBeNull();
    release(ITEM_2);
    expect(getSelectedNavigatorItem()).toBeNull();
  });

  it("listeners hear a real change once, and nothing for a no-op", () => {
    const heard: unknown[] = [];
    const off = onSelectedNavigatorItemChange((s) => heard.push(s));
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-1" });
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-1" });
    setSelectedNavigatorItem(null);
    setSelectedNavigatorItem(null);
    off();
    expect(heard).toEqual([{ controlId: NAV, itemKey: "id-1" }, null]);
  });
});

describe("Escape climbs one rung", () => {
  it("with an item selected: the item clears, the navigator stays selected, the listener is removed", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-1" });
      expect(add.mock.calls.filter((c) => c[0] === "keydown")).toHaveLength(1);
      escape();
      expect(getSelectedNavigatorItem()).toBeNull();
      expect(isFloatingControlSelected(NAV)).toBe(true);
      const added = add.mock.calls.find((c) => c[0] === "keydown")![1];
      expect(remove.mock.calls.some((c) => c[0] === "keydown" && c[1] === added)).toBe(true);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("Escape typed outside the grid (the Properties pane) leaves the item selected", () => {
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-1" });
    h.gridFocused = false;
    escape();
    expect(getSelectedNavigatorItem()).toEqual({ controlId: NAV, itemKey: "id-1" });
  });

  it("Controls' provider owns Escape only while an item is selected, and never Delete", () => {
    const provider = createControlSelectionProvider();
    expect(provider.ownsKey?.("Escape")).toBe(false);
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-1" });
    expect(provider.ownsKey?.("Escape")).toBe(true);
    expect(provider.ownsKey?.("Delete"), "Delete must delete the WHOLE navigator").toBe(false);
    expect(provider.ownsKey?.("Tab")).toBe(false);
    expect(provider.ownsKey?.("Arrow")).toBe(false);
    expect(provider.ownsKey?.("Clipboard")).toBe(false);
    escape();
    expect(provider.ownsKey?.("Escape"), "the NEXT Escape must deselect the navigator").toBe(false);
  });
});

describe("describePageNavigatorView marks the selected item", () => {
  it("only its own navigator's item, and never a key that is no longer an item", () => {
    setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-2" });
    expect(describePageNavigatorView(NAV).items.map((i) => i.selected)).toEqual([false, true]);
    expect(describePageNavigatorView(OTHER).items.map((i) => i.selected)).toEqual([false, false]);
    // The page went away (before the selection module heard it): nothing is
    // marked and the read wrote nothing.
    useCanvases([page(1, "Overview")]);
    expect(describePageNavigatorView(NAV).items.map((i) => i.selected)).toEqual([false]);
    expect(getSelectedNavigatorItem()).toEqual({ controlId: NAV, itemKey: "id-2" });
  });
});
