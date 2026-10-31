//! FILENAME: app/src/api/structuralFollow.ts
// PURPOSE: ONE way for a store that holds CELL COORDINATES the backend never
//   sees (a Watch Window entry, a cell bookmark, an Insights overlay's range,
//   an animation's driver cell) to follow inserted and deleted rows and
//   columns, Insert / Delete Cells and moved cells -- on the sheet on screen,
//   on any other sheet, and back again on Undo and Redo -- the way Excel's own
//   references do.
// CONTEXT: BUG-0614. Measured on live Excel 16 (2026-10-30, a fresh unsaved
//   workbook): a Watch Window entry on C5 reads C6 after a row is inserted
//   above it and D6 after a column is inserted left of it; Ctrl+Z returns it
//   to C5 and Ctrl+Y to C6 again; deleting the watched cell's row removes the
//   entry. A cut-paste of the watched cell moves the entry with it, and Undo
//   moves it back.
//
//   The announcements a coordinate change makes are combined here:
//     - ROWS_INSERTED / ROWS_DELETED / COLUMNS_INSERTED / COLUMNS_DELETED: an
//       edit on the sheet ON SCREEN ({ startRow | startCol, count }); the
//       sheet is the active one when the event is heard.
//     - STRUCTURAL_EDIT_ELSEWHERE: edits on OTHER sheets, every edit of the
//       burst in order (a floating grid's own lines, sheetIndex null, move no
//       sheet cell and are skipped).
//     - STRUCTURAL_UNDO (StructuralUndoPayload): `source: "edit"` for an
//       Insert / Delete Cells, with its band shift; `source: "undo" | "redo"`
//       for the Undo / Redo of a structural step, with `deltas`, the changes
//       it made in the order made -- read by the backend from the STEP ITSELF
//       (`UndoResult.structuralDeltas`), so a grouped step (a macro holding
//       several inserts) and a cell shift are followed exactly, whatever the
//       step's description says. `source: "rollback"` for a gesture taken
//       back to its savepoint (Insert Copied Cells whose paste did not land):
//       followed as the Undo of the edits it announced, with nothing to Redo.
//     - CELLS_MOVED (CellsMovedPayload): a Cut + Paste (or drag) that moved a
//       block, and the Undo / Redo of a step that did.
//
//   Each subscription keeps a JOURNAL of the changes it heard, only to give an
//   undo the SAME `seq` as the edit it reverses (a store puts back on undo what
//   that edit took -- a cell bookmark on a deleted row). The movement itself
//   always comes from the deltas; a journal that does not match them (a step
//   this subscription never heard) only means a fresh `seq`.
//
//   The shift rules are a formula reference's: a cell moves with its line and
//   a deleted cell is gone (`null`); a range grows when lines are inserted
//   inside it, shrinks when some of its lines are deleted and is gone when all
//   of them are. A BAND edit (Insert / Delete Cells) moves only the cells
//   inside its band, and a range only when it lies wholly inside the band
//   [LIVE 2026-10-30: Insert B2:B3 shift down turns =SUM(B1:B10) into
//   B1:B12 and =B7 into =B9, and leaves =SUM(A1:C10) and =SUM(A3:B5)
//   alone]. A MOVE takes the cells of its block (and a range wholly inside
//   it) to where the block landed. `structuralAnchorShift`
//   (scriptHost/embeddedFormPlacements.ts) is the whole-line cell rule, shared
//   with the embedded forms and Controls.

import { AppEvents, onAppEvent } from "./events";
import type { CellsMovedPayload, StructuralEditElsewherePayload, StructuralUndoPayload } from "./events";
import { getGridStateSnapshot } from "./grid";
import { structuralAnchorShift, type StructuralEditKind } from "./scriptHost/embeddedFormPlacements";
import type { DeltaBand, StructuralDelta, StructuralMoveDelta } from "../core/types";
import { renumberedSheetIndex } from "../core/state/sheetRenumbering";

export type { StructuralEditKind } from "./scriptHost/embeddedFormPlacements";
export type { DeltaBand, StructuralDelta, StructuralLineDelta, StructuralMoveDelta } from "../core/types";

