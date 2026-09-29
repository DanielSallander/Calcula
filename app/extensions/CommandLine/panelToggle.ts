//! FILENAME: app/extensions/CommandLine/panelToggle.ts
// PURPOSE: The command line's open/close toggle -- the one the command, the
//          Ctrl+Shift+P keybinding and View > Command Line all run. Its own
//          module so it is testable without mounting the Monaco-backed panel.

import { hideDialog, isDialogOpen, showDialog } from "@api";

export const COMMAND_LINE_DIALOG_ID = "command-line-panel";

// Asks the dialog registry, never a flag of its own. It used to mirror the
// panel's `isOpen` in a module variable written by an effect, and the X (and
// Escape) close the dialog by UNMOUNTING the panel, so the mirror stayed
// `true`: the next toggle "closed" a closed panel and View > Command Line /
// Ctrl+Shift+P did nothing (found live 2026-09-29, e2e fixall-calp CLI-TOGGLE).
export function toggleAppCliPanel(): void {
  if (isDialogOpen(COMMAND_LINE_DIALOG_ID)) hideDialog(COMMAND_LINE_DIALOG_ID);
  else showDialog(COMMAND_LINE_DIALOG_ID);
}
