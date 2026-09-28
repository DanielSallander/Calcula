//! FILENAME: app/extensions/Pivot/components/PivotGrid/__tests__/pivotGridReportFilter.test.tsx
// PURPOSE: The React pivot grid's report-filter dropdown filters one field and
//          leaves the other report filters alone (review3 finding 2) -- the
//          same defect, and the same fix, as the sheet's report-filter dropdown
//          (handlers/__tests__/reportFilterDropdown.test.ts): a one-entry
//          `update_pivot_fields` REPLACED the whole filter zone.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PivotViewResponse } from "@api/pivot";

vi.mock("@api/pivot", () => ({
  pivot: {
    applyFilter: vi.fn(() => Promise.resolve({})),
    clearFilter: vi.fn(() => Promise.resolve({})),
    updateFields: vi.fn(() => Promise.resolve({})),
  },
}));

import { pivot } from "@api/pivot";
import { usePivotGridInteraction, type UsePivotGridInteractionResult } from "../usePivotGridInteraction";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const view = {
  filterRows: [
    { fieldIndex: 3, fieldName: "Region" },
    { fieldIndex: 4, fieldName: "Channel" },
  ],
} as unknown as PivotViewResponse;

let hook: UsePivotGridInteractionResult | null = null;
function Harness(): null {
  hook = usePivotGridInteraction({
    pivotId: "p1",
    pivotView: view,
    eventTargetRef: { current: null },
    interactiveBounds: null,
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  hook = null;
  vi.mocked(pivot.applyFilter).mockClear();
  vi.mocked(pivot.clearFilter).mockClear();
  vi.mocked(pivot.updateFields).mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the pivot grid's report-filter dropdown", () => {
  it("a narrowed selection filters that field only (apply_pivot_filter), never the whole zone", async () => {
    await act(async () => hook!.handleApplyFilter(3, ["East"], ["West"]));
    expect(pivot.updateFields).not.toHaveBeenCalled();
    expect(pivot.applyFilter).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 3,
      filters: { manualFilter: { selectedItems: ["East"] } },
    });
  });

  it("selecting every item clears that field only (clear_pivot_filter)", async () => {
    await act(async () => hook!.handleApplyFilter(3, ["East", "West"], []));
    expect(pivot.updateFields).not.toHaveBeenCalled();
    expect(pivot.clearFilter).toHaveBeenCalledWith({ pivotId: "p1", fieldIndex: 3 });
  });
});
