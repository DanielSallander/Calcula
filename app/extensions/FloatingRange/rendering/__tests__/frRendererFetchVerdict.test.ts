//! FILENAME: app/extensions/FloatingRange/rendering/__tests__/frRendererFetchVerdict.test.ts
// PURPOSE: Pin the DEFERRED VERDICT on a failed floating-range cell fetch.
//
// CONTEXT (BUG-0057). Backend-initiated deletes — the @api wrapper, a
// script's `api.deleteFloatingRange` — announce first and the extension's
// store prunes in an ASYNC reload, so an overlay redraw inside that window
// renders (and fetches) a row the backend has already dropped. The old catch
// logged `console.error` unconditionally, which (a) spammed a benign race and
// (b) tripped the walker's no-console-errors invariant on its first fr.delete.
// The fix defers the verdict instead of softening it: a row that is GONE from
// the store by verdict time lost a delete race and stays silent; a row STILL
// in the store is a real store/backend inconsistency and stays loud — that
// loud path is exactly how BUG-0056 (the stale-store session poison) was
// caught, and it must not be weakened.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  getFloatingRangeCells: vi.fn(async () => {
    throw new Error("No floating range with id fr-x");
  }),
  updateFloatingRange: vi.fn(async () => ({})),
}));

vi.mock("../../editor/frEditor", () => ({
  layoutFrEditorForFrame: vi.fn(),
}));

import { fetchFrCells } from "../frRenderer";
import {
  fromInfo,
  upsertFromInfo,
  resetFloatingRangeStore,
} from "../../lib/floatingRangeStore";
import type { FloatingRangeInfo } from "@api/floatingRanges";

function info(id: string): FloatingRangeInfo {
  return {
    id,
    backingSheetId: "backing",
    hostSheetId: "host",
    x: 100,
    y: 50,
    rotation: 0,
    pinToGrid: false,
    rowCount: 2,
    colCount: 2,
    colWidths: {},
    rowHeights: {},
    name: "Float1",
    backingSheetIndex: 1,
    hostSheetIndex: 0,
  };
}

describe("frRenderer: the failed-fetch verdict is deferred, not softened", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFloatingRangeStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetFloatingRangeStore();
    vi.restoreAllMocks();
  });

  it("stays SILENT when the row lost a delete race (gone from the store)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The row is rendered from a store snapshot but NEVER (re)enters the
    // store — the reload pruned it while the fetch was in flight.
    const entry = fromInfo(info("fr-x"));
    await fetchFrCells(entry);

    expect(errorSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(
      errorSpy,
      "a fetch that lost the delete race must not scream"
    ).not.toHaveBeenCalled();
  });

  it("stays LOUD when the row is still in the store (real inconsistency)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const entry = upsertFromInfo(info("fr-x")); // still present at verdict time
    await fetchFrCells(entry);

    expect(errorSpy, "the verdict is deferred").not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(
      errorSpy,
      "a persistent store/backend inconsistency must keep failing walks — " +
        "this is the line that caught BUG-0056"
    ).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("fr-x");
  });
});
