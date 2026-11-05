//! FILENAME: app/src/core/lib/clearGestures/__tests__/clearGesturesGroupedSheets.test.ts
// PURPOSE: BUG-0350 -- a clear with GROUPED sheets (tabs Ctrl+clicked
//          together) clears the same range on every sheet of the group, as ONE
//          undo step, and the one-cell writeback edit is the gesture's own.
// CONTEXT: The group replication lived in useSpreadsheetSelection's own Delete
//          handler, which the registry's Delete binding pre-empts in the
//          capture phase, so Delete with grouped sheets cleared the ACTIVE sheet
//          only. Excel (Microsoft 365, live 2026-10-29): with two sheets
//          grouped, Delete, Clear Contents, Clear Formats and Clear All clear
//          BOTH sheets and ONE Application.Undo restores both. The gesture
//          (the one door every clear reaches) now does it.
//          Round 3 (reviews G#1, G#4, G#9): with one grouped sheet PROTECTED
//          Excel clears nothing on ANY sheet, so the group's write is the
//          FIRST one -- ONE `clearRangeOnSheets` for every block, listing the
//          active sheet too, which the backend gates with the rest before it
//          writes anything -- and a refusal stops the active sheet's clear.
//          And a group the sheet on screen is not part of (reached by the Name
//          Box, Go To, a link) is not cleared: Excel ungroups on such a switch.
//
// The dialog double takes the TAURI shape (alertAsync resolves a Promise).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const api = vi.hoisted(() => ({
  clearRange: vi.fn(),
  clearRangeOnSheets: vi.fn(),
  clearRangeWithOptions: vi.fn(),
  clearCommentsInRange: vi.fn(),
  clearNotesInRange: vi.fn(),
  clearHyperlinksInRange: vi.fn(),
  getHyperlinksInRange: vi.fn(),
  beginUndoTransaction: vi.fn(),
  commitUndoTransaction: vi.fn(),
  cancelUndoTransaction: vi.fn(),
}));
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(), confirmAsync: vi.fn() }));
const emit = vi.hoisted(() => vi.fn());
const grid = vi.hoisted(() => ({ activeSheetIndex: 0 as number | null }));

vi.mock("../../tauri-api", () => api);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    throw new Error(`unexpected raw invoke ${cmd}`);
  },
}));
vi.mock("../../dialogs", () => dialogs);
vi.mock("../../cellEvents", () => ({ cellEvents: { emit } }));
vi.mock("../../../state/GridContext", () => ({
  getGridStateSnapshot: () =>
    grid.activeSheetIndex === null ? null : { sheetContext: { activeSheetIndex: grid.activeSheetIndex } },
}));

import type { Selection } from "../../../types";
import { runClearGesture, type ClearGestureHost } from "../clearGestures";
import { clearSheetGrouping, setSelectedSheetIndices } from "../../../state/sheetGrouping";
import { registerRangeGuard } from "../../editGuards";
import { setGridCellTextCommitter } from "../../selectionOwner";

function sel(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  extra?: Selection["additionalRanges"],
): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", additionalRanges: extra };
}

const refresh = vi.fn();

function host(selection: Selection | null, extra?: Partial<ClearGestureHost>): ClearGestureHost {
  return { selection, refresh, ...extra };
}

/** Every backend WRITE, in order, with its arguments (reads and undo brackets left out). */
function writes(): Array<[string, unknown[]]> {
  const all: Array<{ name: string; args: unknown[]; order: number }> = [];
  for (const [name, fn] of Object.entries(api)) {
    if (name.endsWith("UndoTransaction") || name === "getHyperlinksInRange") continue;
    fn.mock.calls.forEach((args, i) => all.push({ name, args, order: fn.mock.invocationCallOrder[i] }));
  }
  return all.sort((a, b) => a.order - b.order).map((w) => [w.name, w.args]);
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  dialogs.alertAsync.mockReset();
  dialogs.alertAsync.mockReturnValue(Promise.resolve());
  emit.mockReset();
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
  api.clearRange.mockResolvedValue(0);
  api.clearRangeOnSheets.mockResolvedValue([2]);
  api.clearRangeWithOptions.mockResolvedValue({});
  api.clearCommentsInRange.mockResolvedValue(0);
  api.clearNotesInRange.mockResolvedValue(0);
  api.clearHyperlinksInRange.mockResolvedValue(0);
  api.getHyperlinksInRange.mockResolvedValue([{ row: 0, col: 0, linkType: "url" }]);
  api.beginUndoTransaction.mockResolvedValue(9);
  api.commitUndoTransaction.mockResolvedValue(undefined);
  api.cancelUndoTransaction.mockResolvedValue(undefined);
  grid.activeSheetIndex = 0;
  // Sheet1 (active, index 0) grouped with Sheet3 (index 2).
  setSelectedSheetIndices([0, 2]);
});

