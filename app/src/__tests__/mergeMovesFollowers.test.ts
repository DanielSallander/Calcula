//! FILENAME: app/src/__tests__/mergeMovesFollowers.test.ts
// PURPOSE: A merge that MOVES a value into the top-left cell moves the cell
//          followers (a cell bookmark, a Watch Window entry) with it, and its
//          Undo moves them back -- never a follower the merge did not move.
// CONTEXT: Bug-ledger fix programme round 12 (lane clip4), reviewer rev10A's
//          MAJOR finding: `relocate_cell_references` records a Move for the
//          step's Undo / Redo, but the merge gesture never ANNOUNCED the move
//          forward. The Undo then reported the inverse move (A1 -> B1): the
//          bookmark on A1 -- which the merge never moved -- went to B1, and the
//          one on B1 was deleted for good. Live Excel 16 [2026-10-30,
//          clip4/probe-merge.ps1, a fresh workbook]: A1 empty, B1=5, watches on
//          A1 and B1, =B1 in E1 and =A1 in E2; Merge & Center A1:C1 -> A1=5,
//          ONE watch, on $A$1 (B1's followed, A1's -- overwritten -- removed),
//          E1 =A1, E2 =#REF!; Ctrl+Z -> B1=5, the watch reads $B$1. A move,
//          exactly as a cut and paste of B1 onto A1. Driven through the REAL
//          merge gesture, the REAL @api/structuralFollow on the real event bus,
//          and the REAL bookmark and watch stores; the backend is a double, and
//          the Undo announces what the backend's step record carries.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("../core/lib/tauri-api", () => api);
vi.mock("../core/lib/dialogs", () => ({
  alertAsync: vi.fn(() => Promise.resolve()),
  confirmAsync: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../core/lib/cellEvents", () => ({ cellEvents: { emit: vi.fn() } }));
vi.mock("../core/state/GridContext", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));
// The watch store's own reads (its refresh is not exercised here).
vi.mock("@api", () => ({
  getWatchCells: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({ sheets: [] })),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
}));

import type { MergeResult, Selection } from "../core/types";
import { runMergeGesture } from "../core/lib/merge/mergeGestures";
import { AppEvents, emitAppEvent } from "@api/events";
import { followStructuralEdits } from "@api/structuralFollow";
import { announceRolledBackRestore } from "../core/lib/cellsMoved";
import type { UndoResult } from "../core/lib/tauri-api";
import {
  addBookmark,
  applyStructuralStep as applyBookmarkStep,
  getAllBookmarks,
  removeAllBookmarks,
} from "../../extensions/BuiltIn/CellBookmarks/lib/bookmarkStore";
import {
  addWatch,
  applyStructuralStep as applyWatchStep,
  getItems,
  reset as resetWatches,
} from "../../extensions/WatchWindow/lib/watchStore";

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

const sel = (startRow: number, startCol: number, endRow: number, endCol: number): Selection => ({
  startRow,
  startCol,
  endRow,
  endCol,
  type: "cells",
});

const bookmarks = () =>
  getAllBookmarks()
    .map((b) => [b.label, b.row, b.col] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
const watches = () => getItems().map((w) => [w.row, w.col]);

/** Every CELLS_MOVED the gesture announced. */
let announced: unknown[] = [];
const offs: Array<() => void> = [];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.isActiveSheetProtected.mockResolvedValue(false);
  api.getMergedRegions.mockResolvedValue([]);
  api.beginUndoTransaction.mockResolvedValue(7);
  api.commitUndoTransaction.mockResolvedValue(undefined);
  api.cancelUndoTransaction.mockResolvedValue(undefined);
  api.applyFormatting.mockResolvedValue({ cells: [], styles: [] });
  api.relocateCellReferences.mockResolvedValue([]);
  // The value rule: A1 is empty, so B1's value moves into A1.
  api.mergeCells.mockImplementation(async (_sr: number, _sc: number, _er: number, _ec: number, _s: unknown, o: { probe?: boolean }) =>
    o?.probe ? result() : result({ movedCells: [{ fromRow: 0, fromCol: 1, toRow: 0, toCol: 0 }] }),
  );
  removeAllBookmarks();
  resetWatches();
  announced = [];
  const record = (event: Event) => announced.push((event as CustomEvent).detail);
  window.addEventListener(AppEvents.CELLS_MOVED, record);
  offs.push(() => window.removeEventListener(AppEvents.CELLS_MOVED, record));
  offs.push(followStructuralEdits((step) => applyBookmarkStep(step), { activeSheet: () => 0, moves: true }));
  offs.push(followStructuralEdits((step) => applyWatchStep(step), { activeSheet: () => 0, moves: true }));
});

afterEach(() => {
  for (const off of offs.splice(0)) off();
});

/** What the backend's Undo of the merge step reports: the inverse of the move it recorded. */
function undoTheMerge(): void {
  emitAppEvent(AppEvents.CELLS_MOVED, {
    source: "undo",
    moves: [
      { kind: "move", fromSheetIndex: 0, fromStartRow: 0, fromStartCol: 0, fromEndRow: 0, fromEndCol: 0, toSheetIndex: 0, toRow: 0, toCol: 1 },
    ],
  });
}

