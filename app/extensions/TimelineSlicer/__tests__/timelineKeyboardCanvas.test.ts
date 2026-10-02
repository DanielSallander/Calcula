//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineKeyboardCanvas.test.ts
// PURPOSE: The keyboard inside a selected timeline ON A CANVAS (M8 S8), through
//          the REAL keybinding dispatcher, the REAL canvas bindings (Tab /
//          Escape cycling, objectCycling.ts; the arrow nudge, objectNudge.ts)
//          and the REAL TimelineSlicer activate():
//            - the dispatcher's window-capture listener runs BEFORE the
//              timeline's, so while the keyboard is inside a timeline its
//              Escape and nudge bindings must stand down -- they ask the
//              timeline's object-selection provider (`ownsKey`), which answers
//              'Escape' and 'Arrow' while the focus lives;
//            - Enter then Right moves the focus ring and nudges nothing, and
//              Shift+Right previews (no large-step nudge either);
//            - Escape drops the preview, the next leaves (the timeline stays
//              selected), and the one after is the canvas's again: it
//              deselects;
//            - Tab after Enter goes on to the next object, and that selection
//              change ends the focus.
//          The controls: outside the timeline the same keys nudge and deselect.
//          The Slicer's twin is Slicer/__tests__/slicerKeyboardCanvas.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  timelines: new Map<string, Record<string, unknown>>(),
  periods: new Map<string, Array<Record<string, unknown>>>(),
  commits: [] as unknown[][],
  /** The canvas page: editable (not subscribed) and whether its objects are LOCKED. */
  surface: { editable: true, locked: false },
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas", zoom: 1, sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/state", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ surface: "canvas", zoom: 1, sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
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
  updateTimelineSelectionAsync: vi.fn(async (...args: unknown[]) => {
    h.commits.push(args);
  }),
}));

import type { ExtensionContext } from "@api/contract";
import { initKeybindings } from "@api/keybindings";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { registerLayoutSurfaceProvider } from "@api/layoutSurface";
import { getSelectedObjectRegions } from "@api/objectSelection";
import { isSelectionOwned } from "@api/selectionOwner";
import { escapeApplies, installCanvasObjectKeyboard } from "../../CanvasSheet/lib/objectCycling";
import {
  hasPendingNudge,
  installCanvasObjectNudge,
  nudgeApplies,
  resetCanvasObjectNudge,
} from "../../CanvasSheet/lib/objectNudge";
import extension from "../index";
import { deselectTimeline, isTimelineSelected, selectTimeline } from "../handlers/selectionHandler";
import { getTimelineKeyFocus, resetTimelineKeyFocus } from "../lib/timelineKeyFocus";
import { getTimelineRangePreview } from "../lib/timelineGestureView";
import { TimelineSlicerEvents } from "../lib/timelineSlicerEvents";

// The shell's order: the dispatcher's window-capture listener is installed at
// bootstrap, before any extension activates -- so it runs FIRST.
initKeybindings();

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function timelineRow(id: string, y: number): Record<string, unknown> {
  return {
    id,
    name: id,
    headerText: null,
    sheetIndex: 0,
    x: 64,
    y,
    width: 416,
    height: 144,
    sourceType: "pivot",
    sourceId: "p1",
    fieldName: "Date",
    level: "months",
    selectionStart: null,
    selectionEnd: null,
    showHeader: true,
    showLevelSelector: true,
    showScrollbar: true,
    stylePreset: "TimelineStyleLight1",
    connectedPivotIds: ["p1"],
  };
}

function region(id: string, y: number): GridRegion {
  return {
    id: `timeline-slicer-${id}`,
    type: "timeline-slicer",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 64, y, width: 416, height: 144 },
    data: { timelineId: id },
  };
}

const context = {
  invokeBackend: vi.fn(async () => null),
  ui: { dialogs: { register: vi.fn() } },
  grid: { overlays: { register: () => () => {} } },
  events: { on: () => () => {} },
} as unknown as ExtensionContext;

let container: HTMLDivElement;
const cleanups: Array<() => void> = [];

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  container.dispatchEvent(e);
  return e;
}

