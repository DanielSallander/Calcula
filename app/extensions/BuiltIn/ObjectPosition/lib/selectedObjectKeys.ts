//! FILENAME: app/extensions/BuiltIn/ObjectPosition/lib/selectedObjectKeys.ts
// PURPOSE: While a floating object is SELECTED, the selection owns the
//          keyboard (BUG-0270): Delete / Backspace remove the selected
//          object(s) as ONE undo step, Escape goes back to the cells, and
//          nothing the keyboard does reaches the active cell hidden behind the
//          object -- no typed character, F2, Space, Alt+Down or Clear Contents.
// CONTEXT: On a WORKSHEET, selecting a slicer or a timeline (a click on its
//          header) leaves Core's selection on the active cell, out of sight.
//          Delete then cleared THAT cell (the dispatcher's Clear Contents) and
//          left the slicer standing; a typed character opened an edit in it;
//          Space and Alt+Down acted on it. M8c claimed the selection only
//          while the keyboard is INSIDE a slicer or timeline. Excel: Delete
//          deletes the selected object, typing goes nowhere near the cells,
//          Escape returns to the cell.
//
// THREE PIECES, all feature-neutral (no family is named here):
//
//   1. THE CLAIM (@api/selectionOwner, id "selectedObject"): on a worksheet,
//      while ANY object is selected (`getSelectedObjectRegions`), the
//      selection is the object's. Every door that acts on Core's selection
//      already asks the claim -- type-to-edit and F2, Core's grid keyboard
//      (Space, the format keys), Data Validation's Alt+Down, the grid
//      commands (Clear Contents, paste, the fills), and the ribbon and menu
//      doors -- and refuses with ONE sentence. It is a FALLBACK owner: a
//      specific claim speaks first (a floating grid's selected cell, whose
//      own cell takes typing; the keyboard inside a slicer, with its own
//      sentence), whatever order the extensions registered in. A canvas has
//      no cell behind its objects, so the claim never holds there.
//      It ADMITS one kind of door (`SelectionOwner.admits`): the object
//      inserts -- Insert Shape, Insert > Controls > Button, Insert Image --
//      which add a NEW object at the active cell and write no cell. Excel
//      allows them while an object is selected (owner call 25, 2026-10-02).
//      Each sentence is SAID once while the same object stays selected (and
//      again only after its toast has had time to go): a refused keystroke
//      still refuses, but typing a word is one toast, not one per character
//      (`SelectionOwner.shouldAnnounce`, review finding 5). Excel says nothing.
//
//   2. DELETE / BACKSPACE (a guarded binding, any surface): they hand the
//      whole selection to `deleteSelectedObjects` (@api/objectSelection) --
//      each family's share through its OWN provider's `deleteObjects` (the
//      slicer's carries its filter with it), ONE undo step, refusals (a
//      protected sheet) named in one toast with the objects kept selected.
//      PRECEDENCE: the binding is registered LAST (this extension activates
//      after every object family and after the canvas, extensions/manifest.ts),
//      and the dispatcher breaks a tie between guarded bindings by
//      registration order, so a family's OWN door -- Charts (the smallest
//      thing selected: the title before the chart), Controls, the floating
//      grid (a selected cell is cleared, not the grid deleted) -- and the
//      canvas's multi-family Delete win. Charts takes Backspace on a document
//      listener the dispatcher would pre-empt, so precedence does not cover
//      it: the guard ALSO stands down while any family's `ownsKey("Delete")`
//      answers yes (a chart selected, a floating grid selected, the keyboard
//      inside a slicer or timeline -- where the inside claim refuses the key
//      instead of deleting the object the keyboard is in). What is left for
//      this binding: slicers, timelines and canvas pivot boxes, which have no
//      Delete door of their own. On a CANVAS that closes a dead key -- the
//      canvas's own binding acts only on a selection that spans families, so
//      Delete with ONE slicer, timeline or pivot box selected did nothing.
//
//   3. ESCAPE (a guarded binding, worksheet only): deselects every object
//      (`clearObjectSelection`) and so ends the claim. A canvas has its own
//      Escape (CanvasSheet lib/objectCycling.ts), with the same rule. It
//      stands down while a family owns Escape (a chart walked below chart
//      level steps up a rung; an open menu closes itself; the keyboard inside
//      a slicer leaves the items) and while an object's grip menu is open.
//
//   4. A PRESS ON THE SHEET (worksheet): deselects every object too -- the
//      other way back to the cells the claim's sentence names. Families drop
//      their selection when Core's selection CHANGES, and two presses change
//      nothing: a click on the cell Core already has active (Controls dedupes
//      an identical selection), and a right-press INSIDE the selection (Core
//      keeps it for the grid's context menu). Both left the object selected
//      and the claim on, so typing and the grid menu's Clear Contents were
//      refused right after the user had clicked a cell (review finding 6).
//      Core announces every handled sheet press, both kinds included
//      (`onGridCellPressed`, @api/cellClickInterceptors) -- the Floating
//      Range's precedent (BUG-0186), here once for every family.
//
// ARROWS ARE LEFT AS THEY ARE (BUG-0270 scope): Excel nudges a selected
// slicer, shape or picture with the arrow keys; Calcula on a worksheet moves
// the cell cursor, which deselects the object -- nothing is written. A
// worksheet nudge would need the anchoring rules of every family and must not
// take a chart's element walk (CI-10).

