//! FILENAME: app/extensions/BuiltIn/HomeTab/components/runCommand.ts
// PURPOSE: The ONE door every Home tab control runs a command through:
//          CommandRegistry.execute, with a thrown refusal shown to the user.
// CONTEXT: The Seam Rule. Almost nothing the Home tab offers is the ribbon's
//          own: Paste Special's variants belong to PasteSpecial, Insert /
//          Delete Cells to InsertDeleteCells, the sort and filter rows to
//          Sorting and AutoFilter, the sheet and row/column commands to Core
//          and the shell, Format Cells... to its dialog. So the ribbon says WHAT
//          (a command id and its args) and the owner decides HOW: its refusals
//          (a protected sheet, an object holding the selection, a canvas sheet,
//          the last visible sheet), its one undo step, its dialog. The menus,
//          the keyboard and scripts run the same ids, so the ribbon cannot
//          behave differently from them.
//
//          A refusal arrives one of two ways. Most owners tell the user
//          themselves (a toast, an alert) and return; some THROW, and a thrown
//          message used to die in the console. Caught here and shown with
//          alertAsync -- so "nothing happened" always comes with a reason.
//          Never window.alert (CLAUDE.md: the globals are broken under Tauri
//          and banned by lint).
//
//          FOUR COPIES OF THIS lived in the group folders until 2026-10-04
//          (clipboard/runHomeCommand, cells/runCellsCommand,
//          editing/runEditingCommand, font/fontCommand's runFontCommand), each
//          lane owning only its folder; their bodies were byte-identical, and a
//          copied rule is one that drifts on the first change (review finding:
//          the mini toolbar's font ladder and Series AutoFill had already
//          drifted from their originals). homeTabOneCopy.test.ts keeps it one.

import { CommandRegistry } from "@api/commands";
import { alertAsync } from "@api/dialogs";

/** The message of anything thrown, for the user. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `commandId` (with `args` when given). Never rejects: a refusal that
 * escapes as an error reaches the user, in the command's own words, and a
 * ribbon click has nobody above it to catch the error.
 *
 * `args` is passed ONLY when given, so a command without options is executed
 * exactly as the menu bar and the keyboard execute it -- `execute(id)`, not
 * `execute(id, undefined)` -- and a test can pin the call byte for byte. That
 * matters: INSERT_CELLS / DELETE_CELLS with NO args open their dialog, which
 * is what Excel's "Insert Cells..." row does.
 *
 * The alert is not awaited: the dialog's lifetime is the user's, not the
 * click's.
 */
export async function runCommand(commandId: string, args?: unknown): Promise<void> {
  try {
    if (args === undefined) await CommandRegistry.execute(commandId);
    else await CommandRegistry.execute(commandId, args);
  } catch (err) {
    void alertAsync(messageOf(err));
  }
}

/** Every Home menu row draws its picture on the 20px grid (as the Merge menu's
 *  do); a row without one reserves the same column (MENU_ICON_BLANK), so every
 *  label lines up as in Excel's menus. */
export const MENU_ROW_ICON_SIZE = 20;
