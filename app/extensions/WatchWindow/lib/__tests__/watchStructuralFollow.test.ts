//! FILENAME: app/extensions/WatchWindow/lib/__tests__/watchStructuralFollow.test.ts
// PURPOSE: BUG-0614 -- a Watch Window entry follows inserted and deleted rows
//          and columns, Insert / Delete Cells, a cut-pasted cell and its
//          SHEET, and their Undo / Redo, as Excel's does. Live Excel 16
//          (2026-10-30, fresh workbook): a watch on C5 reads C6 after a row is
//          inserted above it and D6 after a column is inserted left of it;
//          Ctrl+Z puts it back on C5, Ctrl+Y on C6; deleting the watched
//          cell's row (or column) REMOVES the entry, and an Undo does not bring
//          it back; C5 cut and pasted onto F8 takes the watch to F8 and Undo
//          back to C5; a watch on F8 when a block is pasted ONTO F8 is
//          removed; a watch on Sheet2!C5 still reads Sheet2!C5 after Sheet2 is
//          moved before Sheet1, and goes when Sheet2 is deleted. Driven through
//          the real @api/structuralFollow and the deltas an Undo carries.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api", () => ({
  getWatchCells: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({ sheets: [] })),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
}));

import { AppEvents } from "@api/events";
import { followSheetRenumbering, followStructuralEdits } from "@api/structuralFollow";
/** Core's far index for an inserted or removed sheet (core/state/sheetRenumbering.ts). */
const BEYOND_EVERY_SHEET = Number.MAX_SAFE_INTEGER;
import { addWatch, applySheetRenumbering, applyStructuralStep, getItems, reset, resyncSheets } from "../watchStore";

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

const where = () => getItems().map((w) => [w.sheetIndex, w.row, w.col]);
const undo = (...deltas: unknown[]) => ({ description: "x", source: "undo", deltas });
const redo = (...deltas: unknown[]) => ({ description: "x", source: "redo", deltas });

beforeEach(() => {
  reset();
});

describe("Watch Window entries follow structural edits (BUG-0614)", () => {
  it("[LIVE] insert a row above / a column left: C5 -> C6 -> D6; Undo C6 then C5; Redo C6", () => {
    const emit = wiredBus(0);
    addWatch(0, "Sheet1", 4, 2);
    emit(AppEvents.ROWS_INSERTED, { startRow: 2, count: 1 });
    expect(where()).toEqual([[0, 5, 2]]);
    emit(AppEvents.COLUMNS_INSERTED, { startCol: 0, count: 1 });
    expect(where()).toEqual([[0, 5, 3]]);
    emit(AppEvents.STRUCTURAL_UNDO, undo({ kind: "colDelete", sheetIndex: 0, at: 0, count: 1, band: null }));
    expect(where()).toEqual([[0, 5, 2]]);
    emit(AppEvents.STRUCTURAL_UNDO, undo({ kind: "rowDelete", sheetIndex: 0, at: 2, count: 1, band: null }));
    expect(where()).toEqual([[0, 4, 2]]);
    emit(AppEvents.STRUCTURAL_UNDO, redo({ kind: "rowInsert", sheetIndex: 0, at: 2, count: 1, band: null }));
    expect(where()).toEqual([[0, 5, 2]]);
  });

  it("[LIVE] deleting the watched cell's row removes the entry, and its Undo does not bring it back", () => {
    const emit = wiredBus(0);
    addWatch(0, "Sheet1", 4, 2);
    addWatch(0, "Sheet1", 9, 2);
    emit(AppEvents.ROWS_DELETED, { startRow: 4, count: 1 });
    expect(where()).toEqual([[0, 8, 2]]);
    emit(AppEvents.STRUCTURAL_UNDO, undo({ kind: "rowInsert", sheetIndex: 0, at: 4, count: 1, band: null }));
    expect(where()).toEqual([[0, 9, 2]]);
  });

  it("an undo of a GROUPED step (a macro's two inserts) puts the watch back, though its description names neither", () => {
    const emit = wiredBus(0);
    addWatch(0, "Sheet1", 4, 2);
    emit(AppEvents.ROWS_INSERTED, { startRow: 0, count: 2 });
    emit(AppEvents.COLUMNS_INSERTED, { startCol: 1, count: 1 });
    expect(where()).toEqual([[0, 6, 3]]);
    emit(AppEvents.STRUCTURAL_UNDO, {
      description: "Run macro",
      source: "undo",
      deltas: [
        { kind: "colDelete", sheetIndex: 0, at: 1, count: 1, band: null },
        { kind: "rowDelete", sheetIndex: 0, at: 0, count: 2, band: null },
      ],
    });
    expect(where()).toEqual([[0, 4, 2]]);
  });

  it("Insert Cells moves a watch inside its band only, and its Undo moves it back", () => {
    const emit = wiredBus(0);
    addWatch(0, "Sheet1", 6, 1); // B7, inside the band
    addWatch(0, "Sheet1", 6, 0); // A7, outside it
    const band = { start: 1, end: 1 };
    emit(AppEvents.STRUCTURAL_UNDO, { description: "Insert Cells", source: "edit", deltas: [{ kind: "rowInsert", sheetIndex: 0, at: 1, count: 2, band }] });
    expect(where()).toEqual([[0, 8, 1], [0, 6, 0]]);
    emit(AppEvents.STRUCTURAL_UNDO, undo({ kind: "rowDelete", sheetIndex: 0, at: 1, count: 2, band }));
    expect(where()).toEqual([[0, 6, 1], [0, 6, 0]]);
  });

  it("[LIVE] a cut-pasted cell takes its watch along, onto another sheet too, and Undo brings it back", () => {
    const emit = wiredBus(0);
    addWatch(0, "Sheet1", 4, 2, null, "id-1");
    const move = { kind: "move", fromSheetIndex: 0, fromStartRow: 4, fromStartCol: 2, fromEndRow: 4, fromEndCol: 2, toSheetIndex: 1, toRow: 7, toCol: 5 };
    emit(AppEvents.CELLS_MOVED, { moves: [move], source: "edit" });
    expect(where()).toEqual([[1, 7, 5]]);
    expect(getItems()[0].sheetId).toBeUndefined(); // re-read from the sheet it landed on
    emit(AppEvents.CELLS_MOVED, {
      moves: [{ kind: "move", fromSheetIndex: 1, fromStartRow: 7, fromStartCol: 5, fromEndRow: 7, fromEndCol: 5, toSheetIndex: 0, toRow: 4, toCol: 2 }],
      source: "undo",
    });
    expect(where()).toEqual([[0, 4, 2]]);
  });

  it("[LIVE] a watch added on the emptied source after a cut-paste survives the Undo: both read C5", () => {
    // Excel [LIVE 2026-10-30, clip4/probe-cutundo.ps1]: watch C5, cut C5 and
    // paste onto F8 (the watch reads F8), add a watch on the empty C5, Ctrl+Z
    // -> two watches, both $C$5. An Undo restores cells; it overwrites nothing.
    const emit = wiredBus(0);
    addWatch(0, "Sheet1", 4, 2);
    emit(AppEvents.CELLS_MOVED, {
      moves: [{ kind: "move", fromSheetIndex: 0, fromStartRow: 4, fromStartCol: 2, fromEndRow: 4, fromEndCol: 2, toSheetIndex: 0, toRow: 7, toCol: 5 }],
      source: "edit",
    });
    addWatch(0, "Sheet1", 4, 2);
    expect(where()).toEqual([[0, 7, 5], [0, 4, 2]]);
    emit(AppEvents.CELLS_MOVED, {
      moves: [{ kind: "move", fromSheetIndex: 0, fromStartRow: 7, fromStartCol: 5, fromEndRow: 7, fromEndCol: 5, toSheetIndex: 0, toRow: 4, toCol: 2 }],
      source: "undo",
    });
    expect(where(), "the Undo of the move removed the watch on the cell it put back").toEqual([[0, 4, 2], [0, 4, 2]]);
  });

  it("[LIVE] a watch on the cell a block is pasted ONTO is removed", () => {
    const emit = wiredBus(0);
    addWatch(0, "Sheet1", 7, 5); // F8
    emit(AppEvents.CELLS_MOVED, {
      moves: [{ kind: "move", fromSheetIndex: 0, fromStartRow: 4, fromStartCol: 2, fromEndRow: 4, fromEndCol: 2, toSheetIndex: 0, toRow: 7, toCol: 5 }],
      source: "edit",
    });
    expect(getItems()).toHaveLength(0);
  });

  it("an edit on ANOTHER sheet moves only that sheet's watches", () => {
    const emit = wiredBus(0);
    addWatch(0, "Sheet1", 4, 2);
    addWatch(1, "Sheet2", 4, 2);
    emit(AppEvents.STRUCTURAL_EDIT_ELSEWHERE, {
      descriptions: ["Insert Rows"],
      edits: [{ sheetIndex: 1, kind: "rowInsert", at: 0, count: 3 }],
    });
    expect(where()).toEqual([[0, 4, 2], [1, 7, 2]]);
  });
});

