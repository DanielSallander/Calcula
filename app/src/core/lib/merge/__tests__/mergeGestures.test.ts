//! FILENAME: app/src/core/lib/merge/__tests__/mergeGestures.test.ts
// PURPOSE: Excel's four Merge commands as gestures, against doubles of the
//          backend: the data-loss warning (Cancel changes NOTHING), the toggle,
//          Merge Across as one call and one undo step, the refusals shown to
//          the user, the value rule's re-pointing, and the alignment bound.
//
// The dialog doubles take the TAURI shape -- confirmAsync resolves a Promise --
// because a synchronous boolean double is exactly what let a never-firing
// guard pass review for so long (CLAUDE.md, the dialog globals ban).

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
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(), confirmAsync: vi.fn() }));
const emit = vi.hoisted(() => vi.fn());

vi.mock("../../tauri-api", () => api);
vi.mock("../../dialogs", () => dialogs);
vi.mock("../../cellEvents", () => ({ cellEvents: { emit } }));

import type { MergedRegion, MergeResult, Selection } from "../../../types";
import { runMergeGesture, isMergeGestureRunning } from "../mergeGestures";
import { MERGE_DISCARDS_VALUES, MERGE_ON_PROTECTED_SHEET } from "../mergeText";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function sel(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  additionalRanges?: Selection["additionalRanges"],
): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", additionalRanges };
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

function host(selection: Selection) {
  return { selection, refresh };
}

/** The real (non-probe) merge calls. */
function realMerges(): unknown[][] {
  return api.mergeCells.mock.calls.filter((c) => !(c[5] as { probe?: boolean } | undefined)?.probe);
}

/** The probe calls. */
function probes(): unknown[][] {
  return api.mergeCells.mock.calls.filter((c) => (c[5] as { probe?: boolean } | undefined)?.probe);
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
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
  api.unmergeCells.mockResolvedValue(result({ success: false }));
  api.relocateCellReferences.mockResolvedValue([]);
  api.mergeCells.mockImplementation(async (sr: number, sc: number, er: number, ec: number) =>
    result({ createdRegions: [{ startRow: sr, startCol: sc, endRow: er, endCol: ec }] }),
  );
  dialogs.alertAsync.mockReturnValue(Promise.resolve());
  refresh.mockResolvedValue(undefined);
});

/** The probe reports that the merge would discard values. */
function probeIsLossy(): void {
  api.mergeCells.mockImplementation(async (sr: number, sc: number, er: number, ec: number, _s: unknown, o: { probe?: boolean }) =>
    o?.probe
      ? result({ lossyRegions: 1 })
      : result({ createdRegions: [{ startRow: sr, startCol: sc, endRow: er, endCol: ec }] }),
  );
}

// ---------------------------------------------------------------------------
// The data-loss warning
// ---------------------------------------------------------------------------

