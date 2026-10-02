//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineKeyboard.test.ts
// PURPOSE: The keyboard INSIDE a selected timeline (M8 S8, lib/timelineKeys.ts),
//          driven through the REAL `activate()` (the timelinePressWiring.test.ts
//          style) with the real selection handler, the real object-selection
//          seam, the real zone geometry, the real commit rule the range drag
//          shares (lib/timelineCommit.ts) and the real @api/announce seam --
//          only the store's backend door is a double:
//            - Enter goes in only on ONE selected object that is a timeline
//              (KD1): at the first period of the range shown, else the first
//              VISIBLE period; every key it claims is consumed, so the grid's
//              own keyboard (a BUBBLE listener on the focus container) never
//              hears it, not even an arrow at the edge;
//            - Left / Right / Home / End / PageUp / PageDown move the focus
//              ring and scroll it into view; Up and Down are consumed and do
//              nothing;
//            - Shift+arrows grow a PREVIEW (shown, never written) and Enter or
//              Space commits it ONCE through the shared rule -- one backend
//              call, one undo step; dates that already are the range write
//              nothing;
//            - Escape drops the preview first, then leaves, and the timeline
//              stays selected; Alt+C clears, only while filtered; Tab is never
//              claimed;
//            - the listener stands down for a claimed key, a key the
//              dispatcher took, a text target, a live cell edit, an unfocused
//              grid, a live content gesture, the timeline's menu and the grip's
//              menu -- one case each;
//            - the focus ends on a deselect, a second selected object, a sheet
//              switch, a delete, a pointer press, a level change and a refresh
//              that removes the focused period;
//            - every move, preview and landed commit is announced.
// CONTEXT: The canvas half (the dispatcher's Escape and nudge bindings stand
//          down) is timelineKeyboardCanvas.test.ts; the ring's paint is
//          timelineFocusRing.test.ts. The Slicer's twin is
//          Slicer/__tests__/slicerKeyboard.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

type Period = {
  label: string;
  groupLabel: string;
  startDate: string;
  endDate: string;
  hasData: boolean;
  isSelected: boolean;
  index: number;
};

const h = vi.hoisted(() => ({
  timelines: new Map<string, Record<string, unknown>>(),
  periods: new Map<string, Array<Record<string, unknown>>>(),
  commits: [] as unknown[][],
  /** Hold every commit un-landed (a slow pivot filter) until `held` is run. */
  hold: false,
  held: [] as Array<() => void>,
  editing: false,
  /** The keybinding dispatcher's stand-in: when set, it takes every key first. */
  dispatcherTakes: false,
  appEvents: new Map<string, Array<() => void>>(),
  redraws: 0,
  /** The timeline a client point lands on (null: another object, a cell, the page). */
  pointAt: "t1" as string | null,
}));

vi.mock("../lib/timelineSlicerStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshCache: vi.fn(async () => undefined),
  refreshCacheAndReconcile: vi.fn(async () => undefined),
  getTimelineById: (id: string) => h.timelines.get(id),
  getAllTimelines: () => [...h.timelines.values()],
  getCachedTimelineData: (id: string) => {
    const periods = h.periods.get(id);
    return periods ? { periods } : undefined;
  },
  updateTimelineSelectionAsync: (...args: unknown[]) => {
    h.commits.push(args);
    const [id, start, end] = args as [string, string | null, string | null];
    const landed = () => {
      // What the store does once its backend round trip is back: the new
      // dates, then the refreshed overlap flags.
      const tl = h.timelines.get(id);
      if (tl) {
        tl.selectionStart = start;
        tl.selectionEnd = end;
      }
      for (const p of (h.periods.get(id) ?? []) as Period[]) {
        p.isSelected = start !== null && end !== null && p.startDate <= end && p.endDate >= start;
      }
    };
    if (!h.hold) {
      landed();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) =>
      h.held.push(() => {
        landed();
        resolve();
      }),
    );
  },
}));

vi.mock("../lib/timelineCanvasGeometry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  timelineCanvasBounds: (t: { x: number; y: number; width: number; height: number }) => ({
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
  }),
  clientToTimelineCanvas: (x: number, y: number) => ({ x, y }),
  timelineAtCanvasPoint: () => (h.pointAt === null ? null : h.timelines.get(h.pointAt)),
}));

vi.mock("@api/state", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ zoom: 1, sheetContext: { activeSheetIndex: 0 } }),
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
// runs FIRST. Its stand-in is bound here, before activate() binds the timeline's.
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
import { noteObjectGripMenuOpen } from "@api/objectPosition";
import extension from "../index";
import { deselectTimeline, isTimelineSelected, selectTimeline } from "../handlers/selectionHandler";
import {
  closeTimelineContextMenu,
  handleTimelineContextMenu,
  isTimelineContextMenuOpen,
} from "../handlers/timelineSlicerContextMenu";
import { createTimelineSelectionProvider } from "../lib/timelineObjectSelection";
import { beginTimelineContentPress, resetTimelineContentPress } from "../lib/timelineRangeDrag";
import { getTimelineRangePreview } from "../lib/timelineGestureView";
import { rememberedTimelineAnchor, resetTimelineCommit } from "../lib/timelineCommit";
import { getScrollOffset, resetScrollOffsets, setScrollOffset } from "../lib/timelineView";
import { computeTimelineLayout } from "../lib/timelineZones";
import { getTimelineKeyFocus, resetTimelineKeyFocus } from "../lib/timelineKeyFocus";
import { timelineScrollToShow } from "../lib/timelineKeys";
import { TimelineSlicerEvents } from "../lib/timelineSlicerEvents";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Twelve months of 2026; `range` sets the committed DATES (whole months) and the flags. */
function monthPeriods(range: [number, number] | null): Period[] {
  return MONTHS.map((label, i) => ({
    label,
    groupLabel: "2026",
    startDate: `2026-${pad(i + 1)}-01`,
    endDate: `2026-${pad(i + 1)}-${DAYS[i]}`,
    hasData: i !== 6, // July has no data
    isSelected: range !== null && i >= range[0] && i <= range[1],
    index: i,
  }));
}

