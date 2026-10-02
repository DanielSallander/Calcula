//! FILENAME: app/src/core/lib/__tests__/mergeRecording.test.ts
// PURPOSE: What the macro recorder sees from the merge wrappers. A macro must
//          replay what the merge DID, region by region: a probe records
//          nothing; absorbed merges are taken apart first; Merge Across over N
//          rows records N merges; a range unmerge records one unmerge per
//          region. The new arguments reach the backend under their camelCase
//          names, and a plain call sends exactly what it always did.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  getMergedRegions,
  mergeCells,
  setGridRecorderHook,
  unmergeCells,
  type RecordedGridEvent,
} from "../tauri-api";

const recorded: RecordedGridEvent[] = [];

beforeEach(() => {
  invoke.mockReset();
  recorded.length = 0;
  setGridRecorderHook((e) => recorded.push(e));
});

afterEach(() => {
  setGridRecorderHook(null);
});

const region = (startRow: number, startCol: number, endRow: number, endCol: number) => ({
  startRow,
  startCol,
  endRow,
  endCol,
});

describe("merge recording", () => {
  it("a plain merge sends no options and records the region it created", async () => {
    invoke.mockResolvedValue({ success: true, createdRegions: [region(0, 0, 1, 1)], removedRegions: [] });
    await mergeCells(0, 0, 1, 1);
    expect(invoke).toHaveBeenCalledWith("merge_cells", {
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
      sheetIndex: null,
      options: null,
    });
    expect(recorded).toEqual([{ kind: "mergeCells", startRow: 0, startCol: 0, endRow: 1, endCol: 1 }]);
  });

  it("a probe records nothing", async () => {
    invoke.mockResolvedValue({ success: true, createdRegions: [region(0, 0, 0, 2)], removedRegions: [], lossyRegions: 1 });
    await mergeCells(0, 0, 0, 2, undefined, { probe: true, absorb: true });
    expect(invoke.mock.calls[0][1]).toMatchObject({ options: { probe: true, absorb: true } });
    expect(recorded).toEqual([]);
  });

  it("Merge Across records one merge per row; absorbed merges are unmerged first", async () => {
    invoke.mockResolvedValue({
      success: true,
      removedRegions: [region(0, 0, 1, 0)],
      createdRegions: [region(0, 0, 0, 2), region(1, 0, 1, 2)],
    });
    await mergeCells(0, 0, 1, 2, undefined, { across: true, absorb: true });
    expect(recorded).toEqual([
      { kind: "unmergeCells", row: 0, col: 0 },
      { kind: "mergeCells", startRow: 0, startCol: 0, endRow: 0, endCol: 2 },
      { kind: "mergeCells", startRow: 1, startCol: 0, endRow: 1, endCol: 2 },
    ]);
  });

  it("a merge that did nothing records nothing", async () => {
    invoke.mockResolvedValue({ success: false, createdRegions: [], removedRegions: [] });
    await mergeCells(3, 3, 3, 3);
    expect(recorded).toEqual([]);
  });

  it("a range unmerge sends the end corner and records one unmerge per region", async () => {
    invoke.mockResolvedValue({ success: true, removedRegions: [region(0, 0, 0, 1), region(4, 2, 5, 3)] });
    await unmergeCells(0, 0, undefined, { endRow: 9, endCol: 9 });
    expect(invoke).toHaveBeenCalledWith("unmerge_cells", { row: 0, col: 0, sheetIndex: null, endRow: 9, endCol: 9 });
    expect(recorded).toEqual([
      { kind: "unmergeCells", row: 0, col: 0 },
      { kind: "unmergeCells", row: 4, col: 2 },
    ]);
  });

  it("the single-cell unmerge sends no end corner", async () => {
    invoke.mockResolvedValue({ success: true, removedRegions: [region(2, 2, 3, 3)] });
    await unmergeCells(3, 3);
    expect(invoke).toHaveBeenCalledWith("unmerge_cells", { row: 3, col: 3, sheetIndex: null, endRow: null, endCol: null });
  });

  it("the merged-regions read is filtered only when a range is given", async () => {
    invoke.mockResolvedValue([]);
    await getMergedRegions();
    expect(invoke).toHaveBeenLastCalledWith("get_merged_regions");
    await getMergedRegions({ startRow: 5, startCol: 4, endRow: 1, endCol: 0 });
    expect(invoke).toHaveBeenLastCalledWith("get_merged_regions", { startRow: 1, startCol: 0, endRow: 5, endCol: 4 });
  });
});