describe("the data-loss warning", () => {
  it("asks with Excel's own words, and Cancel changes nothing at all", async () => {
    probeIsLossy();
    dialogs.confirmAsync.mockReturnValue(Promise.resolve(false));

    await runMergeGesture("mergeCenter", host(sel(0, 0, 0, 2)));

    expect(dialogs.confirmAsync).toHaveBeenCalledTimes(1);
    expect(dialogs.confirmAsync.mock.calls[0][0]).toBe(MERGE_DISCARDS_VALUES);
    expect(dialogs.confirmAsync.mock.calls[0][1]).toMatchObject({ okLabel: "OK", cancelLabel: "Cancel" });
    expect(probes()).toHaveLength(1);
    expect(realMerges()).toHaveLength(0);
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
    expect(api.applyFormatting).not.toHaveBeenCalled();
  });

  it("OK merges and centres, as ONE undo step (positive control)", async () => {
    probeIsLossy();
    dialogs.confirmAsync.mockReturnValue(Promise.resolve(true));

    await runMergeGesture("mergeCenter", host(sel(0, 0, 0, 2)));

    expect(realMerges()).toEqual([[0, 0, 0, 2, undefined, { across: false, absorb: true, keepFirstValue: true }]]);
    expect(api.applyFormatting).toHaveBeenCalledWith([0], [0, 1, 2], { textAlign: "center" });
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.beginUndoTransaction).toHaveBeenCalledWith("Merge & Center");
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(7);
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
  });

  it("a merge that discards nothing asks nothing", async () => {
    await runMergeGesture("mergeCells", host(sel(0, 0, 1, 1)));
    expect(dialogs.confirmAsync).not.toHaveBeenCalled();
    expect(realMerges()).toHaveLength(1);
  });

  it("is asked ONCE for several lossy blocks", async () => {
    probeIsLossy();
    dialogs.confirmAsync.mockReturnValue(Promise.resolve(true));
    await runMergeGesture("mergeCells", host(sel(5, 0, 5, 2, [{ startRow: 0, startCol: 0, endRow: 0, endCol: 2 }])));
    expect(dialogs.confirmAsync).toHaveBeenCalledTimes(1);
    expect(realMerges()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The four commands
// ---------------------------------------------------------------------------

describe("Merge & Center is a toggle", () => {
  it("with a merge anywhere in the selection it UNMERGES and resets alignment over the former merge", async () => {
    const merged: MergedRegion = { startRow: 1, startCol: 1, endRow: 1, endCol: 2 };
    api.getMergedRegions.mockResolvedValue([merged]);
    api.unmergeCells.mockResolvedValue(result({ removedRegions: [merged] }));

    await runMergeGesture("mergeCenter", host(sel(0, 0, 2, 4)));

    expect(api.unmergeCells).toHaveBeenCalledWith(0, 0, undefined, { endRow: 2, endCol: 4 });
    expect(api.applyFormatting).toHaveBeenCalledWith([1], [1, 2], { textAlign: "general" });
    expect(api.mergeCells).not.toHaveBeenCalled();
    expect(dialogs.confirmAsync).not.toHaveBeenCalled();
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(7);
  });

  it("on a single cell it only centres", async () => {
    await runMergeGesture("mergeCenter", host(sel(3, 3, 3, 3)));
    expect(api.mergeCells).not.toHaveBeenCalled();
    expect(api.applyFormatting).toHaveBeenCalledWith([3], [3], { textAlign: "center" });
  });
});

describe("Merge Across, Merge Cells, Unmerge Cells", () => {
  it("Merge Across is ONE across call per block and one undo step, with no alignment", async () => {
    await runMergeGesture("mergeAcross", host(sel(0, 0, 2, 2)));
    expect(realMerges()).toEqual([[0, 0, 2, 2, undefined, { across: true, absorb: true, keepFirstValue: true }]]);
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.beginUndoTransaction).toHaveBeenCalledWith("Merge Across");
    expect(api.commitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.applyFormatting).not.toHaveBeenCalled();
  });

  it("Merge Across over one column does nothing", async () => {
    await runMergeGesture("mergeAcross", host(sel(0, 0, 5, 0)));
    expect(api.mergeCells).not.toHaveBeenCalled();
  });

  it("Merge Cells on a single cell does nothing", async () => {
    await runMergeGesture("mergeCells", host(sel(0, 0, 0, 0)));
    expect(api.mergeCells).not.toHaveBeenCalled();
    expect(api.applyFormatting).not.toHaveBeenCalled();
  });

  it("Unmerge Cells unmerges every merge in the selection and keeps alignment", async () => {
    const merged: MergedRegion = { startRow: 0, startCol: 0, endRow: 0, endCol: 1 };
    api.getMergedRegions.mockResolvedValue([merged]);
    api.unmergeCells.mockResolvedValue(result({ removedRegions: [merged] }));
    await runMergeGesture("unmergeCells", host(sel(0, 0, 3, 3)));
    expect(api.unmergeCells).toHaveBeenCalledWith(0, 0, undefined, { endRow: 3, endCol: 3 });
    expect(api.applyFormatting).not.toHaveBeenCalled();
  });

  it("Unmerge Cells with nothing merged does nothing", async () => {
    await runMergeGesture("unmergeCells", host(sel(0, 0, 3, 3)));
    expect(api.unmergeCells).not.toHaveBeenCalled();
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Refusals and edge rules
// ---------------------------------------------------------------------------

describe("refusals", () => {
  it("a protected sheet is refused with a message and nothing else", async () => {
    api.isActiveSheetProtected.mockResolvedValue(true);
    await runMergeGesture("mergeCenter", host(sel(0, 0, 0, 2)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith(MERGE_ON_PROTECTED_SHEET);
    expect(api.mergeCells).not.toHaveBeenCalled();
    expect(api.unmergeCells).not.toHaveBeenCalled();
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("overlapping blocks merge nothing, silently", async () => {
    await runMergeGesture("mergeCells", host(sel(0, 0, 2, 2, [{ startRow: 1, startCol: 1, endRow: 3, endCol: 3 }])));
    expect(api.mergeCells).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("overlapping blocks still UNMERGE (the no-op is Excel's rule for merging)", async () => {
    const merged: MergedRegion = { startRow: 0, startCol: 0, endRow: 0, endCol: 1 };
    api.getMergedRegions.mockResolvedValue([merged]);
    api.unmergeCells.mockResolvedValue(result({ removedRegions: [merged] }));
    await runMergeGesture("unmergeCells", host(sel(0, 0, 2, 2, [{ startRow: 1, startCol: 1, endRow: 3, endCol: 3 }])));
    expect(api.unmergeCells).toHaveBeenCalled();
  });

  it("a refused probe is shown to the user and nothing is written", async () => {
    api.mergeCells.mockRejectedValue("Cannot merge: selection overlaps with existing merged region");
    await runMergeGesture("mergeCells", host(sel(0, 0, 1, 1)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Cannot merge: selection overlaps with existing merged region");
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("a failure after something was written COMMITS (so Ctrl+Z can take it back) and says why", async () => {
    let real = 0;
    api.mergeCells.mockImplementation(async (_sr: number, _sc: number, _er: number, _ec: number, _s: unknown, o: { probe?: boolean }) => {
      if (o?.probe) return result();
      real += 1;
      if (real === 2) throw new Error("changed meanwhile");
      return result();
    });
    await runMergeGesture("mergeCells", host(sel(5, 0, 5, 2, [{ startRow: 0, startCol: 0, endRow: 0, endCol: 2 }])));
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(7);
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("changed meanwhile");
  });

  it("a failure before anything was written CANCELS", async () => {
    api.mergeCells.mockImplementation(async (_sr: number, _sc: number, _er: number, _ec: number, _s: unknown, o: { probe?: boolean }) => {
      if (o?.probe) return result();
      throw new Error("refused");
    });
    await runMergeGesture("mergeCells", host(sel(0, 0, 0, 2)));
    expect(api.cancelUndoTransaction).toHaveBeenCalledWith(7);
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
  });
});

describe("the value rule, the alignment bound, the finish", () => {
  it("a moved value keeps its readers: references are re-pointed in the same step", async () => {
    api.mergeCells.mockImplementation(async (_sr: number, _sc: number, _er: number, _ec: number, _s: unknown, o: { probe?: boolean }) =>
      o?.probe ? result() : result({ movedCells: [{ fromRow: 0, fromCol: 1, toRow: 0, toCol: 0 }] }),
    );
    await runMergeGesture("mergeCells", host(sel(0, 0, 0, 2)));
    expect(api.relocateCellReferences).toHaveBeenCalledWith(0, 1, 0, 1, 0, 0);
    expect(api.relocateCellReferences.mock.invocationCallOrder[0]).toBeLessThan(
      api.commitUndoTransaction.mock.invocationCallOrder[0],
    );
  });

  it("centres only the top-left cell of a block bigger than the bound (whole columns)", async () => {
    await runMergeGesture("mergeCenter", host(sel(0, 0, 1_048_575, 2)));
    expect(api.applyFormatting).toHaveBeenCalledWith([0], [0], { textAlign: "center" });
  });

  it("refreshes the grid and announces the change", async () => {
    await runMergeGesture("mergeCells", host(sel(2, 1, 2, 3)));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ row: 2, col: 1 }));
  });

  it("a second gesture while one runs is ignored (no second warning, no joined step)", async () => {
    probeIsLossy();
    let answer: (ok: boolean) => void = () => {};
    dialogs.confirmAsync.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

    const first = runMergeGesture("mergeCenter", host(sel(0, 0, 0, 2)));
    await vi.waitFor(() => expect(dialogs.confirmAsync).toHaveBeenCalledTimes(1));
    expect(isMergeGestureRunning()).toBe(true);
    await runMergeGesture("mergeCenter", host(sel(0, 0, 0, 2)));
    expect(dialogs.confirmAsync).toHaveBeenCalledTimes(1);

    answer(true);
    await first;
    expect(isMergeGestureRunning()).toBe(false);
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
  });
});
