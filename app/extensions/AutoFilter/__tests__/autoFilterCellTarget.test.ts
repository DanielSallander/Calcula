//! FILENAME: app/extensions/AutoFilter/__tests__/autoFilterCellTarget.test.ts
// PURPOSE: Turning AutoFilter ON over a floating grid's cells is REFUSED with
//          the 1.3 sentence (P3 S11, spec 1.3): the door asks the cell-target
//          question with capability "filter", which no owner admits -- even an
//          owner that admits every other kind -- so the owner explains why,
//          once, and no filter is built. Turning an existing sheet filter OFF
//          is still not refused (W18).
// CONTEXT: The selection owner is REAL (@api/selectionOwner), shaped like the
//          floating grid's after S8.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  applyAutoFilter: vi.fn(),
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
import {
  registerSelectionOwner,
  CELL_TARGET_CAPABILITIES,
  type CellTargetCapability,
} from "@api/selectionOwner";
import { registerToastSink } from "@api/notifications";

const FILTER_SENTENCE =
  "Filter is not available inside a floating grid: a floating grid is already a table-like object. Nothing was changed.";

const toasts: string[] = [];
let owns = true;
let calls: Array<[string, CellTargetCapability | undefined]> = [];
let release: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  toasts.length = 0;
  calls = [];
  owns = true;
  registerToastSink((t) => toasts.push(t.message));
  setCurrentSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" });
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => owns,
    actsOn: CELL_TARGET_CAPABILITIES.filter((c) => c !== "table" && c !== "filter" && c !== "shiftCells"),
    refusal: (action, capability) => {
      calls.push([action, capability]);
      return capability === "filter"
        ? FILTER_SENTENCE
        : `${action} is not available inside a floating grid yet. Nothing was changed.`;
    },
    cellTarget: () => ({
      ref: { kind: "floatingRange", id: "fr-1" },
      selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells", activeRow: 0, activeCol: 0 },
      bounds: { rows: 5, cols: 5 },
      label: "Float1",
      wholeObject: false,
    }),
  });
});
afterEach(() => {
  release();
  resetState();
});

describe("AutoFilter on a floating grid's cells", () => {
  it("turning the filter ON asks for \"filter\" and refuses with the 1.3 sentence; nothing built", async () => {
    await toggleFilter();
    expect(calls).toEqual([["Filter", "filter"]]);
    expect(toasts).toEqual([FILTER_SENTENCE]);
    expect(h.detectDataRegion).not.toHaveBeenCalled();
    expect(h.applyAutoFilter).not.toHaveBeenCalled();
  });

  it("an existing sheet filter can still be turned OFF (W18)", async () => {
    owns = false;
    h.applyAutoFilter.mockResolvedValueOnce({
      success: true,
      autoFilter: { startRow: 0, startCol: 0, endRow: 5, endCol: 3, enabled: true, criteria: [] },
      hiddenRows: [],
    });
    await toggleFilter();
    expect(isFilterActive()).toBe(true);
    owns = true;
    await toggleFilter();
    expect(h.removeAutoFilter).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });
});
