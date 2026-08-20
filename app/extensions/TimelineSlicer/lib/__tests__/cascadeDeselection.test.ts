//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/cascadeDeselection.test.ts
// PURPOSE: The timeline half of BUG-0026, which was the identical defect on the
//          identical seam and had never been reported — it was found by asking
//          the object-dependency matrix which OTHER objects a cascade deletes.
//
// A timeline slicer can only be sourced from a pivot, so `DEPENDENCY_MATRIX`
// deletes it whenever its last pivot goes (`pivot -> timelineSlicer.sourceId`,
// CascadeOrRebind) and again when the sheet it sits on is deleted. Both are
// backend cascades. `TIMELINE_DELETED` was dispatched from exactly one place —
// `deleteTimelineAsync` — so neither of them announced anything and the
// contextual Timeline Options tab stayed on screen addressing a dead id.
//
// The reproduction is the pivot-shaped twin of the slicer's three actions:
//
//          pivot.create -> timeline.create -> pivot.delete
//
// VACUITY: every "the tab is gone" case is paired with one where it must stay.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRegisterPanel = vi.fn();
const mockUnregisterPanel = vi.fn();
vi.mock("@api/ui", () => ({
  registerPanel: (...a: unknown[]) => mockRegisterPanel(...a),
  unregisterPanel: (...a: unknown[]) => mockUnregisterPanel(...a),
}));

const mockAddContextKey = vi.fn();
const mockRemoveContextKey = vi.fn();
vi.mock("@api", () => ({
  addTaskPaneContextKey: (...a: unknown[]) => mockAddContextKey(...a),
  removeTaskPaneContextKey: (...a: unknown[]) => mockRemoveContextKey(...a),
}));

vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));

vi.mock("../../manifest", () => ({
  TIMELINE_OPTIONS_TAB_ID: "timeline-options",
  TimelineOptionsPanelDefinition: { id: "timeline-options", title: "Timeline" },
}));

/** THE BACKEND, as a set of ids. */
let backendTimelines: string[] = [];
const deleteTimelineSpy = vi.fn(async (id: string) => {
  backendTimelines = backendTimelines.filter((t) => t !== id);
});

vi.mock("../timeline-slicer-api", () => ({
  getAllTimelineSlicers: async () =>
    backendTimelines.map((id) => ({
      id,
      name: `Timeline${id}`,
      sheetIndex: 0,
      x: 10,
      y: 10,
      width: 320,
      height: 100,
      sourceType: "pivot",
      sourceId: "pivot-1",
      fieldName: "Date",
      level: "months",
      connectedPivotIds: [],
    })),
  getTimelineData: async () => ({ periods: [] }),
  createTimelineSlicer: vi.fn(),
  deleteTimelineSlicer: (id: string) => deleteTimelineSpy(id),
  updateTimelineSlicer: vi.fn(),
  updateTimelinePosition: vi.fn(),
  updateTimelineSelection: vi.fn(),
}));

import { refreshCache, deleteTimelineAsync, resetStore } from "../timelineSlicerStore";
import { TimelineSlicerEvents } from "../timelineSlicerEvents";
import {
  selectTimeline,
  dropTimelineFromSelection,
  isTimelineSelected,
  getSelectedTimelineIds,
  resetSelectionHandlerState,
} from "../../handlers/selectionHandler";

/** The one line `index.ts` wires on TIMELINE_DELETED. */
function wireExtension(): () => void {
  const handler = (e: Event) => {
    const id = (e as CustomEvent).detail?.timelineId as string | undefined;
    if (id != null) dropTimelineFromSelection(id);
  };
  window.addEventListener(TimelineSlicerEvents.TIMELINE_DELETED, handler);
  return () => window.removeEventListener(TimelineSlicerEvents.TIMELINE_DELETED, handler);
}

function tabIsRegistered(): boolean {
  const events = [
    ...mockRegisterPanel.mock.invocationCallOrder.map((n) => ({ n, on: true })),
    ...mockUnregisterPanel.mock.invocationCallOrder.map((n) => ({ n, on: false })),
  ].sort((a, b) => a.n - b.n);
  return events.length > 0 ? events[events.length - 1].on : false;
}

let announced: string[] = [];
let capture: (e: Event) => void;

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  resetSelectionHandlerState();
  backendTimelines = [];
  announced = [];
  capture = (e: Event) => {
    announced.push((e as CustomEvent).detail.timelineId as string);
  };
  window.addEventListener(TimelineSlicerEvents.TIMELINE_DELETED, capture);
  return () => window.removeEventListener(TimelineSlicerEvents.TIMELINE_DELETED, capture);
});

describe("a pivot cascade takes the contextual Timeline tab down", () => {
  it("pivot.create -> timeline.create -> pivot.delete leaves no Timeline tab", async () => {
    const unwire = wireExtension();
    backendTimelines = ["t1"];
    await refreshCache();
    selectTimeline("t1");
    expect(tabIsRegistered(), "precondition: the Timeline tab is showing").toBe(true);
    expect(mockAddContextKey).toHaveBeenCalledWith("timeline-slicer");

    // The PIVOT is deleted. `cascade_deleted_sources` removes the timeline
    // whose last source it was; nothing calls deleteTimelineSlicer.
    backendTimelines = [];
    await refreshCache();

    expect(deleteTimelineSpy).not.toHaveBeenCalled();
    expect(announced).toEqual(["t1"]);
    expect(isTimelineSelected("t1")).toBe(false);
    expect(tabIsRegistered()).toBe(false);
    expect(mockRemoveContextKey).toHaveBeenCalledWith("timeline-slicer");
    unwire();
  });

  it("keeps the survivors of a multi-selection", async () => {
    const unwire = wireExtension();
    backendTimelines = ["t1", "t2"];
    await refreshCache();
    selectTimeline("t1");
    selectTimeline("t2", true);

    backendTimelines = ["t2"];
    await refreshCache();

    expect(announced).toEqual(["t1"]);
    expect([...getSelectedTimelineIds()]).toEqual(["t2"]);
    expect(tabIsRegistered()).toBe(true);
    unwire();
  });

  it("a refresh that removes nothing announces nothing", async () => {
    const unwire = wireExtension();
    backendTimelines = ["t1"];
    await refreshCache();
    selectTimeline("t1");
    await refreshCache();
    expect(announced).toEqual([]);
    expect(tabIsRegistered()).toBe(true);
    unwire();
  });

  it("the by-hand delete announces exactly once, through the same diff", async () => {
    const unwire = wireExtension();
    backendTimelines = ["t1"];
    await refreshCache();
    selectTimeline("t1");

    await deleteTimelineAsync("t1");

    expect(deleteTimelineSpy).toHaveBeenCalledWith("t1");
    expect(announced).toEqual(["t1"]);
    expect(tabIsRegistered()).toBe(false);
    unwire();
  });
});
