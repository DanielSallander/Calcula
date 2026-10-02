//! FILENAME: app/extensions/Slicer/__tests__/slicerSlotStep.test.ts
// PURPOSE: The keyboard's slots over THE frame the painter and the hit test
//          read (M8 S7, rendering/slicerRenderer.ts):
//            - `slicerSlotStep`: vertical and grid are ROW-MAJOR (`cols` per
//              row, as painted) and never wrap; horizontal is ONE row as
//              painted, even with `columns > 1` (computeLayout counts rows it
//              never paints); "Select all" is slot 0 when shown; Home / End /
//              PageUp / PageDown; clamping;
//            - `slicerScrollToShow`: the least scroll that shows a slot;
//            - the focus ring is PAINTED on the slot the keys act on, where
//              `itemCellAt` paints that item -- and the ring's middle hit-tests
//              to the focused item (paint == keys == hit).

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  slicer: null as Record<string, unknown> | null,
  items: [] as Array<{ value: string; selected: boolean; hasData: boolean }>,
}));

vi.mock("../lib/slicerStore", () => ({
  getSlicerById: (id: string) => (id === "s1" ? (h.slicer ?? undefined) : undefined),
  getCachedItems: (id: string) => (id === "s1" ? h.items : undefined),
}));

vi.mock("@api/objectScriptBadge", () => ({
  drawObjectScriptBadgeIfPresent: () => {},
}));

vi.mock("@api", () => ({
  getSlicerItemBitmap: () => null,
  hasSlicerItemBitmapRenderer: () => false,
}));

import type { OverlayRenderContext } from "@api/gridOverlays";
import type { Slicer } from "../lib/slicerTypes";
import {
  SLICER_FOCUS_RING_DARK,
  SLICER_FOCUS_RING_LIGHT,
  getSlicerHitDetail,
  renderSlicer,
  resetScrollOffsets,
  setScrollOffset,
  slicerItemButton,
  slicerScrollToShow,
  slicerSlotStep,
  type SlicerFocusKey,
} from "../rendering/slicerRenderer";
import { SLICER_SELECT_ALL_FOCUS, resetSlicerKeyFocus, setSlicerKeyFocus } from "../lib/slicerKeyFocus";

/** Painted at canvas (100, 50): the gutters, scroll 0. */
const B = { x: 100, y: 50 };

function load(over: Record<string, unknown>, count: number): Slicer {
  h.slicer = {
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
    buttonRadius: 2,
    selectedItems: null,
    selectionMode: "standard",
    indicateNoData: false,
    stylePreset: "SlicerStyleLight1",
    ...over,
  };
  h.items = Array.from({ length: count }, (_, i) => ({ value: `Item${i}`, selected: true, hasData: true }));
  return h.slicer as unknown as Slicer;
}

const size = () => ({ width: Number(h.slicer!.width), height: Number(h.slicer!.height) });
const step = (from: number, key: SlicerFocusKey) => slicerSlotStep(h.slicer as unknown as Slicer, h.items.length, size(), from, key);

beforeEach(() => {
  resetScrollOffsets();
  resetSlicerKeyFocus();
});

// ============================================================================
// slicerSlotStep
// ============================================================================

describe("slicerSlotStep: vertical (one column)", () => {
  it("Down / Up move one item and stop at the ends; Left / Right go nowhere", () => {
    load({}, 5);
    expect(step(0, "ArrowDown")).toBe(1);
    expect(step(3, "ArrowDown")).toBe(4);
    expect(step(4, "ArrowDown"), "the last item: nowhere to go").toBe(4);
    expect(step(0, "ArrowUp"), "the first item: nowhere to go").toBe(0);
    expect(step(2, "ArrowUp")).toBe(1);
    expect(step(2, "ArrowLeft")).toBe(2);
    expect(step(2, "ArrowRight")).toBe(2);
  });

  it("Home / End: the first and the last slot", () => {
    load({}, 5);
    expect(step(3, "Home")).toBe(0);
    expect(step(1, "End")).toBe(4);
  });

  it("PageDown / PageUp move one item-area of rows and clamp", () => {
    // 176 tall: a 144 px item area holds 4 rows of 26 + 4 px.
    load({ height: 176 }, 20);
    expect(step(0, "PageDown")).toBe(4);
    expect(step(4, "PageUp")).toBe(0);
    expect(step(2, "PageUp")).toBe(0);
    expect(step(18, "PageDown")).toBe(19);
  });

  it("a slot beyond the list is clamped into it", () => {
    load({}, 3);
    expect(step(9, "ArrowUp")).toBe(1);
  });
});

