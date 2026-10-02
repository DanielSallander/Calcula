//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerItemDrag.test.ts
// PURPOSE: The slicer's content gesture (lib/slicerItemDrag.ts, BUG-0258
//          design phase 4) as a user drives it -- press, move, release through
//          REAL window events -- and what it commits:
//            - a release with no movement is a CLICK: exactly one
//              `clickSlicerItem` with the raw Ctrl, at the release, never at
//              the press;
//            - a drag across items is a RUN: exactly one `clickSlicerItemRun`
//              with the items swept (in sweep order), nothing while the
//              pointer moves, and the run painted as a transient preview
//              until its commit has landed;
//            - a move with the primary button UP (a release this page never
//              heard), Escape, blur and the next press all end the gesture
//              with NO commit;
//            - "Select all" and the lit clear button act only when released
//              over themselves -- and not where another object covers them
//              (Core's occlusion question, asked with the region and the
//              release's client point);
//            - a release of ANOTHER button ends the gesture with no commit
//              when the primary one is up (a middle press), and not while it
//              is held;
//            - the scrollbar thumb drags the items (and a press on the track
//              jumps), writing nothing; an item drag past the item area's edge
//              AUTO-SCROLLS and the run follows;
//            - the pointer the gesture owns is held through Core's seam
//              (`holdContentGestureCursor`) and let go on every end path.
// CONTEXT: index.ts hands the press over from Core's
//          `floatingObject:bodyDragStart`; the press here stands in for it
//          with the same fields. Client points ARE canvas points in these
//          tests (`clientToCanvas` is the identity). The timeline's gesture is
//          pinned the same way (TimelineSlicer/lib/__tests__/timelineRangeDrag.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  slicer: null as Record<string, unknown> | null,
  items: [] as Array<{ value: string; selected: boolean; hasData: boolean }>,
  clicks: [] as unknown[][],
  runs: [] as unknown[][],
  clears: [] as unknown[][],
  /** Hold every run commit un-landed (a slow pivot filter) until `held` is run. */
  hold: false,
  /** Core's occlusion answer: another object covers this region at this client point. */
  covered: (_regionId: string, _x: number, _y: number): boolean => false,
  coveredAsked: [] as unknown[][],
  held: [] as Array<() => void>,
}));

vi.mock("../slicerStore", () => ({
  getSlicerById: (id: string) => (id === "s1" ? (h.slicer ?? undefined) : undefined),
  getCachedItems: (id: string) => (id === "s1" ? h.items : undefined),
  clickSlicerItem: (...args: unknown[]) => {
    h.clicks.push(args);
    return Promise.resolve();
  },
  clickSlicerItemRun: (...args: unknown[]) => {
    h.runs.push(args);
    if (!h.hold) return Promise.resolve();
    return new Promise<void>((resolve) => h.held.push(resolve));
  },
  clickSlicerClearFilter: (...args: unknown[]) => {
    h.clears.push(args);
    return Promise.resolve();
  },
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestOverlayRedraw: vi.fn(),
  isFloatingRegionCoveredAtClient: (regionId: string, x: number, y: number) => {
    h.coveredAsked.push([regionId, x, y]);
    return h.covered(regionId, x, y);
  },
}));

import { clearContentGestureCursor, contentGestureCursorFor } from "@api/gridOverlays";
import {
  beginSlicerContentPress,
  cancelSlicerContentPress,
  isSlicerContentGestureActive,
  resetSlicerContentPress,
  type SlicerContentPress,
} from "../slicerItemDrag";
import { getSlicerRunPreview } from "../slicerGestureView";
import {
  getScrollOffset,
  resetScrollOffsets,
  setScrollOffset,
  slicerItemIndexNear,
  slicerScrollOffsetForThumb,
  slicerScrollThumb,
} from "../../rendering/slicerRenderer";
import type { Slicer, SlicerItem } from "../slicerTypes";

