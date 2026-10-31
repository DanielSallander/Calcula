//! FILENAME: app/extensions/BuiltIn/CellBookmarks/__tests__/bookmarkStructuralFollow.test.ts
// PURPOSE: BUG-0614 -- a cell bookmark follows inserted and deleted rows and
//          columns, Insert / Delete Cells and a cut-pasted cell on any sheet,
//          and their Undo / Redo; one whose cell was deleted (or overwritten by
//          a pasted block) leaves the list and comes back when that change is
//          undone (as an Undo restores the notes and comments of the cells it
//          puts back). And it follows its SHEET: a moved sheet keeps its
//          bookmarks, a deleted one takes them away. Driven through the real
//          @api/structuralFollow and the deltas an Undo carries.

import { describe, it, expect, beforeEach } from "vitest";
import { AppEvents } from "@api/events";
import { followSheetRenumbering, followStructuralEdits } from "@api/structuralFollow";
import {
  addBookmark,
  applySheetRenumbering,
  applyStructuralStep,
  getAllBookmarks,
  getBookmarkAt,
  removeAllBookmarks,
  resyncSheets,
} from "../lib/bookmarkStore";

/** Core's far index for an inserted or removed sheet (core/state/sheetRenumbering.ts). */
const BEYOND_EVERY_SHEET = Number.MAX_SAFE_INTEGER;

