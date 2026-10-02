//! FILENAME: app/extensions/Slicer/__tests__/slicerPressWiring.test.ts
// PURPOSE: What index.ts does with Core's two press events now that a slicer's
//          items are CONTENT (BUG-0258 design phase 4), driven through the REAL
//          `activate()` with a fake host, the real selection handler, the real
//          hit test and the real content gesture:
//            - THE Ctrl+click DEFECT: a Ctrl+click on an item of a SELECTED
//              slicer toggles the ITEM and keeps the slicer selected. The
//              Slicer used to record Ctrl from its own capture-phase mousedown
//              -- before Core decided whose the modifier was -- and passed it
//              to `selectSlicer(id, ctrl)`, which TOGGLES: the slicer dropped
//              out of its own selection. Core now zeroes Ctrl on content
//              (`floatingObject:selected`) and hands the raw one to the content
//              (`floatingObject:bodyDragStart`);
//            - activate() binds no capture mousedown at all;
//            - a Ctrl press on the FRAME still toggles the slicer (the control);
//            - the content press TAKES the pending click, so its release is not
//              also a frame click; a 'grip' press arms nothing;
//            - a content press on one member of a multi-selection narrows to it
//              at the RELEASE (the M5 T2 rule), never at the press.
// CONTEXT: The gesture is pinned in lib/__tests__/slicerItemDrag.test.ts and
//          Core's order in core/.../overlayZones.test.ts. This file pins the
//          lines in between, whose absence is silent at runtime (the timeline's
//          precedent: TimelineSlicer/__tests__/timelinePressWiring.test.ts).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  clickItem: vi.fn(async (..._args: unknown[]) => undefined),
  clickRun: vi.fn(async (..._args: unknown[]) => undefined),
  clickClear: vi.fn(async (..._args: unknown[]) => undefined),
  added: [] as Array<{ type: string; capture: boolean }>,
}));

/** Two slicers on the canvas: s1 at (100, 50) and s2 at (400, 50), 180 x 240, three items each. */
const B1 = { x: 100, y: 50, width: 180, height: 240 };
const B2 = { x: 400, y: 50, width: 180, height: 240 };

function slicerRow(id: string, b: { x: number; y: number }) {
  return {
    id,
    name: id,
    sheetIndex: 0,
    x: b.x,
    y: b.y,
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
    connectedSources: [],
  };
}

vi.mock("../lib/slicerStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshCache: vi.fn(async () => undefined),
  refreshCacheAndReapplyChangedFilters: vi.fn(async () => undefined),
  getSlicerById: (id: string) => (id === "s1" ? slicerRow("s1", B1) : id === "s2" ? slicerRow("s2", B2) : undefined),
  getAllSlicers: () => [slicerRow("s1", B1), slicerRow("s2", B2)],
  getCachedItems: (id: string) =>
    id === "s1" || id === "s2"
      ? ["North", "South", "West"].map((value) => ({ value, selected: true, hasData: true }))
      : undefined,
  clickSlicerItem: h.clickItem,
  clickSlicerItemRun: h.clickRun,
  clickSlicerClearFilter: h.clickClear,
}));