/** One row / column edit on one sheet -- whole lines, or a band of cells. */
export interface StructuralLineEdit {
  /** The sheet whose lines moved (0-based). */
  sheetIndex: number;
  kind: StructuralEditKind;
  /** The first row (column) inserted or deleted, 0-based. */
  at: number;
  /** How many rows (columns). */
  count: number;
  /**
   * Insert / Delete Cells: only the cells inside this band move -- the columns
   * of a row-wise shift, the rows of a column-wise one. Absent (or null) for
   * whole lines.
   */
  band?: DeltaBand | null;
}

/** A block of cells that moved (Cut + Paste, drag): `StructuralMoveDelta`. */
export type StructuralCellMove = StructuralMoveDelta;

/** Any coordinate change a follower that takes moves is handed. */
export type StructuralFollowEdit = StructuralLineEdit | StructuralCellMove;

/** Why a step is applied: the edit itself, its undo (the INVERSE change) or its redo. */
export type StructuralFollowCause = "edit" | "undo" | "redo";

/** What a follower is handed: the change to apply now, why, and which journal entry it is. */
export interface StructuralFollowStep<E extends StructuralFollowEdit = StructuralLineEdit> {
  /** The change to APPLY now (for an undo, already the inverse of the one undone). */
  edit: E;
  cause: StructuralFollowCause;
  /**
   * The journal entry this step belongs to: the same number for an edit, its
   * undo and its redo, so a store can put back on undo what that edit took
   * (a cell bookmark on a deleted row) and take it again on redo.
   */
  seq: number;
}

/** A rectangle of cells, 0-based and inclusive. */
export interface StructuralRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Whether `index` (the coordinate across the edit) lies in the band; no band = every index. */
function inBand(band: DeltaBand | null | undefined, index: number): boolean {
  return !band || (index >= band.start && index <= band.end);
}

/** Where a cell goes under one line edit; `null` when the cell was deleted. */
export function shiftCellByEdit(
  edit: Pick<StructuralLineEdit, "kind" | "at" | "count" | "band">,
  row: number,
  col: number,
): { row: number; col: number } | null {
  const rows = edit.kind === "rowInsert" || edit.kind === "rowDelete";
  if (!inBand(edit.band, rows ? col : row)) return { row, col };
  return structuralAnchorShift(edit.kind, edit.at, edit.count)(row, col);
}

/** One interval [lo, hi] under an insert or delete of `count` lines at `at`; null when every line went. */
function shiftInterval(insert: boolean, at: number, count: number, lo: number, hi: number): [number, number] | null {
  if (insert) {
    if (lo >= at) return [lo + count, hi + count];
    if (hi >= at) return [lo, hi + count];
    return [lo, hi];
  }
  const last = at + count - 1;
  const nlo = lo < at ? lo : lo > last ? lo - count : at;
  const nhi = hi < at ? hi : hi > last ? hi - count : at - 1;
  return nlo > nhi ? null : [nlo, nhi];
}

/**
 * Where a range goes under one line edit, as a formula reference goes: it
 * moves with lines inserted at or before its first line, grows with lines
 * inserted inside it, shrinks with some of its lines deleted, and is `null`
 * when all of them were. Under a BAND edit it moves only when it lies wholly
 * inside the band; one that reaches outside it stays as it is (Excel's
 * references do the same [LIVE]). Every other field of the range is kept.
 */
export function shiftRangeByEdit<R extends StructuralRange>(
  edit: Pick<StructuralLineEdit, "kind" | "at" | "count" | "band">,
  range: R,
): R | null {
  const rows = edit.kind === "rowInsert" || edit.kind === "rowDelete";
  const insert = edit.kind === "rowInsert" || edit.kind === "colInsert";
  const r0 = Math.min(range.startRow, range.endRow);
  const r1 = Math.max(range.startRow, range.endRow);
  const c0 = Math.min(range.startCol, range.endCol);
  const c1 = Math.max(range.startCol, range.endCol);
  if (edit.band) {
    const [p0, p1] = rows ? [c0, c1] : [r0, r1];
    if (p0 < edit.band.start || p1 > edit.band.end) return { ...range };
  }
  const moved = shiftInterval(insert, edit.at, edit.count, rows ? r0 : c0, rows ? r1 : c1);
  if (moved === null) return null;
  return rows
    ? { ...range, startRow: moved[0], endRow: moved[1], startCol: c0, endCol: c1 }
    : { ...range, startRow: r0, endRow: r1, startCol: moved[0], endCol: moved[1] };
}

