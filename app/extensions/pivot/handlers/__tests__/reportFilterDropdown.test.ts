//! FILENAME: app/extensions/Pivot/handlers/__tests__/reportFilterDropdown.test.ts
// PURPOSE: A report filter's dropdown filters THAT field and leaves the pivot's
//          other report filters alone (review3 finding 2).
//
//          It used to send `update_pivot_fields` with a one-entry filterFields
//          list. That command REPLACES the whole zone
//          (`definition.filter_fields = filter_configs...`, pivot/commands.rs),
//          so a pivot with two report filters lost the other one -- and its
//          filter -- the moment the user filtered the first. The dropdown now
//          goes through apply_pivot_filter / clear_pivot_filter, which patch one
//          field by its cache index and keep every other field.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  onApply: null as ((fieldIndex: number, selected: string[], hidden: string[]) => Promise<void>) | null,
  emitted: [] as Array<{ event: string; detail: unknown }>,
}));

vi.mock("@api/pivot", () => ({
  pivot: {
    getAtCell: vi.fn(() => Promise.resolve({ pivotId: "p1" })),
    getFieldUniqueValues: vi.fn(() => Promise.resolve({ uniqueValues: ["East", "West", "North"] })),
    applyFilter: vi.fn(() => Promise.resolve({})),
    clearFilter: vi.fn(() => Promise.resolve({})),
    updateFields: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock("@api", () => ({
  OverlayExtensions: {
    showOverlay: (_id: string, opts: { data: { onApply: typeof h.onApply } }) => {
      h.onApply = opts.data.onApply;
    },
    hideOverlay: vi.fn(),
  },
  emitAppEvent: (event: string, detail: unknown) => h.emitted.push({ event, detail }),
}));
vi.mock("../../manifest", () => ({ PIVOT_FILTER_OVERLAY_ID: "pivot-filter-overlay" }));
vi.mock("../../lib/pivotViewStore", () => ({ getCachedPivotView: () => undefined }));

import { pivot } from "@api/pivot";
import { handleOpenFilterMenu } from "../filterMenuHandler";

async function openRegionFilter(): Promise<void> {
  await handleOpenFilterMenu({
    fieldIndex: 3,
    fieldName: "Region",
    row: 0,
    col: 1,
    anchorX: 10,
    anchorY: 20,
    pivotId: "p1",
  });
  expect(h.onApply).not.toBeNull();
}

beforeEach(() => {
  h.onApply = null;
  h.emitted = [];
  vi.mocked(pivot.applyFilter).mockClear();
  vi.mocked(pivot.clearFilter).mockClear();
  vi.mocked(pivot.updateFields).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("the report-filter dropdown filters one field, never the whole zone", () => {
  it("a narrowed selection is an apply_pivot_filter on that field -- no update_pivot_fields", async () => {
    await openRegionFilter();
    await h.onApply!(3, ["East"], ["West", "North"]);

    expect(pivot.updateFields).not.toHaveBeenCalled();
    expect(pivot.applyFilter).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 3,
      filters: { manualFilter: { selectedItems: ["East"] } },
    });
    // The field pane still hears about it (and learns the item list).
    expect(h.emitted.find((e) => e.event === "app:pivot-filter-applied")?.detail).toMatchObject({
      pivotId: "p1",
      fieldIndex: 3,
      hiddenItems: ["West", "North"],
    });
  });

  it("selecting every item is a clear_pivot_filter on that field", async () => {
    await openRegionFilter();
    await h.onApply!(3, ["East", "West", "North"], []);

    expect(pivot.updateFields).not.toHaveBeenCalled();
    expect(pivot.applyFilter).not.toHaveBeenCalled();
    expect(pivot.clearFilter).toHaveBeenCalledWith({ pivotId: "p1", fieldIndex: 3 });
  });
});