/** t1 at (100, 50) and t2 at (100, 260): 420 x 140, months -- 50 px tiles, eight wholly visible. */
function timelineRow(id: string, y: number, range: [number, number] | null = null): Record<string, unknown> {
  return {
    id,
    name: id === "t1" ? "Order Date" : "Ship Date",
    headerText: null,
    sheetIndex: 0,
    x: 100,
    y,
    width: 420,
    height: 140,
    sourceType: "pivot",
    sourceId: "p1",
    fieldName: "Date",
    level: "months",
    selectionStart: range ? `2026-${pad(range[0] + 1)}-01` : null,
    selectionEnd: range ? `2026-${pad(range[1] + 1)}-${DAYS[range[1]]}` : null,
    showHeader: true,
    showLevelSelector: true,
    showScrollbar: true,
    stylePreset: "TimelineStyleLight1",
    connectedPivotIds: ["p1"],
  };
}

function load(id: string, range: [number, number] | null): void {
  h.timelines.set(id, timelineRow(id, id === "t1" ? 50 : 260, range));
  h.periods.set(id, monthPeriods(range));
}

function region(id: string, y: number): GridRegion {
  return {
    id: `timeline-slicer-${id}`,
    type: "timeline-slicer",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 100, y, width: 420, height: 140 },
    data: { timelineId: id },
  };
}

const P = (i: number) => (h.periods.get("t1") as Period[])[i];

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
const shiftRight = () => key("ArrowRight", { shiftKey: true });
const altC = () => key("c", { code: "KeyC", altKey: true });

/** Let landed commits run their `.then` announcements. */
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

/** Select t1 alone and go in with Enter. */
function enterT1(): KeyboardEvent {
  selectTimeline("t1", false);
  const e = key("Enter");
  expect(getTimelineKeyFocus()?.timelineId, "fixture: Enter went into the selected timeline").toBe("t1");
  return e;
}

/** t1 switched to quarters (what the store holds after a level change landed). */
function toQuarters(): void {
  h.timelines.get("t1")!.level = "quarters";
  h.periods.set(
    "t1",
    ["Q1", "Q2", "Q3", "Q4"].map((label, i) => ({
      label,
      groupLabel: "2026",
      startDate: `2026-${pad(i * 3 + 1)}-01`,
      endDate: `2026-${pad(i * 3 + 3)}-${DAYS[i * 3 + 2]}`,
      hasData: true,
      isSelected: false,
      index: i,
    })),
  );
}

/** The focused period's index (by its start date), or null. */
const focusIndex = () => {
  const f = getTimelineKeyFocus();
  return f ? (h.periods.get(f.timelineId) as Period[]).findIndex((p) => p.startDate === f.periodStart) : null;
};

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.setAttribute("data-grid-area", "");
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
  h.timelines.clear();
  h.periods.clear();
  load("t1", null);
  load("t2", null);
  setGridRegions([region("t1", 50), region("t2", 260)]);
  resetTimelineContentPress();
  resetTimelineCommit();
  closeTimelineContextMenu();
  deselectTimeline();
  resetTimelineKeyFocus();
  resetScrollOffsets();
  h.editing = false;
  h.dispatcherTakes = false;
  h.pointAt = "t1";
  h.hold = false;
  h.held = [];
  h.commits = [];
  container.focus();
  bubbled = [];
  said.length = 0;
});

// ============================================================================
// Enter goes in (KD1)
// ============================================================================

describe("Enter goes into ONE selected timeline", () => {
  it("UNFILTERED: at the first VISIBLE period, scrolled fully into view; the Enter is consumed and announced", () => {
    // Scrolled 120 px: period 2 (Mar) is the first one on screen, partly.
    setScrollOffset("t1", 120);
    expect(getScrollOffset("t1"), "fixture: the periods scroll").toBe(120);
    const e = enterT1();
    expect(focusIndex()).toBe(2);
    expect(getScrollOffset("t1"), "the focused period was left partly scrolled out of view").toBe(100);
    expect(e.defaultPrevented, "the Enter was not claimed").toBe(true);
    expect(bubbled, "the grid's own keyboard (a bubble listener) heard the Enter -- it would move the cell cursor").toEqual([]);
    expect(isTimelineSelected("t1"), "going in deselected the timeline").toBe(true);
    expect(said).toEqual(["Order Date: Mar 2026, 3 of 12"]);
    expect(h.commits, "going in wrote something").toEqual([]);
  });

  it("FILTERED: at the first period of the range, which is said to be selected", () => {
    load("t1", [3, 5]);
    enterT1();
    expect(focusIndex()).toBe(3);
    expect(said).toEqual(["Order Date: Apr 2026, 4 of 12, selected"]);
  });

  it("TWO selected objects: Enter is left alone (it is the grid's)", () => {
    selectTimeline("t1", false);
    selectTimeline("t2", true);
    const e = key("Enter");
    expect(getTimelineKeyFocus(), "Enter went into a timeline of a multi-selection").toBeNull();
    expect(e.defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["Enter"]);
  });

  it("control: nothing selected -- Enter is the grid's", () => {
    const e = key("Enter");
    expect(getTimelineKeyFocus()).toBeNull();
    expect(e.defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["Enter"]);
  });

  it("nothing is claimed before Enter went in: a selected timeline's arrows and Space stay the grid's", () => {
    selectTimeline("t1", false);
    expect(key("ArrowRight").defaultPrevented).toBe(false);
    expect(space().defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["ArrowRight", " "]);
    expect(h.commits).toEqual([]);
  });

  it("Shift+Enter or Ctrl+Enter does not go in", () => {
    selectTimeline("t1", false);
    key("Enter", { shiftKey: true });
    key("Enter", { ctrlKey: true });
    expect(getTimelineKeyFocus()).toBeNull();
    expect(bubbled).toEqual(["Enter", "Enter"]);
  });

  it("a timeline with NO periods: Enter is not claimed", () => {
    h.periods.set("t1", []);
    selectTimeline("t1", false);
    const e = key("Enter");
    expect(getTimelineKeyFocus()).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });
});

