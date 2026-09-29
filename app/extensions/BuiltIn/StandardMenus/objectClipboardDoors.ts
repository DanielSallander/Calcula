//! FILENAME: app/extensions/BuiltIn/StandardMenus/objectClipboardDoors.ts
// PURPOSE: Edit > Copy and Edit > Paste: run the command that answers Copy /
//          Paste RIGHT NOW. On a CANVAS that is the canvas's object clipboard
//          (Copy / Paste of the selected objects); everywhere else, the grid's
//          cell clipboard.
// CONTEXT: X12 (wave D) made the items ask the canvas's question at all -- they
//          ran `core.clipboard.copy` / `.paste` unconditionally, which has
//          nothing to act on on a page without cells. Y11 (wave E) moved the
//          question itself into @api/objectClipboard (`clipboardDoorCommand`):
//          the Edit menu, the Home tab's buttons and the canvas's Ctrl+C /
//          Ctrl+V guard now share ONE rule instead of keeping a copy each.
//          A menu click runs no keybinding, so it asks the rule itself; the
//          keyboard guard's focus half does not apply (the grid is not focused
//          while a menu is open, and a menu click leaves no DOM text selection).

import { CommandRegistry } from "@api/commands";
import { clipboardDoorCommand } from "@api/objectClipboard";

function run(commandId: string): void {
  CommandRegistry.execute(commandId).catch((err) => {
    console.error(`[StandardMenus] ${commandId} failed:`, err);
  });
}

/** Edit > Copy. */
export function runEditCopy(): void {
  run(clipboardDoorCommand("copy"));
}

/** Edit > Paste > Paste. */
export function runEditPaste(): void {
  run(clipboardDoorCommand("paste"));
}