vi.mock("../lib/slicerCanvasGeometry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The slicer rows carry their CANVAS position as x/y (no gutters, no scroll).
  slicerCanvasBounds: (s: { x: number; y: number; width: number; height: number }) => ({
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
  }),
  clientToSlicerCanvas: (x: number, y: number) => ({ x, y }),
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

import type { ExtensionContext } from "@api/contract";
import type { OverlayRegistration } from "@api/gridOverlays";
import extension from "../index";
import { slicerZoneAt } from "../rendering/slicerRenderer";
import { deselectSlicer, getSelectedSlicerIds, isSlicerSelected, selectSlicer } from "../handlers/selectionHandler";
import { clearPendingSlicerClick, peekPendingSlicerClick } from "../lib/slicerPendingClick";
import { isSlicerContentGestureActive, resetSlicerContentPress } from "../lib/slicerItemDrag";

const registrations: OverlayRegistration[] = [];

const context = {
  invokeBackend: vi.fn(async () => null),
  ui: { dialogs: { register: vi.fn() } },
  grid: {
    overlays: {
      register: (r: OverlayRegistration) => {
        registrations.push(r);
        return () => {};
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
} as unknown as ExtensionContext;

/** The middle of item `i` of a slicer at `b` (a 32 px header, then 26 px items 4 px apart). */
const item = (b: { x: number; y: number }, i: number) => ({ x: b.x + 90, y: b.y + 32 + i * 30 + 13 });

/** Core's `floatingObject:selected` (pressZone's detail): Ctrl is FALSE on content. */
function selected(id: string, zone: "frame" | "content", part: string | null, at: { x: number; y: number }, ctrlKey: boolean): void {
  window.dispatchEvent(
    new CustomEvent("floatingObject:selected", {
      detail: {
        regionId: `slicer-${id}`,
        regionType: "slicer",
        data: { slicerId: id },
        zone,
        part,
        canvasX: at.x,
        canvasY: at.y,
        ctrlKey,
        shiftKey: false,
      },
    }),
  );
}

/** Core's `floatingObject:bodyDragStart` for a content press (the RAW modifiers). */
function bodyDragStart(id: string, part: string, at: { x: number; y: number }, ctrlKey: boolean): void {
  window.dispatchEvent(
    new CustomEvent("floatingObject:bodyDragStart", {
      detail: {
        regionId: `slicer-${id}`,
        regionType: "slicer",
        data: { slicerId: id },
        canvasX: at.x,
        canvasY: at.y,
        part,
        ctrlKey,
        shiftKey: false,
      },
    }),
  );
}

function up(at: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button: 0 }));
}

/** A Ctrl+click on item `i` of s1, the way Core delivers it: the native mousedown, then the zone-filtered press. */
function ctrlClickItem(b: { x: number; y: number }, id: string, i: number): void {
  const at = item(b, i);
  window.dispatchEvent(new MouseEvent("mousedown", { ctrlKey: true, button: 0, clientX: at.x, clientY: at.y }));
  selected(id, "content", "item", at, false);
  bodyDragStart(id, "item", at, true);
  up(at);
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const realAdd = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    const capture = options === true || (typeof options === "object" && options?.capture === true);
    h.added.push({ type, capture });
    realAdd(type, listener, options);
  }) as typeof window.addEventListener);
  extension.activate(context);
});

afterAll(() => {
  extension.deactivate?.();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetSlicerContentPress();
  clearPendingSlicerClick();
  // A release closes any press a test left open (the frame click's mouseup).
  up({ x: 0, y: 0 });
  deselectSlicer();
  h.clickItem.mockClear();
  h.clickRun.mockClear();
  h.clickClear.mockClear();
});

describe("the slicer's registration", () => {
  it("answers ONE zone: zoneAt is slicerZoneAt, with no second press or cursor answer", () => {
    const mine = registrations.filter((r) => r.type === "slicer");
    expect(mine).toHaveLength(1);
    expect(mine[0].zoneAt).toBe(slicerZoneAt);
    const fields = mine[0] as unknown as Record<string, unknown>;
    expect(fields.getCursor).toBeUndefined();
    expect(fields.getCellCursor).toBeUndefined();
    expect(fields.claimsBodyDrag).toBeUndefined();
  });

  it("activate() binds NO mousedown listener: the press's modifiers are Core's, not a capture mousedown's", () => {
    expect(h.added.filter((a) => a.type === "mousedown")).toEqual([]);
  });
});