const focusStart = () => getTimelineKeyFocus()?.periodStart;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  document.body.appendChild(container);
  cleanups.push(
    registerLayoutSurfaceProvider({
      get: () => ({
        snapToGrid: false,
        gridSize: 16,
        showGrid: false,
        page: { width: 1200, height: 700 },
        editable: h.surface.editable,
        isLocked: () => h.surface.locked,
      }),
    }),
  );
  cleanups.push(...installCanvasObjectKeyboard("calcula.canvas-sheet"));
  cleanups.push(...installCanvasObjectNudge("calcula.canvas-sheet"));
  extension.activate(context);
});

afterAll(() => {
  extension.deactivate?.();
  while (cleanups.length > 0) cleanups.pop()!();
  container.remove();
  vi.restoreAllMocks();
});

beforeEach(() => {
  h.timelines.clear();
  h.periods.clear();
  h.commits = [];
  h.timelines.set("t1", timelineRow("t1", 64));
  h.timelines.set("t2", timelineRow("t2", 320));
  for (const id of ["t1", "t2"]) {
    h.periods.set(
      id,
      Array.from({ length: 6 }, (_, i) => ({
        label: `M${i + 1}`,
        groupLabel: "2026",
        startDate: `2026-${pad(i + 1)}-01`,
        endDate: `2026-${pad(i + 1)}-28`,
        hasData: true,
        isSelected: false,
        index: i,
      })),
    );
  }
  setGridRegions([region("t1", 64), region("t2", 320)]);
  h.surface = { editable: true, locked: false };
  resetCanvasObjectNudge();
  deselectTimeline();
  resetTimelineKeyFocus();
  container.focus();
  selectTimeline("t1", false);
});

describe("on a canvas, inside a timeline, the canvas's Escape and nudge stand down", () => {
  it("control: outside the timeline, Escape and the arrows are the canvas's -- an arrow NUDGES the selected timeline", () => {
    expect(escapeApplies()).toBe(true);
    expect(nudgeApplies()).toBe(true);
    const e = key("ArrowRight");
    expect(e.defaultPrevented).toBe(true);
    expect(hasPendingNudge(), "control: the arrow did not nudge (the probe below would prove nothing)").toBe(true);
    expect(getTimelineKeyFocus()).toBeNull();
    resetCanvasObjectNudge();
  });

  it("inside: escapeApplies() and nudgeApplies() are false; after leaving, true again", () => {
    expect(key("Enter").defaultPrevented, "fixture: Enter went in").toBe(true);
    expect(getTimelineKeyFocus()?.timelineId).toBe("t1");
    expect(escapeApplies(), "the canvas's Escape would DESELECT the timeline the keyboard is inside").toBe(false);
    expect(nudgeApplies(), "the canvas's arrows would NUDGE the timeline the keyboard is inside").toBe(false);
    key("Escape");
    expect(getTimelineKeyFocus()).toBeNull();
    expect(escapeApplies()).toBe(true);
    expect(nudgeApplies()).toBe(true);
  });

  it("Enter, then Right and Shift+Right, through the REAL dispatcher: the ring moves, the preview grows, nothing is nudged", () => {
    key("Enter");
    const e = key("ArrowRight");
    expect(e.defaultPrevented).toBe(true);
    expect(focusStart(), "the arrow never reached the timeline (the nudge took it)").toBe("2026-02-01");
    const s = key("ArrowRight", { shiftKey: true });
    expect(s.defaultPrevented).toBe(true);
    expect(getTimelineRangePreview("t1"), "Shift+Right never reached the timeline (the large-step nudge took it)").toEqual({ first: 1, last: 2 });
    expect(hasPendingNudge(), "an arrow NUDGED the timeline the keyboard is inside").toBe(false);
    expect(h.commits).toEqual([]);
  });

  it("Escape drops the preview, the next leaves and keeps the timeline selected; the one after is the canvas's and deselects it", () => {
    key("Enter");
    key("ArrowRight", { shiftKey: true });
    key("Escape");
    expect(getTimelineKeyFocus(), "the first Escape left (the preview should go first)").not.toBeNull();
    expect(isTimelineSelected("t1")).toBe(true);
    key("Escape");
    expect(getTimelineKeyFocus()).toBeNull();
    expect(isTimelineSelected("t1"), "the second Escape deselected the timeline (the canvas binding took it)").toBe(true);
    const third = key("Escape");
    expect(third.defaultPrevented).toBe(true);
    expect(isTimelineSelected("t1"), "control: the third Escape is the canvas's").toBe(false);
  });

  it("Tab after Enter goes on to the NEXT object, and the focus ends", () => {
    key("Enter");
    const e = key("Tab");
    expect(e.defaultPrevented, "the canvas's Tab binding did not take Tab").toBe(true);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["timeline-slicer-t2"]);
    expect(getTimelineKeyFocus(), "the keyboard stayed inside the timeline it Tabbed away from").toBeNull();
  });

  it("a canvas has no cell behind the timeline: the keyboard inside claims no selection there (only a worksheet's hidden active cell needs it)", () => {
    key("Enter");
    expect(getTimelineKeyFocus()?.timelineId, "fixture: inside").toBe("t1");
    expect(isSelectionOwned(), "the canvas's own doors (object copy and paste) were refused while inside").toBe(false);
  });

  it("after a LEVEL change the focus ended at once: the next arrow NUDGES the selected timeline (the key is not lost)", () => {
    key("Enter");
    h.timelines.get("t1")!.level = "quarters";
    h.periods.set(
      "t1",
      Array.from({ length: 2 }, (_, i) => ({
        label: `Q${i + 1}`,
        groupLabel: "2026",
        startDate: `2026-${pad(i * 3 + 1)}-01`,
        endDate: `2026-${pad(i * 3 + 3)}-28`,
        hasData: true,
        isSelected: false,
        index: i,
      })),
    );
    window.dispatchEvent(new Event(TimelineSlicerEvents.TIMELINE_DATA_CHANGED));
    expect(getTimelineKeyFocus(), "the focus outlived the level it was taken at").toBeNull();
    const e = key("ArrowRight");
    expect(e.defaultPrevented).toBe(true);
    expect(hasPendingNudge(), "the arrow was LOST: the stale focus still owned it, and nothing moved").toBe(true);
    resetCanvasObjectNudge();
  });
});