/** The slicer on the canvas: 180 x 240 at (100, 50) -- a 32 px header, then 26 px items 4 px apart. */
const B = { x: 100, y: 50, width: 180, height: 240 };
const HEADER = 32;
const PITCH = 30;
/** The middle of item `i` (no "Select all"), in canvas px. */
const itemY = (i: number) => B.y + HEADER + i * PITCH + 13;
const X = B.x + 90;
const REGION_ID = "slicer-s1";
const NAMES = ["North", "South", "West", "East", "Mid", "Coast", "Hill", "Vale", "Port", "Lake", "Moor", "Dale"];

function load(over: Record<string, unknown> = {}, count = 4): void {
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
    selectedItems: null,
    selectionMode: "standard",
    ...over,
  };
  h.items = NAMES.slice(0, count).map((value) => ({ value, selected: true, hasData: true }));
}

function press(x: number, y: number, over: Partial<SlicerContentPress> = {}): boolean {
  return beginSlicerContentPress({
    slicerId: "s1",
    regionId: REGION_ID,
    canvasX: x,
    canvasY: y,
    boundsOf: () => B,
    clientToCanvas: (cx, cy) => ({ x: cx, y: cy }),
    ...over,
  });
}

function move(x: number, y: number, buttons = 1): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons }));
}

/** `buttons`: the buttons still held AFTER this release (bit 1 = the primary). */
function up(x: number, y: number, button = 0, buttons = 0): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, button, buttons }));
}

