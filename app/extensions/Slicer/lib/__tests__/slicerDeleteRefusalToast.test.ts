//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerDeleteRefusalToast.test.ts
// PURPOSE: A slicer's own Delete doors (the context menu, the Slicer tab's
//          Delete) TELL the user when the backend refuses the delete (a sheet
//          protected against object edits: `delete_slicer`'s `editObjects`
//          gate). `deleteSlicerAsync` only logged the refusal, so the menu item
//          did nothing, silently -- the same door the timeline has (wave C).
// CONTEXT: The canvas-wide Delete (`deleteSlicersReporting`, the seam's
//          `deleteObjects`) reports its refusals through the seam, not here;
//          this is the single-slicer door.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  backend: [] as string[],
  refuse: {} as Record<string, string>,
  toasts: [] as Array<{ message: string; type?: string }>,
}));

vi.mock("@api/ui", () => ({ registerPanel: vi.fn(), unregisterPanel: vi.fn() }));
vi.mock("@api", () => ({ addTaskPaneContextKey: vi.fn(), removeTaskPaneContextKey: vi.fn() }));
vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));
vi.mock("@api/state", () => ({ getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }) }));
vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { MUTATION_REFRESH: "app:mutation-refresh" },
}));
vi.mock("@api/notifications", () => ({
  showToast: (message: string, options?: { type?: string }) => {
    h.toasts.push({ message, type: options?.type });
  },
}));
vi.mock("../slicerFilterBridge", () => ({
  applySlicerFilter: vi.fn(async () => undefined),
  listPivotSlicerItemsFromModel: vi.fn(async () => null),
  reportSlicerFilterFailures: vi.fn(),
}));
vi.mock("../../manifest", () => ({
  SLICER_OPTIONS_TAB_ID: "slicer-options",
  SlicerOptionsPanelDefinition: { id: "slicer-options", title: "Slicer" },
}));
vi.mock("../slicer-api", () => ({
  getAllSlicers: async () =>
    h.backend.map((id) => ({
      id,
      name: id,
      sheetIndex: 0,
      x: 10,
      y: 10,
      width: 180,
      height: 240,
      sourceType: "table",
      cacheSourceId: "table-1",
      fieldName: "Region",
      selectedItems: null,
      connectedSources: [],
    })),
  getSlicerItems: async () => [],
  createSlicer: vi.fn(),
  deleteSlicer: async (id: string) => {
    if (h.refuse[id]) throw new Error(h.refuse[id]);
    h.backend = h.backend.filter((s) => s !== id);
  },
  updateSlicer: vi.fn(),
  updateSlicerPosition: vi.fn(),
  updateSlicerSelection: vi.fn(),
}));

import { deleteSlicerAsync, getSlicerById, refreshCache, resetStore } from "../slicerStore";

beforeEach(async () => {
  resetStore();
  h.backend = ["s1", "s2"];
  h.refuse = {};
  h.toasts.length = 0;
  await refreshCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a single slicer delete the backend refuses", () => {
  it("tells the user why, once, and keeps the slicer", async () => {
    h.refuse = { s1: "Sheet is protected." };
    expect(await deleteSlicerAsync("s1")).toBe(false);
    expect(getSlicerById("s1"), "fixture: the refused slicer is still there").toBeDefined();
    expect(h.toasts.length, "a refused slicer Delete said nothing (only the console heard it)").toBe(1);
    expect(h.toasts[0].type).toBe("error");
    expect(h.toasts[0].message).toContain("Sheet is protected.");
  });

  it("a delete that lands says nothing", async () => {
    expect(await deleteSlicerAsync("s2")).toBe(true);
    expect(getSlicerById("s2")).toBeUndefined();
    expect(h.toasts).toEqual([]);
  });
});