/** A move's source block, normalised. */
function moveBlock(move: StructuralCellMove): StructuralRange {
  return {
    startRow: Math.min(move.fromStartRow, move.fromEndRow),
    startCol: Math.min(move.fromStartCol, move.fromEndCol),
    endRow: Math.max(move.fromStartRow, move.fromEndRow),
    endCol: Math.max(move.fromStartCol, move.fromEndCol),
  };
}

/**
 * Where a cell on `sheetIndex` goes under any change: a line edit on its
 * sheet shifts it (`null` = deleted); a move takes a cell of its block to
 * where the block landed, on the sheet it landed on, and a cell the block
 * landed on is gone (`null`, overwritten). Every other cell stays.
 */
export function followCell(
  edit: StructuralFollowEdit,
  sheetIndex: number,
  row: number,
  col: number,
): { sheetIndex: number; row: number; col: number } | null {
  if (edit.kind === "move") {
    const block = moveBlock(edit);
    if (
      sheetIndex === edit.fromSheetIndex &&
      row >= block.startRow && row <= block.endRow &&
      col >= block.startCol && col <= block.endCol
    ) {
      return {
        sheetIndex: edit.toSheetIndex,
        row: edit.toRow + (row - block.startRow),
        col: edit.toCol + (col - block.startCol),
      };
    }
    // A cell the block landed ON was overwritten: gone, as Excel's Watch
    // Window drops a watch on it [LIVE 2026-10-30: a watch on F8, C5 cut and
    // pasted onto F8 -> the watch is removed].
    if (
      sheetIndex === edit.toSheetIndex &&
      row >= edit.toRow && row <= edit.toRow + (block.endRow - block.startRow) &&
      col >= edit.toCol && col <= edit.toCol + (block.endCol - block.startCol)
    ) {
      return null;
    }
    return { sheetIndex, row, col };
  }
  if (sheetIndex !== edit.sheetIndex) return { sheetIndex, row, col };
  const moved = shiftCellByEdit(edit, row, col);
  return moved === null ? null : { sheetIndex, ...moved };
}

/**
 * Where a range on `sheetIndex` goes under any change: a line edit on its
 * sheet as `shiftRangeByEdit`; a move takes a range wholly inside its block
 * to where the block landed (a range only partly inside stays, as a formula
 * reference does).
 */
export function followRange<R extends StructuralRange>(
  edit: StructuralFollowEdit,
  sheetIndex: number,
  range: R,
): { sheetIndex: number; range: R } | null {
  if (edit.kind === "move") {
    const block = moveBlock(edit);
    const r0 = Math.min(range.startRow, range.endRow);
    const r1 = Math.max(range.startRow, range.endRow);
    const c0 = Math.min(range.startCol, range.endCol);
    const c1 = Math.max(range.startCol, range.endCol);
    if (
      sheetIndex === edit.fromSheetIndex &&
      r0 >= block.startRow && r1 <= block.endRow &&
      c0 >= block.startCol && c1 <= block.endCol
    ) {
      const dr = edit.toRow - block.startRow;
      const dc = edit.toCol - block.startCol;
      return {
        sheetIndex: edit.toSheetIndex,
        range: { ...range, startRow: r0 + dr, endRow: r1 + dr, startCol: c0 + dc, endCol: c1 + dc },
      };
    }
    return { sheetIndex, range };
  }
  if (sheetIndex !== edit.sheetIndex) return { sheetIndex, range };
  const moved = shiftRangeByEdit(edit, range);
  return moved === null ? null : { sheetIndex, range: moved };
}

/**
 * The change that undoes `edit`: an insert's undo deletes the same lines (the
 * same band), a delete's undo inserts them, a move's undo moves the landed
 * block back to where it came from.
 */