import type { ExtensionContext } from "@api/contract";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import { registerSelectionOwner, type SelectionDoorKind } from "@api/selectionOwner";
import {
  clearObjectSelection,
  deleteSelectedObjects,
  getSelectedObjectRegions,
  objectOwnsKey,
  onObjectSelectionChanged,
} from "@api/objectSelection";
import { isObjectGripMenuOpen } from "@api/objectPosition";
import { getGridStateSnapshot } from "@api/grid";
import { onGridCellPressed } from "@api/cellClickInterceptors";

/** The id the selected object claims the selection under (@api/selectionOwner). */
export const SELECTED_OBJECT_OWNER_ID = "selectedObject";

/** Delete / Backspace on a selected object. */
export const OBJECT_DELETE_SELECTION_COMMAND = "object.deleteSelection";

/** Escape on a selected object (a worksheet): back to the cells. */
export const OBJECT_DESELECT_COMMAND = "object.deselect";

/**
 * How long a refusal's toast stays on screen (the toast default): an identical
 * refusal inside it is not said again.
 */
export const SELECTED_OBJECT_REFUSAL_QUIET_MS = 5000;

/**
 * The door kinds the claim lets through: the object inserts (Insert Shape,
 * Insert > Controls > Button, Insert Image). Excel inserts a shape, a form
 * button or a picture while a slicer or a shape is selected, and the new
 * object goes where it goes with nothing selected -- the active cell, which
 * the selected object leaves where it was (owner call 25, 2026-10-02).
 */
const OBJECT_INSERT_ADMITTED: readonly SelectionDoorKind[] = ["objectInsert"];

/** The ONE sentence every door refused while an object is selected shows. */
export function selectedObjectRefusal(action: string): string {
  return (
    `${action} is not available while an object is selected. ` +
    "Press Escape or click a cell to go back to the cells. Nothing was changed."
  );
}

/** A worksheet (not a canvas). No grid state at all counts as a worksheet. */
function onWorksheet(): boolean {
  return getGridStateSnapshot()?.surface !== "canvas";
}

/**
 * THE CLAIM: an object is selected on a WORKSHEET, whose active cell is hidden
 * behind it. Asked by every door, every time -- never cached.
 */
export function selectedObjectOwnsSelection(): boolean {
  return onWorksheet() && getSelectedObjectRegions().length > 0;
}

/**
 * Whether Delete / Backspace delete the selected object(s) right now: the
 * keyboard is the grid's, no grip menu is open, something is selected, and no
 * family's own door or inner keyboard owns the key.
 */
export function objectDeleteApplies(): boolean {
  return (
    isGridFocused() &&
    !isObjectGripMenuOpen() &&
    getSelectedObjectRegions().length > 0 &&
    !objectOwnsKey("Delete")
  );
}