afterEach(() => {
  clearSheetGrouping();
  setGridCellTextCommitter(null);
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("Delete / Clear Contents with grouped sheets", () => {
  it("clears the same range on the OTHER grouped sheets too, as ONE undo step -- the group's gated write FIRST", async () => {
    await runClearGesture("clearContents", host(sel(0, 0, 1, 1)));
    expect(writes()).toEqual([
      ["clearRangeOnSheets", [[0, 2], 0, 0, 1, 1, { applyTo: "contents", moreAreas: [] }]],
      ["clearRangeWithOptions", [0, 0, 1, 1, "contents"]],
    ]);
    expect(api.beginUndoTransaction, "the group clear is ONE step").toHaveBeenCalledTimes(1);
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(9);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  // review G#9: one group call (one backend recalculation) for every block,
  // never one per block.
  it("every Ctrl+click block is replicated, in ONE group call", async () => {
    await runClearGesture("clearContents", host(sel(5, 5, 5, 5, [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }])));
    expect(writes()).toEqual([
      [
        "clearRangeOnSheets",
        [[0, 2], 5, 5, 5, 5, { applyTo: "contents", moreAreas: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }] }],
      ],
      // BUG-0394: the active sheet's blocks in ONE call too.
      ["clearRangeWithOptions", [5, 5, 5, 5, "contents", undefined, { moreAreas: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }] }]],
    ]);
    expect(api.clearRangeOnSheets).toHaveBeenCalledTimes(1);
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
  });

  // review G#1, Excel [LIVE]: Sheet2 protected, Sheet1 + Sheet2 grouped, Clear
  // Contents -> nothing is cleared on either sheet.
  it("a grouped sheet that refuses (protected): SHOWN, and NOTHING is cleared -- not even the active sheet", async () => {
    api.clearRangeOnSheets.mockRejectedValue("The cell is on a protected sheet.");
    await runClearGesture("clearContents", host(sel(0, 0, 1, 1)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
    expect(api.clearRangeWithOptions, "the active sheet was cleared past the group's refusal").not.toHaveBeenCalled();
    expect(api.cancelUndoTransaction, "the empty step is cancelled").toHaveBeenCalledWith(9);
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
    expect(emit, "nothing was cleared, so nothing is announced").not.toHaveBeenCalled();
  });

  // review G#4: Excel ungroups when you reach another sheet by the Name Box,
  // Go To or a link; a group the sheet on screen is not part of is not cleared.
  it("the sheet on screen is NOT in the group (reached by the Name Box / Go To): the active sheet alone", async () => {
    setSelectedSheetIndices([1, 2]);
    await runClearGesture("clearContents", host(sel(0, 0, 1, 1)));
    expect(writes()).toEqual([["clearRangeWithOptions", [0, 0, 1, 1, "contents"]]]);
    await runClearGesture("clearAll", host(sel(0, 0, 1, 1)));
    expect(api.clearRangeOnSheets).not.toHaveBeenCalled();
  });

  it("control: no group -> the active sheet alone, its own undo step", async () => {
    clearSheetGrouping();
    await runClearGesture("clearContents", host(sel(0, 0, 1, 1)));
    expect(writes()).toEqual([["clearRangeWithOptions", [0, 0, 1, 1, "contents"]]]);
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("an OBJECT's cells (a floating grid) never replicate to the group", async () => {
    const target = { kind: "floatingRange", id: "fr-1" } as unknown as ClearGestureHost["target"];
    await runClearGesture("clearContents", host(sel(0, 0, 1, 1), { target }));
    expect(api.clearRangeOnSheets).not.toHaveBeenCalled();
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[0, 0, 1, 1, "contents", undefined, { target }]]);
  });

  it("the sheet on screen unknown (no grid): nothing is replicated", async () => {
    grid.activeSheetIndex = null;
    await runClearGesture("clearContents", host(sel(0, 0, 1, 1)));
    expect(writes()).toEqual([["clearRangeWithOptions", [0, 0, 1, 1, "contents"]]]);
  });
});

describe("Clear Formats and Clear All with grouped sheets", () => {
  it("Clear Formats clears the formats on every grouped sheet (the group door, then the active sheet)", async () => {
    setSelectedSheetIndices([0, 1, 3]);
    await runClearGesture("clearFormatting", host(sel(2, 2, 3, 3)));
    expect(writes()).toEqual([
      ["clearRangeOnSheets", [[0, 1, 3], 2, 2, 3, 3, { applyTo: "formats", moreAreas: [] }]],
      ["clearRangeWithOptions", [2, 2, 3, 3, "formats"]],
    ]);
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
  });

  it("Clear All: every sheet's contents + formats FIRST (the refusable phase), then the active sheet's comments, notes and links", async () => {
    await runClearGesture("clearAll", host(sel(0, 0, 1, 1)));
    expect(writes()).toEqual([
      ["clearRangeOnSheets", [[0, 2], 0, 0, 1, 1, { applyTo: "all", moreAreas: [] }]],
      ["clearRangeWithOptions", [0, 0, 1, 1, "all"]],
      ["clearCommentsInRange", [0, 0, 1, 1]],
      ["clearNotesInRange", [0, 0, 1, 1]],
      ["clearHyperlinksInRange", [0, 0, 1, 1]],
    ]);
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
  });

  it("Clear All, a grouped sheet refuses: nothing anywhere is cleared -- no contents, comment, note or link", async () => {
    api.clearRangeOnSheets.mockRejectedValue("The cell is on a protected sheet.");
    await runClearGesture("clearAll", host(sel(0, 0, 1, 1)));
    expect(api.clearRangeWithOptions, "the active sheet was cleared past the group's refusal").not.toHaveBeenCalled();
    expect(api.clearCommentsInRange).not.toHaveBeenCalled();
    expect(api.clearNotesInRange).not.toHaveBeenCalled();
    expect(api.clearHyperlinksInRange).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
  });

  for (const kind of ["clearComments", "clearHyperlinks", "removeHyperlinks"] as const) {
    it(`${kind} stays on the active sheet (no sheet-addressed door for comments, notes or links)`, async () => {
      await runClearGesture(kind, host(sel(0, 0, 1, 1)));
      expect(api.clearRangeOnSheets).not.toHaveBeenCalled();
      for (const call of api.clearRangeWithOptions.mock.calls) expect(call[5]).toBeUndefined();
    });
  }
});

describe("the one-cell writeback edit is the gesture's own (Delete reaches it now)", () => {
  /** A writeback-style guard: refuses a bulk write to (3,3), admits one EDIT. */
  function writebackCellAt(row: number, col: number): void {
    cleanups.push(
      registerRangeGuard((r0, c0, r1, c1, operation) =>
        r0 <= row && row <= r1 && c0 <= col && col <= c1 && operation === "other"
          ? { blocked: true, message: "Writeback cells take one answer at a time." }
          : null,
      ),
    );
  }

  it("Delete on that one cell ENTERS an empty edit (the owner's commit guard records it); no bulk clear", async () => {
    writebackCellAt(3, 3);
    const committed: string[] = [];
    setGridCellTextCommitter(async (text) => {
      committed.push(text);
      return true;
    });
    await runClearGesture("clearContents", host(sel(3, 3, 3, 3)));
    expect(committed).toEqual([""]);
    expect(writes()).toEqual([]);
  });

  it("no committer: the clear runs, and its refusal names the remedy", async () => {
    writebackCellAt(3, 3);
    api.clearRangeWithOptions.mockRejectedValue("This cell collects one answer at a time.");
    await runClearGesture("clearContents", host(sel(3, 3, 3, 3)));
    expect(api.clearRangeWithOptions).toHaveBeenCalledTimes(1);
    expect(dialogs.alertAsync).toHaveBeenCalledWith("This cell collects one answer at a time.");
  });

  it("control: a RANGE over that cell is a bulk clear, never an edit", async () => {
    writebackCellAt(3, 3);
    const committer = vi.fn(async () => true);
    setGridCellTextCommitter(committer);
    await runClearGesture("clearContents", host(sel(3, 3, 4, 4)));
    expect(committer).not.toHaveBeenCalled();
    expect(api.clearRangeWithOptions).toHaveBeenCalledTimes(1);
  });

  it("control: Clear Formats on that cell is never entered as an edit", async () => {
    writebackCellAt(3, 3);
    const committer = vi.fn(async () => true);
    setGridCellTextCommitter(committer);
    await runClearGesture("clearFormatting", host(sel(3, 3, 3, 3)));
    expect(committer).not.toHaveBeenCalled();
  });
});
