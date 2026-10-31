//! FILENAME: app/src/core/lib/cellsMoved.ts
// PURPOSE: The ONE forward announcement of a block of sheet cells that MOVED
//          (CELLS_MOVED, `source: "edit"`), shared by every Core gesture whose
//          step records the move (`relocate_cell_references` records a Move
//          marker for the step's Undo / Redo).
// CONTEXT: The stores whose coordinates the backend never holds -- a Watch
//          Window entry, a cell bookmark -- follow a move through
//          @api/structuralFollow. The step's Undo / Redo hands them the move
//          back and forth from the step's own record, so EVERY move a step
//          records must also have been announced forward: a recorded move that
//          was never announced made its Undo move a bookmark the gesture had
//          never moved, and delete the one on the cell it "returned" to
//          (round 11, rev10A: Merge & Center that moved a value into the
//          top-left cell). The callers are the Cut + Paste, the drag-moves and
//          the merge gestures.
//          The converse holds for a TAKE-BACK to an undo savepoint
//          (`announceRolledBackRestore`): the followers are handed back exactly
//          the changes they were told about -- every line edit (announced the
//          moment it lands) and each move announced here -- and nothing else.

import { AppEvents as ApiAppEvents, emitAppEvent as emitApiAppEvent } from "../../api/events";
import type { CellsMovedPayload, MutationDomain, StructuralUndoPayload } from "../../api/events";
import type { StructuralDelta, StructuralMoveDelta } from "../types";
import type { UndoResult } from "./tauri-api";

/**
 * The moves announced forward by a gesture whose step JOINED an outer one,
 * newest last (bounded, and released when that outer step closes:
 * `releaseAnnouncedMoves`): a take-back replays the inverse of a move only when
 * the move itself was announced -- a gesture
 * JOINED to an outer step (a granted macro run) announces its move when its
 * own part is kept, and the outer step's take-back must then move the
 * followers back; a gesture taken back inside its OWN step never announced
 * its move, and the take-back must move nothing.
 */
const announcedMoves: AnnouncedMove[] = [];

/**
 * One remembered joined move, tagged with the undo TRANSACTION (the ticket a
 * savepoint names) of the outer step it joined, when the gesture knows it (a
 * cut's or drag-move's move point names it); null when it does not (a merge).
 * A take-back consumes only its own transaction's moves (and untagged ones),
 * and a step's close releases only its own (round 18, rev16B: the release was
 * global, so a run that closed dropped what a gesture still holding ANOTHER
 * step had announced, and a stale move of a closed step could still match).
 */
interface AnnouncedMove {
  move: StructuralMoveDelta;
  transaction: number | null;
}
const ANNOUNCED_MOVES_KEPT = 256;

/**
 * Announce a block of sheet cells that MOVED, once the move has committed:
 * CELLS_MOVED, which the stores that follow cells follow -- Excel's Watch
 * Window entry follows a cut-pasted cell, and a value Merge & Center moved
 * into the top-left cell [LIVE 2026-10-30]. Its Undo / Redo is announced by
 * the undo itself, from the step's own record of the move. A block that did
 * not move announces nothing. `joinedStep`: the gesture's transaction JOINED
 * an outer step (a granted macro run) that may still be taken back to a
 * savepoint -- the move is remembered so that take-back moves the followers
 * back (`announceRolledBackRestore`). A NUMBER is that outer step's
 * transaction (its savepoint's `transaction`), which tags the memory so only
 * that step's take-back and close touch it; `true` joined a step the gesture
 * cannot name.
 */
export function announceCellsMoved(
  fromSheetIndex: number,
  fromStartRow: number,
  fromStartCol: number,
  fromEndRow: number,
  fromEndCol: number,
  toSheetIndex: number,
  toRow: number,
  toCol: number,
  joinedStep: boolean | number = false,
): void {
  if (fromSheetIndex === toSheetIndex && fromStartRow === toRow && fromStartCol === toCol) return;
  const move: StructuralMoveDelta = {
    kind: "move",
    fromSheetIndex,
    fromStartRow,
    fromStartCol,
    fromEndRow,
    fromEndCol,
    toSheetIndex,
    toRow,
    toCol,
  };
  if (joinedStep !== false) {
    announcedMoves.push({ move, transaction: typeof joinedStep === "number" ? joinedStep : null });
    if (announcedMoves.length > ANNOUNCED_MOVES_KEPT) announcedMoves.splice(0, announcedMoves.length - ANNOUNCED_MOVES_KEPT);
  }
  const payload: CellsMovedPayload = { moves: [move], source: "edit" };
  emitApiAppEvent(ApiAppEvents.CELLS_MOVED, payload);
}

