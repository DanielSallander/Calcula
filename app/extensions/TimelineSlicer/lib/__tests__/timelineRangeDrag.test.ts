//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineRangeDrag.test.ts
// PURPOSE: The timeline's content gesture (BUG-0258) as a user drives it --
//          press, move, release through REAL window events -- and what it
//          commits: exactly ONE `updateTimelineSelectionAsync` per drag, at
//          release (one undo step), nothing while the pointer moves, nothing
//          on Escape, blur or a lost release, one period for a click, the
//          opposite end anchored for a range-end marker, a button acting only
//          when released over itself, the periods scrolling at an edge,
//          Shift+press extending the range shown (design phase 2, M5 T3), and
//          the pointer the gesture holds through Core's seam
//          (`holdContentGestureCursor`), let go on every end path.
// CONTEXT: index.ts hands the press over from Core's
//          `floatingObject:bodyDragStart`; the press here stands in for it
//          with the same fields. Client points ARE canvas points in these
//          tests (`clientToCanvas` is the identity).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  timeline: null as Record<string, unknown> | null,
  periods: [] as Array<Record<string, unknown>>,
  commits: [] as unknown[][],
  levels: [] as unknown[][],
  /** Hold every commit un-landed (a slow pivot filter) until `held` is run. */
  hold: false,
  held: [] as Array<() => void>,
}));

vi.mock("../timelineSlicerStore", () => ({
  getTimelineById: (id: string) => (id === "t1" ? h.timeline ?? undefined : undefined),
  getCachedTimelineData: (id: string) => (id === "t1" ? { periods: h.periods } : undefined),
  updateTimelineSelectionAsync: (...args: unknown[]) => {
    h.commits.push(args);
    if (!h.hold) return Promise.resolve();
    return new Promise<void>((resolve) => h.held.push(resolve));
  },
  updateTimelineAsync: (...args: unknown[]) => {
    h.levels.push(args);
    return Promise.resolve(h.timeline);
  },
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestOverlayRedraw: vi.fn(),
}));