// ============================================================================
// Inside: the arrows
// ============================================================================

describe("inside: the arrows move the focus ring", () => {
  it("Right twice walks Jan -> Feb -> Mar, each announced; nothing is written and the grid hears nothing", () => {
    enterT1();
    key("ArrowRight");
    expect(focusIndex()).toBe(1);
    key("ArrowRight");
    expect(focusIndex()).toBe(2);
    expect(said).toEqual(["Order Date: Jan 2026, 1 of 12", "Feb 2026, 2 of 12", "Mar 2026, 3 of 12"]);
    expect(h.commits).toEqual([]);
    expect(bubbled, "an arrow reached the grid's keyboard (the cell cursor would move)").toEqual([]);
  });

  it("a period the timeline paints dimmed is said to have no data", () => {
    enterT1();
    key("End");
    for (let i = 0; i < 5; i++) key("ArrowLeft");
    expect(focusIndex()).toBe(6);
    expect(said[said.length - 1]).toBe("Jul 2026, 7 of 12, no data");
  });

  it("an arrow at the EDGE is still consumed (the grid behind never sees it), and the focus stays", () => {
    enterT1();
    const left = key("ArrowLeft");
    expect(left.defaultPrevented, "ArrowLeft on the first period was returned unclaimed").toBe(true);
    expect(focusIndex()).toBe(0);
    key("End");
    expect(focusIndex()).toBe(11);
    const right = key("ArrowRight");
    expect(right.defaultPrevented, "ArrowRight on the last period was returned unclaimed").toBe(true);
    expect(focusIndex()).toBe(11);
    key("Home");
    expect(focusIndex()).toBe(0);
    expect(bubbled).toEqual([]);
  });

  it("the keys SCROLL the periods to show the focused one (End to the far right, Home back to the start)", () => {
    enterT1();
    expect(getScrollOffset("t1")).toBe(0);
    key("End");
    const layout = computeTimelineLayout(h.timelines.get("t1") as never, 12);
    expect(getScrollOffset("t1"), "End moved the focus off screen and did not scroll to it").toBe(12 * layout.periodWidth - 420);
    key("Home");
    expect(getScrollOffset("t1")).toBe(0);
  });

  it("PageDown / PageUp move by the whole periods the timeline shows (eight here)", () => {
    enterT1();
    key("PageDown");
    expect(focusIndex()).toBe(8);
    key("PageDown");
    expect(focusIndex(), "PageDown past the end wrapped or overshot").toBe(11);
    key("PageUp");
    expect(focusIndex()).toBe(3);
    key("PageUp");
    expect(focusIndex()).toBe(0);
  });

  it("Up and Down are CONSUMED and do nothing (no level change from the keyboard)", () => {
    enterT1();
    key("ArrowRight");
    const up = key("ArrowUp");
    const down = key("ArrowDown", { shiftKey: true });
    expect(up.defaultPrevented && down.defaultPrevented, "Up/Down reached the grid (the cell cursor would move)").toBe(true);
    expect(bubbled).toEqual([]);
    expect(focusIndex()).toBe(1);
    expect(h.commits).toEqual([]);
    expect(h.timelines.get("t1")!.level).toBe("months");
  });

  it("Tab is NOT claimed: it goes on to the grid (the next object or cell)", () => {
    enterT1();
    const e = key("Tab");
    expect(e.defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["Tab"]);
  });

  it("a key the timeline does not use (a letter) goes on to Core -- whose type-to-edit then REFUSES it: the inside owns the selection", () => {
    enterT1();
    expect(key("x").defaultPrevented).toBe(false);
    expect(bubbled).toEqual(["x"]);
    // Core's type-to-edit (useSpreadsheetEditing) asks this before it opens an
    // entry in its active cell -- hidden behind the timeline on a worksheet.
    expect(isSelectionOwned(), "the letter would open an edit in the cell BEHIND the timeline").toBe(true);
  });

  it("every change of the focus repaints (the ring shows, moves and goes), leaving too", () => {
    enterT1();
    h.redraws = 0;
    for (const cb of h.appEvents.get(AppEvents.SHEET_CHANGED) ?? []) cb();
    expect(getTimelineKeyFocus()).toBeNull();
    expect(h.redraws, "the focus ended and nothing repainted: the ring stays on screen").toBeGreaterThan(0);
  });
});

// ============================================================================
// Shift+arrows preview; Enter / Space commit ONCE
// ============================================================================

