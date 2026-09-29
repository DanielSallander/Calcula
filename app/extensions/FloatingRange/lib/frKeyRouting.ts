//! FILENAME: app/extensions/FloatingRange/lib/frKeyRouting.ts
// PURPOSE: While a floating range owns the selection, nothing may act on Core's
//          HIDDEN active cell. Delete/Backspace are routed to the range (clear
//          its cells, or delete the object); every other door that acts on
//          Core's selection is refused with one sentence -- through the two
//          feature-neutral seams built for exactly this (wave A, K1 and K3).
// CONTEXT: Review 2026-09-27 (FR finding 5). Clicking a floating range's cell
//          on a WORKSHEET leaves Core's selection on the last grid cell (say
//          Sheet1!C3) and the grid container focused. Delete cleared C3 as
//          well as the range's cell, Ctrl+V pasted into C3, the ribbon's Bold
//          turned it bold (BUG-0185).
//
// TWO MECHANISMS, EACH FOR WHAT IT COVERS (E7, 2026-09-28; W18, wave C):
//
//   1. THE SELECTION OWNER (@api/selectionOwner). The range CLAIMS the
//      selection while one of its cells -- or the range itself -- is selected
//      on the sheet shown. Every door that writes to Core's selection asks the
//      claim and refuses ONCE with the range's sentence, whichever key, button
//      or menu reached it (so a remap changes nothing -- BUG-0199): the grid
//      commands' one choke point (`gridCommands.execute`: cut, copy, paste,
//      the clears, the fills, merge, insert/delete row/column -- the core.*
//      commands bridge to it), Core's grid keyboard (the font toggles, number
//      formats, Ctrl+; / Ctrl+Shift+:, Ctrl+Alt+V, F11, Space), the formatting
//      doors (Home tab, Format Cells, Format menu, mini toolbar, Format
//      Painter, Paste Special and its quick pastes, Conditional Formatting),
//      and since D4 every extension command that acts on the selection
//      (Insert Table, AutoFilter, Group/Ungroup, Hyperlink, Flash Fill,
//      Comment/Note, Bookmark, ...).
//      W18: the range used to ALSO refuse 24 of those commands by id at the
//      dispatcher (`registerCommandRefusal`) -- first for doors that did not
//      ask yet, then "belt and braces". Answering BEFORE the door made it
//      redundant everywhere and wrong where the door is finer: Ctrl+Shift+L
//      could not turn an existing filter OFF, which AutoFilter's door allows
//      (the sheet's filter, not the selection's). The door decides now.
//
//   2. COMBINATIONS, only for a key no command stands behind: Data
//      Validation's Alt+Down is its own window listener, so the refusal is a
//      guarded, EXCLUSIVE binding on that key (the listener asks the owner
//      too since D4; the exclusive binding keeps it to one sentence, the
//      range's, and keeps the key from anything else on the window).
//
// Delete/Backspace stay a guarded binding of the RANGE (not a refusal): they
// clear the range's cells, which is a real action. A remapped Clear Contents
// is refused by the owner (its command bridges to `gridCommands`).

import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import { registerSelectionOwner } from "@api/selectionOwner";
import { deleteSelectedObjects, shouldActOnWholeObjectSelection } from "@api/objectSelection";
import { showToast } from "@api";
import { getFloatingRangeById, getFrActiveSheetIndex } from "./floatingRangeStore";
import { getLocalSelection, getSelectedFloatingRange } from "./frSelection";
import { isFrEditorOpen } from "../editor/frEditor";

/** The range's Delete/Backspace command (clear the cells, or delete the object). */
export const FR_DELETE_SELECTION_COMMAND = "ext.floatingRange.deleteSelection";

/** The id the range claims the selection under (@api/selectionOwner). */
export const FR_SELECTION_OWNER_ID = "floatingRange";

/** What the refusal calls the thing that holds the selection. */
export const FR_SELECTION_OWNER_LABEL = "a floating grid's cells";

/**
 * The ONE sentence every refused door shows -- a key, a ribbon button, a menu
 * item, a remapped shortcut -- so the user hears the same thing whichever way
 * they asked.
 */
export function frSelectionRefusal(action: string): string {
  return `${action} is not available for a floating range's cells yet. Nothing was changed.`;
}

/** A key with no command behind it, refused as a COMBINATION. */
export interface FrRefusedCombo {
  combo: string;
  action: string;
}

/**
 * The keys no registered command stands behind -- an extension's own window
 * listener acts on them -- so only an exclusive binding on the key itself can
 * stop them. Keep this list short: a combination does NOT follow a remap.
 */
export const FR_REFUSED_COMBOS: readonly FrRefusedCombo[] = [
  // Data Validation's in-cell dropdown (its own window-capture listener).
  { combo: "Alt+ArrowDown", action: "Pick From List" },
];

/** The binding/command slug of a refused combination (unique). */
export function frRefusalSlug(key: { action: string }): string {
  return key.action.toLowerCase().replace(/\s+/g, "");
}

/** A floating range selection (cells, or just the object) on the sheet shown. */
export function frSelectionOnScreen(): boolean {
  const id = getLocalSelection()?.frId ?? getSelectedFloatingRange();
  if (!id) return false;
  const entry = getFloatingRangeById(id);
  return !!entry && entry.sheetIndex === getFrActiveSheetIndex();
}