import {
  clearContentGestureCursor,
  contentGestureCursorFor,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import {
  beginTimelineContentPress,
  getTimelineRangePreview,
  isTimelineContentGestureActive,
  resetTimelineContentPress,
  type TimelineContentPress,
} from "../timelineRangeDrag";
import { getScrollOffset, resetScrollOffsets, timelineOverlayZoneAt, timelineZoneOf } from "../timelineView";
import { computeTimelineLayout, levelButtonLeft } from "../timelineZones";

/** The timeline on the canvas: 420 x 140 at (100, 50). */
const B = { x: 100, y: 50, width: 420, height: 140 };
const PW = 50; // a month tile
const LAYOUT = computeTimelineLayout(
  { width: B.width, height: B.height, showHeader: true, showLevelSelector: true, showScrollbar: true, level: "months" },
  12,
);
/** The middle of the month-tile row, in canvas px. */
const TILE_Y = B.y + LAYOUT.tileTop + 14;
/** The canvas x of the middle of period `i` (unscrolled). */
const mid = (i: number) => B.x + i * PW + PW / 2;

function load(selected: [number, number] | null = null): void {
  h.timeline = {
    id: "t1",
    name: "Date",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: B.width,
    height: B.height,
    showHeader: true,
    showLevelSelector: true,
    showScrollbar: true,
    level: "months",
    selectionStart: selected ? `2026-${pad(selected[0] + 1)}-01` : null,
    selectionEnd: selected ? `2026-${pad(selected[1] + 1)}-28` : null,
  };
  h.periods = Array.from({ length: 12 }, (_, i) => ({
    label: `M${i}`,
    groupLabel: "2026",
    startDate: `2026-${pad(i + 1)}-01`,
    endDate: `2026-${pad(i + 1)}-28`,
    hasData: true,
    isSelected: selected ? i >= selected[0] && i <= selected[1] : false,
    index: i,
  }));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const P = (i: number) => h.periods[i] as { startDate: string; endDate: string };

/** The grid region Core knows t1 by (the store publishes it under this id). */
const REGION_ID = "timeline-slicer-t1";

function press(x: number, y: number, over: Partial<TimelineContentPress> = {}): boolean {
  return beginTimelineContentPress({
    timelineId: "t1",
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

/** The context Core's hover and press hand the registration, at a canvas point on t1. */
function hoverCtx(x: number, y: number): OverlayHitTestContext {
  return {
    region: {
      id: REGION_ID,
      type: "timeline-slicer",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: 0, y: 0, width: B.width, height: B.height },
      data: { timelineId: "t1" },
    },
    canvasX: x,
    canvasY: y,
    row: 0,
    col: 0,
    floatingCanvasBounds: B,
  };
}

/** A committed range whose DATES start and end inside its first and last period. */
function setDates(start: string, end: string): void {
  h.timeline!.selectionStart = start;
  h.timeline!.selectionEnd = end;
}

beforeEach(() => {
  resetTimelineContentPress();
  resetScrollOffsets();
  clearContentGestureCursor();
  h.commits = [];
  h.levels = [];
  h.hold = false;
  h.held = [];
  load();
});

afterEach(() => {
  resetTimelineContentPress();
  clearContentGestureCursor();
  vi.useRealTimers();
});

describe("a range drag across the month tiles", () => {
  it("commits EXACTLY ONCE, at release: the range pressed-to-released, asking before an overwrite", () => {
    expect(press(mid(2), TILE_Y)).toBe(true);
    for (const i of [3, 4, 5]) move(mid(i), TILE_Y);
    expect(h.commits, "nothing is written while the pointer moves").toEqual([]);
    expect(getTimelineRangePreview("t1"), "the preview follows the pointer").toEqual({ first: 2, last: 5 });

    up(mid(5), TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(5).endDate, { askBeforeOverwrite: true }]]);

    // The gesture is over: its listeners are gone, so nothing more commits.
    expect(isTimelineContentGestureActive()).toBe(false);
    move(mid(8), TILE_Y);
    up(mid(8), TILE_Y);
    expect(h.commits.length).toBe(1);
  });

  it("a drag leftwards commits the same range the other way round", () => {
    press(mid(6), TILE_Y);
    move(mid(4), TILE_Y);
    move(mid(3), TILE_Y);
    up(mid(3), TILE_Y);
    expect(h.commits).toEqual([["t1", P(3).startDate, P(6).endDate, { askBeforeOverwrite: true }]]);
  });

  it("the pointer's height does not matter once the drag is under way", () => {
    press(mid(1), TILE_Y);
    move(mid(4), TILE_Y + 80); // well below the tile row, still inside the timeline's column
    up(mid(4), TILE_Y + 80);
    expect(h.commits).toEqual([["t1", P(1).startDate, P(4).endDate, { askBeforeOverwrite: true }]]);
  });

  it("the preview is transient: it is gone once the committed range has landed", async () => {
    press(mid(2), TILE_Y);
    move(mid(4), TILE_Y);
    up(mid(4), TILE_Y);
    // Held on screen until the commit settles, so the old range does not flash back.
    expect(getTimelineRangePreview("t1")).toEqual({ first: 2, last: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTimelineRangePreview("t1")).toBeNull();
  });
});

describe("a click (a release with no movement)", () => {
  it("selects the ONE period pressed", () => {
    press(mid(2), TILE_Y);
    up(mid(2) + 1, TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(2).endDate, { askBeforeOverwrite: true }]]);
  });

  it("jitter inside Core's 3px threshold across a tile edge is still a click on the tile pressed", () => {
    const edge = B.x + 3 * PW; // between period 2 and period 3
    press(edge - 1, TILE_Y);
    move(edge + 2, TILE_Y);
    up(edge + 2, TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(2).endDate, { askBeforeOverwrite: true }]]);
  });

  it("on the period that already IS the range commits nothing (no empty undo step)", () => {
    load([3, 3]);
    press(mid(3), TILE_Y);
    up(mid(3), TILE_Y);
    expect(h.commits).toEqual([]);
  });
});

