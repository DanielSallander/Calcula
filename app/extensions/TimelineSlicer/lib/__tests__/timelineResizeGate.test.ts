//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineResizeGate.test.ts
// PURPOSE: A timeline's resize handles are CORE's business now (BUG-0258
//          design phase 3). Core's handles are live only on a SELECTED object
//          and only where Core paints them (core/lib/floatingHandles.ts,
//          pinned in src/core/lib/__tests__/floatingHandles.test.ts), so the
//          interim phase-1 workaround -- the store publishing `resizable` =
//          selected and re-publishing every region on every selection change,
//          because Core's old 10px corner boxes were live on EVERY region that
//          did not say otherwise -- is gone. What is pinned here is that it
//          stays gone: the published region never carries a resize flag, and a
//          selection change re-publishes nothing (a stale flag published by the
//          family would now switch Core's handles OFF on a selected timeline).
// CONTEXT: Driven through the real store, the real selection handler and the
//          real @api/objectSelection announcement.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const view = vi.hoisted(() => ({ activeSheetIndex: 0 }));

vi.mock("@api/ui", () => ({ registerPanel: vi.fn(), unregisterPanel: vi.fn() }));
vi.mock("@api", () => ({ addTaskPaneContextKey: vi.fn(), removeTaskPaneContextKey: vi.fn() }));
vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: view.activeSheetIndex } }),
}));
vi.mock("../../manifest", () => ({
  TIMELINE_OPTIONS_TAB_ID: "timeline-options",
  TimelineOptionsPanelDefinition: { id: "timeline-options", title: "Timeline" },
}));
vi.mock("../timeline-slicer-api", () => ({
  getAllTimelineSlicers: async () =>
    ["t1", "t2"].map((id, i) => ({
      id,
      name: `Timeline ${id}`,
      sheetIndex: 0,
      x: 10 + i * 500,
      y: 10,
      width: 420,
      height: 140,
      sourceType: "pivot",
      sourceId: "pivot-1",
      fieldName: "Date",
      level: "months",
      connectedPivotIds: [],
    })),
  getTimelineData: async () => ({ periods: [] }),
}));

import { getGridRegions, onRegionChange, setGridRegions, type GridRegion } from "@api/gridOverlays";
import * as store from "../timelineSlicerStore";
import { deselectTimeline, resetSelectionHandlerState, selectTimeline } from "../../handlers/selectionHandler";

function region(id: string): GridRegion | undefined {
  return getGridRegions().find((r) => r.id === `timeline-slicer-${id}`);
}

beforeEach(async () => {
  view.activeSheetIndex = 0;
  setGridRegions([]);
  resetSelectionHandlerState();
  store.resetStore();
  await store.refreshCache();
});

afterEach(() => {
  resetSelectionHandlerState();
  store.resetStore();
});

describe("a timeline publishes no resize flag of its own (Core gates the handles on the selection)", () => {
  it("the published region carries NO `resizable`, selected or not", () => {
    expect(region("t1")).toMatchObject({
      type: "timeline-slicer",
      floating: { x: 10, y: 10, width: 420, height: 140 },
      data: { timelineId: "t1" },
    });
    expect(region("t1")?.data).not.toHaveProperty("resizable");
    selectTimeline("t1");
    store.syncTimelineRegions();
    expect(region("t1")?.data, "a selected timeline published a resize flag").not.toHaveProperty("resizable");
    deselectTimeline();
    store.syncTimelineRegions();
    expect(region("t1")?.data).not.toHaveProperty("resizable");
  });

  it("a selection change re-publishes nothing (the phase-1 resync is gone)", () => {
    // A redraw request notifies region listeners too, so the test is on the
    // PUBLISHED LIST itself: every publication replaces the array.
    const before = getGridRegions();
    const notified: GridRegion[][] = [];
    const off = onRegionChange((r) => notified.push(r));
    try {
      selectTimeline("t1");
      selectTimeline("t2");
      deselectTimeline();
    } finally {
      off();
    }
    expect(notified.length, "control: the selection changes were announced (a repaint)").toBeGreaterThan(0);
    expect(getGridRegions(), "selecting or deselecting a timeline re-published the regions").toBe(before);
    expect("installTimelineRegionResyncs" in store, "the resync export came back").toBe(false);
  });
});