describe("[LIVE] a merge that moves a value moves its followers, and its Undo moves them back", () => {
  it("announces the move it recorded, after the commit", async () => {
    await runMergeGesture("mergeCenter", { selection: sel(0, 0, 0, 2), refresh: vi.fn(async () => {}) });
    // The backend's merge re-points the moved value's readers itself (round C);
    // a second frontend relocation would turn those readers into #REF!.
    expect(api.relocateCellReferences).not.toHaveBeenCalled();
    expect(announced, "the merge recorded a move it never announced").toEqual([
      {
        source: "edit",
        moves: [
          { kind: "move", fromSheetIndex: 0, fromStartRow: 0, fromStartCol: 1, fromEndRow: 0, fromEndCol: 1, toSheetIndex: 0, toRow: 0, toCol: 0 },
        ],
      },
    ]);
  });

  it("bookmarks on A1 and B1: B1's follows the value to A1, A1's leaves; Undo puts BOTH back (none lost)", async () => {
    addBookmark(0, 0, 0, "Sheet1", { label: "onA1" });
    addBookmark(0, 1, 0, "Sheet1", { label: "onB1" });
    await runMergeGesture("mergeCenter", { selection: sel(0, 0, 0, 2), refresh: vi.fn(async () => {}) });
    expect(bookmarks()).toEqual([["onB1", 0, 0]]);
    undoTheMerge();
    expect(bookmarks(), "the Undo moved a bookmark the merge never moved, or lost one").toEqual([
      ["onA1", 0, 0],
      ["onB1", 0, 1],
    ]);
  });

  it("[LIVE] watches on A1 and B1: one watch, on A1; Undo puts it back on B1 (Excel's count and addresses)", async () => {
    addWatch(0, "Sheet1", 0, 0);
    addWatch(0, "Sheet1", 0, 1);
    await runMergeGesture("mergeCenter", { selection: sel(0, 0, 0, 2), refresh: vi.fn(async () => {}) });
    expect(watches()).toEqual([[0, 0]]);
    undoTheMerge();
    expect(watches()).toEqual([[0, 1]]);
  });

  it("control: a merge that moves no value announces nothing", async () => {
    api.mergeCells.mockImplementation(async () => result());
    await runMergeGesture("mergeCenter", { selection: sel(0, 0, 0, 2), refresh: vi.fn(async () => {}) });
    expect(api.relocateCellReferences).not.toHaveBeenCalled();
    expect(announced).toEqual([]);
  });

  it("a merge whose step is not kept (nothing written, cancelled) announces nothing", async () => {
    api.mergeCells.mockImplementation(async (_sr: number, _sc: number, _er: number, _ec: number, _s: unknown, o: { probe?: boolean }) => {
      if (o?.probe) return result();
      throw new Error("refused");
    });
    await runMergeGesture("mergeCells", { selection: sel(0, 0, 0, 2), refresh: vi.fn(async () => {}) });
    expect(api.cancelUndoTransaction).toHaveBeenCalledWith(7);
    expect(announced).toEqual([]);
  });
});

// Round 14 (lane clip6), reviewer rev12A's nit: a Merge whose transaction only
// JOINED an outer step (a granted macro run that runs Merge & Center, then
// fails) announced its move; the run's take-back to its savepoint then left
// the followers where the move had put them. A take-back now hands the
// followers the inverse of exactly the moves that were announced from a
// joined step -- and never the inverse of a move nobody was told about (a
// cut-paste taken back inside its own step).
describe("a take-back to an undo savepoint moves the followers back from an announced merge move, and only then", () => {
  /** What the backend's take-back reports: the inverse of the merge's recorded move (B1 -> A1). */
  function takeBack(): UndoResult {
    return {
      success: true,
      description: "Run macro",
      updatedCells: [],
      canUndo: true,
      canRedo: false,
      mergeChanged: true,
      structuralRestore: false,
      pivotChanged: false,
      slicerChanged: false,
      ribbonFilterChanged: false,
      paneControlChanged: false,
      objectsChanged: false,
      hiddenChanged: false,
      refreshDomains: [],
      activeSheetIndex: 0,
      activeSheetName: "Sheet1",
      restoredAnchor: null,
      restoredRange: null,
      structuralDeltas: [
        { kind: "move", fromSheetIndex: 0, fromStartRow: 0, fromStartCol: 0, fromEndRow: 0, fromEndCol: 0, toSheetIndex: 0, toRow: 0, toCol: 1 },
      ],
    };
  }

  it("a merge in a JOINED step (a granted run), then the run taken back: the bookmark and the watch return to B1", async () => {
    api.beginUndoTransaction.mockResolvedValue(null); // joined the run's step
    addBookmark(0, 1, 0, "Sheet1", { label: "onB1" });
    addWatch(0, "Sheet1", 0, 1);
    await runMergeGesture("mergeCenter", { selection: sel(0, 0, 0, 2), refresh: vi.fn(async () => {}) });
    expect(api.commitUndoTransaction, "a joined merge closed the run's step").not.toHaveBeenCalled();
    expect(bookmarks()).toEqual([["onB1", 0, 0]]);
    announceRolledBackRestore(takeBack());
    expect(bookmarks(), "the run was taken back but the bookmark stayed where the merge moved it").toEqual([["onB1", 0, 1]]);
    expect(watches(), "the run was taken back but the watch stayed on A1").toEqual([[0, 1]]);
  });

  it("control: a take-back of a move that was never announced (a cut-paste refused inside its own step) moves nothing", () => {
    addBookmark(0, 0, 0, "Sheet1", { label: "onA1" });
    addBookmark(0, 1, 0, "Sheet1", { label: "onB1" });
    announced = [];
    announceRolledBackRestore(takeBack());
    expect(announced, "a move nobody was told about was handed back").toEqual([]);
    expect(bookmarks()).toEqual([
      ["onA1", 0, 0],
      ["onB1", 0, 1],
    ]);
  });
});