describe("Shift+arrows preview a range; Enter or Space commits it ONCE", () => {
  it("Shift+Right twice, then Enter: ONE write with the three periods' dates; nothing while previewing", () => {
    enterT1();
    shiftRight();
    expect(getTimelineRangePreview("t1"), "the preview is not shown").toEqual({ first: 0, last: 1 });
    shiftRight();
    expect(getTimelineRangePreview("t1")).toEqual({ first: 0, last: 2 });
    expect(h.commits, "a Shift+arrow wrote the timeline (one undo step per key)").toEqual([]);
    expect(said.slice(1)).toEqual(["Jan 2026 to Feb 2026 previewed, 2 periods", "Jan 2026 to Mar 2026 previewed, 3 periods"]);
    const e = key("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(h.commits).toEqual([["t1", P(0).startDate, P(2).endDate, { askBeforeOverwrite: true }]]);
    expect(bubbled).toEqual([]);
  });

  it("the journey's K-3 keys: Enter, Right, Shift+Right twice, Enter -- ONE range of three periods (Feb..Apr)", () => {
    enterT1();
    key("ArrowRight");
    shiftRight();
    shiftRight();
    key("Enter");
    expect(h.commits).toEqual([["t1", P(1).startDate, P(3).endDate, { askBeforeOverwrite: true }]]);
  });

  it("Shift+Left grows the preview BACK from the same anchor; Space commits it", () => {
    enterT1();
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowLeft", { shiftKey: true });
    key("ArrowLeft", { shiftKey: true });
    expect(getTimelineRangePreview("t1")).toEqual({ first: 0, last: 2 });
    space();
    expect(h.commits).toEqual([["t1", P(0).startDate, P(2).endDate, { askBeforeOverwrite: true }]]);
  });

  it("Shift+End previews to the last period; a PLAIN arrow ends the run (the preview goes) and Enter then commits the focused period alone", () => {
    enterT1();
    key("End", { shiftKey: true });
    expect(getTimelineRangePreview("t1")).toEqual({ first: 0, last: 11 });
    key("ArrowLeft");
    expect(getTimelineRangePreview("t1"), "a plain arrow kept the preview").toBeNull();
    expect(getTimelineKeyFocus()?.anchorStart).toBeNull();
    key("Enter");
    expect(h.commits).toEqual([["t1", P(10).startDate, P(10).endDate, { askBeforeOverwrite: true }]]);
  });

  it("Space with no preview commits the focused period alone", () => {
    enterT1();
    key("ArrowRight");
    space();
    expect(h.commits).toEqual([["t1", P(1).startDate, P(1).endDate, { askBeforeOverwrite: true }]]);
  });

  it("Enter on a period whose DATES already are the range writes NOTHING (the shared rule), and says it is selected", async () => {
    load("t1", [3, 3]);
    enterT1();
    said.length = 0;
    key("Enter");
    expect(h.commits, "an empty undo step: the range already was exactly April").toEqual([]);
    await flush();
    expect(said).toEqual(["Apr 2026 selected"]);
  });

  it("a HELD Space (auto-repeat) commits once -- while the first commit is still landing, when the dates check cannot hide a second", () => {
    // Held un-landed: the store still has the old dates, so a repeat that
    // committed again would WRITE again (once landed, "already the range"
    // would swallow it and prove nothing about the repeat).
    h.hold = true;
    enterT1();
    space();
    space({ repeat: true });
    space({ repeat: true });
    expect(h.commits).toHaveLength(1);
    expect(bubbled).toEqual([]);
  });

  it("the commit is announced only once it LANDED, as the dates it landed", async () => {
    h.hold = true;
    enterT1();
    key("ArrowRight");
    shiftRight();
    shiftRight();
    said.length = 0;
    key("Enter");
    expect(getTimelineRangePreview("t1"), "the committed range is not shown while it lands").toEqual({ first: 1, last: 3 });
    await flush();
    expect(said, "announced before the commit landed").toEqual([]);
    for (const run of h.held.splice(0)) run();
    await flush();
    expect(said).toEqual(["Feb 2026 to Apr 2026 selected"]);
    expect(getTimelineRangePreview("t1"), "the landed range is still held on screen").toBeNull();
  });

  it("a commit that did not land as those dates (declined, refused) is not announced as selected", async () => {
    h.hold = true;
    enterT1();
    key("ArrowRight");
    said.length = 0;
    key("Enter");
    // The decline: the store took the step back, so the dates are what they were.
    h.held.splice(0);
    await flush();
    expect(said, "a commit was announced as selected although it never landed as those dates").toEqual([]);
  });

  it("the commit leaves its ANCHOR for a later mouse Shift+click (the drag's memory)", () => {
    enterT1();
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowLeft", { shiftKey: true });
    key("ArrowLeft", { shiftKey: true });
    key("Enter");
    expect(h.commits).toEqual([["t1", P(1).startDate, P(3).endDate, { askBeforeOverwrite: true }]]);
    // The run was anchored at April (index 3), and swept back to February.
    expect(rememberedTimelineAnchor("t1", "months", { first: 1, last: 3 })).toBe(3);
  });

  it("the run ends at the commit: the next Shift+arrow starts a new preview from the focus", () => {
    enterT1();
    shiftRight();
    key("Enter");
    expect(getTimelineKeyFocus()?.anchorStart).toBeNull();
    shiftRight();
    expect(getTimelineRangePreview("t1")).toEqual({ first: 1, last: 2 });
  });
});

// ============================================================================
// Escape and Alt+C
// ============================================================================

describe("Escape drops the preview, then leaves; Alt+C clears", () => {
  it("Escape with a preview drops ONLY the preview -- the focus stays; the next Escape leaves, and the timeline stays selected", () => {
    enterT1();
    key("ArrowRight");
    shiftRight();
    said.length = 0;
    const first = key("Escape");
    expect(first.defaultPrevented).toBe(true);
    expect(getTimelineRangePreview("t1"), "Escape left the preview on screen").toBeNull();
    expect(getTimelineKeyFocus(), "the FIRST Escape left the timeline (it should drop the preview only)").not.toBeNull();
    expect(focusIndex()).toBe(2);
    expect(said).toEqual(["Preview cancelled"]);
    const second = key("Escape");
    expect(second.defaultPrevented).toBe(true);
    expect(getTimelineKeyFocus()).toBeNull();
    expect(isTimelineSelected("t1"), "Escape deselected the timeline").toBe(true);
    expect(said).toEqual(["Preview cancelled", "Left Order Date"]);
    expect(h.commits).toEqual([]);
    const third = key("Escape");
    expect(third.defaultPrevented, "the third Escape is not the timeline's").toBe(false);
    expect(bubbled).toEqual(["Escape"]);
  });

  it("Escape with no preview leaves at once", () => {
    enterT1();
    key("Escape");
    expect(getTimelineKeyFocus()).toBeNull();
    expect(isTimelineSelected("t1")).toBe(true);
  });

  it("Alt+C on ONE selected, FILTERED timeline clears WITHOUT going in, and says so once it is clear", async () => {
    load("t1", [2, 4]);
    selectTimeline("t1", false);
    const e = altC();
    expect(e.defaultPrevented).toBe(true);
    expect(bubbled).toEqual([]);
    expect(h.commits).toEqual([["t1", null, null, { askBeforeOverwrite: true }]]);
    expect(getTimelineKeyFocus(), "Alt+C went in").toBeNull();
    await flush();
    expect(said).toEqual(["Filter cleared"]);
  });

  it("Alt+C on an UNFILTERED timeline is not claimed", () => {
    selectTimeline("t1", false);
    const e = altC();
    expect(e.defaultPrevented).toBe(false);
    expect(h.commits).toEqual([]);
  });

  it("Alt+C inside clears too, and drops a preview", () => {
    load("t1", [2, 4]);
    enterT1();
    shiftRight();
    altC();
    expect(h.commits).toEqual([["t1", null, null, { askBeforeOverwrite: true }]]);
    expect(getTimelineKeyFocus()?.anchorStart).toBeNull();
  });

  it("AltGr+C (Ctrl+Alt+C: a CHARACTER on Polish or Czech layouts) is not Alt+C: never claimed, the filter untouched", async () => {
    load("t1", [2, 4]);
    selectTimeline("t1", false);
    const outsideKey = key("c", { code: "KeyC", ctrlKey: true, altKey: true });
    expect(outsideKey.defaultPrevented, "AltGr+C was taken as Alt+C on a selected timeline").toBe(false);
    enterT1();
    bubbled = [];
    const insideKey = key("c", { code: "KeyC", ctrlKey: true, altKey: true });
    expect(insideKey.defaultPrevented, "AltGr+C was taken as Alt+C inside the timeline").toBe(false);
    expect(bubbled).toEqual(["c"]);
    await flush();
    expect(h.commits, "AltGr+C cleared the filter").toEqual([]);
  });
});

// ============================================================================
// The gates
// ============================================================================

describe("the listener stands down", () => {
  it("for a CLAIMED key (a surface stacked on the grid)", () => {
    selectTimeline("t1", false);
    const claimed = document.createElement("div");
    claimed.setAttribute("data-pointer-claim", "test-form");
    claimed.tabIndex = 0;
    container.appendChild(claimed);
    try {
      claimed.focus();
      const e = key("Enter", {}, claimed);
      expect(getTimelineKeyFocus()).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    } finally {
      claimed.remove();
      container.focus();
    }
  });

  it("for a key the dispatcher already TOOK (defaultPrevented)", () => {
    selectTimeline("t1", false);
    h.dispatcherTakes = true;
    key("Enter");
    expect(getTimelineKeyFocus()).toBeNull();
  });

  it("for a TEXT target (an input inside the grid)", () => {
    selectTimeline("t1", false);
    const input = document.createElement("input");
    container.appendChild(input);
    try {
      input.focus();
      const e = key("Enter", {}, input);
      expect(getTimelineKeyFocus()).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    } finally {
      input.remove();
      container.focus();
    }
  });

  it("while a CELL EDIT is live", () => {
    selectTimeline("t1", false);
    h.editing = true;
    const e = key("Enter");
    expect(getTimelineKeyFocus()).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  it("while a FLOATING GRID's cell edit is live (an external session: parked, the keyboard on the grid container)", () => {
    // Inside already, then the edit starts: the timeline's keys stand down too.
    enterT1();
    const before = getTimelineKeyFocus();
    const off = registerExternalFormulaTarget({
      isExpectingReference: () => true,
      insertReference: () => undefined,
      session: {} as never,
    });
    try {
      const right = key("ArrowRight");
      expect(getTimelineKeyFocus(), "an arrow moved the timeline's focus in the middle of a floating grid's cell edit").toEqual(before);
      expect(right.defaultPrevented, "the edit's arrow was taken").toBe(false);
      resetTimelineKeyFocus();
      const e = key("Enter");
      expect(getTimelineKeyFocus(), "Enter went into the timeline instead of committing the floating grid's edit").toBeNull();
      expect(e.defaultPrevented, "the edit's Enter was taken").toBe(false);
    } finally {
      off();
    }
  });

  it("while the GRID IS NOT FOCUSED (a ribbon button, a task pane)", () => {
    selectTimeline("t1", false);
    outside.focus();
    try {
      const e = key("Enter", {}, outside);
      expect(getTimelineKeyFocus(), "Enter went into the timeline from outside the grid").toBeNull();
      expect(e.defaultPrevented, "a key aimed at a button outside the grid was taken").toBe(false);
    } finally {
      container.focus();
    }
  });

  it("while a timeline CONTENT GESTURE is live (a held range drag owns Escape)", () => {
    enterT1();
    const layout = computeTimelineLayout(h.timelines.get("t1") as never, 12);
    expect(
      beginTimelineContentPress({
        timelineId: "t1",
        regionId: "timeline-slicer-t1",
        canvasX: 100 + 125,
        canvasY: 50 + layout.tileTop + 14,
        boundsOf: () => ({ x: 100, y: 50, width: 420, height: 140 }),
        clientToCanvas: (x, y) => ({ x, y }),
      }),
      "fixture: the press started a gesture",
    ).toBe(true);
    // A real press would also end the focus through Core's events; the focus
    // is kept here so the GATE, not that end hook, is what keeps the keyboard
    // out of a live drag.
    expect(getTimelineKeyFocus()?.timelineId, "fixture: still inside").toBe("t1");
    try {
      const e = key("ArrowRight");
      expect(e.defaultPrevented, "the keyboard took a key from a live range drag").toBe(false);
      expect(focusIndex(), "the keyboard moved its focus during a live range drag").toBe(0);
    } finally {
      resetTimelineContentPress();
    }
  });

  it("while the timeline's right-click MENU is open (the new probe), and again once it closed", () => {
    selectTimeline("t1", false);
    handleTimelineContextMenu(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 150 }), container);
    expect(isTimelineContextMenuOpen(), "fixture: the right-click opened the menu").toBe(true);
    try {
      const e = key("Enter");
      expect(getTimelineKeyFocus(), "Enter went into the timeline behind its open menu").toBeNull();
      expect(e.defaultPrevented).toBe(false);
    } finally {
      closeTimelineContextMenu();
    }
    expect(isTimelineContextMenuOpen()).toBe(false);
    key("Enter");
    expect(getTimelineKeyFocus()?.timelineId, "control: with the menu closed Enter goes in").toBe("t1");
  });

  it("while an object's GRIP MENU is open", () => {
    selectTimeline("t1", false);
    const closed = noteObjectGripMenuOpen();
    try {
      const e = key("Enter");
      expect(getTimelineKeyFocus()).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    } finally {
      closed();
    }
    key("Enter");
    expect(getTimelineKeyFocus()?.timelineId, "control: with the menu closed Enter goes in").toBe("t1");
  });
});

// ============================================================================
// The focus ends
// ============================================================================

describe("the focus ends", () => {
  it("on a DESELECT (a click on a cell, the canvas's Escape)", () => {
    enterT1();
    deselectTimeline();
    expect(getTimelineKeyFocus()).toBeNull();
  });

  it("when a SECOND object joins the selection", () => {
    enterT1();
    selectTimeline("t2", true);
    expect(getTimelineKeyFocus()).toBeNull();
  });

  it("on a SHEET SWITCH", () => {
    enterT1();
    for (const cb of h.appEvents.get(AppEvents.SHEET_CHANGED) ?? []) cb();
    expect(getTimelineKeyFocus()).toBeNull();
  });

  it("when the timeline is DELETED", () => {
    enterT1();
    window.dispatchEvent(new CustomEvent(TimelineSlicerEvents.TIMELINE_DELETED, { detail: { timelineId: "t1" } }));
    expect(getTimelineKeyFocus()).toBeNull();
  });

  it("on the next POINTER PRESS on an object (Core's press events), and its preview goes with it", () => {
    enterT1();
    shiftRight();
    window.dispatchEvent(
      new CustomEvent("floatingObject:selected", {
        detail: { regionId: "timeline-slicer-t1", regionType: "timeline-slicer", data: { timelineId: "t1" }, zone: "frame", part: "header", canvasX: 200, canvasY: 60, ctrlKey: false },
      }),
    );
    expect(getTimelineKeyFocus(), "a press on the timeline's frame kept the keyboard inside").toBeNull();
    expect(getTimelineRangePreview("t1"), "the keyboard's preview outlived the focus").toBeNull();
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
  });

  it("a CONTENT press ends the focus and its preview -- and the range drag it starts keeps ITS range", () => {
    enterT1();
    shiftRight(); // previews Jan..Feb
    const layout = computeTimelineLayout(h.timelines.get("t1") as never, 12);
    window.dispatchEvent(
      new CustomEvent("floatingObject:bodyDragStart", {
        detail: {
          regionId: "timeline-slicer-t1",
          regionType: "timeline-slicer",
          data: { timelineId: "t1" },
          canvasX: 100 + 5 * 50 + 25,
          canvasY: 50 + layout.tileTop + 14,
          part: "period",
          shiftKey: false,
        },
      }),
    );
    try {
      expect(getTimelineKeyFocus(), "a content press kept the keyboard inside").toBeNull();
      expect(getTimelineRangePreview("t1"), "ending the keyboard's focus erased the drag's range (one shared slot)").toEqual({ first: 5, last: 5 });
    } finally {
      resetTimelineContentPress();
    }
  });

  it("a LEVEL change ends it AT ONCE, and says so -- even on January, whose start date Q1 shares: the next arrow is not the timeline's, and Enter goes in again at the new level", () => {
    enterT1(); // January: 2026-01-01, which is also Q1's start date
    said.length = 0;
    toQuarters();
    window.dispatchEvent(new Event(TimelineSlicerEvents.TIMELINE_DATA_CHANGED));
    expect(getTimelineKeyFocus(), "the focus survived a level change until the next key").toBeNull();
    expect(said, "the ring vanished and nothing was said").toEqual(["Left Order Date"]);
    const e = key("ArrowRight");
    expect(e.defaultPrevented, "the arrow was still taken by a focus that had ended").toBe(false);
    key("Enter");
    expect(getTimelineKeyFocus()).toMatchObject({ level: "quarters", periodStart: "2026-01-01" });
  });

  it("a refresh that REMOVES the focused period ends it at once, and says so", () => {
    enterT1();
    key("ArrowRight"); // Feb
    said.length = 0;
    h.periods.set("t1", monthPeriods(null).filter((_, i) => i !== 1));
    window.dispatchEvent(new Event(TimelineSlicerEvents.TIMELINE_DATA_CHANGED));
    expect(getTimelineKeyFocus()).toBeNull();
    expect(said).toEqual(["Left Order Date"]);
  });

  it("control: a refresh that keeps the focused period (same level) keeps the focus, and says nothing", () => {
    enterT1();
    key("ArrowRight");
    said.length = 0;
    window.dispatchEvent(new Event(TimelineSlicerEvents.TIMELINE_DATA_CHANGED));
    expect(focusIndex()).toBe(1);
    expect(said).toEqual([]);
  });

  it("a key that still finds the focus STALE (a level change no refresh announced) ends it, says so, and is CONSUMED -- the arrow and Space never reach the cell behind; Enter goes in again", () => {
    enterT1();
    said.length = 0;
    toQuarters();
    const e = key("ArrowRight");
    expect(getTimelineKeyFocus()).toBeNull();
    expect(e.defaultPrevented, "the stale focus passed the arrow on: the cell cursor moves and nothing is said").toBe(true);
    expect(bubbled).toEqual([]);
    expect(said).toEqual(["Left Order Date"]);
    // Again, with Space.
    load("t1", null);
    enterT1();
    toQuarters();
    const sp = space();
    expect(sp.defaultPrevented, "Space reached the cell behind (a checkbox toggle, an edit)").toBe(true);
    expect(h.commits).toEqual([]);
    // Enter in the same state goes in again, at the new level.
    load("t1", null);
    enterT1();
    toQuarters();
    const enter = key("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(getTimelineKeyFocus()).toMatchObject({ level: "quarters" });
  });

  it("the stale-focus key: Tab is not consumed, and a bare Shift ends nothing", () => {
    enterT1();
    toQuarters();
    const shift = key("Shift", { shiftKey: true });
    expect(shift.defaultPrevented).toBe(false);
    expect(getTimelineKeyFocus(), "a bare modifier is never the timeline's key").not.toBeNull();
    const tab = key("Tab");
    expect(getTimelineKeyFocus()).toBeNull();
    expect(tab.defaultPrevented, "Tab was swallowed").toBe(false);
  });

  it("a RIGHT press anywhere but the focused timeline ends the focus -- another object's menu (a slicer's, which selects nothing) then owns Escape, Enter and Space", () => {
    enterT1();
    shiftRight();
    h.pointAt = null; // a slicer, a cell, the page
    container.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 700, clientY: 400, bubbles: true, cancelable: true }));
    expect(getTimelineKeyFocus(), "the keyboard stayed inside the timeline under another menu").toBeNull();
    expect(getTimelineRangePreview("t1"), "the keyboard's preview outlived the focus").toBeNull();
    const esc = key("Escape");
    expect(esc.defaultPrevented, "the first Escape left the timeline instead of closing the menu").toBe(false);
    const sp = space();
    expect(sp.defaultPrevented, "Space committed a range behind the open menu").toBe(false);
    expect(h.commits).toEqual([]);
  });

  it("a right press ON the focused timeline keeps the keyboard inside (its own menu takes the keys while open)", () => {
    enterT1();
    h.pointAt = "t1";
    container.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 150, clientY: 100, bubbles: true, cancelable: true }));
    expect(getTimelineKeyFocus()?.timelineId, "a right press on the timeline itself ended the focus").toBe("t1");
    h.pointAt = "t2";
    container.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 150, clientY: 300, bubbles: true, cancelable: true }));
    expect(getTimelineKeyFocus(), "a right press on ANOTHER timeline kept the keyboard inside the first").toBeNull();
  });

  it("a refresh that only MOVES the focused period keeps it on the same month (by start date)", () => {
    enterT1();
    key("ArrowRight"); // Feb, index 1
    h.periods.set("t1", [
      { label: "Dec", groupLabel: "2025", startDate: "2025-12-01", endDate: "2025-12-31", hasData: true, isSelected: false, index: 0 },
      ...monthPeriods(null),
    ]);
    key("ArrowRight");
    expect(getTimelineKeyFocus()?.periodStart, "the focus followed an index, not the month").toBe("2026-03-01");
  });
});

