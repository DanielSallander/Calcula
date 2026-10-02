//! FILENAME: app/extensions/CanvasSheet/lib/canvasDelete.ts
// PURPOSE: Delete / Backspace on a canvas MULTI-selection delete EVERY
//          selected object, across families, as ONE undo step.
// CONTEXT: Each family binds its own Delete (Charts, Controls, the Floating
//          Range), guarded by "my family holds a selection", and the
//          keybinding dispatcher runs ONE winner per key -- so with a chart, a
//          second chart the selection set holds, and a slicer selected, Delete
//          removed one chart and left the rest (open-items 2.af row 1). The
//          whole-selection delete lives on the seam (`deleteSelectedObjects`,
//          @api/objectSelection); the families' own doors hand a selection
//          that spans families to it, and this binding is the door for a
//          selection none of their bindings matches (a slicer with a pivot
//          box, two charts' worth of set-held members after the family one
//          was removed from the set).
//
//          Guarded (`when`), registered last (the canvas activates after the
//          families): it applies only on a CANVAS, with the grid focused, and
//          only while the selection spans families -- a single object, or
//          several a family holds itself, stays with that family's own
//          Delete.
//
//          CANVAS ONLY, by its OWN check: the seam's rule
//          (`shouldActOnWholeObjectSelection`) answers on a worksheet too since
//          worksheets gained press parity (BUG-0270 review). There the
//          families' doors hand a spanning selection over themselves, and a
//          selection of slicers and timelines -- no door of their own -- goes
//          to the generic object Delete (ObjectPosition
//          lib/selectedObjectKeys.ts), which also stands down while a family
//          owns the key (an open menu, the keyboard inside).

import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import { deleteSelectedObjects, shouldActOnWholeObjectSelection } from "@api/objectSelection";
import { getGridStateSnapshot } from "@api/grid";

export const CANVAS_DELETE_SELECTION_COMMAND = "canvasSheet.deleteSelection";

/** Whether the active sheet is a canvas (a page, not a worksheet). */
function onCanvas(): boolean {
  return getGridStateSnapshot()?.surface === "canvas";
}

/** The binding's guard (exported for tests). */
export function canvasDeleteApplies(): boolean {
  return onCanvas() && isGridFocused() && shouldActOnWholeObjectSelection();
}

/** Register the command and its Delete / Backspace bindings; returns the cleanups. */
export function installCanvasObjectDelete(extensionId: string): Array<() => void> {
  const cleanups: Array<() => void> = [];
  CommandRegistry.register(CANVAS_DELETE_SELECTION_COMMAND, () => {
    // Re-checked at run time: the palette or a script may execute it -- on a
    // worksheet too, where the families' doors and the generic object Delete
    // answer instead.
    if (!onCanvas() || !shouldActOnWholeObjectSelection()) return;
    void deleteSelectedObjects();
  });
  cleanups.push(() => CommandRegistry.unregister(CANVAS_DELETE_SELECTION_COMMAND));
  for (const combo of ["Delete", "Backspace"] as const) {
    cleanups.push(
      registerKeybinding(
        {
          id: `ext.canvasSheet.deleteSelection.${combo.toLowerCase()}`,
          combo,
          commandId: CANVAS_DELETE_SELECTION_COMMAND,
          label: "Delete Selected Objects",
          category: "Canvas",
          context: "not-editing",
          source: "extension",
          extensionId,
        },
        canvasDeleteApplies,
      ),
    );
  }
  return cleanups;
}