export function inverseStructuralEdit<E extends StructuralFollowEdit>(edit: E): E {
  if (edit.kind === "move") {
    const block = moveBlock(edit);
    const inverse: StructuralCellMove = {
      kind: "move",
      fromSheetIndex: edit.toSheetIndex,
      fromStartRow: edit.toRow,
      fromStartCol: edit.toCol,
      fromEndRow: edit.toRow + (block.endRow - block.startRow),
      fromEndCol: edit.toCol + (block.endCol - block.startCol),
      toSheetIndex: edit.fromSheetIndex,
      toRow: block.startRow,
      toCol: block.startCol,
    };
    return inverse as E;
  }
  const kind: StructuralEditKind =
    edit.kind === "rowInsert" ? "rowDelete"
    : edit.kind === "rowDelete" ? "rowInsert"
    : edit.kind === "colInsert" ? "colDelete"
    : "colInsert";
  return { ...edit, kind };
}

/** Whether two changes are the same change (a band absent and null are the same). */
export function sameStructuralEdit(a: StructuralFollowEdit, b: StructuralFollowEdit): boolean {
  if (a.kind === "move" || b.kind === "move") {
    if (a.kind !== "move" || b.kind !== "move") return false;
    return (
      a.fromSheetIndex === b.fromSheetIndex &&
      a.fromStartRow === b.fromStartRow && a.fromStartCol === b.fromStartCol &&
      a.fromEndRow === b.fromEndRow && a.fromEndCol === b.fromEndCol &&
      a.toSheetIndex === b.toSheetIndex && a.toRow === b.toRow && a.toCol === b.toCol
    );
  }
  return (
    a.kind === b.kind && a.sheetIndex === b.sheetIndex && a.at === b.at && a.count === b.count &&
    (a.band?.start ?? null) === (b.band?.start ?? null) && (a.band?.end ?? null) === (b.band?.end ?? null)
  );
}

/** A delta off the wire, checked: the change it names, or null for anything malformed. */
function readDelta(raw: unknown): StructuralFollowEdit | null {
  const d = raw as Partial<StructuralDelta> | null;
  if (!d || typeof d !== "object") return null;
  const n = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (d.kind === "move") {
    const m = d as Partial<StructuralMoveDelta>;
    const fields = [m.fromSheetIndex, m.fromStartRow, m.fromStartCol, m.fromEndRow, m.fromEndCol, m.toSheetIndex, m.toRow, m.toCol];
    return fields.every(n) ? (m as StructuralMoveDelta) : null;
  }
  if (d.kind !== "rowInsert" && d.kind !== "rowDelete" && d.kind !== "colInsert" && d.kind !== "colDelete") return null;
  const l = d as Partial<StructuralLineEdit>;
  if (!n(l.sheetIndex) || !n(l.at) || !n(l.count)) return null;
  const band = l.band && n(l.band.start) && n(l.band.end) ? { start: l.band.start, end: l.band.end } : null;
  return { sheetIndex: l.sheetIndex, kind: d.kind, at: l.at, count: l.count, ...(band ? { band } : {}) };
}

/**
 * Follow the sheet list being RENUMBERED -- a sheet moved, inserted or deleted
 * (Core's `sheet:reorder`, which the tab strip and the script doors both send)
 * -- synchronously, so a store keyed by sheet index is renumbered before any
 * later edit names the new numbering. `onRenumber` is handed the rule: where
 * the sheet that stood at an index stands now, or null when it was deleted
 * (core/state/sheetRenumbering.ts, the rule Core's own per-sheet stores use).
 * A store that also keeps the sheet's stable id re-checks it against the
 * backend's list afterwards (`SheetInfo.sheetId`); this keeps it right in
 * between. Excel's Watch Window follows its sheet when the sheet is moved and
 * drops the watch when the sheet is deleted [LIVE 2026-10-30].
 */
