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

import { refuseIfSelectionOwned } from "@api/selectionOwner";

/**
 * `readSelection()` when Core's grid holds the selection; null -- with the
 * refusal announced once -- when another feature owns it. `action` names the
 * door in the refusal ("Insert Button").
 */
export function insertAnchorOrRefuse<T>(action: string, readSelection: () => T | null): T | null {
  if (refuseIfSelectionOwned(action)) return null;
  return readSelection();
}