// ============================================================================
// The least scroll that shows a period
// ============================================================================

describe("timelineScrollToShow: the least scroll that shows the focused period", () => {
  const layout = computeTimelineLayout(
    { width: 420, height: 140, showHeader: true, showLevelSelector: true, showScrollbar: true, level: "months" },
    12,
  );

  it("a period already in view keeps the scroll; one to the left scrolls to its left edge, one to the right to its right edge", () => {
    expect(timelineScrollToShow(layout, 60, 3)).toBe(60);
    expect(timelineScrollToShow(layout, 120, 1)).toBe(50);
    expect(timelineScrollToShow(layout, 0, 9)).toBe(10 * 50 - 420);
  });

  it("a period WIDER than the timeline shows its left edge", () => {
    const narrow = computeTimelineLayout(
      { width: 30, height: 140, showHeader: true, showLevelSelector: true, showScrollbar: true, level: "months" },
      12,
    );
    expect(timelineScrollToShow(narrow, 0, 4)).toBe(4 * 50);
  });
});

// ============================================================================
// Ownership on a canvas (the provider the canvas bindings ask)
// ============================================================================

describe("the timeline owns Escape and the arrows while the keyboard is inside", () => {
  it("ownsKey('Escape') and ownsKey('Arrow') are true inside, false after leaving; Tab never", () => {
    const p = createTimelineSelectionProvider();
    selectTimeline("t1", false);
    expect(p.ownsKey?.("Arrow"), "control: outside, the arrows nudge").toBe(false);
    expect(p.ownsKey?.("Escape")).toBe(false);
    key("Enter");
    expect(p.ownsKey?.("Arrow"), "a canvas would NUDGE the timeline instead of moving the focus").toBe(true);
    expect(p.ownsKey?.("Escape"), "a canvas would DESELECT the timeline instead of leaving the periods").toBe(true);
    expect(p.ownsKey?.("Tab")).toBe(false);
    key("Escape");
    expect(p.ownsKey?.("Arrow")).toBe(false);
    expect(p.ownsKey?.("Escape")).toBe(false);
  });

  // BUG-0270: a SELECTED timeline is deleted by the generic Delete
  // (ObjectPosition lib/selectedObjectKeys.ts), which stands down while a
  // family owns the key. Inside, Delete is refused by the inside claim -- it
  // must never delete the timeline the keyboard is in.
  it("ownsKey('Delete') is true inside, false while merely selected and after leaving", () => {
    const p = createTimelineSelectionProvider();
    selectTimeline("t1", false);
    expect(p.ownsKey?.("Delete"), "control: a selected timeline's Delete is the generic object Delete").toBe(false);
    key("Enter");
    expect(p.ownsKey?.("Delete"), "Delete INSIDE the timeline would delete the timeline").toBe(true);
    key("Escape");
    expect(p.ownsKey?.("Delete")).toBe(false);
  });

  // BUG-0270 review: the timeline's right-click menu takes no focus, so the
  // grid keeps the keyboard while it is open. Delete there deleted the
  // timeline BEHIND the menu (the generic Delete asked only the inside and the
  // gesture), and the generic Escape deselected it and left the menu open
  // (the BUG-0196 pattern).
  it("ownsKey('Delete') and ownsKey('Escape') are true while the timeline's right-click MENU is open", () => {
    const p = createTimelineSelectionProvider();
    selectTimeline("t1", false);
    expect(p.ownsKey?.("Delete"), "control: no menu").toBe(false);
    handleTimelineContextMenu(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 150 }), container);
    expect(isTimelineContextMenuOpen(), "fixture: the right-click opened the menu").toBe(true);
    try {
      expect(p.ownsKey?.("Delete"), "Delete with the menu open deleted the timeline behind it").toBe(true);
      expect(p.ownsKey?.("Escape"), "Escape with the menu open deselected the timeline and left the menu").toBe(true);
      expect(p.ownsKey?.("Arrow"), "the arrows are not the menu's").toBe(false);
    } finally {
      closeTimelineContextMenu();
    }
    expect(p.ownsKey?.("Delete"), "the menu closed but the timeline still refuses its Delete").toBe(false);
    expect(p.ownsKey?.("Escape")).toBe(false);
  });

  it("Escape CLOSES the timeline's menu and is consumed there; the timeline stays selected", () => {
    selectTimeline("t1", false);
    handleTimelineContextMenu(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 150 }), container);
    expect(isTimelineContextMenuOpen(), "fixture: the right-click opened the menu").toBe(true);
    try {
      const e = key("Escape");
      expect(isTimelineContextMenuOpen(), "Escape left the timeline's menu open").toBe(false);
      expect(e.defaultPrevented, "the Escape that closed the menu went on to the grid").toBe(true);
      expect(bubbled, "the grid's keyboard heard the menu's Escape").not.toContain("Escape");
      expect(isTimelineSelected("t1"), "closing the menu deselected the timeline").toBe(true);
      const again = key("Escape");
      expect(again.defaultPrevented, "a stale menu listener ate the next Escape").toBe(false);
    } finally {
      closeTimelineContextMenu();
    }
  });

  it("ownsKey('Delete') is true while a timeline CONTENT GESTURE is live (a range drag): the timeline under it is not deleted", () => {
    const p = createTimelineSelectionProvider();
    selectTimeline("t1", false);
    const layout = computeTimelineLayout(h.timelines.get("t1") as never, 12);
    expect(
      beginTimelineContentPress({
        timelineId: "t1",
        regionId: "timeline-slicer-t1",
        canvasX: 100 + 125,
        canvasY: 50 + layout.tileTop + 14,
        boundsOf: () => ({ x: 100, y: 50, width: 420, height: 140 }),
        clientToCanvas: (x, y) => ({ x, y }),
      }),
      "fixture: the press started a gesture",
    ).toBe(true);
    try {
      expect(p.ownsKey?.("Delete"), "Delete during a live range drag deleted the timeline under it").toBe(true);
    } finally {
      resetTimelineContentPress();
    }
    expect(p.ownsKey?.("Delete"), "control: the gesture ended").toBe(false);
  });
});