// The backend flags a period `isSelected` when it OVERLAPS the committed dates
// (timeline_slicer/commands.rs), and a level change keeps the dates. So a
// Days range of Apr 5-20 flags all of April at Months: the flags say "April
// is the range" while the pivots are filtered to half of it.
describe("'already the range' is judged by the DATES, never by the overlap flags", () => {
  it("a click on a period only PARTLY inside the range commits the WHOLE period", () => {
    load([3, 3]);
    setDates("2026-04-05", "2026-04-20");
    press(mid(3), TILE_Y);
    up(mid(3), TILE_Y);
    expect(h.commits).toEqual([["t1", P(3).startDate, P(3).endDate, { askBeforeOverwrite: true }]]);
  });

  it("a drag over exactly the flagged periods of a partial range commits them whole", () => {
    load([2, 5]);
    setDates("2026-03-10", "2026-06-15");
    press(mid(2), TILE_Y);
    move(mid(4), TILE_Y);
    move(mid(5), TILE_Y);
    up(mid(5), TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(5).endDate, { askBeforeOverwrite: true }]]);
  });

  it("a range-end marker pressed and released in place on a PARTIAL range leaves it alone (no rounding out)", () => {
    load([2, 5]);
    setDates("2026-03-10", "2026-06-15");
    press(B.x + 6 * PW - 2, TILE_Y);
    up(B.x + 6 * PW - 2, TILE_Y);
    expect(h.commits).toEqual([]);
  });
});

describe("cancelling", () => {
  it("Escape cancels with NO commit, consumes the key, and the release after it commits nothing", () => {
    press(mid(2), TILE_Y);
    move(mid(5), TILE_Y);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(isTimelineContentGestureActive()).toBe(false);
    expect(getTimelineRangePreview("t1")).toBeNull();
    up(mid(5), TILE_Y);
    expect(h.commits).toEqual([]);
  });

  it("any other key leaves the drag alone", () => {
    press(mid(2), TILE_Y);
    move(mid(4), TILE_Y);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    up(mid(4), TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(4).endDate, { askBeforeOverwrite: true }]]);
  });

  it("the window losing focus cancels with no commit", () => {
    press(mid(2), TILE_Y);
    move(mid(5), TILE_Y);
    window.dispatchEvent(new Event("blur"));
    up(mid(5), TILE_Y);
    expect(h.commits).toEqual([]);
  });

  it("a move with the primary button UP (a release never heard) ends it: no growth, no commit, ever", () => {
    press(mid(2), TILE_Y);
    move(mid(3), TILE_Y);
    move(mid(6), TILE_Y, 0);
    expect(isTimelineContentGestureActive()).toBe(false);
    // The phantom-drag shape (WF-D3): the next unrelated mouseup must not commit.
    up(mid(6), TILE_Y);
    expect(h.commits).toEqual([]);
  });

  it("a MIDDLE press (the primary never held): its release ends the gesture with no commit; a secondary release WITH the primary held does not (M7 review)", () => {
    press(mid(2), TILE_Y);
    move(mid(4), TILE_Y);
    up(mid(4), TILE_Y, 2, 1);
    expect(isTimelineContentGestureActive(), "a right release while the primary is held ended the drag").toBe(true);
    up(mid(4), TILE_Y, 1, 0);
    expect(isTimelineContentGestureActive(), "a middle release left the drag (and its listeners) live").toBe(false);
    up(mid(4), TILE_Y);
    expect(h.commits, "a later primary release committed a drag that had ended").toEqual([]);
  });

  it("a new press ends a gesture whose release was never heard, committing nothing for it", () => {
    press(mid(2), TILE_Y);
    move(mid(5), TILE_Y);
    press(mid(7), TILE_Y);
    up(mid(7), TILE_Y);
    expect(h.commits).toEqual([["t1", P(7).startDate, P(7).endDate, { askBeforeOverwrite: true }]]);
  });
});