function escape(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

/** Every commit the gesture made, of any kind. */
function commits(): number {
  return h.clicks.length + h.runs.length + h.clears.length;
}

beforeEach(() => {
  resetSlicerContentPress();
  resetScrollOffsets();
  clearContentGestureCursor();
  h.clicks = [];
  h.runs = [];
  h.clears = [];
  h.hold = false;
  h.held = [];
  h.covered = () => false;
  h.coveredAsked = [];
  load();
});

afterEach(() => {
  resetSlicerContentPress();
  clearContentGestureCursor();
  vi.useRealTimers();
});

describe("a click on an item (a release with no movement)", () => {
  it("commits EXACTLY ONE clickSlicerItem, at the release -- nothing at the press", () => {
    expect(press(X, itemY(0))).toBe(true);
    expect(commits(), "the press itself committed").toBe(0);
    expect(isSlicerContentGestureActive()).toBe(true);
    up(X, itemY(0));
    expect(h.clicks).toEqual([["s1", "North", false]]);
    expect(h.runs).toEqual([]);
    expect(isSlicerContentGestureActive()).toBe(false);
  });

  it("Ctrl (the RAW modifier Core hands the content) reaches the click: it toggles the item", () => {
    press(X, itemY(1), { additive: true });
    up(X, itemY(1));
    expect(h.clicks).toEqual([["s1", "South", true]]);
  });

  it("a wobble within Core's 3 px on the same item is still a click", () => {
    press(X, itemY(2));
    move(X + 2, itemY(2) + 2);
    up(X + 2, itemY(2) + 2);
    expect(h.clicks).toEqual([["s1", "West", false]]);
    expect(h.runs).toEqual([]);
  });

  it("a wobble within 3 px into the GAP next to the item is still a click (a gap is not another item)", () => {
    // Pressed on the first painted row of item 1's button (it starts 1 px
    // into its cell), released 3 px higher -- in the gap above it, which the
    // clamped nearest-item lookup files under item 0.
    const top = B.y + HEADER + PITCH + 1;
    press(X, top);
    move(X, top - 3);
    up(X, top - 3);
    expect(h.runs, "a 3 px wobble into the gap became a two-item run").toEqual([]);
    expect(h.clicks).toEqual([["s1", "South", false]]);
  });
});

describe("a drag across items (a run)", () => {
  it("commits EXACTLY ONE clickSlicerItemRun at release with the items swept, and nothing while the pointer moves", () => {
    press(X, itemY(0));
    move(X, itemY(1));
    expect(commits(), "a move committed").toBe(0);
    move(X, itemY(2));
    expect(commits(), "a move committed").toBe(0);
    up(X, itemY(2));
    expect(h.runs).toEqual([["s1", ["North", "South", "West"], false]]);
    expect(h.clicks, "a run is not also a click").toEqual([]);

    // The gesture is over: its listeners are gone, so nothing more commits.
    expect(isSlicerContentGestureActive()).toBe(false);
    move(X, itemY(3));
    up(X, itemY(3));
    expect(commits()).toBe(1);
  });

  it("the live run is painted as a transient preview (no write), following the pointer", () => {
    press(X, itemY(0));
    expect(getSlicerRunPreview("s1"), "a press alone shows no run").toBeNull();
    move(X, itemY(1));
    expect(getSlicerRunPreview("s1")).toEqual({ slicerId: "s1", values: ["North", "South"], additive: false });
    move(X, itemY(3));
    expect(getSlicerRunPreview("s1")?.values).toEqual(["North", "South", "West", "East"]);
    move(X, itemY(1));
    expect(getSlicerRunPreview("s1")?.values, "the run shrinks back with the pointer").toEqual(["North", "South"]);
    expect(commits()).toBe(0);
  });

  it("a drag UPWARD commits the run in sweep order (the last is the item released on)", () => {
    press(X, itemY(2));
    move(X, itemY(1));
    move(X, itemY(0));
    up(X, itemY(0));
    expect(h.runs).toEqual([["s1", ["West", "South", "North"], false]]);
  });

  it("Ctrl+drag hands the run over as ADDITIVE", () => {
    press(X, itemY(1), { additive: true });
    move(X, itemY(3));
    up(X, itemY(3));
    expect(h.runs).toEqual([["s1", ["South", "West", "East"], true]]);
  });

  it("a release without an intermediate move still reads the release point (a fast flick is a run)", () => {
    press(X, itemY(0));
    up(X, itemY(2));
    expect(h.runs).toEqual([["s1", ["North", "South", "West"], false]]);
    expect(h.clicks).toEqual([]);
  });

  it("past the item area the run clamps to the edge item shown (the pointer beside the slicer still drags)", () => {
    press(X, itemY(0));
    move(B.x + B.width + 60, itemY(2));
    up(B.x + B.width + 60, itemY(2));
    expect(h.runs).toEqual([["s1", ["North", "South", "West"], false]]);
  });

  it("the released run stays painted until its commit has LANDED (the old selection never flashes back)", async () => {
    h.hold = true;
    press(X, itemY(0));
    move(X, itemY(2));
    up(X, itemY(2));
    expect(isSlicerContentGestureActive()).toBe(false);
    expect(getSlicerRunPreview("s1")?.values, "the run vanished before its commit landed").toEqual(["North", "South", "West"]);
    h.held.forEach((resolve) => resolve());
    await Promise.resolve();
    await Promise.resolve();
    expect(getSlicerRunPreview("s1"), "the landed run is still painted over the committed selection").toBeNull();
  });
});

describe("a gesture that ends WITHOUT a release commits nothing", () => {
  it("a move with the primary button UP (a release this page never heard) cancels", () => {
    press(X, itemY(0));
    move(X, itemY(1));
    move(X, itemY(2), 0);
    expect(isSlicerContentGestureActive()).toBe(false);
    expect(getSlicerRunPreview("s1")).toBeNull();
    up(X, itemY(2));
    expect(commits(), "a lost release committed at the next mouseup").toBe(0);
  });

  it("Escape cancels and is the gesture's (nothing behind it hears it)", () => {
    press(X, itemY(0));
    move(X, itemY(2));
    const e = escape();
    expect(e.defaultPrevented, "the gesture's Escape was not consumed").toBe(true);
    expect(isSlicerContentGestureActive()).toBe(false);
    expect(getSlicerRunPreview("s1")).toBeNull();
    up(X, itemY(2));
    expect(commits()).toBe(0);
  });

  it("losing the window (blur) cancels", () => {
    press(X, itemY(0));
    move(X, itemY(2));
    window.dispatchEvent(new Event("blur"));
    expect(isSlicerContentGestureActive()).toBe(false);
    up(X, itemY(2));
    expect(commits()).toBe(0);
  });

  it("the next press ends the previous gesture without acting on it", () => {
    press(X, itemY(0));
    move(X, itemY(2));
    press(X, itemY(3));
    up(X, itemY(3));
    expect(h.runs, "the abandoned run was committed").toEqual([]);
    expect(h.clicks).toEqual([["s1", "East", false]]);
  });

  it("a MIDDLE press (the primary never held): its release ends the gesture with no commit; a secondary release WITH the primary held does not", () => {
    press(X, itemY(0));
    up(X, itemY(0), 2, 1);
    expect(isSlicerContentGestureActive(), "a right release while the primary is held ended the gesture").toBe(true);
    up(X, itemY(0), 1, 0);
    expect(isSlicerContentGestureActive(), "a middle click left the gesture (and its listeners) live").toBe(false);
    expect(commits()).toBe(0);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
    up(X, itemY(0));
    expect(commits(), "a later primary release acted on a gesture that had ended").toBe(0);
  });

  it("cancelSlicerContentPress (deactivation) commits nothing", () => {
    press(X, itemY(0));
    move(X, itemY(2));
    cancelSlicerContentPress();
    up(X, itemY(2));
    expect(commits()).toBe(0);
  });
});

describe("'Select all' and the clear button act only when released over THEMSELVES", () => {
  it("'Select all': released off itself, nothing; released on itself, ONE clear", () => {
    load({ showSelectAll: true, selectedItems: ["South"] });
    const selectAllY = itemY(0);
    expect(press(X, selectAllY)).toBe(true);
    up(X, itemY(2)); // an item, not "Select all"
    expect(commits()).toBe(0);

    press(X, selectAllY);
    up(X, selectAllY);
    expect(h.clears).toEqual([["s1"]]);
    expect(h.clicks).toEqual([]);
  });

  it("the LIT clear button: released on itself, ONE clear; released outside the slicer, nothing", () => {
    load({ selectedItems: ["North"] });
    const btn = { x: B.x + B.width - 10, y: B.y + 12 };
    expect(press(btn.x, btn.y)).toBe(true);
    up(B.x + B.width + 40, btn.y);
    expect(commits()).toBe(0);
    press(btn.x, btn.y);
    up(btn.x, btn.y);
    expect(h.clears).toEqual([["s1"]]);
  });

  it("released on itself where ANOTHER object covers it there: nothing (the question names this slicer's region and the release point)", () => {
    load({ showSelectAll: true, selectedItems: ["South"] });
    const selectAllY = itemY(0);
    h.covered = (regionId, x, y) => regionId === REGION_ID && x === X + 5 && y === selectAllY;
    press(X, selectAllY);
    up(X + 5, selectAllY);
    expect(h.coveredAsked).toContainEqual([REGION_ID, X + 5, selectAllY]);
    expect(h.clears, "a release over an object covering 'Select all' cleared the filter").toEqual([]);
    // ...and where nothing covers it, the same release clears once (the control).
    press(X, selectAllY);
    up(X + 6, selectAllY);
    expect(h.clears).toEqual([["s1"]]);
  });

  it("the DIMMED clear button (unfiltered) is not content: no gesture starts there (D9)", () => {
    load({ selectedItems: null });
    expect(press(B.x + B.width - 10, B.y + 12)).toBe(false);
    expect(isSlicerContentGestureActive()).toBe(false);
  });
});

describe("the scrollbar drags the items and writes nothing", () => {
  /** 12 items: 356 px of items in a 208 px viewport -- the vertical bar is at x = 172..180, from y = 32. */
  const TRACK = { start: HEADER, length: 208, extent: 12 * PITCH - 4 };
  const barX = B.x + B.width - 4;

  it("a thumb drag scrolls exactly where the SAME thumb geometry the painter draws puts it", () => {
    load({}, 12);
    const thumb = slicerScrollThumb(TRACK.start, TRACK.length, TRACK.extent, 0);
    const grabRel = thumb.start + 20; // 20 px into the thumb
    expect(press(barX, B.y + grabRel)).toBe(true);
    move(barX, B.y + grabRel + 40);
    expect(getScrollOffset("s1")).toBeCloseTo(slicerScrollOffsetForThumb(TRACK.start, TRACK.length, TRACK.extent, thumb.start + 40), 5);
    expect(getScrollOffset("s1")).toBeGreaterThan(0);
    up(barX, B.y + grabRel + 40);
    expect(commits(), "a scrollbar drag committed a selection").toBe(0);
  });

  it("a press on the thumb where it is painted AFTER a scroll grabs it where it was pressed (paint == hit)", () => {
    load({}, 12);
    setScrollOffset("s1", 100);
    const thumb = slicerScrollThumb(TRACK.start, TRACK.length, TRACK.extent, 100);
    press(barX, B.y + thumb.start + 5);
    move(barX, B.y + thumb.start + 5);
    expect(getScrollOffset("s1"), "a press ON the painted thumb jumped the items").toBeCloseTo(100, 5);
    up(barX, B.y + thumb.start + 5);
  });

  it("a press on the track below the thumb jumps the thumb under the pointer", () => {
    load({}, 12);
    const thumb = slicerScrollThumb(TRACK.start, TRACK.length, TRACK.extent, 0);
    const at = TRACK.start + TRACK.length - 10;
    press(barX, B.y + at);
    expect(getScrollOffset("s1")).toBeCloseTo(
      slicerScrollOffsetForThumb(TRACK.start, TRACK.length, TRACK.extent, at - thumb.length / 2),
      5,
    );
    up(barX, B.y + at);
    expect(commits()).toBe(0);
  });
});

describe("an item drag past the item area's edge auto-scrolls", () => {
  it("the items scroll while the pointer stays at the bottom edge, and the run follows them", () => {
    vi.useFakeTimers();
    load({}, 12);
    press(X, itemY(0));
    // 6 px above the item area's bottom edge (y = 32 + 208): inside the auto-scroll band.
    const edgeY = B.y + HEADER + 208 - 2;
    move(X, edgeY);
    const shownAtFirst = getSlicerRunPreview("s1")?.values.length ?? 0;
    vi.advanceTimersByTime(300);
    expect(getScrollOffset("s1"), "the items did not scroll").toBeGreaterThan(0);
    const grown = getSlicerRunPreview("s1")?.values.length ?? 0;
    expect(grown, "the run did not follow the scrolled items").toBeGreaterThan(shownAtFirst);
    up(X, edgeY);
    expect(h.runs).toHaveLength(1);
    expect((h.runs[0][1] as string[]).length).toBe(grown);
    expect((h.runs[0][1] as string[])[0]).toBe("North");
  });
});

describe("the pointer is held through Core's seam and let go on EVERY end path", () => {
  it("an item gesture holds 'pointer' under the pressed region; the release lets go", () => {
    press(X, itemY(0));
    expect(contentGestureCursorFor(REGION_ID)).toBe("pointer");
    move(X, itemY(2));
    expect(contentGestureCursorFor(REGION_ID)).toBe("pointer");
    up(X, itemY(2));
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("Escape lets go", () => {
    press(X, itemY(0));
    escape();
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("blur lets go", () => {
    press(X, itemY(0));
    window.dispatchEvent(new Event("blur"));
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("a lost release (a move with the button up) lets go", () => {
    press(X, itemY(0));
    move(X, itemY(1), 0);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("the scrollbar holds the default arrow, and its release lets go", () => {
    load({}, 12);
    press(B.x + B.width - 4, B.y + HEADER + 20);
    expect(contentGestureCursorFor(REGION_ID)).toBe("default");
    up(B.x + B.width - 4, B.y + HEADER + 20);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });
});

describe("slicerItemIndexNear: the item a drag's pointer is on (clamped to the items shown)", () => {
  const near = (relX: number, relY: number) =>
    slicerItemIndexNear(h.slicer as unknown as Slicer, h.items as SlicerItem[], B, relX, relY);

  it("vertical: the item under the pointer; a gap takes the item before it; beyond the items, the edge item", () => {
    expect(near(90, HEADER + 13)).toBe(0);
    expect(near(90, HEADER + 2 * PITCH + 13)).toBe(2);
    expect(near(90, HEADER + 28), "the gap under item 0").toBe(0);
    expect(near(90, -50), "above the slicer").toBe(0);
    expect(near(90, B.height + 80), "below the slicer").toBe(3);
    expect(near(-40, HEADER + PITCH + 13), "left of the slicer").toBe(1);
  });

  it("GRID: row-major -- a run is the items between two in reading order", () => {
    load({ arrangement: "grid", columns: 2 }, 4);
    // Two columns of (180 + 4) / 2 - 4 = 88 px: col 0 at x 0..88, col 1 at x 92..180.
    expect(near(40, HEADER + 13)).toBe(0);
    expect(near(130, HEADER + 13)).toBe(1);
    expect(near(40, HEADER + PITCH + 13)).toBe(2);
    expect(near(130, HEADER + PITCH + 13)).toBe(3);
    expect(near(400, HEADER + PITCH + 13), "right of the slicer: the last column").toBe(3);
    expect(near(40, B.height - 4), "the empty body under the items: the last item").toBe(3);
  });

  it("a GRID drag from the first item to the last of the second row commits the run in reading order", () => {
    load({ arrangement: "grid", columns: 2 }, 4);
    press(B.x + 40, itemY(0));
    move(B.x + 130, itemY(1));
    up(B.x + 130, itemY(1));
    expect(h.runs).toEqual([["s1", ["North", "South", "West", "East"], false]]);
  });

  it("HORIZONTAL: along the row; 'Select all' is never the answer (its slot clamps to the first item)", () => {
    load({ arrangement: "horizontal", columns: 1, showSelectAll: true }, 3);
    // Four slots of (180 + 4) / 4 - 4 = 42 px: "Select all", then the three items.
    expect(near(20, HEADER + 13), "the 'Select all' slot").toBe(0);
    expect(near(46 + 20, HEADER + 13)).toBe(0);
    expect(near(2 * 46 + 20, HEADER + 13)).toBe(1);
    expect(near(3 * 46 + 20, HEADER + 13)).toBe(2);
    expect(near(900, HEADER + 13), "beyond the row: the last item").toBe(2);
  });

  it("no items: null", () => {
    load({}, 0);
    expect(near(90, HEADER + 13)).toBeNull();
  });
});

describe("a press that is not on the slicer's content starts nothing", () => {
  it("the header, a gap between items, and a part other than the one Core named", () => {
    expect(press(X, B.y + 12), "the header").toBe(false);
    expect(press(X, B.y + HEADER + 28), "the gap under item 0").toBe(false);
    expect(press(X, itemY(0), { part: "scrollbar" }), "Core named another part").toBe(false);
    expect(isSlicerContentGestureActive()).toBe(false);
    up(X, itemY(0));
    expect(commits()).toBe(0);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("an unknown slicer, or no bounds", () => {
    expect(press(X, itemY(0), { slicerId: "nope" })).toBe(false);
    expect(press(X, itemY(0), { boundsOf: () => null })).toBe(false);
  });
});