function wiredBus(active: number) {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const subscribe = (name: string, cb: (d: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(cb);
    listeners.set(name, set);
    return () => {
      set.delete(cb);
    };
  };
  followStructuralEdits((step) => applyStructuralStep(step), { subscribe, activeSheet: () => active, moves: true });
  return (name: string, detail?: unknown) => {
    for (const cb of listeners.get(name) ?? []) cb(detail);
  };
}

const where = () =>
  getAllBookmarks()
    .map((b) => [b.label, b.sheetIndex, b.row, b.col] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
const undo = (...deltas: unknown[]) => ({ description: "x", source: "undo", deltas });
const redo = (...deltas: unknown[]) => ({ description: "x", source: "redo", deltas });

beforeEach(() => {
  removeAllBookmarks();
});

describe("cell bookmarks follow structural edits (BUG-0614)", () => {
  it("move with an inserted row, and back on Undo, and the lookup key moves with them", () => {
    const emit = wiredBus(0);
    addBookmark(4, 2, 0, "Sheet1", { label: "c5" });
    emit(AppEvents.ROWS_INSERTED, { startRow: 0, count: 2 });
    expect(where()).toEqual([["c5", 0, 6, 2]]);
    expect(getBookmarkAt(6, 2, 0)?.label).toBe("c5");
    expect(getBookmarkAt(4, 2, 0)).toBeUndefined();
    emit(AppEvents.STRUCTURAL_UNDO, undo({ kind: "rowDelete", sheetIndex: 0, at: 0, count: 2, band: null }));
    expect(where()).toEqual([["c5", 0, 4, 2]]);
  });

  it("a deleted cell's bookmark leaves, comes back on Undo and leaves again on Redo", () => {
    const emit = wiredBus(0);
    addBookmark(4, 2, 0, "Sheet1", { label: "c5" });
    addBookmark(9, 2, 0, "Sheet1", { label: "c10" });
    emit(AppEvents.COLUMNS_DELETED, { startCol: 2, count: 1 });
    expect(where()).toEqual([]);
    emit(AppEvents.STRUCTURAL_UNDO, undo({ kind: "colInsert", sheetIndex: 0, at: 2, count: 1, band: null }));
    expect(where()).toEqual([["c10", 0, 9, 2], ["c5", 0, 4, 2]]);
    emit(AppEvents.STRUCTURAL_UNDO, redo({ kind: "colDelete", sheetIndex: 0, at: 2, count: 1, band: null }));
    expect(where()).toEqual([]);
  });

  it("an edit on another sheet moves only that sheet's bookmarks", () => {
    const emit = wiredBus(0);
    addBookmark(4, 2, 0, "Sheet1", { label: "a" });
    addBookmark(4, 2, 1, "Sheet2", { label: "b" });
    emit(AppEvents.STRUCTURAL_EDIT_ELSEWHERE, {
      descriptions: ["Insert Columns"],
      edits: [{ sheetIndex: 1, kind: "colInsert", at: 1, count: 1 }],
    });
    expect(where()).toEqual([["a", 0, 4, 2], ["b", 1, 4, 3]]);
  });

  it("a Delete Cells band takes the bookmark inside it, and its Undo brings it back", () => {
    const emit = wiredBus(0);
    addBookmark(3, 1, 0, "Sheet1", { label: "b4" });
    addBookmark(3, 0, 0, "Sheet1", { label: "a4" });
    const band = { start: 1, end: 1 };
    emit(AppEvents.STRUCTURAL_UNDO, { description: "Delete Cells", source: "edit", deltas: [{ kind: "rowDelete", sheetIndex: 0, at: 3, count: 2, band }] });
    expect(where()).toEqual([["a4", 0, 3, 0]]);
    emit(AppEvents.STRUCTURAL_UNDO, undo({ kind: "rowInsert", sheetIndex: 0, at: 3, count: 2, band }));
    expect(where()).toEqual([["a4", 0, 3, 0], ["b4", 0, 3, 1]]);
  });

  it("a cut-pasted cell takes its bookmark along; the one it lands on leaves and comes back on Undo", () => {
    const emit = wiredBus(0);
    addBookmark(4, 2, 0, "Sheet1", { label: "c5" });
    addBookmark(7, 5, 0, "Sheet1", { label: "f8" });
    const move = { kind: "move", fromSheetIndex: 0, fromStartRow: 4, fromStartCol: 2, fromEndRow: 4, fromEndCol: 2, toSheetIndex: 0, toRow: 7, toCol: 5 };
    emit(AppEvents.CELLS_MOVED, { moves: [move], source: "edit" });
    expect(where()).toEqual([["c5", 0, 7, 5]]);
    emit(AppEvents.CELLS_MOVED, {
      moves: [{ kind: "move", fromSheetIndex: 0, fromStartRow: 7, fromStartCol: 5, fromEndRow: 7, fromEndCol: 5, toSheetIndex: 0, toRow: 4, toCol: 2 }],
      source: "undo",
    });
    expect(where()).toEqual([["c5", 0, 4, 2], ["f8", 0, 7, 5]]);
  });

  // Round 12 (clip4), rev10A minor: the Undo of a cut-paste DELETED, for good,
  // a bookmark added on the emptied source after the move. Excel [LIVE
  // 2026-10-30, clip4/probe-cutundo.ps1]: C5 cut and pasted onto F8, a watch
  // added on the empty C5, Ctrl+Z -> both watches read C5. An Undo restores
  // cells; it overwrites nothing.
  const c5ToF8 = { kind: "move", fromSheetIndex: 0, fromStartRow: 4, fromStartCol: 2, fromEndRow: 4, fromEndCol: 2, toSheetIndex: 0, toRow: 7, toCol: 5 };
  const f8ToC5 = { kind: "move", fromSheetIndex: 0, fromStartRow: 7, fromStartCol: 5, fromEndRow: 7, fromEndCol: 5, toSheetIndex: 0, toRow: 4, toCol: 2 };

  it("[LIVE] a bookmark added on the emptied source after a cut-paste survives the Undo", () => {
    const emit = wiredBus(0);
    emit(AppEvents.CELLS_MOVED, { moves: [c5ToF8], source: "edit" });
    addBookmark(4, 2, 0, "Sheet1", { label: "newC5" });
    emit(AppEvents.CELLS_MOVED, { moves: [f8ToC5], source: "undo" });
    expect(where(), "the Undo of the move deleted the bookmark on the cell it put back").toEqual([["newC5", 0, 4, 2]]);
    // The Redo makes the move again: the bookmark on C5 goes with the cell.
    emit(AppEvents.CELLS_MOVED, { moves: [c5ToF8], source: "redo" });
    expect(where()).toEqual([["newC5", 0, 7, 5]]);
  });

  it("when the moved cell had a bookmark of its own, the returning one takes C5 and the Redo gives C5 back to the new one", () => {
    const emit = wiredBus(0);
    addBookmark(4, 2, 0, "Sheet1", { label: "c5" });
    emit(AppEvents.CELLS_MOVED, { moves: [c5ToF8], source: "edit" });
    addBookmark(4, 2, 0, "Sheet1", { label: "newC5" });
    emit(AppEvents.CELLS_MOVED, { moves: [f8ToC5], source: "undo" });
    expect(where()).toEqual([["c5", 0, 4, 2]]);
    emit(AppEvents.CELLS_MOVED, { moves: [c5ToF8], source: "redo" });
    expect(where(), "the bookmark set aside by the Undo was lost").toEqual([["c5", 0, 7, 5], ["newC5", 0, 4, 2]]);
  });

  // Round 14 (lane clip6), reviewer rev12A's minor: the set-aside bookmark
  // comes back only with the Redo, so once a new edit discards the redo
  // history it is gone. DECIDED BY EXCEL'S ANALOGUE, and pinned: an item an
  // Undo removes does not come back -- not after a new edit, and not even on
  // Redo [LIVE 2026-10-30, clip6/probe-watch.ps1, a fresh visible Excel 16:
  // row 2 inserted (Ctrl+Plus), a watch added on A2, Ctrl+Z -> 0 watches,
  // Ctrl+Y -> still 0]. A cell holds ONE bookmark, so of the two that meet on
  // C5 the returning one keeps the cell (the Undo restores C5 as it was);
  // the set-aside one is already given back on Redo, which is more than
  // Excel's own rule does, and is not resurrected by any later step.
  it("[LIVE] the bookmark an Undo set aside stays gone once a new edit discards the Redo; the restored one keeps C5", () => {
    const emit = wiredBus(0);
    addBookmark(4, 2, 0, "Sheet1", { label: "c5" });
    emit(AppEvents.CELLS_MOVED, { moves: [c5ToF8], source: "edit" });
    addBookmark(4, 2, 0, "Sheet1", { label: "newC5" });
    emit(AppEvents.CELLS_MOVED, { moves: [f8ToC5], source: "undo" });
    expect(where()).toEqual([["c5", 0, 4, 2]]);
    // A new edit (a row inserted far below): the Redo is gone.
    emit(AppEvents.ROWS_INSERTED, { startRow: 20, count: 1 });
    expect(where()).toEqual([["c5", 0, 4, 2]]);
    // Its Undo and Redo, and a later move away from C5, never bring the set-aside one back.
    emit(AppEvents.STRUCTURAL_UNDO, undo({ kind: "rowDelete", sheetIndex: 0, at: 20, count: 1, band: null }));
    emit(AppEvents.STRUCTURAL_UNDO, redo({ kind: "rowInsert", sheetIndex: 0, at: 20, count: 1, band: null }));
    emit(AppEvents.CELLS_MOVED, { moves: [c5ToF8], source: "edit" });
    expect(where(), "a bookmark an Undo removed came back after the history moved on (Excel's never does)").toEqual([
      ["c5", 0, 7, 5],
    ]);
  });
});

describe("cell bookmarks follow their SHEET", () => {
  it("a moved sheet keeps its bookmarks, a deleted sheet takes them away", () => {
    const target = new EventTarget() as unknown as Window;
    followSheetRenumbering((renumber) => applySheetRenumbering(renumber), target);
    const reorder = (fromIndex: number, toIndex: number) =>
      target.dispatchEvent(new CustomEvent("sheet:reorder", { detail: { fromIndex, toIndex } }));
    addBookmark(4, 2, 1, "Sheet2", { label: "s2" });
    addBookmark(0, 0, 0, "Sheet1", { label: "s1" });
    reorder(1, 0);
    expect(where()).toEqual([["s1", 1, 0, 0], ["s2", 0, 4, 2]]);
    expect(getBookmarkAt(4, 2, 0)?.label).toBe("s2");
    reorder(0, BEYOND_EVERY_SHEET);
    expect(where()).toEqual([["s1", 0, 0, 0]]);
  });

  it("re-checks by the stable id: index and name follow, a vanished sheet's bookmarks go", () => {
    addBookmark(1, 1, 0, "Sheet1", { label: "a", sheetId: "id-a" });
    addBookmark(2, 2, 1, "Sheet2", { label: "b", sheetId: "id-b" });
    addBookmark(3, 3, 2, "Sheet3", { label: "c" });
    resyncSheets([
      { index: 0, name: "Inputs", sheetId: "id-b" },
      { index: 1, name: "Sheet3", sheetId: "id-c" },
    ]);
    expect(
      getAllBookmarks()
        .map((b) => [b.label, b.sheetIndex, b.sheetName, b.sheetId ?? null])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual([
      ["b", 0, "Inputs", "id-b"],
      // No sheet at its index in this list: left as it is, never guessed.
      ["c", 2, "Sheet3", null],
    ]);
  });
});
