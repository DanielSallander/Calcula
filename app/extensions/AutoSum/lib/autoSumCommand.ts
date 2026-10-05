//! FILENAME: app/extensions/AutoSum/lib/autoSumCommand.ts
// PURPOSE: The `autosum.insert { fn }` command: plan (lib/autoSumPlan.ts), then
//          either open the active cell's edit holding the guess or write the
//          totals in ONE undo step.
// CONTEXT: Home tab 2026-10-04 (the AutoSum split: Sum, Average, Count
//          Numbers, Max, Min) and Alt+= (keybindings.ts, "not-editing"). Every
//          door comes through here. A Ctrl+click selection totals every area
//          in the same one undo step (planAutoSumAreas).

import { getGridStateSnapshot, refreshGridData, setSelection, scrollToCell } from "@api/grid";
import { dispatchGridAction } from "@api/gridDispatch";
import {
  updateCellsBatch,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
} from "@api/lib";
import { ownUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import { getLocaleSettings } from "@api/locale";
import { showToast } from "@api/notifications";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { planAutoSumAreas, AUTOSUM_FUNCTIONS, type AutoSumFn, type CellRange } from "./autoSumPlan";
import { createLiveReader } from "./liveReader";
import { openAutoSumEdit } from "./editOpener";

/** AutoSum's closes, read when a close runs (see ownUndoTransaction): a
 *  script's open batch is JOINED and left for the script to close. */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/** Excel's names for the menu rows, for messages. */
const ACTION_NAME: Record<AutoSumFn, string> = {
  SUM: "AutoSum",
  AVERAGE: "Average",
  COUNT: "Count Numbers",
  MAX: "Max",
  MIN: "Min",
};

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The function asked for: `{ fn }` (any case), SUM when absent, null when unknown. */
export function functionFromArgs(args: unknown): AutoSumFn | null {
  const raw = (args as { fn?: unknown } | undefined)?.fn;
  if (raw === undefined || raw === null) return "SUM";
  if (typeof raw !== "string") return null;
  const upper = raw.toUpperCase();
  return (AUTOSUM_FUNCTIONS as readonly string[]).includes(upper) ? (upper as AutoSumFn) : null;
}

async function listSeparator(): Promise<string> {
  try {
    return (await getLocaleSettings()).listSeparator || ",";
  } catch {
    return ",";
  }
}

/**
 * The new selection after a write: the totals included, Core's active corner
 * kept on the same side it was (Core's active cell is the selection's END).
 */
function selectionAfter(original: CellRange, union: CellRange) {
  const downward = original.endRow >= original.startRow;
  const rightward = original.endCol >= original.startCol;
  return {
    startRow: downward ? union.startRow : union.endRow,
    endRow: downward ? union.endRow : union.startRow,
    startCol: rightward ? union.startCol : union.endCol,
    endCol: rightward ? union.endCol : union.startCol,
    type: "cells" as const,
  };
}

export async function runAutoSum(args?: unknown): Promise<void> {
  const fn = functionFromArgs(args);
  if (fn === null) {
    showToast(
      `AutoSum does not know the function "${String((args as { fn?: unknown })?.fn)}". ` +
        `Known: ${AUTOSUM_FUNCTIONS.join(", ")}.`,
      { variant: "error" },
    );
    return;
  }
  const action = ACTION_NAME[fn];

  // It totals (and writes beside) Core's selection: refuse while something
  // else owns the selection -- a floating grid's cell, a selected object --
  // whose own cells are not the ones Core's selection points at (D4).
  if (refuseIfSelectionOwned(action)) return;
  const snapshot = getGridStateSnapshot();
  if (snapshot?.surface === "canvas") {
    showToast(`${action} is not available on a canvas sheet: it holds objects, not cells.`, { variant: "info" });
    return;
  }
  const sel = snapshot?.selection;
  if (!sel) return;

  // Every area, the main one first (Go To Special > Blanks then Alt+= puts a
  // total in every blank -- Excel's well-known subtotal recipe, measured live).
  const areas: CellRange[] = [sel, ...(sel.additionalRanges ?? [])];
  let plan;
  try {
    plan = await planAutoSumAreas(fn, areas, createLiveReader(), await listSeparator());
  } catch (err) {
    showToast(messageOf(err), { variant: "error" });
    return;
  }

  if (plan.kind === "nothing") {
    showToast(plan.message, { variant: "info" });
    return;
  }

  if (plan.kind === "edit") {
    const opened = await openAutoSumEdit(plan.formula, plan.caret);
    if (!opened) showToast(`${action} could not open the cell for editing.`, { variant: "error" });
    return;
  }

  // Written totals: ONE undo step, closed only by the begin that opened it.
  const tx = ownUndoTransaction(await beginUndoTransaction(action), UNDO_CLOSES);
  try {
    // Canonical spelling ("," separators, English names): skip delocalising.
    await updateCellsBatch(plan.writes.map((w) => ({ row: w.row, col: w.col, value: w.formula, invariant: true })));
  } catch (err) {
    await tx.cancel().catch(() => {});
    showToast(messageOf(err), { variant: "error" });
    return;
  }
  await tx.commit();
  refreshGridData();

  // Each area stays selected, grown over its totals; the main one keeps
  // Core's active corner on the side it was.
  const main = selectionAfter(sel, plan.selections[0]);
  const next =
    plan.selections.length > 1
      ? { ...main, additionalRanges: plan.selections.slice(1).map((r) => ({ ...r })) }
      : main;
  dispatchGridAction(setSelection(next));
  dispatchGridAction(scrollToCell(next.endRow, next.endCol, false));
}