describe("a range-end marker", () => {
  it("pressing the END marker anchors the START: dragging it right extends the range", () => {
    load([2, 5]);
    const endX = B.x + 6 * PW; // the right edge of period 5
    press(endX - 2, TILE_Y);
    move(mid(7), TILE_Y);
    move(mid(8), TILE_Y);
    up(mid(8), TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(8).endDate, { askBeforeOverwrite: true }]]);
  });

  it("pressing the START marker anchors the END: dragging it left extends the range", () => {
    load([2, 5]);
    const startX = B.x + 2 * PW;
    press(startX + 2, TILE_Y);
    move(mid(0), TILE_Y);
    up(mid(0), TILE_Y);
    expect(h.commits).toEqual([["t1", P(0).startDate, P(5).endDate, { askBeforeOverwrite: true }]]);
  });

  it("a marker pressed and released in place changes nothing", () => {
    load([2, 5]);
    press(B.x + 6 * PW - 2, TILE_Y);
    up(B.x + 6 * PW - 2, TILE_Y);
    expect(h.commits).toEqual([]);
  });
});

describe("the timeline's buttons act on RELEASE over themselves", () => {
  const CLEAR = { x: B.x + B.width - 12, y: B.y + 14 };

  it("the clear button, released over itself, clears the range (asking, one step)", () => {
    load([2, 5]);
    expect(press(CLEAR.x, CLEAR.y)).toBe(true);
    expect(h.commits).toEqual([]);
    up(CLEAR.x + 1, CLEAR.y);
    expect(h.commits).toEqual([["t1", null, null, { askBeforeOverwrite: true }]]);
  });

  it("the clear button, released somewhere else, does nothing", () => {
    load([2, 5]);
    press(CLEAR.x, CLEAR.y);
    move(mid(3), TILE_Y);
    up(mid(3), TILE_Y);
    expect(h.commits).toEqual([]);
  });

  it("a level button changes the level on release over the SAME button only", () => {
    const rowY = B.y + LAYOUT.levelTop + 12;
    const years = B.x + levelButtonLeft(B.width, 0) + 30;
    const quarters = B.x + levelButtonLeft(B.width, 1) + 30;
    press(years, rowY);
    up(years + 2, rowY);
    expect(h.levels).toEqual([["t1", { level: "years" }]]);
    press(years, rowY);
    up(quarters, rowY);
    expect(h.levels.length, "released over a different button").toBe(1);
  });
});

describe("the periods scroll", () => {
  it("a drag held past the right edge scrolls, and the range reaches the periods it scrolled in", () => {
    vi.useFakeTimers();
    press(mid(2), TILE_Y);
    move(mid(4), TILE_Y);
    move(B.x + B.width + 20, TILE_Y); // past the right edge
    expect(getScrollOffset("t1")).toBe(0);
    vi.advanceTimersByTime(600);
    expect(getScrollOffset("t1")).toBe(180); // 12 x 50 - 420: all the way
    up(B.x + B.width + 20, TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(11).endDate, { askBeforeOverwrite: true }]]);
  });

  it("the scrollbar thumb drags the periods and commits nothing", () => {
    const sbY = B.y + LAYOUT.scrollbarTop + 4;
    // Thumb: width 420 * 420/600 = 294, at x 0 while unscrolled.
    press(B.x + 50, sbY);
    move(B.x + 50 + 63, sbY); // half of the 126px thumb range
    expect(getScrollOffset("t1")).toBeCloseTo(90, 5);
    up(B.x + 50 + 63, sbY);
    expect(h.commits).toEqual([]);
  });
});

