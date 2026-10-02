//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineStoreDataChanged.test.ts
// PURPOSE: The timeline store says when what it holds CHANGED -- the timeline
//          list (where a timeline's LEVEL lives) or a timeline's periods -- by
//          `TimelineSlicerEvents.TIMELINE_DATA_CHANGED`, fired AFTER the cache
//          holds the new state. The keyboard inside a timeline
//          (lib/timelineKeys.ts) listens, so a level change or a refresh that
//          removes the focused period ends the focus at once -- announced --
//          instead of silently at the next key, when ownsKey still claimed the
//          arrow and a canvas lost it (M8 review, findings 4 and 9).
// CONTEXT: Driven through the real store; only the backend is a double (the
//          timelineStoreGrip.test.ts harness).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const backend = vi.hoisted(() => ({
  level: "months",
  periods: [] as Array<Record<string, unknown>>,
  /** Reading a timeline's periods fails. */
  failData: false,
}));

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
  getAllTimelineSlicers: async () => [
    {
      id: "t1",
      name: "Timeline t1",
      sheetIndex: 0,
      x: 10,
      y: 10,
      width: 420,
      height: 140,
      sourceType: "pivot",
      sourceId: "pivot-1",
      fieldName: "Date",
      level: backend.level,
      showHeader: true,
      connectedPivotIds: [],
    },
  ],
  getTimelineData: async () => {
    if (backend.failData) throw new Error("periods unavailable");
    return { periods: backend.periods };
  },
}));

import * as store from "../timelineSlicerStore";
import { TimelineSlicerEvents } from "../timelineSlicerEvents";

/** What the store held at each TIMELINE_DATA_CHANGED: t1's level and its period labels. */
let seen: Array<{ level: string | null; periods: string[] | null }> = [];
const onChanged = (): void => {
  seen.push({
    level: store.getTimelineById("t1")?.level ?? null,
    periods: (store.getCachedTimelineData("t1")?.periods as Array<{ label: string }> | undefined)?.map((p) => p.label) ?? null,
  });
};

const period = (label: string) => ({ label, groupLabel: "2026", startDate: "", endDate: "", hasData: true, isSelected: false });

beforeEach(() => {
  store.resetStore();
  backend.level = "months";
  backend.periods = [period("Jan"), period("Feb")];
  backend.failData = false;
  seen = [];
  window.addEventListener(TimelineSlicerEvents.TIMELINE_DATA_CHANGED, onChanged);
});

afterEach(() => {
  window.removeEventListener(TimelineSlicerEvents.TIMELINE_DATA_CHANGED, onChanged);
  vi.restoreAllMocks();
});

describe("the timeline store announces every change of what it holds", () => {
  it("a re-read of a timeline's PERIODS fires once, after the cache holds them", async () => {
    await store.refreshCache();
    seen = [];
    backend.periods = [period("Feb")];
    await store.refreshTimelineData("t1");
    expect(seen, "the periods changed and nobody was told: a keyboard focus on one goes stale silently").toEqual([
      { level: "months", periods: ["Feb"] },
    ]);
  });

  it("a re-read of the timeline LIST (a level change: an undo, a script, the ribbon) fires with the new level already in place", async () => {
    await store.refreshCache();
    seen = [];
    backend.level = "quarters";
    backend.periods = [period("Q1")];
    await store.refreshCache();
    expect(seen.length, "a level change fired nothing").toBeGreaterThan(0);
    expect(seen[0].level, "the event fired BEFORE the cache held the new level").toBe("quarters");
    expect(seen[seen.length - 1]).toEqual({ level: "quarters", periods: ["Q1"] });
  });

  it("a LEVEL change is announced by the list re-read itself: even when reading the new periods FAILS", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await store.refreshCache();
    seen = [];
    backend.level = "quarters";
    backend.failData = true;
    await store.refreshCache();
    expect(seen, "the level changed and nobody was told (only a periods read announced, and it failed)").toEqual([
      { level: "quarters", periods: ["Jan", "Feb"] },
    ]);
  });

  it("resetting the store (a new document) fires too", () => {
    store.resetStore();
    expect(seen).toEqual([{ level: null, periods: null }]);
  });
});
