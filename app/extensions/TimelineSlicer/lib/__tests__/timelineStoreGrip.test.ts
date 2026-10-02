//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineStoreGrip.test.ts
// PURPOSE: A timeline asks Core for its six-dot HOVER GRIP exactly when its
//          header is HIDDEN (BUG-0258 design phase 5): its months are content,
//          its year strip and empty space stay frame, but it has no header to
//          grab, so Core shows the grip (core/lib/floatingGrip.ts) while it is
//          hovered or selected -- on a region that publishes `grip: "hover"`.
//          A timeline WITH its header publishes no grip flag.
// CONTEXT: The timelineResizeGate.test.ts harness: the real store and the real
//          published region list; only the backend is a double.

import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = vi.hoisted(() => ({ headers: { t1: true, t2: false } as Record<string, boolean> }));

vi.mock("@api/ui", () => ({ registerPanel: vi.fn(), unregisterPanel: vi.fn() }));
vi.mock("@api", () => ({ addTaskPaneContextKey: vi.fn(), removeTaskPaneContextKey: vi.fn() }));
vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("../../manifest", () => ({
  TIMELINE_OPTIONS_TAB_ID: "timeline-options",
  TimelineOptionsPanelDefinition: { id: "timeline-options", title: "Timeline" },
}));
vi.mock("../timeline-slicer-api", () => ({
  getAllTimelineSlicers: async () =>
    Object.entries(backend.headers).map(([id, showHeader], i) => ({
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
      showHeader,
      connectedPivotIds: [],
    })),
  getTimelineData: async () => ({ periods: [] }),
}));

import { getGridRegions, setGridRegions } from "@api/gridOverlays";
import * as store from "../timelineSlicerStore";

const dataOf = (id: string) => getGridRegions().find((r) => r.id === `timeline-slicer-${id}`)?.data;

beforeEach(() => {
  setGridRegions([]);
  store.resetStore();
  backend.headers = { t1: true, t2: false };
});

describe("a timeline's grip flag follows its header", () => {
  it("header SHOWN: no grip flag; header HIDDEN: grip 'hover'", async () => {
    await store.refreshCache();
    expect(dataOf("t1"), "precondition: t1 is published").toBeDefined();
    expect(dataOf("t1"), "a timeline WITH its header asks for a grip").not.toHaveProperty("grip");
    expect(dataOf("t2")).toMatchObject({ timelineId: "t2", grip: "hover" });
  });

  it("re-published when the header is toggled", async () => {
    await store.refreshCache();
    backend.headers = { t1: false, t2: true };
    await store.refreshCache();
    expect(dataOf("t1")?.grip).toBe("hover");
    expect(dataOf("t2")).not.toHaveProperty("grip");
  });
});