/**
 * Forget the remembered joined moves of the outer step that has CLOSED
 * (`transaction`: its moves and the untagged ones -- the backend has ONE open
 * slot, so an untagged move announced while that step was open is that step's,
 * and one left over from a step already closed is stale), or EVERY one when no
 * transaction is named (the document was replaced). Closed means committed
 * (its Undo now hands the moves back from the step's own record) or taken back
 * (`announceRolledBackRestore` has consumed what it undid). A run that only
 * JOINED a caller's step releases nothing: that step is still open, and what
 * a gesture holding it announced is still its own. Without this the memory outlived the run that
 * made it, and a LATER take-back of the same geometry (the user's own refused
 * Cut A1 > Paste C1, inside its own step) matched the stale entry and moved a
 * bookmark on C1 to A1 that no announced move had ever put there (rev14A,
 * round 16). Called by the granted-run step's close (api/scriptHost/host.ts
 * `closeGrantedRunStep`) and the workbook reset (`hostResetAll`).
 */
export function releaseAnnouncedMoves(transaction?: number): void {
  if (transaction === undefined) {
    announcedMoves.length = 0;
    return;
  }
  for (let i = announcedMoves.length - 1; i >= 0; i--) {
    const tag = announcedMoves[i].transaction;
    if (tag === null || tag === transaction) announcedMoves.splice(i, 1);
  }
}

/** Whether `inverse` (a take-back's delta) undoes a move announced forward; consumes that announcement. */
function takeAnnouncedMove(inverse: StructuralMoveDelta, transaction: number | undefined): boolean {
  // The move it undoes: the block that LANDED at inverse.from went there from inverse.to.
  const rows = Math.abs(inverse.fromEndRow - inverse.fromStartRow);
  const cols = Math.abs(inverse.fromEndCol - inverse.fromStartCol);
  const landedRow = Math.min(inverse.fromStartRow, inverse.fromEndRow);
  const landedCol = Math.min(inverse.fromStartCol, inverse.fromEndCol);
  for (let i = announcedMoves.length - 1; i >= 0; i--) {
    const { move: m, transaction: tag } = announcedMoves[i];
    if (transaction !== undefined && tag !== null && tag !== transaction) continue;
    if (
      m.fromSheetIndex === inverse.toSheetIndex &&
      Math.min(m.fromStartRow, m.fromEndRow) === inverse.toRow &&
      Math.min(m.fromStartCol, m.fromEndCol) === inverse.toCol &&
      Math.abs(m.fromEndRow - m.fromStartRow) === rows &&
      Math.abs(m.fromEndCol - m.fromStartCol) === cols &&
      m.toSheetIndex === inverse.fromSheetIndex &&
      m.toRow === landedRow &&
      m.toCol === landedCol
    ) {
      announcedMoves.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Show what a gesture's TAKE-BACK to its undo savepoint restored
 * (`rollBackToUndoSavepoint`, the restore Ctrl+Z uses, leaving nothing to
 * Redo) the way Ctrl+Z shows a restore: the dimensions re-read when lines or
 * merges came back, the cells re-fetched, every refresh domain announced
 * (MUTATION_REFRESH), and the LINE edits it took back announced as
 * STRUCTURAL_UNDO `source: "rollback"` with their inverse deltas -- so the
 * followers that followed the gesture's insert forward (a pending copy's
 * source, cell bookmarks, Watch Window entries: @api/structuralFollow) take
 * the inverse and end up where they were. Before this a refused Insert Copied
 * Cells put the backend back and left the copy's source one row low, so the
 * next Paste pasted the wrong cell (rev12A).
 *
 * A MOVE is replayed only when it was announced: a gesture announces its move
 * (CELLS_MOVED) when its part of the step is kept, so a take-back inside the
 * gesture's own step undoes a move nobody was told about and moves nothing,
 * while the take-back of an outer step a gesture JOINED (a granted macro run
 * that ran Merge & Center, then failed) moves the followers back. Line edits
 * are always replayed: they are announced the moment they land (the insert /
 * delete wrappers). `transaction`: the taken-back step's (its savepoint's), so
 * only moves remembered for THAT step (or untagged) are handed back.
 */
export function announceRolledBackRestore(result: UndoResult, transaction?: number): void {
  const followed: StructuralDelta[] = (result.structuralDeltas ?? []).filter(
    (d) => d.kind !== "move" || takeAnnouncedMove(d, transaction),
  );
  if (result.structuralRestore || result.mergeChanged || result.hiddenChanged) {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
  }
  if (followed.some((d) => d.kind !== "move")) {
    const payload: StructuralUndoPayload = { description: result.description, source: "rollback", deltas: followed };
    emitApiAppEvent(ApiAppEvents.STRUCTURAL_UNDO, payload);
  } else if (followed.length > 0) {
    const moves = followed.filter((d): d is StructuralMoveDelta => d.kind === "move");
    const payload: CellsMovedPayload = { moves, source: "rollback" };
    emitApiAppEvent(ApiAppEvents.CELLS_MOVED, payload);
  }
  const domains: MutationDomain[] = ["styles", ...((result.refreshDomains ?? []) as MutationDomain[])];
  emitApiAppEvent(ApiAppEvents.MUTATION_REFRESH, { domains, source: "undo" });
  window.dispatchEvent(new CustomEvent("grid:refresh"));
}
