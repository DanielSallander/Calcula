//! FILENAME: app/extensions/AutoFilter/__tests__/autoFilterSelectionOwner.test.ts
// PURPOSE: Turning AutoFilter ON (Data > Filter, the autofilter.toggle command
//          Ctrl+Shift+L runs) refuses with ONE toast and creates nothing while
//          a selection owner holds the selection; turning an existing filter
//          OFF is not refused (it is the sheet's filter, not the selection's);
//          both work when nothing owns the selection.
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). Creating a filter builds it
//          from Core's selection (or the data region around its active cell),
//          which is HIDDEN under a floating grid while that grid's cell is
//          selected. TEST owner (@api/selectionOwner).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  applyAutoFilter: vi.fn(async () => ({ success: false })),
  removeAutoFilter: vi.fn(async () => ({ success: true })),
  detectDataRegion: vi.fn(async () => [0, 0, 5, 3] as [number, number, number, number]),
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  applyAutoFilter: (...a: unknown[]) => h.applyAutoFilter(...(a as [])),
  removeAutoFilter: (...a: unknown[]) => h.removeAutoFilter(...(a as [])),
  detectDataRegion: (...a: unknown[]) => h.detectDataRegion(...(a as [])),
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  setHiddenRows: vi.fn(),
  dispatchGridAction: vi.fn(),
}));

import { toggleFilter, setCurrentSelection, resetState, isFilterActive } from "../lib/filterStore";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  setCurrentSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" });
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
  resetState();
});

describe("AutoFilter while a selection owner holds the selection", () => {
  it("turning the filter ON reads and filters nothing from Core's hidden selection; one toast", async () => {
    owns = true;
    await toggleFilter();
    expect(h.detectDataRegion).not.toHaveBeenCalled();
    expect(h.applyAutoFilter, "a filter was built from Core's hidden selection").not.toHaveBeenCalled();
    expect(refusals().length).toBe(1);
  });

  it("turning an existing filter OFF is not refused (the sheet's filter, not the selection)", async () => {
    h.applyAutoFilter.mockResolvedValueOnce({
      success: true,
      autoFilter: { startRow: 0, startCol: 0, endRow: 5, endCol: 3, enabled: true, criteria: [] },
      hiddenRows: [],
    } as never);
    await toggleFilter();
    expect(isFilterActive()).toBe(true);
    owns = true;
    await toggleFilter();
    expect(h.removeAutoFilter).toHaveBeenCalledTimes(1);
    expect(refusals()).toEqual([]);
  });
});

describe("positive control: nothing owns the selection", () => {
  it("turning the filter ON builds it from the data region around Core's active cell", async () => {
    await toggleFilter();
    expect(h.detectDataRegion).toHaveBeenCalledWith(2, 1);
    expect(h.applyAutoFilter).toHaveBeenCalledWith(0, 0, 5, 3);
    expect(refusals()).toEqual([]);
  });
});
