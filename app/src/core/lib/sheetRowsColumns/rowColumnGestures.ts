//! FILENAME: app/src/core/lib/sheetRowsColumns/rowColumnGestures.ts
// PURPOSE: Excel's Insert Sheet Rows / Insert Sheet Columns / Delete Sheet Rows /
//          Delete Sheet Columns as gestures over ANY selection.
// CONTEXT: These are the handlers behind the grid commands `insertRow`,
//          `insertColumn`, `deleteRow` and `deleteColumn`, which Core's
//          Spreadsheet registers (CLAUDE.md rule 5's precedent for grid
//          gestures, like core/lib/merge). The Home tab's Insert / Delete menus,
//          the grid's right-click menu (whole rows / columns only) and object
//          scripts (all four are script-safe) reach them through the ONE
//          grid-command door, so every entry point gets the same spans, the
//          same refusals and the same undo step.
//
//          They used to return early unless whole rows (columns) were
//          selected. A cell selection therefore did NOTHING -- no message, and
//          gridCommands.execute still answered true -- and inside a PivotTable
//          the pivot's structural guard refused a change that would never have
//          run. For a script that is worse than a refusal: DELETE_ROW "worked".
//
// THE RULES (Excel, observed live in Microsoft 365 build 20326, 2026-10-04;
// see spans.ts for the span arithmetic):
// - The rows (columns) the selection spans are inserted / deleted, whatever
//   its shape. Several Ctrl+click blocks each get their own; blocks that
//   share a row (column) are refused whole.
// - Several blocks are ONE undo step (one Ctrl+Z restores every one).
// - Deleting every row (a whole-column selection) empties the sheet; Excel
//   refuses to insert when non-blank cells would be pushed off the sheet, and
//   inserting as many rows as the sheet has pushes off every one of them.

import type { Selection } from "../../types";
import {
  beginUndoTransaction,
  cancelUndoTransaction,
  commitUndoTransaction,
  deleteColumns,
  deleteRows,
  insertColumns,
  insertRows,
} from "../tauri-api";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "../undoTransactionOwnership";
import { alertAsync } from "../dialogs";
import { sheetSpans, type IndexSpan, type SheetAxis } from "./spans";

/** The four commands, named as their grid commands are. */
export type RowColumnGestureKind = "insertRow" | "insertColumn" | "deleteRow" | "deleteColumn";

/** What a gesture needs from the grid that runs it. */
export interface RowColumnGestureHost {
  /** The selection the gesture acts on. */
  selection: Selection | null;
  /** The sheet's size, for the push-off-the-sheet refusal. */
  totalRows: number;
  totalCols: number;
  /**
   * Repaint after the change: re-read dimensions and cells, animate, announce.
   * `spans` are the spans that LANDED, ascending (all of them unless a later
   * block was refused).
   */
  afterChange(kind: RowColumnGestureKind, spans: IndexSpan[]): Promise<void>;
}

/** Excel's own sentence for blocks that share a row (column), measured live. */
export const OVERLAPPING_SELECTIONS = "Cannot use that command on overlapping selections.";

/** Inserting as many rows (columns) as the sheet has would shift every one off it. */
export function shiftOffSheetRefusal(kind: RowColumnGestureKind): string {
  const what = kind === "insertRow" || kind === "deleteRow" ? "rows" : "columns";
  return (
    `To prevent possible loss of data, Calcula can't insert that many ${what}: ` +
    `every ${what === "rows" ? "row" : "column"} on the sheet would be shifted off the worksheet.`
  );
}

/** The closes an owned transaction uses, read when the close runs. */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/** What one undo step of several blocks is called in Edit > Undo. */
const STEP_LABELS: Record<RowColumnGestureKind, string> = {
  insertRow: "Insert Sheet Rows",
  insertColumn: "Insert Sheet Columns",
  deleteRow: "Delete Sheet Rows",
  deleteColumn: "Delete Sheet Columns",
};

function axisOf(kind: RowColumnGestureKind): SheetAxis {
  return kind === "insertRow" || kind === "deleteRow" ? "rows" : "columns";
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The one backend call a span makes. */
function apply(kind: RowColumnGestureKind, span: IndexSpan): Promise<unknown> {
  switch (kind) {
    case "insertRow":
      return insertRows(span.start, span.count);
    case "insertColumn":
      return insertColumns(span.start, span.count);
    case "deleteRow":
      return deleteRows(span.start, span.count);
    case "deleteColumn":
      return deleteColumns(span.start, span.count);
  }
}

/**
 * Run one of Excel's Insert / Delete Sheet Rows / Columns over
 * `host.selection`. Never throws: every refusal reaches the user as an alert.
 */
export async function runRowColumnGesture(kind: RowColumnGestureKind, host: RowColumnGestureHost): Promise<void> {
  const answer = sheetSpans(host.selection, axisOf(kind));
  if (!answer.ok) {
    await alertAsync(OVERLAPPING_SELECTIONS);
    return;
  }
  const spans = answer.spans;
  if (spans.length === 0) return;

  if (kind === "insertRow" || kind === "insertColumn") {
    const total = kind === "insertRow" ? host.totalRows : host.totalCols;
    if (spans.some((s) => s.count >= total)) {
      await alertAsync(shiftOffSheetRefusal(kind));
      return;
    }
  }

  // ONE block: the backend command is its own undo step (it opens one, or
  // joins a script's open batch), exactly as the right-click menu always ran.
  if (spans.length === 1) {
    try {
      await apply(kind, spans[0]);
    } catch (error) {
      console.error(`[rowColumnGestures] ${kind} failed:`, error);
      await alertAsync(messageOf(error));
      return;
    }
    await host.afterChange(kind, spans);
    return;
  }

  // SEVERAL blocks: bottom-up (right-to-left), so a block's index is still
  // where the user saw it when its turn comes -- inserting above row 5 first
  // leaves row 2 where it was. ONE undo step over all of them; a begin that
  // JOINS a script's batch closes nothing (undoTransactionOwnership).
  const landed: IndexSpan[] = [];
  let tx: OwnedUndoTransaction | null = null;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction(STEP_LABELS[kind]), UNDO_CLOSES);
    for (const span of [...spans].reverse()) {
      await apply(kind, span);
      landed.push(span);
    }
    await tx.commit();
  } catch (error) {
    console.error(`[rowColumnGestures] ${kind} failed:`, error);
    // What LANDED is committed, never cancelled: a cancel drops the undo record
    // and keeps the writes, so the blocks already inserted / deleted would be
    // undoable by nothing. With nothing landed, the empty step is cancelled.
    if (landed.length > 0) {
      await tx?.commit().catch(() => {});
    } else {
      await tx?.cancel().catch(() => {});
    }
    await alertAsync(messageOf(error));
    if (landed.length === 0) return;
  }
  await host.afterChange(kind, [...landed].sort((a, b) => a.start - b.start));
}