export function followSheetRenumbering(
  onRenumber: (renumber: (index: number) => number | null) => void,
  target: Window = window,
): () => void {
  const onReorder = (event: Event): void => {
    const detail = (event as CustomEvent<{ fromIndex?: unknown; toIndex?: unknown } | undefined>).detail;
    const from = detail?.fromIndex;
    const to = detail?.toIndex;
    if (typeof from !== "number" || typeof to !== "number" || from === to) return;
    try {
      onRenumber((index) => renumberedSheetIndex(index, from, to));
    } catch (err) {
      console.error("[structuralFollow] a sheet renumbering follower failed:", err);
    }
  };
  target.addEventListener("sheet:reorder", onReorder);
  return () => target.removeEventListener("sheet:reorder", onReorder);
}

/** The four on-screen events and the edit kind each announces. */
const ON_SCREEN: ReadonlyArray<readonly [string, StructuralEditKind]> = [
  [AppEvents.ROWS_INSERTED, "rowInsert"],
  [AppEvents.ROWS_DELETED, "rowDelete"],
  [AppEvents.COLUMNS_INSERTED, "colInsert"],
  [AppEvents.COLUMNS_DELETED, "colDelete"],
];

/** The sheet on screen, as the grid state holds it right now. */
function activeSheetNow(): number | null {
  const ctx = getGridStateSnapshot()?.sheetContext as { activeSheetIndex?: number } | undefined;
  return typeof ctx?.activeSheetIndex === "number" ? ctx.activeSheetIndex : null;
}

/** The subscription shape (`onAppEvent`, or an extension context's `events.on`). */
export type StructuralFollowSubscribe = (eventName: string, callback: (detail: unknown) => void) => () => void;

export interface FollowStructuralEditsOptions {
  /** Defaults to `onAppEvent`. */
  subscribe?: StructuralFollowSubscribe;
  /** The sheet on screen; defaults to the grid state's. */
  activeSheet?: () => number | null;
}

/** A follower that takes MOVED cells too (Cut + Paste, drag) as well as line edits. */
export interface FollowStructuralEditsWithMovesOptions extends FollowStructuralEditsOptions {
  moves: true;
}

/**
 * Call `onStep` for every row / column edit on any sheet (whole lines or an
 * Insert / Delete Cells band), for its Undo (with the inverse change) and for
 * its Redo -- see the header. With `{ moves: true }` the follower is handed
 * moved blocks of cells too. Synchronous: the step is applied in the order the
 * events are heard. Returns the one cleanup.
 */
