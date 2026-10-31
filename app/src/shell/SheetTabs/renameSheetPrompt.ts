//! FILENAME: app/src/shell/SheetTabs/renameSheetPrompt.ts
// PURPOSE: THE rename question. Every door that renames a sheet -- a double-
//          click on its tab, the tab menu's Rename, Home > Format > Rename
//          Sheet (core.sheet.rename), and Protection's guarded Rename (through
//          that command) -- asks it here.
// CONTEXT: The prompt had been copied three times (the tab double-click, the
//          tab menu item, Protection's override of that item), and a fourth
//          door was about to make it four. A copied prompt is a second answer
//          to "what does renaming ask?" that drifts on the first change; the
//          tab copy already compared the UNTRIMMED answer with the old name, so
//          " Sheet1" renamed Sheet1 to itself.
//
//          `promptAsync`, not `window.prompt`: the latter is the one dialog
//          global Tauri does not replace, and a suppressed prompt returns null,
//          which is indistinguishable from Cancel (CLAUDE.md, dialog globals).
//          Excel renames inline on the tab; Calcula's modal is the named
//          divergence.

import { promptAsync } from "@api/dialogs";

/**
 * Ask for a sheet's new name. Resolves the name EXACTLY as typed, or null when
 * the user cancelled, answered empty, or kept the name (nothing to rename).
 * NOT trimmed: Excel keeps a leading or trailing space, and a name of spaces
 * only -- its Rename UI names a sheet ` Data ` when that is typed [LIVE, Excel
 * 16, 2026-10-31]. The backend applies Excel's naming rule
 * (`validate_sheet_name`); this only decides whether there is anything to send.
 */
export async function promptForSheetName(currentName: string): Promise<string | null> {
  const answer = await promptAsync("Enter new sheet name:", {
    title: "Rename sheet",
    defaultValue: currentName,
  });
  if (typeof answer !== "string") return null;
  if (answer === "" || answer === currentName) return null;
  return answer;
}
