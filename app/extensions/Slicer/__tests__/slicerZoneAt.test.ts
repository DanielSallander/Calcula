//! FILENAME: app/extensions/Slicer/__tests__/slicerZoneAt.test.ts
// PURPOSE: The slicer's ONE zone answer (rendering/slicerRenderer.ts
//          `slicerZoneAt`, BUG-0258 design phase 4) and what Core makes of it
//          (`resolveFloatingZone`):
//            - an item, "Select all" and the scrollbar are CONTENT (a hand, a
//              hand, the default arrow): a press there is the slicer's own
//              gesture (lib/slicerItemDrag.ts) and never moves it -- on a
//              LOCKED slicer and on a subscribed page too, because filtering
//              is reading the report (owner decision 2026-09-29);
//            - the clear button is content only while the slicer is FILTERED
//              (D9): unfiltered it is painted dimmed and does nothing, so its
//              corner is the header's;
//            - the header, the padding, the GAPS between items and the empty
//              body are plain frame (null): Core's 'move', or 'default' where
//              the slicer cannot move;
//            - a header-less slicer's 4px edge band is frame by name
//              (`part: 'border'`, D3), and the scrollbar wins over it;
//            - index.ts registers it as the slicer's `zoneAt`, with no
//              `getCursor` beside it (the old answer this replaced).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const h = vi.hoisted(() => ({
  slicers: new Map<string, Record<string, unknown>>(),
  items: new Map<string, Array<Record<string, unknown>>>(),
}));

vi.mock("../lib/slicerStore", () => ({
  getSlicerById: (id: string) => h.slicers.get(id),
  getCachedItems: (id: string) => h.items.get(id),
}));

vi.mock("../handlers/selectionHandler", () => ({
  isSlicerSelected: () => false,
}));

import {
  registerGridOverlay,
  resolveFloatingZone,
  type GridRegion,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import { SLICER_FRAME_BAND, slicerZoneAt } from "../rendering/slicerRenderer";

/** The slicer at canvas (100, 50), 180 x 240: a 32px header, then 26px items 4px apart. */
const B = { x: 100, y: 50, width: 180, height: 240 };
const HEADER_MID_Y = B.y + 12;
/** The middle of item `i` (vertical arrangement, one column, no "Select all"). */
const itemY = (i: number) => B.y + 32 + i * 30 + 13;
/** The 6px between the painted buttons of item `i` and item `i + 1` (a button is painted 1px inside its 26px cell). */
const gapY = (i: number) => B.y + 32 + i * 30 + 28;

function load(over: Record<string, unknown> = {}, count = 3): void {
  h.slicers.set("s1", {
    id: "s1",
    name: "Region",
    sheetIndex: 0,
    x: B.x,
    y: B.y,
    width: B.width,
    height: B.height,
    showHeader: true,
    showSelectAll: false,
    arrangement: "vertical",
    columns: 1,
    itemGap: 4,
    itemPadding: 0,
    selectedItems: null,
    ...over,
  });
  const names = ["North", "South", "West", "East", "Mid", "Coast", "Hill", "Vale", "Port", "Lake", "Moor", "Dale"];
  h.items.set(
    "s1",
    names.slice(0, count).map((value) => ({ value, selected: true, hasData: true })),
  );
}

const REGION: GridRegion = {
  id: "slicer-s1",
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: B.x, y: B.y, width: B.width, height: B.height },
  data: { slicerId: "s1" },
};

function ctx(x: number, y: number): OverlayHitTestContext {
  return { region: REGION, canvasX: x, canvasY: y, row: 0, col: 0, floatingCanvasBounds: { ...B } };
}

let cleanups: Array<() => void> = [];

beforeEach(() => {
  h.slicers.clear();
  h.items.clear();
  cleanups.push(registerGridOverlay({ type: "slicer", render: () => {}, zoneAt: slicerZoneAt }));
});

afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

