//! FILENAME: app/src/api/__tests__/structuralFollow.test.ts
// PURPOSE: BUG-0614 -- the ONE helper the frontend coordinate stores (Watch
//          Window, cell bookmarks, Insights overlays, animation driver cells)
//          follow coordinate changes through: the shift rules (a formula
//          reference's, a band's, a move's), and the structured deltas an Undo
//          / Redo carries (STRUCTURAL_UNDO / CELLS_MOVED `deltas` / `moves`,
//          read by the backend from the step itself -- round 10 replaced the
//          parse of the step's DESCRIPTION, which could not name a grouped
//          step or a cell shift). Live Excel 16 (2026-10-30): a watch on C5
//          reads C6 after a row inserted above, Ctrl+Z puts it on C5, Ctrl+Y
//          on C6 again; Insert B2:B3 shift down turns =B7 into =B9 and leaves
//          =SUM(A3:B5) alone.

import { describe, it, expect } from "vitest";
import { AppEvents } from "../events";
import {
  followCell,
  followRange,
  followSheetRenumbering,
  followStructuralEdits,
  inverseStructuralEdit,
  shiftCellByEdit,
  shiftRangeByEdit,
  type StructuralFollowEdit,
  type StructuralFollowStep,
} from "../structuralFollow";
import { BEYOND_EVERY_SHEET } from "../../core/state/sheetRenumbering";