/**
 * Whether Escape deselects the selected object(s) right now: on a worksheet,
 * with the keyboard the grid's, no grip menu open, something selected, and no
 * family owning Escape.
 */
export function objectEscapeApplies(): boolean {
  return (
    onWorksheet() &&
    isGridFocused() &&
    !isObjectGripMenuOpen() &&
    getSelectedObjectRegions().length > 0 &&
    !objectOwnsKey("Escape")
  );
}

/**
 * A handled press on the SHEET (a cell, a header, the corner -- Core announces
 * it after the press, a right-press inside the selection included): on a
 * worksheet, every selected object is deselected, so the claim ends with the
 * press that went back to the cells. Nothing selected: no family is asked.
 */
export function deselectObjectsOnSheetPress(): void {
  if (!onWorksheet()) return;
  if (getSelectedObjectRegions().length === 0) return;
  clearObjectSelection();
}

/**
 * Register the claim, the two commands, the three guarded bindings and the
 * sheet-press listener. Returns the cleanup (reverse order).
 */
export function installSelectedObjectKeys(
  context: Pick<ExtensionContext, "commands">,
  extensionId: string,
): () => void {
  const cleanups: Array<() => void> = [];

  context.commands.register(OBJECT_DELETE_SELECTION_COMMAND, () => {
    // Re-checked at run time: the palette or a script may execute it.
    if (!objectDeleteApplies()) return;
    void deleteSelectedObjects();
  });
  cleanups.push(() => context.commands.unregister(OBJECT_DELETE_SELECTION_COMMAND));

  context.commands.register(OBJECT_DESELECT_COMMAND, () => {
    if (!objectEscapeApplies()) return;
    clearObjectSelection();
  });
  cleanups.push(() => context.commands.unregister(OBJECT_DESELECT_COMMAND));

  for (const combo of ["Delete", "Backspace"] as const) {
    cleanups.push(
      registerKeybinding(
        {
          id: `ext.objectPosition.deleteSelection.${combo.toLowerCase()}`,
          combo,
          commandId: OBJECT_DELETE_SELECTION_COMMAND,
          label: "Delete Selected Objects",
          category: "Editing",
          context: "not-editing",
          source: "extension",
          extensionId,
        },
        objectDeleteApplies,
      ),
    );
  }
  cleanups.push(
    registerKeybinding(
      {
        id: "ext.objectPosition.deselect",
        combo: "Escape",
        commandId: OBJECT_DESELECT_COMMAND,
        label: "Deselect Object",
        category: "Editing",
        context: "not-editing",
        source: "extension",
        extensionId,
      },
      objectEscapeApplies,
    ),
  );

  // Each sentence said once per selection (and again once its toast is gone):
  // what was said, and when. A new selection -- or none -- forgets it.
  const said = new Map<string, number>();
  cleanups.push(onObjectSelectionChanged(() => said.clear()));
  const shouldAnnounce = (sentence: string): boolean => {
    const now = Date.now();
    const at = said.get(sentence);
    if (at !== undefined && now - at < SELECTED_OBJECT_REFUSAL_QUIET_MS) return false;
    said.set(sentence, now);
    return true;
  };

  cleanups.push(
    registerSelectionOwner({
      id: SELECTED_OBJECT_OWNER_ID,
      label: "the selected object",
      fallback: true,
      ownsSelection: selectedObjectOwnsSelection,
      refusal: selectedObjectRefusal,
      // Nothing of an object takes a typed character in place of the hidden
      // cell: a Ctrl+Alt character is read as the shortcut it collides with,
      // never typed into the cell behind the object (W17).
      receivesTyping: () => false,
      shouldAnnounce,
      // Insert Shape, Insert > Controls > Button and Insert Image stay
      // available while an object is selected (owner call 25, Excel parity):
      // they place a NEW object at the active cell and write no cell.
      admits: OBJECT_INSERT_ADMITTED,
    }),
  );

  cleanups.push(onGridCellPressed(deselectObjectsOnSheetPress));

  return () => {
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        cleanups[i]();
      } catch (err) {
        console.error("[ObjectPosition] selected-object key cleanup failed:", err);
      }
    }
  };
}