function useSurface(s: Partial<LayoutSurface>): void {
  const surface: LayoutSurface = {
    snapToGrid: false,
    gridSize: 25,
    showGrid: false,
    page: { width: 1280, height: 720 },
    editable: true,
    ...s,
  };
  cleanups.push(registerLayoutSurfaceProvider({ get: () => surface }));
}

describe("the slicer's zone: the content", () => {
  it("an ITEM is CONTENT with a hand (a press there filters; it never moves the slicer)", () => {
    load();
    for (const i of [0, 1, 2]) {
      expect(slicerZoneAt(ctx(B.x + 90, itemY(i))), `item ${i}`).toEqual({ kind: "content", cursor: "pointer", part: "item" });
    }
    // The whole painted button, edge to edge.
    expect(slicerZoneAt(ctx(B.x + 1, itemY(1)))).toMatchObject({ kind: "content", part: "item" });
    expect(slicerZoneAt(ctx(B.x + 179, itemY(1)))).toMatchObject({ kind: "content", part: "item" });
  });

  it("'Select all' is content with a hand", () => {
    load({ showSelectAll: true });
    expect(slicerZoneAt(ctx(B.x + 90, itemY(0)))).toEqual({ kind: "content", cursor: "pointer", part: "selectAll" });
    expect(slicerZoneAt(ctx(B.x + 90, itemY(1)))).toEqual({ kind: "content", cursor: "pointer", part: "item" });
  });

  it("the clear button is content ONLY while the slicer is filtered (D9); unfiltered it is the header's", () => {
    load({ selectedItems: ["North"] });
    expect(slicerZoneAt(ctx(B.x + B.width - 10, HEADER_MID_Y))).toEqual({
      kind: "content",
      cursor: "pointer",
      part: "clearButton",
    });
    load({ selectedItems: null });
    expect(slicerZoneAt(ctx(B.x + B.width - 10, HEADER_MID_Y))).toBeNull();
  });

  it("the scrollbar is content with the default arrow (it drags the items, never the slicer)", () => {
    load({}, 12); // 12 x 30 - 4 = 356 px of items in a 208 px viewport: it scrolls
    expect(slicerZoneAt(ctx(B.x + B.width - 4, B.y + 100))).toEqual({ kind: "content", cursor: "default", part: "scrollbar" });
    // Beside the bar, the item.
    expect(slicerZoneAt(ctx(B.x + 90, itemY(1)))).toMatchObject({ kind: "content", part: "item" });
  });
});

describe("the slicer's zone: the frame", () => {
  it("the header, the padding, the GAP between two items and the empty body are plain frame (null: Core's answer)", () => {
    load();
    expect(slicerZoneAt(ctx(B.x + 40, HEADER_MID_Y)), "the header").toBeNull();
    expect(slicerZoneAt(ctx(B.x + 90, gapY(0))), "the gap under item 0").toBeNull();
    expect(slicerZoneAt(ctx(B.x + 90, gapY(1))), "the gap under item 1").toBeNull();
    expect(slicerZoneAt(ctx(B.x + 90, B.y + B.height - 10)), "the empty body").toBeNull();
    load({ itemPadding: 8 });
    expect(slicerZoneAt(ctx(B.x + 3, B.y + 32 + 8 + 13)), "the left padding").toBeNull();
    expect(slicerZoneAt(ctx(B.x + 90, B.y + 32 + 3)), "the top padding").toBeNull();
  });

  it("a header-LESS slicer: a 4px band along every edge is frame ('border'); the items inside it are content", () => {
    load({ showHeader: false });
    const band = { kind: "frame", part: "border" };
    expect(SLICER_FRAME_BAND).toBe(4);
    expect(slicerZoneAt(ctx(B.x + 2, B.y + 13)), "left").toEqual(band);
    expect(slicerZoneAt(ctx(B.x + 90, B.y + 2)), "top").toEqual(band);
    expect(slicerZoneAt(ctx(B.x + B.width - 2, B.y + 13)), "right").toEqual(band);
    expect(slicerZoneAt(ctx(B.x + 90, B.y + B.height - 2)), "bottom").toEqual(band);
    // Just inside the band: item 0 (no header: it starts at the top edge).
    expect(slicerZoneAt(ctx(B.x + SLICER_FRAME_BAND, B.y + 13))).toMatchObject({ kind: "content", part: "item" });
    expect(slicerZoneAt(ctx(B.x + 90, B.y + 13))).toMatchObject({ kind: "content", part: "item" });
  });

  it("a slicer WITH a header has no band: its edge beside an item is the item", () => {
    load();
    expect(slicerZoneAt(ctx(B.x + 1, itemY(0)))).toMatchObject({ kind: "content", part: "item" });
  });

  it("the scrollbar wins over the band on a header-less slicer that scrolls", () => {
    load({ showHeader: false }, 12);
    expect(slicerZoneAt(ctx(B.x + B.width - 2, B.y + 100))).toMatchObject({ kind: "content", part: "scrollbar" });
    expect(slicerZoneAt(ctx(B.x + 2, B.y + 100))).toEqual({ kind: "frame", part: "border" });
  });

  it("an unknown slicer, or a context with no bounds, is null", () => {
    expect(slicerZoneAt(ctx(B.x + 90, itemY(0)))).toBeNull();
    load();
    expect(slicerZoneAt({ ...ctx(B.x + 90, itemY(0)), floatingCanvasBounds: undefined })).toBeNull();
  });
});

