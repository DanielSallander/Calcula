//! FILENAME: app/extensions/Controls/lib/insertAnchor.ts
// PURPOSE: The anchor cell an Insert-menu door (Button, Shape, Image) places
//          its control at -- or a refusal, when the selection is not Core's.
// CONTEXT: Wave-B B8. The Insert > Controls > Button, Insert > Shapes and
//          Insert > Image doors read CORE's selection for the anchor. While a
//          feature owns the selection (a floating grid's cell is selected;
//          @api/selectionOwner), Core's selection is a cell hidden under that
//          object, so the new control landed at a place the user never chose.
//          Each door now asks the seam first and refuses with its one toast.
//          (A canvas Insert places at the page, not at the selection, and is
//          not one of these doors.)
//          They ask as the door KIND "objectInsert" (owner call 25,
//          2026-10-02): a claim that admits it -- the generic "an object is
//          selected" one (BUG-0270) -- lets them through, so a shape, a button
//          or a picture is inserted at the active cell while a slicer or a
//          shape is selected, as Excel does. A claim that does not -- a
//          floating grid's selected cell -- still refuses.

import { refuseIfSelectionOwned, type SelectionDoorKind } from "@api/selectionOwner";

/** The kind every Insert-menu control door asks as. */
const OBJECT_INSERT: SelectionDoorKind = "objectInsert";

/**
 * True -- with the refusal announced once -- when a claim that does not admit
 * an object insert holds the selection; the door returns. `action` names the
 * door in the refusal ("Insert Image"). For a door that must refuse BEFORE it
 * reads the anchor (Insert Image, before its file picker).
 */
export function refuseObjectInsertIfSelectionOwned(action: string): boolean {
  return refuseIfSelectionOwned(action, OBJECT_INSERT);
}

/**
 * `readSelection()` when no claim that refuses an object insert holds the
 * selection; null -- with the refusal announced once -- when one does.
 * `action` names the door in the refusal ("Insert Button").
 */
export function insertAnchorOrRefuse<T>(action: string, readSelection: () => T | null): T | null {
  if (refuseObjectInsertIfSelectionOwned(action)) return null;
  return readSelection();
}