// Owner decision 2026-09-29 (design: "Only moving and resizing obey the lock"):
// a LOCKED timeline, and a timeline on a SUBSCRIBED (non-editable) canvas
// page, still FILTER. This is the keyboard's pin.
describe.each([
  { name: "a LOCKED timeline", surface: { editable: true, locked: true } },
  { name: "a timeline on a SUBSCRIBED (non-editable) page", surface: { editable: false, locked: false } },
])("$name still filters from the keyboard", ({ surface }) => {
  it("Enter goes in, the arrows move the ring (never a nudge), Space commits ONE range, Alt+C clears", () => {
    h.surface = { ...surface };
    h.timelines.get("t1")!.selectionStart = "2026-01-01";
    h.timelines.get("t1")!.selectionEnd = "2026-01-28";
    expect(key("Enter").defaultPrevented, "Enter did not go into a timeline whose GEOMETRY is locked").toBe(true);
    expect(focusStart()).toBe("2026-01-01");
    const right = key("ArrowRight");
    expect(right.defaultPrevented).toBe(true);
    expect(focusStart(), "the arrow did not move the focus ring").toBe("2026-02-01");
    expect(hasPendingNudge(), "an arrow nudged a timeline the keyboard is inside").toBe(false);
    key(" ", { code: "Space" });
    expect(h.commits, "Space did not filter: the lock reached the keyboard's filtering").toEqual([
      ["t1", "2026-02-01", "2026-02-28", { askBeforeOverwrite: true }],
    ]);
    key("c", { code: "KeyC", altKey: true });
    expect(h.commits.length, "Alt+C did not clear").toBe(2);
    expect(h.commits[1]).toEqual(["t1", null, null, { askBeforeOverwrite: true }]);
  });
});
