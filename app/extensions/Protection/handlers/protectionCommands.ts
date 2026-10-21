//! FILENAME: app/extensions/Protection/handlers/protectionCommands.ts
// PURPOSE: The Protection extension's commands -- the doors Excel's Home >
//          Cells > Format > Protection rows run:
//            protection.toggleProtectSheet  Protect Sheet... / Unprotect Sheet...
//            protection.toggleLockCell      Lock Cell
// CONTEXT: The extension registered no commands at all: Protect Sheet lived
//          only as a Review-menu action, and Lock Cell existed nowhere (only
//          the Cell Protection dialog changed the flag). The Home tab names
//          WHAT it wants by command id; this extension decides HOW (the Seam
//          Rule), so the ribbon never re-implements a protection flow.
//
//          Neither is script-safe (`CommandOptions.scriptSafe` is an audited
//          opt-in): unprotecting a sheet and unlocking cells are exactly what a
//          distributed script must not be able to do through a side door.

import type { ExtensionContext } from "@api/contract";
import {
  CoreCommands, ExtensionCommands,
  getCellProtection,
  setCellProtection,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
} from "@api";
import { getGridStateSnapshot, refreshGridData } from "@api/grid";
import { showToast } from "@api/notifications";
import { applyFormatting, getStyle } from "@api/lib";
import { resolveCellTarget, targetRefOf, readTargetCell, notifyCellTargetChanged } from "@api/cellTarget";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import { toggleProtectSheet } from "./reviewMenuBuilder";
import { isCurrentSheetProtected, refreshProtectionState } from "../lib/protectionStore";

/** The closes, read when they run (a test's double of @api reaches them). */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

const PROTECTED_REFUSAL =
  "The sheet is protected: which cells are locked cannot change. Unprotect the sheet first (Review > Unprotect Sheet).";

/**
 * Protect Sheet... / Unprotect Sheet... -- the Review menu's own flow. The
 * protection cache is refreshed first: it is only refreshed on events (sheet
 * switch, open, `protection:refresh`), and a command can arrive between one of
 * them and the backend change it follows -- a stale "unprotected" would offer
 * to protect an already protected sheet.
 */
async function protectSheetCommand(): Promise<void> {
  await refreshProtectionState();
  await toggleProtectSheet();
}

/**
 * Excel's Lock Cell: the selection takes the OPPOSITE of the ACTIVE cell's
 * Locked flag (the button shows pressed while the active cell is locked), in
 * ONE undo step.
 *
 * - Only `locked` is sent; the Hidden flag is not this command's.
 * - A protected sheet refuses BEFORE anything is read (Excel greys the item):
 *   the backend would refuse too (`require_sheet_unprotected`), but answering
 *   from the cache saves the round trip and names the fix.
 * - Every area of a multi-area selection, inside one undo transaction this
 *   gesture owns. The backend's `set_cell_protection` opens an owned
 *   transaction of its own, which JOINS this one, so one area or five is one
 *   Ctrl+Z.
 * - The lock lives in the cell's STYLE (a cell format attribute), so the
 *   grid's cached cells -- whose style indices a later copy or Format Painter
 *   reads -- are refreshed afterwards.
 * - WHICH cells (P3, owner finding G3): Core's selection, or a floating grid's
 *   own cells when its owner admits "format". A floating grid's cells take
 *   the `locked` flag of their style through their target
 *   (`applyFormatting(.., { locked }, { target })`, gated by the HOST's
 *   protection, which is the active sheet's), and the active cell's flag is
 *   read through the target too. An owner that does not admit it refuses,
 *   once -- never the sheet cell hidden under the grid (BUG-0185).
 */
export async function toggleLockCell(): Promise<void> {
  const t = resolveCellTarget("Lock Cell", "format");
  if (t === null) return;
  if (isCurrentSheetProtected()) {
    showToast(PROTECTED_REFUSAL, { variant: "info" });
    return;
  }
  const target = targetRefOf(t);
  const selection = t.kind === "object" ? t.selection : (getGridStateSnapshot()?.selection ?? null);
  if (!selection) return;

  // The active cell is (endRow, endCol) in Calcula's selection model; the
  // optional aliases win when a caller set them.
  const activeRow = selection.activeRow ?? selection.endRow;
  const activeCol = selection.activeCol ?? selection.endCol;
  let locked: boolean;
  try {
    if (target) {
      // The style's flag (an empty cell carries the default style, locked).
      const cell = await readTargetCell(target, activeRow, activeCol);
      locked = !((await getStyle(cell?.styleIndex ?? 0)).locked ?? true);
    } else {
      locked = !(await getCellProtection(activeRow, activeCol)).locked;
    }
  } catch (err) {
    console.error("[Protection] Lock Cell: could not read the active cell's protection:", err);
    showToast("Could not read whether the active cell is locked.", { variant: "error" });
    return;
  }

  const areas = [selection, ...(selection.additionalRanges ?? [])];
  let tx: OwnedUndoTransaction | null = null;
  let landed = 0;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction(locked ? "Lock cells" : "Unlock cells"), UNDO_CLOSES);
    for (const area of areas) {
      if (target) {
        // A floating grid's cells: the style flag through the target. A
        // refusal throws (caught below) and stops the gesture.
        const rows: number[] = [];
        const cols: number[] = [];
        for (let r = Math.min(area.startRow, area.endRow); r <= Math.max(area.startRow, area.endRow); r++) rows.push(r);
        for (let c = Math.min(area.startCol, area.endCol); c <= Math.max(area.startCol, area.endCol); c++) cols.push(c);
        await applyFormatting(rows, cols, { locked }, { target });
        landed++;
        continue;
      }
      const result = await setCellProtection({
        startRow: Math.min(area.startRow, area.endRow),
        startCol: Math.min(area.startCol, area.endCol),
        endRow: Math.max(area.startRow, area.endRow),
        endCol: Math.max(area.startCol, area.endCol),
        locked,
      });
      // set_cell_protection resolves its refusals (a protected sheet) rather
      // than throwing; closing as if it had worked told the user a change was
      // made that was not (CellProtectionDialog learned the same).
      if (!result.success) {
        showToast(result.error || "Could not change cell locking.", { variant: "info" });
        break;
      }
      landed++;
    }
  } catch (err) {
    console.error("[Protection] Lock Cell failed:", err);
    showToast(err instanceof Error ? err.message : String(err), { variant: "error" });
  } finally {
    // Commit what landed (a cancel would DROP its undo record); cancel an
    // empty step so nothing invisible is left on the undo stack.
    try {
      if (landed > 0) await tx?.commit();
      else await tx?.cancel();
    } catch (err) {
      console.error("[Protection] Lock Cell: closing the undo step failed:", err);
    }
  }
  if (landed > 0) {
    refreshGridData();
    // A floating grid repaints and the ribbon re-reads from the target.
    if (target) notifyCellTargetChanged();
  }
}

/**
 * Register both commands. Returns the cleanup for deactivation. One
 * `register(CoreCommands.X, ...)` per command, spelled out, for the
 * source-reading shortcut census.
 */
export function registerProtectionCommands(context: ExtensionContext): () => void {
  context.commands.register(ExtensionCommands.PROTECT_SHEET_TOGGLE, () => protectSheetCommand());
  context.commands.register(ExtensionCommands.LOCK_CELL_TOGGLE, () => toggleLockCell());
  return () => {
    context.commands.unregister(ExtensionCommands.PROTECT_SHEET_TOGGLE);
    context.commands.unregister(ExtensionCommands.LOCK_CELL_TOGGLE);
  };
}
