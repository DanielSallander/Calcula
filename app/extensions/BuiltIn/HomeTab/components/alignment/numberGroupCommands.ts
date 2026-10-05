//! FILENAME: app/extensions/BuiltIn/HomeTab/components/alignment/numberGroupCommands.ts
// PURPOSE: The Number group's commands that are not a plain `applyFormat`
//          write (CONTRACT 3.7): Comma Style's preset keyword, and Increase /
//          Decrease Decimal through `adjustNumberFormatDecimals`.
// CONTEXT: Called from the Home tab's handleItemClick (useHomeTabState) for
//          `commaFormat`, `increaseDecimal` and `decreaseDecimal`, which then
//          re-reads the active cell's style as applyFormat does after a write.
//          They used to be computed in the ribbon: Comma
//          wrote "#,##0" (Excel's Comma Style is Accounting with no symbol and
//          two decimals), and the decimal step parsed the DISPLAY NAME the
//          backend reports ("Number (2 decimals)") and rebuilt a plain "0.00"
//          code from it -- so Increase Decimal on a Currency, Accounting,
//          Percentage or Scientific cell silently turned it into a plain
//          number. Excel keeps the kind and adds one decimal.
//
//          The step is now the backend's (`adjust_number_format_decimals`,
//          rust-format lane): the ACTIVE cell's typed format plus its value
//          decide the new format, and the whole selection receives it as ONE
//          undo step. "Active" is read from the order of the arrays it is sent
//          -- the first row and the first column -- so this module puts the
//          active cell first. The active cell is `@api/activeCell`'s rule
//          (Selection.activeRow/activeCol when set, else endRow/endCol, where
//          the grid draws the active-cell border), the one the mini format
//          toolbar, Format Cells and Ctrl+B read too.
//
//          EVERY BLOCK (review finding, 2026-10-04). A Ctrl+click or Go To
//          Special selection has several blocks (`@api/selectionBlocks`, the
//          main one first). The step is still DECIDED by the active cell: the
//          main block goes to the backend with the active cell first, and
//          every other block then receives the format that step produced (the
//          backend reports it as a display name that applyFormatting parses
//          back to the identical typed format -- the same value a recorded
//          macro replays). A per-block step would let each block's own first
//          cell decide. Several blocks are ONE undo step; a refusal part-way
//          commits what landed. It used to step the main range only, while
//          Borders and Clear covered every block.
//
//          The door behaves as the Home tab's `applyFormat` does: it refuses,
//          with one toast and no write, while something else owns the
//          selection; a backend refusal reaches the user through alertAsync;
//          a write is announced through the ONE announcement
//          (`@api/announceFormatting`: cell events, then `styles:refresh` and
//          `grid:refresh`, which also make the ribbon re-read the active cell).

import { getGridStateSnapshot } from "@api/grid";
import {
  adjustNumberFormatDecimals,
  applyFormatting,
  beginUndoTransaction,
  cancelUndoTransaction,
  commitUndoTransaction,
} from "@api/lib";
import { alertAsync } from "@api/dialogs";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { activeCellOf } from "@api/activeCell";
import { selectionBlocks, type SelectionBlock } from "@api/selectionBlocks";
import { announceFormattingResult } from "@api/announceFormatting";
import { ownUndoTransaction } from "@api/undoTicket";
import type { FormattingResult, Selection } from "@api/types";

/** Excel's Comma Style: Accounting with no currency symbol and two decimals
 *  (the backend's `comma` preset, CONTRACT section 5). */
export const COMMA_STYLE_PRESET = "comma";

/**
 * The rows and columns a selection's MAIN rectangle spans, each ascending,
 * except that the ACTIVE cell's row and column come FIRST -- the order
 * `adjustNumberFormatDecimals` reads the active cell from.
 */
export function activeCellFirst(selection: Selection): { rows: number[]; cols: number[] } {
  const top = Math.min(selection.startRow, selection.endRow);
  const bottom = Math.max(selection.startRow, selection.endRow);
  const left = Math.min(selection.startCol, selection.endCol);
  const right = Math.max(selection.startCol, selection.endCol);
  // The one active-cell rule (@api/activeCell).
  const { row: activeRow, col: activeCol } = activeCellOf(selection)!;
  const rows: number[] = [activeRow];
  const cols: number[] = [activeCol];
  for (let r = top; r <= bottom; r++) if (r !== activeRow) rows.push(r);
  for (let c = left; c <= right; c++) if (c !== activeCol) cols.push(c);
  return { rows, cols };
}

/** The rows and columns of one block, as applyFormatting takes them. */
export function rowsColsOf(block: SelectionBlock): { rows: number[]; cols: number[] } {
  const rows: number[] = [];
  const cols: number[] = [];
  for (let r = block.startRow; r <= block.endRow; r++) rows.push(r);
  for (let c = block.startCol; c <= block.endCol; c++) cols.push(c);
  return { rows, cols };
}

/** Whether a result wrote anything (an empty one: Excel would change nothing). */
function wroteSomething(result: FormattingResult): boolean {
  return result.cells.length > 0 || result.styles.length > 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Excel's Increase Decimal (`delta` 1) / Decrease Decimal (-1) over the
 * current selection, every block of it. `action` names it in a refusal and in
 * the undo step ("Increase Decimal"). `fallback` is the last selection the
 * caller knew, for a ribbon click that has cleared the grid's (useHomeTabState
 * keeps one for the same reason).
 *
 * Resolves true when the backend answered for the main block (whether or not
 * Excel would have changed anything), false when the main block was refused
 * or there is no selection. Never throws: a refusal reaches the user.
 */
export async function stepNumberFormatDecimals(
  delta: 1 | -1,
  action: string,
  fallback?: Selection | null,
): Promise<boolean> {
  if (refuseIfSelectionOwned(action)) return false;
  const selection = getGridStateSnapshot()?.selection ?? fallback ?? null;
  if (!selection) return false;
  const { rows, cols } = activeCellFirst(selection);
  const others = selectionBlocks(selection).slice(1);

  // One block: the backend's own step is the one undo step. Several: one
  // bracket around all of them. A begin that fails still lets the step apply
  // (as several steps); a begin that JOINS a script's batch closes nothing.
  const tx =
    others.length > 0
      ? ownUndoTransaction(await beginUndoTransaction(action).catch(() => null), {
          commitUndoTransaction,
          cancelUndoTransaction,
        })
      : null;
  const results: FormattingResult[] = [];
  let answered = false;
  try {
    const main = await adjustNumberFormatDecimals(rows, cols, delta);
    answered = true;
    results.push(main);
    // Every returned style carries the SAME format -- the active cell's,
    // stepped. None: Excel changed nothing at the active cell, so nothing
    // changes anywhere.
    const numberFormat = main.styles[0]?.style.numberFormat;
    if (numberFormat !== undefined) {
      for (const block of others) {
        const lists = rowsColsOf(block);
        results.push(await applyFormatting(lists.rows, lists.cols, { numberFormat }));
      }
    }
    await tx?.commit();
  } catch (err) {
    void alertAsync(messageOf(err));
    // COMMIT what landed (a cancel drops the undo record and keeps the
    // writes, so nothing could undo them); cancel only an empty step.
    const close = results.some(wroteSomething) ? tx?.commit() : tx?.cancel();
    await close?.catch((closeErr: unknown) =>
      console.error("[HomeTab] Decimals: closing the undo step failed:", closeErr),
    );
  }
  if (results.some(wroteSomething)) announceFormattingResult(results);
  return answered;
}