describe("THE Ctrl+click defect: an item of a SELECTED slicer", () => {
  it("toggles the ITEM (clickSlicerItem with Ctrl) and KEEPS the slicer selected", () => {
    selectSlicer("s1", false);
    expect(isSlicerSelected("s1"), "precondition").toBe(true);

    ctrlClickItem(B1, "s1", 1);

    expect(isSlicerSelected("s1"), "a Ctrl+click on an ITEM took the slicer out of its selection").toBe(true);
    expect(h.clickItem).toHaveBeenCalledTimes(1);
    expect(h.clickItem).toHaveBeenCalledWith("s1", "South", true);
    expect(h.clickRun).not.toHaveBeenCalled();
    expect(isSlicerContentGestureActive()).toBe(false);
  });

  it("on an UNSELECTED slicer it selects the slicer (a plain press) and toggles the item", () => {
    expect(isSlicerSelected("s1"), "precondition").toBe(false);
    ctrlClickItem(B1, "s1", 0);
    expect(isSlicerSelected("s1")).toBe(true);
    expect(h.clickItem).toHaveBeenCalledWith("s1", "North", true);
  });
});

describe("the FRAME keeps Core's object-selection Ctrl (the control)", () => {
  it("a Ctrl press on the header of a selected slicer toggles it OUT; a plain one selects it alone", () => {
    selectSlicer("s1", false);
    const header = { x: B1.x + 40, y: B1.y + 12 };
    selected("s1", "frame", null, header, true);
    expect(isSlicerSelected("s1"), "a Ctrl press on the frame did not toggle the slicer").toBe(false);
    up(header);
    selected("s1", "frame", null, header, false);
    expect(isSlicerSelected("s1")).toBe(true);
    up(header);
    expect(h.clickItem, "a frame press filtered").not.toHaveBeenCalled();
  });
});

describe("the pending click", () => {
  it("the content press TAKES it: its release is not also a frame click", () => {
    const at = item(B1, 2);
    selected("s1", "content", "item", at, false);
    expect(peekPendingSlicerClick(), "the press armed no pending click").not.toBeNull();
    bodyDragStart("s1", "item", at, false);
    expect(peekPendingSlicerClick(), "the content press left the pending click armed").toBeNull();
    up(at);
    expect(h.clickItem).toHaveBeenCalledTimes(1);
    expect(h.clickItem).toHaveBeenCalledWith("s1", "West", false);
  });

  it("a press on the GRIP arms nothing and binds no mouseup (a frame press that never acts)", () => {
    const before = h.added.filter((a) => a.type === "mouseup").length;
    selected("s1", "frame", "grip", { x: B1.x + 4, y: B1.y - 12 }, false);
    expect(isSlicerSelected("s1"), "the grip press did not select the slicer").toBe(true);
    expect(peekPendingSlicerClick(), "a grip press armed a pending click").toBeNull();
    expect(h.added.filter((a) => a.type === "mouseup").length, "a grip press bound a mouseup").toBe(before);
  });

  it("a bodyDragStart without Core's region id starts nothing", () => {
    window.dispatchEvent(
      new CustomEvent("floatingObject:bodyDragStart", {
        detail: { regionType: "slicer", data: { slicerId: "s1" }, canvasX: item(B1, 0).x, canvasY: item(B1, 0).y, part: "item" },
      }),
    );
    expect(isSlicerContentGestureActive()).toBe(false);
  });
});

describe("a content press on one member of a multi-selection", () => {
  it("keeps the set during the press and narrows to the pressed slicer at the RELEASE", () => {
    selectSlicer("s1", false);
    selectSlicer("s2", true);
    expect([...getSelectedSlicerIds()].sort(), "precondition").toEqual(["s1", "s2"]);

    const at = item(B2, 0);
    selected("s2", "content", "item", at, false);
    bodyDragStart("s2", "item", at, false);
    expect([...getSelectedSlicerIds()].sort(), "the press narrowed the set before the release").toEqual(["s1", "s2"]);
    up(at);
    expect([...getSelectedSlicerIds()], "the release did not narrow to the pressed slicer").toEqual(["s2"]);
    expect(h.clickItem).toHaveBeenCalledWith("s2", "North", false);
  });
});