describe("what is not the content", () => {
  it("a press on the frame (the year-label strip) starts nothing", () => {
    const yearY = B.y + LAYOUT.yearStripTop + 9;
    expect(press(mid(2), yearY)).toBe(false);
    expect(isTimelineContentGestureActive()).toBe(false);
    up(mid(2), yearY);
    expect(h.commits).toEqual([]);
  });

  it("the release runs the press's onRelease once (the deferred multi-selection narrow), a cancel never", () => {
    const onRelease = vi.fn();
    press(mid(2), TILE_Y, { onRelease });
    up(mid(2), TILE_Y);
    expect(onRelease).toHaveBeenCalledTimes(1);

    const onCancelled = vi.fn();
    press(mid(2), TILE_Y, { onRelease: onCancelled });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    up(mid(2), TILE_Y);
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("an UNFILTERED timeline's dimmed clear button is not content: a press there starts nothing", () => {
    expect(press(B.x + B.width - 12, B.y + 14)).toBe(false);
    expect(isTimelineContentGestureActive()).toBe(false);
  });
});

// Between the release and the moment the commit LANDS (the backend call, the
// pivot filter, the overwrite question, the re-read of the period flags) the
// renderer paints the released range. A press must hit what is painted.
describe("while a released range's commit is still landing", () => {
  it("its painted end marker is where a press lands, and the range it drags is the painted one", () => {
    load([2, 3]);
    h.hold = true;
    press(mid(4), TILE_Y);
    move(mid(5), TILE_Y);
    move(mid(6), TILE_Y);
    up(mid(6), TILE_Y);
    expect(h.commits.length).toBe(1);
    expect(h.held.length, "the first commit has not landed").toBe(1);
    expect(getTimelineRangePreview("t1")).toEqual({ first: 4, last: 6 });

    // The painted end marker (the right edge of period 6) -- not the old one.
    const endX = B.x + 7 * PW - 2;
    expect(timelineZoneOf(hoverCtx(endX, TILE_Y))?.part).toBe("rangeEnd");
    expect(timelineOverlayZoneAt(hoverCtx(endX, TILE_Y))).toEqual({ kind: "content", cursor: "ew-resize", part: "rangeEnd" });
    // Where the OLD committed range began is just a period now.
    expect(timelineZoneOf(hoverCtx(B.x + 2 * PW + 2, TILE_Y))?.part).toBe("period");

    // Dragging that marker moves the PAINTED range's end: its start stays at 4.
    press(endX, TILE_Y);
    move(mid(7), TILE_Y);
    up(mid(7), TILE_Y);
    expect(h.commits[1]).toEqual(["t1", P(4).startDate, P(7).endDate, { askBeforeOverwrite: true }]);
  });
});

// Core's hover keeps asking while the button is held (a content press arms
// none of Core's drag flags). Over the frame the zone answer is "no cursor"
// -- Core's 'move' -- which promises a move this gesture will never make. So
// the gesture HOLDS Core's pointer over the region it pressed
// (`holdContentGestureCursor`; Core's hover reads `contentGestureCursorFor`
// before the zone), and `zoneAt` stays pure: it keeps answering what a PRESS
// there would be.
describe("the pointer shape belongs to the live gesture (Core's gesture-cursor seam)", () => {
  const yearY = () => B.y + LAYOUT.yearStripTop + 9;

  it("a range drag holds its sideways arrow over its region once moved, and lets go at release", () => {
    press(mid(2), TILE_Y);
    expect(contentGestureCursorFor(REGION_ID), "pressed on a tile: the tile's hand").toBe("pointer");
    move(mid(5), TILE_Y);
    expect(contentGestureCursorFor(REGION_ID), "under way: a range end is moving").toBe("ew-resize");
    // Another region is not the gesture's.
    expect(contentGestureCursorFor("timeline-slicer-t2")).toBeNull();
    // The zone answer is unchanged: the year strip is still frame.
    expect(timelineOverlayZoneAt(hoverCtx(mid(3), yearY()))).toEqual({ kind: "frame", part: "yearStrip" });
    up(mid(5), TILE_Y);
    expect(contentGestureCursorFor(REGION_ID), "released").toBeNull();
  });

  it("Escape lets go of the pointer", () => {
    press(mid(2), TILE_Y);
    move(mid(5), TILE_Y);
    expect(contentGestureCursorFor(REGION_ID)).toBe("ew-resize");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("the window losing focus lets go of the pointer", () => {
    press(mid(2), TILE_Y);
    move(mid(5), TILE_Y);
    window.dispatchEvent(new Event("blur"));
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("a lost release (a move with the button up) lets go of the pointer", () => {
    press(mid(2), TILE_Y);
    move(mid(5), TILE_Y);
    move(mid(6), TILE_Y, 0);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("a click still under the threshold keeps the hand it was pressed with", () => {
    press(mid(2), TILE_Y);
    move(mid(2) + 2, TILE_Y);
    expect(contentGestureCursorFor(REGION_ID)).toBe("pointer");
    up(mid(2), TILE_Y);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("a scrollbar drag holds the plain arrow, and lets go at release", () => {
    const sbY = B.y + LAYOUT.scrollbarTop + 4;
    press(B.x + 50, sbY);
    move(B.x + 60, sbY);
    expect(contentGestureCursorFor(REGION_ID)).toBe("default");
    up(B.x + 60, sbY);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });

  it("a press that is not on the content holds nothing", () => {
    expect(press(mid(2), yearY())).toBe(false);
    expect(contentGestureCursorFor(REGION_ID)).toBeNull();
  });
});

// Design phase 2 (M5 T3): Core hands the raw Shift to the content on
// `bodyDragStart` (on content it never reaches the object selection), and a
// Shift+press on a period grows the range SHOWN from its far end. The anchor
// rule is ours -- Excel's Shift+click parity was never checked in Excel.
// The timeline is 420px wide, so periods 0..7 are wholly on screen: every
// press below lands on one of them, as a real press Core hands over would.
describe("Shift+press on a period extends the range", () => {
  it("after the range: the start stays, the range grows to the period pressed (one commit)", () => {
    load([2, 5]);
    press(mid(7), TILE_Y, { extend: true });
    up(mid(7), TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(7).endDate, { askBeforeOverwrite: true }]]);
  });

  it("before the range: the END stays, the range grows back to the period pressed", () => {
    load([2, 5]);
    press(mid(0), TILE_Y, { extend: true });
    up(mid(0), TILE_Y);
    expect(h.commits).toEqual([["t1", P(0).startDate, P(5).endDate, { askBeforeOverwrite: true }]]);
  });

  it("with no range, Shift+click is a plain click: one period", () => {
    press(mid(7), TILE_Y, { extend: true });
    up(mid(7), TILE_Y);
    expect(h.commits).toEqual([["t1", P(7).startDate, P(7).endDate, { askBeforeOverwrite: true }]]);
  });

  it("without Shift the same press replaces the range (the control)", () => {
    load([2, 5]);
    press(mid(7), TILE_Y);
    up(mid(7), TILE_Y);
    expect(h.commits).toEqual([["t1", P(7).startDate, P(7).endDate, { askBeforeOverwrite: true }]]);
  });

  it("Shift+press then a drag keeps growing from the same anchor, and commits once at release", () => {
    load([2, 5]);
    press(mid(6), TILE_Y, { extend: true });
    expect(getTimelineRangePreview("t1"), "the extended range shows at once").toEqual({ first: 2, last: 6 });
    move(mid(7), TILE_Y);
    expect(h.commits).toEqual([]);
    up(mid(7), TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(7).endDate, { askBeforeOverwrite: true }]]);
  });

  it("Shift on a range-end marker behaves like the marker: it moves that end only", () => {
    load([2, 5]);
    const endX = B.x + 6 * PW; // the right edge of period 5
    press(endX - 2, TILE_Y, { extend: true });
    up(endX - 2, TILE_Y);
    expect(h.commits, "a marker released in place changes nothing, Shift or not").toEqual([]);
    press(endX - 2, TILE_Y, { extend: true });
    move(mid(7), TILE_Y);
    up(mid(7), TILE_Y);
    expect(h.commits).toEqual([["t1", P(2).startDate, P(7).endDate, { askBeforeOverwrite: true }]]);
  });

  it("extends the range SHOWN: a released range whose commit is still landing", () => {
    load([2, 3]);
    h.hold = true;
    press(mid(5), TILE_Y);
    move(mid(6), TILE_Y);
    up(mid(6), TILE_Y); // shows [5..6] until it lands
    press(mid(7), TILE_Y, { extend: true });
    up(mid(7), TILE_Y);
    expect(h.commits[1]).toEqual(["t1", P(5).startDate, P(7).endDate, { askBeforeOverwrite: true }]);
  });

  it("Shift on the scrollbar only scrolls, and on the clear button only clears on release", () => {
    load([2, 5]);
    const sbY = B.y + LAYOUT.scrollbarTop + 4;
    press(B.x + 50, sbY, { extend: true });
    move(B.x + 50 + 63, sbY);
    up(B.x + 50 + 63, sbY);
    expect(h.commits).toEqual([]);
    const CLEAR = { x: B.x + B.width - 12, y: B.y + 14 };
    press(CLEAR.x, CLEAR.y, { extend: true });
    up(CLEAR.x, CLEAR.y);
    expect(h.commits).toEqual([["t1", null, null, { askBeforeOverwrite: true }]]);
  });
});

// The fixer round: Shift extends from the ANCHOR -- the period the last plain
// gesture started at -- not from whichever end of the range lies before the
// press (the Windows list convention; Excel's own timeline was not checked).
// The range-position rule stays only as the fallback for a range no gesture
// of this session left (the backend's, a script's, another level's).
describe("Shift+press extends from the last plain press's ANCHOR", () => {
  /** Let the last commit's landing finish (its held preview is released). */
  async function flush(): Promise<void> {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  }
  /** The committed range lands: the store now carries the last commit's dates and flags. */
  async function land(): Promise<void> {
    const c = h.commits[h.commits.length - 1] as [string, string | null, string | null];
    h.timeline!.selectionStart = c[1];
    h.timeline!.selectionEnd = c[2];
    for (const p of h.periods as Array<{ startDate: string; endDate: string; isSelected: boolean }>) {
      p.isSelected = c[1] !== null && c[2] !== null && p.startDate <= c[2] && p.endDate >= c[1];
    }
    await flush();
  }
  async function click(i: number, extend = false): Promise<void> {
    press(mid(i), TILE_Y, extend ? { extend: true } : {});
    up(mid(i), TILE_Y);
    await land();
  }
  const last = () => h.commits[h.commits.length - 1].slice(1, 3);

  it("click July, Shift+click February, Shift+click April: April..July (the anchor July stays)", async () => {
    await click(7);
    await click(1, true);
    expect(last()).toEqual([P(1).startDate, P(7).endDate]);
    await click(3, true);
    expect(last(), "Shift moved the anchor to the range's first period").toEqual([P(3).startDate, P(7).endDate]);
  });

  it("a drag's PRESS is the anchor: drag June back to February, then Shift+click March gives March..June", async () => {
    press(mid(5), TILE_Y);
    move(mid(3), TILE_Y);
    move(mid(1), TILE_Y);
    up(mid(1), TILE_Y);
    await land();
    expect(last()).toEqual([P(1).startDate, P(5).endDate]);
    await click(2, true);
    expect(last()).toEqual([P(2).startDate, P(5).endDate]);
  });

  it("a range-end marker drag anchors the end that stayed: the start marker dragged to January, then Shift+click April gives April..June", async () => {
    load([2, 5]);
    const startX = B.x + 2 * PW; // the left edge of period 2
    press(startX + 2, TILE_Y);
    move(mid(1), TILE_Y);
    move(mid(0), TILE_Y);
    up(mid(0), TILE_Y);
    await land();
    expect(last()).toEqual([P(0).startDate, P(5).endDate]);
    await click(3, true);
    expect(last()).toEqual([P(3).startDate, P(5).endDate]);
  });

  it("FALLBACK: a range no gesture left (the backend's) extends by its position, as before", async () => {
    load([1, 6]);
    await click(3, true);
    expect(last()).toEqual([P(1).startDate, P(3).endDate]);
  });

  it("FALLBACK: once the range changes under the anchor (a script, another user's refresh) the old anchor is not used", async () => {
    await click(7);
    // The backend now says February..June; July is not even in it.
    h.timeline!.selectionStart = P(1).startDate;
    h.timeline!.selectionEnd = P(5).endDate;
    (h.periods as Array<{ isSelected: boolean }>).forEach((p, i) => {
      p.isSelected = i >= 1 && i <= 5;
    });
    await click(3, true);
    expect(last(), "a stale anchor (July) was used").toEqual([P(1).startDate, P(3).endDate]);
  });

  it("the anchor is forgotten on reset (deactivation): the position rule answers again", async () => {
    await click(7);
    await click(1, true);
    expect(last()).toEqual([P(1).startDate, P(7).endDate]);
    resetTimelineContentPress();
    await click(3, true);
    expect(last(), "the anchor survived the reset").toEqual([P(1).startDate, P(3).endDate]);
  });
});
