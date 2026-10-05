//! FILENAME: app/extensions/AutoSum/lib/editOpener.ts
// PURPOSE: Open Core's cell edit on the ACTIVE cell holding AutoSum's guess,
//          through Core's own open path -- so Enter confirms it, Escape drops
//          it, and a click on a cell while the caret sits inside =SUM() picks a
//          reference.
// CONTEXT: The only way into Core's edit that runs its guards (protected
//          ranges, extension edit guards), resolves a merged cell to its master
//          and raises the edit flag every keyboard gate reads is `useEditing()`'s
//          startEditing -- a HOOK. The raw `startEditing` grid action skips all
//          three: an edit opened that way leaves the flag down, so the grid
//          keyboard and pointer treat the open editor as absent (a click would
//          move the selection instead of picking a reference). So the extension
//          contributes an invisible shell component (components/
//          AutoSumEditHost.tsx, through @api/ui registerShellComponent) that
//          holds a useEditing() instance and lends its opener to this module --
//          the same door the formula bar's fx button uses.

import { dispatchGridAction } from "@api/gridDispatch";
import { setFormulaReferences } from "@api/grid";
import { setGlobalCursorPosition } from "@api/editing";
import { parseFormulaReferences } from "@api";

type EditOpener = (initialValue: string) => Promise<void>;

let opener: EditOpener | null = null;

/** Lend the opener (the host does, on every render that changes it). Returns
 *  the release, which clears it only if it is still the one lent. */
export function lendEditOpener(next: EditOpener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

export function hasEditOpener(): boolean {
  return opener !== null;
}

/**
 * Open the active cell's edit holding `formula` with the caret at `caret`
 * (inside the brackets, so the guess is confirmed with Enter and an empty
 * =SUM() is ready for a reference). The guessed range is highlighted the way
 * an edited formula's references are. Returns false when no opener is lent
 * (the host is not mounted).
 */
export async function openAutoSumEdit(formula: string, caret: number): Promise<boolean> {
  if (!opener) return false;
  await opener(formula);
  // The editor focuses on a timer after it mounts and puts the caret at the
  // tracked position then (InlineEditor); setting it now, before that timer,
  // is what lands the caret inside the brackets instead of after them.
  setGlobalCursorPosition(caret);
  dispatchGridAction(setFormulaReferences(parseFormulaReferences(formula, false)));
  return true;
}