describe("slicerSlotStep: grid (row-major, as painted)", () => {
  // 3 columns, 7 items: rows [0 1 2] [3 4 5] [6].
  it("Right / Left move within the row and never wrap", () => {
    load({ arrangement: "grid", columns: 3 }, 7);
    expect(step(0, "ArrowRight")).toBe(1);
    expect(step(2, "ArrowRight"), "the end of a row does not wrap to the next").toBe(2);
    expect(step(3, "ArrowLeft"), "the start of a row does not wrap to the previous").toBe(3);
    expect(step(4, "ArrowLeft")).toBe(3);
    expect(step(6, "ArrowRight"), "past the last item").toBe(6);
  });

  it("Down / Up move a whole row (cols slots), and stay where the row below is shorter", () => {
    load({ arrangement: "grid", columns: 3 }, 7);
    expect(step(1, "ArrowDown")).toBe(4);
    expect(step(3, "ArrowDown")).toBe(6);
    expect(step(4, "ArrowDown"), "no item under slot 4").toBe(4);
    expect(step(6, "ArrowUp")).toBe(3);
    expect(step(2, "ArrowUp")).toBe(2);
  });

  it("a VERTICAL arrangement with columns > 1 is row-major too", () => {
    load({ arrangement: "vertical", columns: 2 }, 5);
    expect(step(0, "ArrowRight")).toBe(1);
    expect(step(1, "ArrowDown")).toBe(3);
    expect(step(3, "ArrowDown"), "no item under slot 3").toBe(3);
  });
});

describe("slicerSlotStep: horizontal (ONE painted row)", () => {
  it("Left / Right walk the one row; Up / Down go nowhere", () => {
    load({ arrangement: "horizontal", columns: 1, width: 600, height: 80 }, 6);
    expect(step(0, "ArrowRight")).toBe(1);
    expect(step(5, "ArrowRight")).toBe(5);
    expect(step(3, "ArrowLeft")).toBe(2);
    expect(step(2, "ArrowDown")).toBe(2);
    expect(step(2, "ArrowUp")).toBe(2);
  });

  it("columns > 1 does NOT make a horizontal slicer a grid: Right from the third item reaches the fourth", () => {
    // computeLayout counts cols = 3 here, and rows it never paints.
    load({ arrangement: "horizontal", columns: 3, width: 600, height: 80 }, 6);
    expect(step(2, "ArrowRight"), "slot 2 is not the end of a row: it is painted beside slot 3").toBe(3);
    expect(step(3, "ArrowLeft")).toBe(2);
    expect(step(1, "ArrowDown"), "there is no row below in a horizontal slicer").toBe(1);
  });
});

describe("slicerSlotStep: 'Select all' is slot 0", () => {
  it("Home reaches it and Down leaves it for the first item", () => {
    load({ showSelectAll: true }, 3);
    expect(step(2, "Home")).toBe(0);
    expect(step(0, "ArrowDown")).toBe(1);
    expect(step(1, "End")).toBe(3);
  });
});

// ============================================================================
// slicerScrollToShow
// ============================================================================

describe("slicerScrollToShow: the least scroll that shows the slot", () => {
  it("scrolls down just far enough for a slot below the item area, and back to 0 for the first", () => {
    load({ height: 176 }, 20);
    // Slot 10's button is 300..326 under the header; the item area is 144 tall.
    expect(slicerScrollToShow(h.slicer as unknown as Slicer, 20, size(), 10)).toBe(182);
    setScrollOffset("s1", 182);
    expect(slicerScrollToShow(h.slicer as unknown as Slicer, 20, size(), 8), "already in view: unchanged").toBe(182);
    expect(slicerScrollToShow(h.slicer as unknown as Slicer, 20, size(), 0)).toBe(0);
  });

  it("a slicer that does not scroll stays at 0", () => {
    load({}, 3);
    expect(slicerScrollToShow(h.slicer as unknown as Slicer, 3, size(), 2)).toBe(0);
  });
});

// ============================================================================
// The ring is painted where the keys act
// ============================================================================

interface Op {
  op: string;
  args: unknown[];
  strokeStyle: string;
  lineWidth: number;
}