// ============================================================================
// The cell BEHIND the timeline (a worksheet): unreachable while the keyboard is inside
// ============================================================================

describe("while the keyboard is inside, the worksheet's hidden active cell is out of reach", () => {
  const SENTENCE = (action: string) =>
    `${action} is not available while the keyboard is inside a timeline. Press Escape to leave it. Nothing was changed.`;

  it("inside, the timeline OWNS the selection: every door that writes Core's active cell -- type-to-edit (a character, F2, Backspace), Delete, Alt+Down -- refuses with the timeline's sentence; nothing types into the timeline", () => {
    selectTimeline("t1", false);
    expect(isSelectionOwned(), "control: a merely SELECTED timeline claims nothing yet").toBe(false);
    key("Enter");
    expect(getTimelineKeyFocus()?.timelineId, "fixture: inside").toBe("t1");
    expect(isSelectionOwned(), "a typed character, F2, Delete or Alt+Down would act on the cell BEHIND the timeline").toBe(true);
    expect(getSelectionOwner()?.receivesTyping?.() ?? false, "nothing of the timeline takes typing").toBe(false);
    for (const action of ["Edit Cell", "Clear Contents", "Open the In-Cell List"]) {
      expect(selectionRefusalFor(action)).toBe(SENTENCE(action));
    }
    for (const k of ["x", "F2", "Backspace"]) expect(key(k).defaultPrevented, `${k} was taken by the timeline`).toBe(false);
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
      selectTimeline("t1", false);
      await settle();
      expect(heard, "control: selecting the timeline is no claim").toEqual([]);
      key("Enter");
      await settle();
      expect(heard, "going in was not announced to the ownership listeners").toEqual([true]);
      key("Escape");
      await settle();
      expect(heard, "leaving with Escape (no selection change) was not announced").toEqual([true, false]);
      key("Enter");
      deselectTimeline();
      await settle();
      expect(isSelectionOwned()).toBe(false);
      enterT1();
      for (const cb of h.appEvents.get(AppEvents.SHEET_CHANGED) ?? []) cb();
      expect(isSelectionOwned(), "a sheet switch left the claim behind").toBe(false);
    } finally {
      off();
    }
  });
});
