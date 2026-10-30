//! FILENAME: app/extensions/_shared/lib/structuralEditReload.ts
// PURPOSE: THE announcements that mean "a structural edit moved ranges the
//   backend keeps for you": Insert/Delete Rows and Columns on the active sheet
//   (the four ROWS_/COLUMNS_ events); STRUCTURAL_UNDO -- what Insert/Delete
//   Cells announces (it has no whole-line coordinates) and what an undone
//   structural edit announces; and STRUCTURAL_EDIT_ELSEWHERE -- what a
//   row/column edit OFF the sheet on screen announces: on a non-active sheet (a
//   script's or the CLI's `sheetIndex`) or on a floating grid's backing sheet
//   (the cell-target route). That one carries no active-sheet coordinates, and
//   NOTHING on the sheet on screen moved, so it is neither the ROWS_ family
//   (whose listeners shift ACTIVE-sheet stores by its coordinates) nor
//   STRUCTURAL_UNDO (whose listeners re-read the visible sheet's stores and
//   close its open UI) -- see `announceStructuralEditElsewhere`,
//   core/lib/tauri-api.ts.
// CONTEXT: Chart and sparkline DATA RANGES are moved by the structural commands
//   in Rust on every one of those routes, inside the edit's own undo step
//   (BUG-0357, app/src-tauri/src/chart_range_shift.rs). The Charts and
//   Sparklines extensions cache those stores in memory and write them back
//   whole, so each re-reads its store on these events -- a stale copy written
//   back would put the old range back. The Collaboration extension re-reads the
//   author's designated writeback regions on the same list (the backend moves
//   those too; lib/designatedRegionsFollowEdits.ts). One list, so the
//   extensions cannot disagree about which edits move a range; the callback is
//   told WHERE the edit was, so a listener can leave what is on screen alone
//   for an edit that was not (the chart store keeps the selected chart then).

import { AppEvents } from "@api";

/** Every event after which a backend-held range may have moved. */
export const STRUCTURAL_EDIT_EVENTS: readonly string[] = [
  AppEvents.ROWS_INSERTED,
  AppEvents.COLUMNS_INSERTED,
  AppEvents.ROWS_DELETED,
  AppEvents.COLUMNS_DELETED,
  AppEvents.STRUCTURAL_UNDO,
  AppEvents.STRUCTURAL_EDIT_ELSEWHERE,
];

/**
 * Where a structural edit landed: on the sheet on screen ("activeSheet": the
 * four whole-line events and STRUCTURAL_UNDO) or off it ("elsewhere":
 * STRUCTURAL_EDIT_ELSEWHERE -- a non-active sheet or a floating grid's backing
 * sheet, nothing on screen moved).
 */
export type StructuralEditWhere = "activeSheet" | "elsewhere";

/** The subscription shape of `ExtensionContext.events.on`. */
export type EventSubscribe = (eventName: string, callback: (detail: unknown) => void) => () => void;

/**
 * Call `onEdit` after every structural edit (see STRUCTURAL_EDIT_EVENTS), told
 * where it landed. Returns the one cleanup that drops every subscription.
 */
export function onStructuralEdit(
  subscribe: EventSubscribe,
  onEdit: (where: StructuralEditWhere) => void,
): () => void {
  const offs = STRUCTURAL_EDIT_EVENTS.map((eventName) => {
    const where: StructuralEditWhere =
      eventName === AppEvents.STRUCTURAL_EDIT_ELSEWHERE ? "elsewhere" : "activeSheet";
    return subscribe(eventName, () => onEdit(where));
  });
  return () => {
    for (const off of offs) off();
  };
}
