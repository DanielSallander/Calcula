//! FILENAME: app/extensions/MacroRecorder/__tests__/sortCapture.test.ts
// PURPOSE: Prove the SORT FAMILY reaches the macro recorder's bridge hook.
// CONTEXT: sortRange / sortRangeByColumn / removeDuplicates are the only
//          workbook mutations that invoke Tauri from the facade
//          (app/src/api/backend.ts) instead of from core/lib/tauri-api.ts. That
//          split is exactly how they came to be missing from recordings: the
//          recorder observes ONE hook, and these three calls were not reporting
//          to it. A recorded macro that replays the writes around a sort but
//          not the sort itself runs cleanly and leaves the data in the wrong
//          order — a silent incompleteness, the worst failure a record-and-
//          replay tool can have. These tests pin the wiring at the real bridge
//          functions, with only Tauri's `invoke` replaced.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Hoisted by vitest: the factory must not close over test locals.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import {
  removeDuplicates,
  setGridRecorderHook,
  sortRange,
  sortRangeByColumn,
} from "@api/lib";
import type { RecordedGridEvent } from "@api/lib";

interface SortResultLike {
  success: boolean;
  error: string | null;
}

let recorded: RecordedGridEvent[];

beforeEach(() => {
  recorded = [];
  invokeMock.mockReset();
  setGridRecorderHook((event) => {
    recorded.push(event);
  });
});

afterEach(() => {
  setGridRecorderHook(null);
});

/** Every `invoke` resolves to a success-shaped result. */
function backendSucceeds(): void {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "remove_duplicates") {
      return {
        success: true,
        duplicatesRemoved: 2,
        uniqueRemaining: 8,
        updatedCells: [],
        error: null,
      };
    }
    return { success: true, error: null, updatedCells: [] };
  });
}

// ============================================================================

describe("sortRange capture", () => {
  it("reports the rectangle, criteria and options the backend received", async () => {
    backendSucceeds();
    await sortRange<SortResultLike>(0, 0, 9, 2, [{ key: 1, ascending: false }], {
      matchCase: true,
      hasHeaders: true,
      orientation: "columns",
    });

    expect(recorded).toEqual([
      {
        kind: "sort",
        startRow: 0,
        startCol: 0,
        endRow: 9,
        endCol: 2,
        fields: [{ key: 1, ascending: false }],
        matchCase: true,
        hasHeaders: true,
        orientation: "columns",
      },
    ]);
  });

  it("records the same defaults it sent to the backend when options are omitted", async () => {
    backendSucceeds();
    await sortRange<SortResultLike>(2, 1, 5, 4, [{ key: 0 }]);

    const sent = invokeMock.mock.calls[0][1] as {
      params: { matchCase: boolean; hasHeaders: boolean; orientation: string };
    };
    expect(recorded[0]).toMatchObject({
      kind: "sort",
      matchCase: sent.params.matchCase,
      hasHeaders: sent.params.hasHeaders,
      orientation: sent.params.orientation,
    });
  });

  it("does not alias the caller's field array", async () => {
    backendSucceeds();
    const fields = [{ key: 1, ascending: true }];
    await sortRange<SortResultLike>(0, 0, 3, 3, fields);

    // The Sorting dialog reuses its criteria array between sorts; aliasing it
    // would retroactively rewrite an already-recorded action.
    fields[0].ascending = false;
    expect((recorded[0] as Extract<RecordedGridEvent, { kind: "sort" }>).fields).toEqual([
      { key: 1, ascending: true },
    ]);
  });

  it("does not record a sort the backend refused", async () => {
    invokeMock.mockResolvedValue({ success: false, error: "range is protected" });
    await sortRange<SortResultLike>(0, 0, 9, 2, [{ key: 0 }]);
    expect(recorded).toEqual([]);
  });

  it("does not record a sort that threw", async () => {
    invokeMock.mockRejectedValue("sheet is protected");
    await expect(sortRange<SortResultLike>(0, 0, 9, 2, [{ key: 0 }])).rejects.toBeTruthy();
    expect(recorded).toEqual([]);
  });
});

describe("sortRangeByColumn capture", () => {
  it("records exactly one sort, with the RANGE-RELATIVE key", async () => {
    backendSucceeds();
    // Sorting C5:F20 by column E => key 2 (E is the third column of the range).
    await sortRangeByColumn<SortResultLike>(4, 2, 19, 5, 4, false, true);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      kind: "sort",
      startRow: 4,
      startCol: 2,
      endRow: 19,
      endCol: 5,
      fields: [{ key: 2, ascending: false }],
      matchCase: false,
      hasHeaders: true,
      orientation: "rows",
    });
  });
});

describe("removeDuplicates capture", () => {
  it("reports the range, key columns and header flag", async () => {
    backendSucceeds();
    await removeDuplicates(0, 0, 99, 4, [0, 2], true);

    expect(recorded).toEqual([
      {
        kind: "removeDuplicates",
        startRow: 0,
        startCol: 0,
        endRow: 99,
        endCol: 4,
        keyColumns: [0, 2],
        hasHeaders: true,
      },
    ]);
  });

  it("does not record a refused remove-duplicates", async () => {
    invokeMock.mockResolvedValue({
      success: false,
      duplicatesRemoved: 0,
      uniqueRemaining: 0,
      updatedCells: [],
      error: "range is protected",
    });
    await removeDuplicates(0, 0, 9, 1, [0], false);
    expect(recorded).toEqual([]);
  });
});

describe("no recorder installed", () => {
  it("leaves the operation untouched", async () => {
    backendSucceeds();
    setGridRecorderHook(null);
    const result = await sortRange<SortResultLike>(0, 0, 1, 1, [{ key: 0 }]);
    expect(result.success).toBe(true);
    expect(recorded).toEqual([]);
  });
});
