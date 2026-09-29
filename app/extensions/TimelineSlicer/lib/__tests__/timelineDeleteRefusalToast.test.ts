//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineDeleteRefusalToast.test.ts
// PURPOSE: A timeline's own Delete doors (the context menu's "Remove
//          Timeline", the Timeline tab's Delete) TELL the user when the
//          backend refuses the delete. Since wave C (W1) `delete_timeline_slicer`
//          is gated like every object delete (`editObjects`), so a protected
//          sheet refuses it -- and `deleteTimelineAsync` only logged the
//          refusal: the menu item did nothing, silently.
// CONTEXT: The canvas-wide Delete (`deleteTimelinesReporting`, the seam's
//          `deleteObjects`) reports its refusals through the seam, not here;
//          this is the single-timeline door.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  backend: [] as Array<Record<string, unknown>>,
  refuse: {} as Record<string, string>,
  toasts: [] as Array<{ message: string; type?: string }>,
}));

vi.mock("../timeline-slicer-api", () => ({
  getAllTimelineSlicers: async () => h.backend.map((t) => ({ ...t })),
  getTimelineData: async () => ({ periods: [] }),
  deleteTimelineSlicer: async (id: string) => {
    if (h.refuse[id]) throw new Error(h.refuse[id]);
    h.backend = h.backend.filter((t) => t.id !== id);
  },
}));
vi.mock("@api/state", () => ({ getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }) }));
vi.mock("@api/notifications", () => ({
  showToast: (message: string, options?: { type?: string }) => {
    h.toasts.push({ message, type: options?.type });
  },
}));

import { deleteTimelineAsync, getTimelineById, refreshCache } from "../timelineSlicerStore";

function timeline(id: string): Record<string, unknown> {
  return { id, name: `Timeline ${id}`, sheetIndex: 0, x: 0, y: 0, width: 300, height: 120, sourceId: "p1" };
}

beforeEach(async () => {
  h.backend = [timeline("t1"), timeline("t2")];
  h.refuse = {};
  h.toasts.length = 0;
  await refreshCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a single timeline delete the backend refuses", () => {
  it("tells the user why, once, and keeps the timeline", async () => {
    h.refuse = { t1: "Sheet is protected." };
    expect(await deleteTimelineAsync("t1")).toBe(false);
    expect(getTimelineById("t1"), "fixture: the refused timeline is still there").toBeDefined();
    expect(h.toasts.length, "a refused Remove Timeline said nothing (only the console heard it)").toBe(1);
    expect(h.toasts[0].type).toBe("error");
    expect(h.toasts[0].message).toContain("Sheet is protected.");
  });

  it("a delete that lands says nothing", async () => {
    expect(await deleteTimelineAsync("t2")).toBe(true);
    expect(getTimelineById("t2")).toBeUndefined();
    expect(h.toasts).toEqual([]);
  });
});