describe("Watch Window entries follow their SHEET", () => {
  it("[LIVE] a moved sheet keeps its watch; a deleted sheet takes it away", () => {
    const target = new EventTarget() as unknown as Window;
    followSheetRenumbering((renumber) => applySheetRenumbering(renumber), target);
    const reorder = (fromIndex: number, toIndex: number) =>
      target.dispatchEvent(new CustomEvent("sheet:reorder", { detail: { fromIndex, toIndex } }));
    addWatch(1, "Sheet2", 4, 2);
    addWatch(0, "Sheet1", 0, 0);
    reorder(1, 0); // Sheet2 moved before Sheet1
    expect(where()).toEqual([[0, 4, 2], [1, 0, 0]]);
    reorder(BEYOND_EVERY_SHEET, 0); // a sheet inserted in front
    expect(where()).toEqual([[1, 4, 2], [2, 0, 0]]);
    reorder(1, BEYOND_EVERY_SHEET); // Sheet2 deleted
    expect(where()).toEqual([[1, 0, 0]]);
  });

  it("re-checks each watch by its sheet's stable id: index and name follow, a vanished sheet removes it", () => {
    addWatch(0, "Sheet1", 1, 1, null, "id-a");
    addWatch(1, "Sheet2", 2, 2, null, "id-b");
    addWatch(2, "Sheet3", 3, 3); // no id yet: takes the one at its index
    resyncSheets([
      { index: 0, name: "Inputs", sheetId: "id-b" },
      { index: 1, name: "Sheet1", sheetId: "id-a" },
      { index: 2, name: "Sheet3", sheetId: "id-c" },
    ]);
    expect(getItems().map((w) => [w.sheetIndex, w.sheetName, w.sheetId])).toEqual([
      [1, "Sheet1", "id-a"],
      [0, "Inputs", "id-b"],
      [2, "Sheet3", "id-c"],
    ]);
    resyncSheets([{ index: 0, name: "Sheet1", sheetId: "id-a" }, { index: 1, name: "Sheet3", sheetId: "id-c" }]);
    expect(getItems().map((w) => [w.sheetIndex, w.sheetId])).toEqual([[0, "id-a"], [1, "id-c"]]);
  });
});