/**
 * Whether a character typed now lands in one of the range's own CELLS (the
 * claim's `receivesTyping`): the range's type-to-edit (index.ts
 * handleFrKeyDown) takes it only with a cell selected and no editor open.
 * With only the OBJECT selected nothing of the range takes typing -- and
 * Core's cell under it is hidden -- so the keybinding dispatcher reads an
 * AltGr character as the shortcut it collides with, not as typing (W17,
 * review C).
 */
export function frReceivesTyping(): boolean {
  return getLocalSelection() !== null && !isFrEditorOpen();
}

/**
 * The keyboard is the grid's: the grid container is focused, or nothing is
 * (a committed range edit leaves the focus on the body -- the canvas it asks
 * for takes none -- and the range's keys have always worked from there).
 * Never a button or a pane: "select a range, click a task pane's tab, press
 * Delete" must not clear the range.
 */
function keyboardIsTheGrids(): boolean {
  if (isGridFocused()) return true;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  return active === null || active === document.body;
}

/**
 * Whether the range owns the grid's selection keys right now -- the GRID's
 * keys, so the keyboard must be the grid's: Delete/Backspace (and their
 * modified forms, index.ts) with the keyboard on a pane's button are not the
 * range's ("select a range, click a task pane's tab, press Delete" must not
 * clear it).
 */
export function frOwnsGridKeys(): boolean {
  return !isFrEditorOpen() && frSelectionOnScreen() && keyboardIsTheGrids();
}

/** Whether a refused combination is refused right now (text fields never see it). */
export function frRefusesCombo(): boolean {
  return !isFrEditorOpen() && frSelectionOnScreen();
}

/**
 * The range's Delete door (index.ts `deleteFrSelection`) asks this BEFORE its
 * own delete: on a CANVAS whose object selection spans families, with no
 * inner cell selection, Delete acts on the WHOLE selection
 * (@api/objectSelection) -- a second chart and a slicer beside the range are
 * deleted with it, through each family's `deleteObjects`. The keybinding
 * dispatcher runs ONE winner per key, so whichever family's Delete binding
 * wins must hand the whole selection over. Returns true when it did.
 */
export function handOverToWholeSelectionDelete(): boolean {
  if (getLocalSelection() !== null) return false;
  if (!shouldActOnWholeObjectSelection()) return false;
  void deleteSelectedObjects();
  return true;
}

/**
 * Install the Delete bindings, the selection-owner claim and the one
 * combination refusal. `deleteSelection` is the extension's own Delete
 * (index.ts: clear the local selection's cells, or confirm-and-delete the
 * selected object). Returns the cleanup.
 */
export function installFrKeyRouting(deps: {
  extensionId: string;
  deleteSelection: () => void;
}): () => void {
  const cleanups: (() => void)[] = [];

  CommandRegistry.register(FR_DELETE_SELECTION_COMMAND, () => {
    // Re-checked at run time: a command palette or a script may execute it.
    if (!frSelectionOnScreen() || isFrEditorOpen()) return;
    deps.deleteSelection();
  });
  cleanups.push(() => CommandRegistry.unregister(FR_DELETE_SELECTION_COMMAND));
  for (const combo of ["Delete", "Backspace"] as const) {
    cleanups.push(
      registerKeybinding(
        {
          id: `ext.floatingRange.deleteSelection.${combo.toLowerCase()}`,
          combo,
          commandId: FR_DELETE_SELECTION_COMMAND,
          label: "Clear Floating Range Cells",
          category: "Editing",
          context: "not-editing",
          source: "extension",
          extensionId: deps.extensionId,
        },
        frOwnsGridKeys,
      ),
    );
  }

  // 1. The claim. Asked by every door, every time (never cached), so it cannot
  //    outlive the selection it describes.
  cleanups.push(
    registerSelectionOwner({
      id: FR_SELECTION_OWNER_ID,
      label: FR_SELECTION_OWNER_LABEL,
      ownsSelection: frSelectionOnScreen,
      refusal: frSelectionRefusal,
      receivesTyping: frReceivesTyping,
    }),
  );

  // 2. The combinations no command stands behind. (No refusal by command id:
  //    every command that acts on the selection asks the claim itself -- W18.)
  for (const key of FR_REFUSED_COMBOS) {
    const slug = frRefusalSlug(key);
    const commandId = `ext.floatingRange.refuse.${slug}`;
    CommandRegistry.register(commandId, () => {
      showToast(frSelectionRefusal(key.action), { variant: "info" });
    });
    cleanups.push(() => CommandRegistry.unregister(commandId));
    cleanups.push(
      registerKeybinding(
        {
          id: `ext.floatingRange.refuse.${slug}`,
          combo: key.combo,
          commandId,
          label: `${key.action} (Floating Range)`,
          category: "Editing",
          context: "not-editing",
          source: "extension",
          extensionId: deps.extensionId,
          // The refusal must be the ONLY listener that acts: the owning
          // extension's own window-capture listener for the same key would
          // otherwise run the refused action over the hidden cell anyway.
          exclusive: true,
          // Not a shortcut the user looks up or remaps: a "not now" over the
          // real one, which stays listed.
          listed: false,
        },
        frRefusesCombo,
      ),
    );
  }

  return () => {
    for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]();
  };
}