describe("what Core makes of it (resolveFloatingZone)", () => {
  it("an item: content with a hand, which Core never moves; the header: 'move'", () => {
    load();
    expect(resolveFloatingZone(ctx(B.x + 90, itemY(1)))).toEqual({
      kind: "content",
      part: "item",
      cursor: "pointer",
      canMove: true,
    });
    expect(resolveFloatingZone(ctx(B.x + 40, HEADER_MID_Y))).toEqual({
      kind: "frame",
      part: null,
      cursor: "move",
      canMove: true,
    });
  });

  it("a header-less slicer's band: frame, 'move'", () => {
    load({ showHeader: false });
    expect(resolveFloatingZone(ctx(B.x + 2, B.y + 100))).toEqual({
      kind: "frame",
      part: "border",
      cursor: "move",
      canMove: true,
    });
  });

  it("on a LOCKED slicer the items stay CONTENT (a click still filters); the header shows 'default'", () => {
    useSurface({ isLocked: () => true });
    load();
    expect(resolveFloatingZone(ctx(B.x + 90, itemY(1)))).toMatchObject({ kind: "content", cursor: "pointer", canMove: false });
    expect(resolveFloatingZone(ctx(B.x + 40, HEADER_MID_Y))).toMatchObject({
      kind: "frame",
      cursor: "default",
      canMove: false,
    });
  });

  it("on a SUBSCRIBED page (not editable) the items stay CONTENT; the header shows 'default'", () => {
    useSurface({ editable: false });
    load();
    expect(resolveFloatingZone(ctx(B.x + 90, itemY(0)))).toMatchObject({ kind: "content", part: "item", cursor: "pointer", canMove: false });
    expect(resolveFloatingZone(ctx(B.x + 40, HEADER_MID_Y))).toMatchObject({ kind: "frame", cursor: "default", canMove: false });
  });
});

describe("index.ts registers it as the slicer's ONE answer", () => {
  const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8").replace(/\/\/.*$/gm, "");
  const at = src.indexOf('type: "slicer"');
  const block = src.slice(src.lastIndexOf("register({", at), src.indexOf("}),", at));

  it("zoneAt: slicerZoneAt, with no getCursor or claimsBodyDrag beside it", () => {
    expect(at, "the slicer registration is gone").toBeGreaterThan(0);
    expect(block).toMatch(/zoneAt\s*:\s*slicerZoneAt\b/);
    expect(block).not.toMatch(/getCursor\s*:/);
    expect(block).not.toMatch(/claimsBodyDrag\s*:/);
  });
});