function recorder(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  const state: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
  };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in state) return state[prop];
        return (...args: unknown[]) => {
          ops.push({ op: prop, args, strokeStyle: String(state.strokeStyle), lineWidth: Number(state.lineWidth) });
        };
      },
      set(_t, prop: string, value: unknown) {
        state[prop] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

function paint(): Op[] {
  const { ctx, ops } = recorder();
  renderSlicer({
    ctx,
    region: {
      id: "slicer-s1",
      type: "slicer",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: 0, y: 0, width: Number(h.slicer!.width), height: Number(h.slicer!.height) },
      data: { slicerId: "s1" },
    },
    config: { rowHeaderWidth: B.x, colHeaderHeight: B.y },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: {},
    canvasWidth: 1000,
    canvasHeight: 800,
  } as unknown as OverlayRenderContext);
  return ops;
}

/** The rectangle (x, y, w, h) of every path stroked in `colour`. */
function strokedRects(ops: Op[], colour: string): number[][] {
  const rects: number[][] = [];
  let last: number[] | null = null;
  for (const o of ops) {
    if (o.op === "roundRect" || o.op === "rect") last = (o.args as number[]).slice(0, 4);
    if (o.op === "stroke" && o.strokeStyle === colour && last) rects.push(last);
  }
  return rects;
}

describe("the focus ring is painted on the slot the keys act on", () => {
  it("vertical: a 2px dark outline and a 1px light line INSIDE the focused item's painted button", () => {
    load({}, 5);
    setSlicerKeyFocus({ slicerId: "s1", value: "Item3", anchorValue: null, slotHint: 3 });
    const ops = paint();
    // Item 3's button: x 100..280, y 50 + 32 + 3 * 30 + 1 = 173, 180 x 24.
    expect(strokedRects(ops, SLICER_FOCUS_RING_DARK)).toEqual([[101, 174, 178, 22]]);
    expect(ops.find((o) => o.op === "stroke" && o.strokeStyle === SLICER_FOCUS_RING_DARK)?.lineWidth).toBe(2);
    expect(strokedRects(ops, SLICER_FOCUS_RING_LIGHT)).toEqual([[102.5, 175.5, 175, 19]]);
    expect(ops.find((o) => o.op === "stroke" && o.strokeStyle === SLICER_FOCUS_RING_LIGHT)?.lineWidth).toBe(1);
  });

  it("the ring's middle hit-tests to the FOCUSED item (paint == keys == hit), and matches slicerItemButton", () => {
    load({ arrangement: "grid", columns: 3, width: 300 }, 7);
    setSlicerKeyFocus({ slicerId: "s1", value: "Item4", anchorValue: null, slotHint: 4 });
    const [ring] = strokedRects(paint(), SLICER_FOCUS_RING_DARK);
    expect(ring, "no ring was painted").toBeDefined();
    const [x, y, w, hh] = ring;
    const hit = getSlicerHitDetail(x + w / 2, y + hh / 2, { x: B.x, y: B.y, width: 300, height: 240 }, "s1");
    expect(hit?.itemValue, "the ring is painted on another item than the one the keys act on").toBe("Item4");
    const button = slicerItemButton(h.slicer as unknown as Slicer, 7, size(), 4)!;
    expect([x - 1, y - 1, w + 2, hh + 2]).toEqual([B.x + button.x, B.y + button.y, button.width, button.height]);
  });

  it("follows the item's VALUE after a refresh reordered the items", () => {
    load({ height: 176 }, 20);
    setSlicerKeyFocus({ slicerId: "s1", value: "Item10", anchorValue: null, slotHint: 10 });
    // A refresh moves Item10 to the front.
    h.items = [h.items[10], ...h.items.filter((_, i) => i !== 10)];
    const [ring] = strokedRects(paint(), SLICER_FOCUS_RING_DARK);
    // 20 items scroll: an 8 px scrollbar takes the right edge, so the buttons are 172 wide.
    expect(ring).toEqual([101, 50 + 32 + 1 + 1, 170, 22]);
  });

  it("'Select all' focused: the ring is on slot 0", () => {
    load({ showSelectAll: true }, 3);
    setSlicerKeyFocus({ slicerId: "s1", value: SLICER_SELECT_ALL_FOCUS, anchorValue: null, slotHint: 0 });
    expect(strokedRects(paint(), SLICER_FOCUS_RING_DARK)).toEqual([[101, 84, 178, 22]]);
  });

  it("no focus, or the focus in ANOTHER slicer: no ring", () => {
    load({}, 3);
    expect(strokedRects(paint(), SLICER_FOCUS_RING_DARK)).toEqual([]);
    setSlicerKeyFocus({ slicerId: "s2", value: "Item1", anchorValue: null, slotHint: 1 });
    expect(strokedRects(paint(), SLICER_FOCUS_RING_DARK)).toEqual([]);
  });
});
