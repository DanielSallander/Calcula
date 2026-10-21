//! FILENAME: app/src/core/lib/merge/__tests__/mergeGesturesTarget.test.ts
// PURPOSE: The Merge gesture on a floating grid's cells (P3 S10, owner finding
//          G3): every probe, merge, unmerge and alignment names the target;
//          the merges it reads are the object's (its styled read), never the
//          active sheet's; the value rule is the sheet's own (ruling Q4: one
//          behaviour, so keepFirstValue stays on); relocateCellReferences --
//          an active-sheet command -- never runs; and the gesture is ONE undo
//          step, as on a sheet.

import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  applyFormatting: vi.fn(),
  beginUndoTransaction: vi.fn(),
  cancelUndoTransaction: vi.fn(),
  commitUndoTransaction: vi.fn(),
  getMergedRegions: vi.fn(),
  isActiveSheetProtected: vi.fn(),
  mergeCells: vi.fn(),
  relocateCellReferences: vi.fn(),
  unmergeCells: vi.fn(),
}));
const target = vi.hoisted(() => ({ getCellTargetCells: vi.fn() }));
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(), confirmAsync: vi.fn() }));
const emit = vi.hoisted(() => vi.fn());

vi.mock("../../tauri-api", () => api);
vi.mock("../../../../api/cellTarget", () => target);
vi.mock("../../dialogs", () => dialogs);
vi.mock("../../cellEvents", () => ({ cellEvents: { emit } }));

import type { CellTargetRef, MergeResult, Selection } from "../../../types";
import { runMergeGesture } from "../mergeGestures";
import { MERGE_DISCARDS_VALUES } from "../mergeText";

const REF: CellTargetRef = { kind: "floatingRange", id: "fr-1" };

function sel(startRow: number, startCol: number, endRow: number, endCol: number): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells" };
}

function result(partial: Partial<MergeResult> = {}): MergeResult {
  return {
    success: true,
    mergedRegions: [],
    updatedCells: [],
    createdRegions: [],
    removedRegions: [],
    lossyRegions: 0,
    movedCells: [],
    ...partial,
  };
}

const refresh = vi.fn();

function targetHost(selection: Selection) {
  return { selection, target: REF, refresh };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  target.getCellTargetCells.mockReset();
  dialogs.alertAsync.mockReset();
  dialogs.confirmAsync.mockReset();
  emit.mockReset();
  refresh.mockReset();
  api.isActiveSheetProtected.mockResolvedValue(false);
  api.getMergedRegions.mockResolvedValue([]);
  api.beginUndoTransaction.mockResolvedValue(7);
  api.commitUndoTransaction.mockResolvedValue(undefined);
  api.cancelUndoTransaction.mockResolvedValue(undefined);
  api.applyFormatting.mockResolvedValue({ cells: [], styles: [] });
  api.relocateCellReferences.mockResolvedValue([]);
  target.getCellTargetCells.mockResolvedValue({ cells: [], merges: [], conditional: [], styles: [], rules: [] });
  dialogs.alertAsync.mockReturnValue(Promise.resolve());
  refresh.mockResolvedValue(undefined);
});

describe("Merge & Center on a floating grid's cells", () => {
  it("probes and merges WITH the target, keeps the sheet's value rule, centres with the target, one step", async () => {
    // The probe says values would be discarded and a value was moved into the
    // top-left cell by the value rule.
    api.mergeCells.mockImplementation(async (_sr, _sc, _er, _ec, _s, o: { probe?: boolean }) =>
      o?.probe
        ? result({ lossyRegions: 1 })
        : result({ movedCells: [{ fromRow: 2, fromCol: 2, toRow: 1, toCol: 1 }] as never }),
    );
    dialogs.confirmAsync.mockResolvedValue(true);

    await runMergeGesture("mergeCenter", targetHost(sel(1, 1, 2, 2)));

    // The merges read are the OBJECT's, never the active sheet's.
    expect(target.getCellTargetCells).toHaveBeenCalledWith(REF, { startRow: 1, startCol: 1, endRow: 2, endCol: 2 });
    expect(api.getMergedRegions, "read the ACTIVE sheet's merges for a floating grid").not.toHaveBeenCalled();

    const calls = api.mergeCells.mock.calls;
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.slice(0, 4)).toEqual([1, 1, 2, 2]);
      expect(c[4], "a target never names a sheet").toBeUndefined();
      expect(c[6], "a merge call dropped the target").toEqual({ target: REF });
      // Ruling Q4: the SAME value rule as a sheet's merge.
      expect((c[5] as { keepFirstValue?: boolean }).keepFirstValue).toBe(true);
    }
    expect((calls[0][5] as { probe?: boolean }).probe).toBe(true);
    expect(dialogs.confirmAsync).toHaveBeenCalledWith(MERGE_DISCARDS_VALUES, expect.anything());

    // relocateCellReferences is an ACTIVE-sheet command: never for a target.
    expect(api.relocateCellReferences).not.toHaveBeenCalled();

    // The alignment names the target too.
    expect(api.applyFormatting).toHaveBeenCalledTimes(1);
    expect(api.applyFormatting.mock.calls[0][2]).toEqual({ textAlign: "center" });
    expect(api.applyFormatting.mock.calls[0][3]).toEqual({ target: REF });

    // ONE undo step, and no active-sheet cell event (its (row, col) would alias the host).
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.commitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("Cancel on the warning changes nothing on the floating grid", async () => {
    api.mergeCells.mockResolvedValue(result({ lossyRegions: 1 }));
    dialogs.confirmAsync.mockResolvedValue(false);
    await runMergeGesture("mergeCells", targetHost(sel(0, 0, 1, 1)));
    expect(api.mergeCells).toHaveBeenCalledTimes(1);
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("the toggle UNMERGES the object's merges (range form, with the target) and resets their alignment", async () => {
    target.getCellTargetCells.mockResolvedValue({
      cells: [],
      merges: [{ startRow: 1, startCol: 1, endRow: 1, endCol: 3 }],
      conditional: [],
      styles: [],
      rules: [],
    });
    api.unmergeCells.mockResolvedValue(result({ removedRegions: [{ startRow: 1, startCol: 1, endRow: 1, endCol: 3 }] }));

    await runMergeGesture("mergeCenter", targetHost(sel(1, 1, 1, 3)));

    expect(api.unmergeCells).toHaveBeenCalledWith(1, 1, undefined, { endRow: 1, endCol: 3 }, { target: REF });
    expect(api.mergeCells).not.toHaveBeenCalled();
    expect(api.applyFormatting).toHaveBeenCalledWith([1], [1, 2, 3], { textAlign: "general" }, { target: REF });
  });

  it("positive control: the SHEET gesture is unchanged -- active merges, no target, relocation runs", async () => {
    api.mergeCells.mockImplementation(async (_sr, _sc, _er, _ec, _s, o: { probe?: boolean }) =>
      o?.probe ? result() : result({ movedCells: [{ fromRow: 2, fromCol: 2, toRow: 1, toCol: 1 }] as never }),
    );
    await runMergeGesture("mergeCells", { selection: sel(1, 1, 2, 2), refresh });
    expect(api.getMergedRegions).toHaveBeenCalled();
    expect(target.getCellTargetCells).not.toHaveBeenCalled();
    for (const c of api.mergeCells.mock.calls) expect(c).toHaveLength(6);
    expect(api.relocateCellReferences).toHaveBeenCalledWith(2, 2, 2, 2, 1, 1);
  });
});