export function followStructuralEdits(
  onStep: (step: StructuralFollowStep<StructuralFollowEdit>) => void,
  options: FollowStructuralEditsWithMovesOptions,
): () => void;
export function followStructuralEdits(
  onStep: (step: StructuralFollowStep) => void,
  options?: FollowStructuralEditsOptions,
): () => void;
export function followStructuralEdits(
  onStep: ((step: StructuralFollowStep<StructuralFollowEdit>) => void) | ((step: StructuralFollowStep) => void),
  options: FollowStructuralEditsOptions & { moves?: boolean } = {},
): () => void {
  const subscribe: StructuralFollowSubscribe =
    options.subscribe ?? ((eventName, callback) => onAppEvent(eventName, callback));
  const activeSheet = options.activeSheet ?? activeSheetNow;
  const takesMoves = options.moves === true;
  type Entry = { edit: StructuralFollowEdit; seq: number };
  // The changes heard, in the order they can be undone (undo) and redone (redo).
  let undoJournal: Entry[] = [];
  let redoJournal: Entry[] = [];
  let nextSeq = 1;

  const run = (step: StructuralFollowStep<StructuralFollowEdit>): void => {
    if (step.edit.kind === "move" && !takesMoves) return;
    try {
      (onStep as (s: StructuralFollowStep<StructuralFollowEdit>) => void)(step);
    } catch (err) {
      console.error("[structuralFollow] a follower failed:", err);
    }
  };
  const forward = (edit: StructuralFollowEdit): void => {
    const entry = { edit, seq: nextSeq++ };
    undoJournal.push(entry);
    redoJournal = [];
    run({ edit, cause: "edit", seq: entry.seq });
  };
  const forget = (): void => {
    undoJournal = [];
    redoJournal = [];
  };
  // An Undo hands the change to apply now -- the INVERSE of the one undone,
  // newest first. The journal only lends it the undone edit's seq.
  const undo = (applied: StructuralFollowEdit): void => {
    const top = undoJournal[undoJournal.length - 1];
    let seq: number;
    if (top !== undefined && sameStructuralEdit(inverseStructuralEdit(top.edit), applied)) {
      undoJournal.pop();
      seq = top.seq;
    } else {
      // A step this subscription never heard (or heard otherwise): follow it
      // all the same, under a fresh number; what came before cannot be matched.
      forget();
      seq = nextSeq++;
    }
    redoJournal.push({ edit: inverseStructuralEdit(applied), seq });
    run({ edit: applied, cause: "undo", seq });
  };
  // A gesture TAKEN BACK to its savepoint (STRUCTURAL_UNDO `source:
  // "rollback"`): the inverse of an edit it announced, applied as that edit's
  // Undo (same seq, cause "undo", so a store puts back what the edit took) --
  // but the gesture never happened, so there is nothing to Redo.
  const rollback = (applied: StructuralFollowEdit): void => {
    const top = undoJournal[undoJournal.length - 1];
    let seq: number;
    if (top !== undefined && sameStructuralEdit(inverseStructuralEdit(top.edit), applied)) {
      undoJournal.pop();
      seq = top.seq;
    } else {
      forget();
      seq = nextSeq++;
    }
    run({ edit: applied, cause: "undo", seq });
  };
  const redo = (applied: StructuralFollowEdit): void => {
    const top = redoJournal[redoJournal.length - 1];
    let seq: number;
    if (top !== undefined && sameStructuralEdit(top.edit, applied)) {
      redoJournal.pop();
      seq = top.seq;
    } else {
      forget();
      seq = nextSeq++;
    }
    undoJournal.push({ edit: applied, seq });
    run({ edit: applied, cause: "redo", seq });
  };
  const applyAll = (source: unknown, raw: unknown): void => {
    if (!Array.isArray(raw)) {
      // An undo / redo that cannot say what it moved: nothing is moved, and
      // the journal no longer lines up with the backend's history.
      if (source === "undo" || source === "redo") forget();
      return;
    }
    for (const item of raw) {
      const edit = readDelta(item);
      if (edit === null) continue;
      if (source === "undo") undo(edit);
      else if (source === "rollback") rollback(edit);
      else if (source === "redo") redo(edit);
      else if (source === "edit") forward(edit);
    }
  };

  const offs: Array<() => void> = [];
  for (const [eventName, kind] of ON_SCREEN) {
    offs.push(
      subscribe(eventName, (detail) => {
        const d = (detail ?? {}) as { startRow?: number; startCol?: number; count?: number };
        const at = kind.startsWith("row") ? d.startRow : d.startCol;
        const sheetIndex = activeSheet();
        if (typeof at !== "number" || typeof d.count !== "number" || sheetIndex === null) return;
        forward({ sheetIndex, kind, at, count: d.count });
      }),
    );
  }
  offs.push(
    subscribe(AppEvents.STRUCTURAL_EDIT_ELSEWHERE, (detail) => {
      const edits = (detail as Partial<StructuralEditElsewherePayload> | null)?.edits;
      if (!Array.isArray(edits)) return;
      for (const e of edits) {
        if (typeof e?.sheetIndex !== "number") continue; // a floating grid's own lines
        forward({ sheetIndex: e.sheetIndex, kind: e.kind, at: e.at, count: e.count });
      }
    }),
  );
  offs.push(
    subscribe(AppEvents.STRUCTURAL_UNDO, (detail) => {
      const d = (detail ?? {}) as Partial<StructuralUndoPayload>;
      applyAll(d.source, d.deltas);
    }),
  );
  offs.push(
    subscribe(AppEvents.CELLS_MOVED, (detail) => {
      const d = (detail ?? {}) as Partial<CellsMovedPayload>;
      applyAll(d.source, d.moves);
    }),
  );
  // A replaced document starts a new undo history.
  offs.push(subscribe(AppEvents.AFTER_NEW, forget));
  offs.push(subscribe(AppEvents.AFTER_OPEN, forget));
  return () => {
    for (const off of offs) off();
  };
}