/** A private event bus standing in for `onAppEvent`. */
function bus() {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  return {
    subscribe: (name: string, cb: (d: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(cb);
      listeners.set(name, set);
      return () => {
        set.delete(cb);
      };
    },
    emit: (name: string, detail?: unknown) => {
      for (const cb of listeners.get(name) ?? []) cb(detail);
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function follow(active = 0) {
  const b = bus();
  const steps: StructuralFollowStep[] = [];
  const off = followStructuralEdits((s) => steps.push(s), { subscribe: b.subscribe, activeSheet: () => active });
  return { b, steps, off };
}

function followWithMoves(active = 0) {
  const b = bus();
  const steps: StructuralFollowStep<StructuralFollowEdit>[] = [];
  const off = followStructuralEdits((s) => steps.push(s), { subscribe: b.subscribe, activeSheet: () => active, moves: true });
  return { b, steps, off };
}

const undo = (deltas: unknown[]) => ({ description: "anything at all", source: "undo", deltas });
const redo = (deltas: unknown[]) => ({ description: "anything at all", source: "redo", deltas });

describe("the shift rules", () => {
  it("a cell moves with its line and a deleted cell is gone", () => {
    expect(shiftCellByEdit({ kind: "rowInsert", at: 2, count: 1 }, 4, 2)).toEqual({ row: 5, col: 2 });
    expect(shiftCellByEdit({ kind: "colInsert", at: 0, count: 1 }, 5, 2)).toEqual({ row: 5, col: 3 });
    expect(shiftCellByEdit({ kind: "rowDelete", at: 4, count: 1 }, 4, 2)).toBeNull();
    expect(shiftCellByEdit({ kind: "rowDelete", at: 1, count: 2 }, 4, 2)).toEqual({ row: 2, col: 2 });
  });

  it("a range moves, grows, shrinks and is gone as a formula reference is", () => {
    const r = { startRow: 3, startCol: 0, endRow: 14, endCol: 2, expandToRegion: false };
    expect(shiftRangeByEdit({ kind: "rowInsert", at: 3, count: 1 }, r)).toEqual({ ...r, startRow: 4, endRow: 15 });
    expect(shiftRangeByEdit({ kind: "rowInsert", at: 5, count: 2 }, r)).toEqual({ ...r, endRow: 16 });
    expect(shiftRangeByEdit({ kind: "rowInsert", at: 15, count: 1 }, r)).toEqual(r);
    expect(shiftRangeByEdit({ kind: "rowDelete", at: 2, count: 3 }, r)).toEqual({ ...r, startRow: 2, endRow: 11 });
    expect(shiftRangeByEdit({ kind: "rowDelete", at: 3, count: 12 }, r)).toBeNull();
    expect(shiftRangeByEdit({ kind: "colInsert", at: 1, count: 1 }, r)).toEqual({ ...r, endCol: 3 });
    expect(shiftRangeByEdit({ kind: "colDelete", at: 0, count: 3 }, r)).toBeNull();
  });

  it("[LIVE] an Insert / Delete Cells BAND moves only what lies inside it", () => {
    // Insert B2:B3 shift down: rows 1..2 inserted in column B only.
    const ins = { kind: "rowInsert" as const, at: 1, count: 2, band: { start: 1, end: 1 } };
    expect(shiftCellByEdit(ins, 6, 1)).toEqual({ row: 8, col: 1 }); // =B7 -> =B9
    expect(shiftCellByEdit(ins, 6, 0)).toEqual({ row: 6, col: 0 }); // A7 stays
    const range = (sr: number, sc: number, er: number, ec: number) => ({ startRow: sr, startCol: sc, endRow: er, endCol: ec });
    expect(shiftRangeByEdit(ins, range(0, 1, 9, 1))).toEqual(range(0, 1, 11, 1)); // B1:B10 -> B1:B12
    expect(shiftRangeByEdit(ins, range(2, 1, 4, 1))).toEqual(range(4, 1, 6, 1)); // B3:B5 -> B5:B7
    expect(shiftRangeByEdit(ins, range(0, 0, 9, 2))).toEqual(range(0, 0, 9, 2)); // A1:C10 stays
    expect(shiftRangeByEdit(ins, range(2, 0, 4, 1))).toEqual(range(2, 0, 4, 1)); // A3:B5 stays
    // Delete B4:B5 shift up.
    const del = { kind: "rowDelete" as const, at: 3, count: 2, band: { start: 1, end: 1 } };
    expect(shiftCellByEdit(del, 3, 1)).toBeNull();
    expect(shiftCellByEdit(del, 3, 2)).toEqual({ row: 3, col: 2 });
    expect(shiftRangeByEdit(del, range(0, 1, 11, 1))).toEqual(range(0, 1, 9, 1)); // B1:B12 -> B1:B10
  });

  it("[LIVE] a move takes the cells of its block where it landed, and a cell it landed on is gone", () => {
    const move = {
      kind: "move" as const,
      fromSheetIndex: 0, fromStartRow: 4, fromStartCol: 2, fromEndRow: 4, fromEndCol: 2,
      toSheetIndex: 1, toRow: 7, toCol: 5,
    };
    expect(followCell(move, 0, 4, 2)).toEqual({ sheetIndex: 1, row: 7, col: 5 }); // Sheet1!C5 -> Sheet2!F8
    expect(followCell(move, 1, 7, 5)).toBeNull(); // the overwritten F8
    expect(followCell(move, 0, 7, 5)).toEqual({ sheetIndex: 0, row: 7, col: 5 }); // F8 on the source sheet stays
    expect(followCell(move, 1, 4, 2)).toEqual({ sheetIndex: 1, row: 4, col: 2 }); // C5 on another sheet stays
    const inverse = inverseStructuralEdit(move);
    expect(inverse).toEqual({
      kind: "move",
      fromSheetIndex: 1, fromStartRow: 7, fromStartCol: 5, fromEndRow: 7, fromEndCol: 5,
      toSheetIndex: 0, toRow: 4, toCol: 2,
    });
    expect(followCell(inverse, 1, 7, 5)).toEqual({ sheetIndex: 0, row: 4, col: 2 });
    const block = { kind: "move" as const, fromSheetIndex: 0, fromStartRow: 0, fromStartCol: 0, fromEndRow: 3, fromEndCol: 1, toSheetIndex: 0, toRow: 10, toCol: 4 };
    expect(followRange(block, 0, { startRow: 1, startCol: 0, endRow: 2, endCol: 1 })).toEqual({
      sheetIndex: 0,
      range: { startRow: 11, startCol: 4, endRow: 12, endCol: 5 },
    });
    // Only partly inside: it stays.
    expect(followRange(block, 0, { startRow: 2, startCol: 0, endRow: 6, endCol: 1 })?.range).toEqual({ startRow: 2, startCol: 0, endRow: 6, endCol: 1 });
    expect(inverseStructuralEdit({ sheetIndex: 0, kind: "rowInsert", at: 2, count: 1 }).kind).toBe("rowDelete");
  });
});

describe("followStructuralEdits", () => {
  it("an on-screen insert is an edit on the active sheet; its Undo / Redo follow the step's deltas, same seq", () => {
    const { b, steps } = follow(1);
    b.emit(AppEvents.ROWS_INSERTED, { startRow: 2, count: 1 });
    expect(steps).toEqual([{ edit: { sheetIndex: 1, kind: "rowInsert", at: 2, count: 1 }, cause: "edit", seq: 1 }]);
    b.emit(AppEvents.STRUCTURAL_UNDO, undo([{ kind: "rowDelete", sheetIndex: 1, at: 2, count: 1, band: null }]));
    expect(steps[1]).toEqual({ edit: { sheetIndex: 1, kind: "rowDelete", at: 2, count: 1 }, cause: "undo", seq: 1 });
    b.emit(AppEvents.STRUCTURAL_UNDO, redo([{ kind: "rowInsert", sheetIndex: 1, at: 2, count: 1, band: null }]));
    expect(steps[2]).toEqual({ edit: { sheetIndex: 1, kind: "rowInsert", at: 2, count: 1 }, cause: "redo", seq: 1 });
  });

  it("a GROUPED step (a macro holding three edits) is followed edit by edit, whatever its description", () => {
    const { b, steps } = follow(0);
    b.emit(AppEvents.ROWS_INSERTED, { startRow: 1, count: 2 });
    b.emit(AppEvents.COLUMNS_INSERTED, { startCol: 3, count: 1 });
    b.emit(AppEvents.ROWS_DELETED, { startRow: 9, count: 1 });
    b.emit(AppEvents.STRUCTURAL_UNDO, {
      description: "Run macro",
      source: "undo",
      deltas: [
        { kind: "rowInsert", sheetIndex: 0, at: 9, count: 1, band: null },
        { kind: "colDelete", sheetIndex: 0, at: 3, count: 1, band: null },
        { kind: "rowDelete", sheetIndex: 0, at: 1, count: 2, band: null },
      ],
    });
    expect(steps.slice(3).map((s) => [s.edit.kind, s.edit.at, s.cause, s.seq])).toEqual([
      ["rowInsert", 9, "undo", 3],
      ["colDelete", 3, "undo", 2],
      ["rowDelete", 1, "undo", 1],
    ]);
    b.emit(AppEvents.STRUCTURAL_UNDO, {
      description: "Run macro",
      source: "redo",
      deltas: [
        { kind: "rowInsert", sheetIndex: 0, at: 1, count: 2, band: null },
        { kind: "colInsert", sheetIndex: 0, at: 3, count: 1, band: null },
        { kind: "rowDelete", sheetIndex: 0, at: 9, count: 1, band: null },
      ],
    });
    expect(steps.slice(6).map((s) => [s.edit.kind, s.cause, s.seq])).toEqual([
      ["rowInsert", "redo", 1],
      ["colInsert", "redo", 2],
      ["rowDelete", "redo", 3],
    ]);
  });

  it("an edit on another sheet is followed on that sheet, and a floating grid's own lines are not", () => {
    const { b, steps } = follow(0);
    b.emit(AppEvents.STRUCTURAL_EDIT_ELSEWHERE, {
      descriptions: ["Insert Columns"],
      edits: [
        { sheetIndex: 2, kind: "colInsert", at: 0, count: 1 },
        { sheetIndex: null, kind: "rowInsert", at: 0, count: 1 },
      ],
    });
    expect(steps.map((s) => s.edit)).toEqual([{ sheetIndex: 2, kind: "colInsert", at: 0, count: 1 }]);
    b.emit(AppEvents.STRUCTURAL_UNDO, undo([{ kind: "colDelete", sheetIndex: 2, at: 0, count: 1, band: null }]));
    expect(steps[1]).toMatchObject({ edit: { sheetIndex: 2, kind: "colDelete", at: 0, count: 1 }, cause: "undo", seq: 1 });
  });

  it("an undo this subscription never heard is followed all the same, under a fresh seq", () => {
    const { b, steps } = follow(0);
    b.emit(AppEvents.ROWS_INSERTED, { startRow: 2, count: 1 });
    b.emit(AppEvents.STRUCTURAL_UNDO, undo([{ kind: "colInsert", sheetIndex: 0, at: 4, count: 2, band: null }]));
    expect(steps[1]).toMatchObject({ edit: { kind: "colInsert", at: 4, count: 2 }, cause: "undo" });
    expect(steps[1].seq).not.toBe(1);
    // An undo that cannot say what it moved moves nothing.
    b.emit(AppEvents.STRUCTURAL_UNDO, { description: "Insert 1 row(s)", source: "undo" });
    expect(steps).toHaveLength(2);
  });

  it("an Insert Cells (source edit) is followed with its band, and its undo reverses that band", () => {
    const { b, steps } = follow(0);
    const band = { start: 1, end: 2 };
    b.emit(AppEvents.STRUCTURAL_UNDO, { description: "Insert Cells", source: "edit", deltas: [{ kind: "rowInsert", sheetIndex: 0, at: 1, count: 2, band }] });
    expect(steps[0]).toEqual({ edit: { sheetIndex: 0, kind: "rowInsert", at: 1, count: 2, band }, cause: "edit", seq: 1 });
    b.emit(AppEvents.STRUCTURAL_UNDO, undo([{ kind: "rowDelete", sheetIndex: 0, at: 1, count: 2, band }]));
    expect(steps[1]).toEqual({ edit: { sheetIndex: 0, kind: "rowDelete", at: 1, count: 2, band }, cause: "undo", seq: 1 });
  });

  it("moves reach only a follower that takes them (CELLS_MOVED, and its undo)", () => {
    const move = { kind: "move", fromSheetIndex: 0, fromStartRow: 4, fromStartCol: 2, fromEndRow: 4, fromEndCol: 2, toSheetIndex: 0, toRow: 7, toCol: 5 };
    const lines = follow(0);
    lines.b.emit(AppEvents.CELLS_MOVED, { moves: [move], source: "edit" });
    expect(lines.steps).toHaveLength(0);
    const all = followWithMoves(0);
    all.b.emit(AppEvents.CELLS_MOVED, { moves: [move], source: "edit" });
    expect(all.steps[0]).toEqual({ edit: move, cause: "edit", seq: 1 });
    all.b.emit(AppEvents.CELLS_MOVED, { moves: [inverseStructuralEdit(move as StructuralFollowEdit)], source: "undo" });
    expect(all.steps[1]).toMatchObject({ cause: "undo", seq: 1, edit: { fromStartRow: 7, toRow: 4 } });
  });

  it("a new edit clears what could be redone, and the cleanup drops every subscription", () => {
    const { b, steps, off } = follow(0);
    b.emit(AppEvents.ROWS_INSERTED, { startRow: 2, count: 1 });
    b.emit(AppEvents.STRUCTURAL_UNDO, undo([{ kind: "rowDelete", sheetIndex: 0, at: 2, count: 1 }]));
    b.emit(AppEvents.ROWS_DELETED, { startRow: 9, count: 1 });
    b.emit(AppEvents.STRUCTURAL_UNDO, redo([{ kind: "rowInsert", sheetIndex: 0, at: 2, count: 1 }]));
    expect(steps.map((s) => s.cause)).toEqual(["edit", "undo", "edit", "redo"]);
    expect(steps[3].seq).not.toBe(steps[0].seq);
    off();
    expect(b.count()).toBe(0);
  });
});

describe("followSheetRenumbering", () => {
  it("hands the rule for a move, an insertion and a removal", () => {
    const target = new EventTarget() as unknown as Window;
    const seen: Array<Array<number | null>> = [];
    const off = followSheetRenumbering((renumber) => seen.push([0, 1, 2, 3].map(renumber)), target);
    const reorder = (fromIndex: number, toIndex: number) =>
      target.dispatchEvent(new CustomEvent("sheet:reorder", { detail: { fromIndex, toIndex } }));
    reorder(1, 0); // Sheet2 moved before Sheet1
    reorder(BEYOND_EVERY_SHEET, 1); // a sheet inserted at 1
    reorder(2, BEYOND_EVERY_SHEET); // the sheet at 2 deleted
    expect(seen).toEqual([
      [1, 0, 2, 3],
      [0, 2, 3, 4],
      [0, 1, null, 2],
    ]);
    off();
    reorder(1, 0);
    expect(seen).toHaveLength(3);
  });
});
