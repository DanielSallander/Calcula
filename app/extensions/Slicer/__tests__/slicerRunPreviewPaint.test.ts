//! FILENAME: app/extensions/Slicer/__tests__/slicerRunPreviewPaint.test.ts
// PURPOSE: What `renderSlicer` PAINTS for the content gesture (BUG-0258 design
//          phase 4), recorded from a fake 2D context:
//            - while a drag across the items lives (lib/slicerGestureView.ts),
//              the items are painted as the selection its release would
//              commit: exactly the run for a plain drag, the run ADDED to the
//              selection for a Ctrl+drag -- nothing is written meanwhile, so
//              the paint is the only place the run shows;
//            - a released run stays painted until its commit lands;
//            - without a gesture the committed selection is painted;
//            - the scrollbar thumb is painted where `slicerScrollThumb` puts
//              it -- the SAME function the scrollbar drag grabs it by
//              (lib/slicerItemDrag.ts), so paint == hit for the thumb.

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
import {
  renderSlicer,
  resetScrollOffsets,
  setScrollOffset,
  slicerScrollThumb,
} from "../rendering/slicerRenderer";
import {
  holdLandingRun,
  releaseLandingRun,
  resetSlicerGestureView,
  showSlicerGesture,
} from "../lib/slicerGestureView";

/** The painted rectangle: the gutters put the slicer at canvas (100, 50). */
const B = { x: 100, y: 50, width: 180, height: 240 };
/** SlicerStyleLight1, the default preset's colours. */
const SELECTED_BG = "#4472C4";
const ITEM_BG = "#edf2f9";
const THUMB = "rgba(0, 0, 0, 0.25)";
const NAMES = ["North", "South", "West", "East", "Mid", "Coast", "Hill", "Vale", "Port", "Lake", "Moor", "Dale"];

interface Op {
  op: string;
  args: unknown[];
  fillStyle: string;
}

/** A 2D context that records every call with the fill style in force. */
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
          ops.push({ op: prop, args, fillStyle: String(state.fillStyle) });
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

function load(selected: string[] | null, count = 4): void {
  h.slicer = {
    id: "s1",
    name: "Region",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: B.width,
    height: B.height,
    showHeader: true,
    showSelectAll: false,
    arrangement: "vertical",
    columns: 1,
    itemGap: 4,
    itemPadding: 0,
    selectedItems: selected,
    selectionMode: "standard",
    stylePreset: "SlicerStyleLight1",
  };
  h.items = NAMES.slice(0, count).map((value) => ({
    value,
    selected: selected === null || selected.includes(value),
    hasData: true,
  }));
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
      floating: { x: 0, y: 0, width: B.width, height: B.height },
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

/** The background each item's button was filled with (the last fill before its label). */
function backgrounds(ops: Op[]): Record<string, string> {
  const out: Record<string, string> = {};
  ops.forEach((o, i) => {
    if (o.op !== "fillText" || !NAMES.includes(String(o.args[0]))) return;
    for (let j = i - 1; j >= 0; j--) {
      if (ops[j].op === "fill") {
        out[String(o.args[0])] = ops[j].fillStyle;
        return;
      }
    }
  });
  return out;
}

/** The items painted selected, in paint order. */
function paintedSelected(ops: Op[]): string[] {
  return Object.entries(backgrounds(ops))
    .filter(([, bg]) => bg === SELECTED_BG)
    .map(([v]) => v);
}

beforeEach(() => {
  resetSlicerGestureView();
  resetScrollOffsets();
  load(["East"]);
});

describe("the run a live drag covers is PAINTED as the selection its release commits", () => {
  it("control: without a gesture the committed selection is painted", () => {
    const bg = backgrounds(paint());
    expect(bg).toEqual({ North: ITEM_BG, South: ITEM_BG, West: ITEM_BG, East: SELECTED_BG });
  });

  it("a plain drag paints EXACTLY the run (the committed item is no longer shown selected)", () => {
    showSlicerGesture({ slicerId: "s1", values: ["North", "South"], additive: false });
    expect(paintedSelected(paint())).toEqual(["North", "South"]);
  });

  it("a Ctrl+drag paints the run ADDED to the selection", () => {
    showSlicerGesture({ slicerId: "s1", values: ["North", "South"], additive: true });
    expect(paintedSelected(paint())).toEqual(["North", "South", "East"]);
  });

  it("another slicer's run paints nothing here", () => {
    showSlicerGesture({ slicerId: "s2", values: ["North", "South"], additive: false });
    expect(paintedSelected(paint())).toEqual(["East"]);
  });

  it("a RELEASED run stays painted until its commit lands, then the committed selection shows", () => {
    const view = { slicerId: "s1", values: ["South", "West"], additive: false };
    holdLandingRun(view);
    showSlicerGesture(null);
    expect(paintedSelected(paint())).toEqual(["South", "West"]);
    releaseLandingRun(view);
    expect(paintedSelected(paint())).toEqual(["East"]);
  });
});

describe("the scrollbar thumb is painted by the ONE thumb geometry", () => {
  it("at a scroll offset, the painted thumb is exactly slicerScrollThumb's (paint == hit)", () => {
    load(null, 12); // 356 px of items in a 208 px viewport: it scrolls
    setScrollOffset("s1", 90);
    const ops = paint();
    // FILLED in the thumb's colour (the border's roundRect after it is stroked).
    const thumbs = ops.filter((o, i) => o.op === "roundRect" && o.fillStyle === THUMB && ops[i + 1]?.op === "fill");
    expect(thumbs, "no thumb painted").toHaveLength(1);
    const [x, y, w, len] = thumbs[0].args as number[];
    const want = slicerScrollThumb(32, 208, 12 * 30 - 4, 90);
    expect(y).toBeCloseTo(B.y + want.start, 6);
    expect(len).toBeCloseTo(want.length, 6);
    // In the track at the right edge, under the header.
    expect(x).toBe(B.x + B.width - 8 + 1);
    expect(w).toBe(6);
  });
});
