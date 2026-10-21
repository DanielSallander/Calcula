//! FILENAME: app/extensions/BuiltIn/StandardMenus/selectionDoors.ts
// PURPOSE: The standard-menu doors whose target is Core's SELECTION, ONCE for
//          every route to them: Insert > Table... and the insert.table command
//          (Ctrl+T); View > Go To Special... and the view.goToSpecial command.
// CONTEXT: D4 (BUG-0185 class). While something other than Core's grid owns
//          the selection -- a floating grid's selected cell -- Core's
//          selection is HIDDEN under it: Create Table prefilled its range from
//          that hidden selection, and Go To Special searched inside it and
//          replaced it. Each door asks @api/selectionOwner first and refuses
//          with one toast. The menu items and the commands each had their own
//          one-liner before; one copy per door is how a door misses a check.
//          P3: Go To Special acts on a floating grid's OWN cells (a cell
//          target, "read"); Insert Table keeps refusing (an Insert-tab door,
//          and a floating grid holds no table).

import { showDialog } from "@api/ui";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { resolveCellTarget } from "@api/cellTarget";

/** Registered by the Table extension (its CreateTableDialog). */
export const TABLE_DIALOG_ID = "table:createDialog";
/** Registered by the Go To Special extension. */
export const GO_TO_SPECIAL_DIALOG_ID = "go-to-special";

/** Insert > Table... / Ctrl+T: the Create Table dialog, prefilled from the selection. */
export function openInsertTableDialog(): void {
  if (refuseIfSelectionOwned("Insert Table")) return;
  showDialog(TABLE_DIALOG_ID);
}

/**
 * View > Go To Special...: searches (within) the selection and replaces it --
 * Core's, or a floating grid's own cells (the dialog's OK asks again: the
 * selection can move while it is open).
 */
export function openGoToSpecialDialog(): void {
  if (resolveCellTarget("Go To Special", "read") === null) return;
  showDialog(GO_TO_SPECIAL_DIALOG_ID);
}
