//! FILENAME: app/extensions/FloatingRange/lib/frKeyRouting.ts
// PURPOSE: While a floating range owns the selection, the grid's own
//          selection-acting keys and commands must not act on Core's HIDDEN
//          active cell. Delete/Backspace are routed to the range (clear its
//          cells, or delete the object); copy, cut, paste, fill, format and
//          merge are refused with a sentence; and the grid commands' ribbon
//          and menu doors are guarded.
// CONTEXT: Review 2026-09-27 (FR finding 5). Clicking a floating range's cell
//          on a WORKSHEET leaves Core's selection on the last grid cell (say
//          Sheet1!C3) and the grid container focused. The keybinding
//          dispatcher (@api/keybindings) is a window-CAPTURE listener that
//          runs before this extension's own keyboard handler, and it matched
//          Delete to `core.edit.clearContents` over C3 -- then the range's
//          handler cleared its own cell too, because the dispatcher's
//          stopPropagation does not stop a second listener on the same target.
//          One Delete cleared two cells, one of them out of sight; Ctrl+V
//          pasted into C3, Ctrl+X cut it, Ctrl+D/R filled around it.
//
//          The ONLY honest way to say "the range owns this key while its
//          selection exists" is a guarded binding: the dispatcher prefers a
//          binding whose `when` passed over the unguarded built-in -- the
//          shape Charts (`ext.charts.deleteSelection`) and Controls
//          (`ext.controls.deleteSelection`) already use for the identical
//          collision. `context: "not-editing"` keeps every text field and
//          pointer claim out of it, and the dispatcher does the
//          preventDefault/stopPropagation itself.
//
//          No clipboard or fill of a range's cells exists yet (v1), so those
//          keys say so instead of reaching the hidden cell. A copy with real
//          DOM text selected is left to the browser, as the dispatcher does for
//          its own copy.

import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import { gridCommands, showToast } from "@api";
import { GRID_COMMANDS, type GridCommand } from "@api/extensions";
import { getFloatingRangeById, getFrActiveSheetIndex } from "./floatingRangeStore";
import { getLocalSelection, getSelectedFloatingRange } from "./frSelection";
import { isFrEditorOpen } from "../editor/frEditor";

/** The range's Delete/Backspace command (clear the cells, or delete the object). */
export const FR_DELETE_SELECTION_COMMAND = "ext.floatingRange.deleteSelection";

/**
 * Every grid key the range refuses while it owns the selection: each one acts
 * on Core's active cell or selection -- on a worksheet, a cell HIDDEN under the
 * range the user is looking at. Audited 2026-09-28 across the three places a
 * grid key is acted on:
 *   - the keybinding registry's built-ins (api/keybindings.ts);
 *   - Core's own grid keyboard (core/hooks/useGridKeyboard.ts: the font
 *     toggles, number formats, Ctrl+; / Ctrl+Shift+:, Ctrl+Alt+V, F11), which
 *     no registry binding names but which this dispatcher's match still
 *     stops (it runs first, on window capture);
 *   - extensions' own window-capture listeners (Hyperlinks Ctrl+K, Flash Fill
 *     Ctrl+E, Grouping Alt+Shift+Arrow, AutoFilter Ctrl+Shift+L, Review
 *     Ctrl+Alt+M and Shift+F2, Data Validation Alt+Down, Format Painter
 *     Ctrl+Shift+C), which only an EXCLUSIVE binding silences.
 * Left alone on purpose: keys that only MOVE Core's selection or open a
 * dialog/pane without writing (Ctrl+A, Ctrl+Space, Ctrl+G, Alt+;, Ctrl+[ / ],
 * Ctrl+F/H, Ctrl+F3, F5, F9, Ctrl+`), and undo/redo (a workbook action, not a
 * cell's).
 * `id` names the binding and command when one action has two keys.
 *
 * WHERE THE KEYBOARD IS (review 2026-09-28). A refusal is refused WHEREVER the
 * keyboard sits -- the grid, the body, a ribbon tab's button, a pane's button
 * -- except a text field (the bindings' "not-editing" context). That is the
 * safe default, because most of these keys are acted on by something that
 * never asks where the focus is: a registry built-in that is not grid-scoped
 * (Ctrl+T, Ctrl+E, Ctrl+Shift+L, ... -- "not-editing" since fix round 4, which
 * keeps them out of text fields and live edits but not off a focused button)
 * or an extension's own window listener (Review's
 * Ctrl+Alt+M wrote a comment into the hidden cell from a focused ribbon tab).
 * Only a key marked `gridFocusOnly` stands down off the grid, and only because
 * EVERY action behind it that reads Core's selection needs the grid focused: a
 * grid-scoped registry binding (the dispatcher skips those off the grid) or
 * Core's grid keyboard (a listener on the grid container). Off the grid such a
 * key keeps its native or pane meaning (Controls' Ctrl+C/V/D act on a selected
 * control, CellBookmarks' Ctrl+Shift+V opens Save View -- neither reads a
 * cell). frKeyRouting.test.ts pins the registry half of that claim; an
 * extension listener added for a `gridFocusOnly` key that acts on the
 * selection must drop the mark.
 */
export interface FrRefusedGridKey {
  combo: string;
  action: string;
  id?: string;
  /** Copy/cut defer to a real DOM text selection (the dispatcher's own rule). */
  textSelectionWins?: boolean;
  /** Every action behind the key needs the grid focused (see above). */
  gridFocusOnly?: boolean;
}

export const FR_REFUSED_GRID_KEYS: readonly FrRefusedGridKey[] = [
  // Grid-scoped registry built-ins (the dispatcher skips them off the grid).
  { combo: "Ctrl+C", action: "Copy", textSelectionWins: true, gridFocusOnly: true },
  { combo: "Ctrl+X", action: "Cut", textSelectionWins: true, gridFocusOnly: true },
  { combo: "Ctrl+V", action: "Paste", gridFocusOnly: true },
  { combo: "Ctrl+Shift+V", action: "Paste Special", gridFocusOnly: true },
  { combo: "Ctrl+D", action: "Fill Down", gridFocusOnly: true },
  { combo: "Ctrl+R", action: "Fill Right", gridFocusOnly: true },
  { combo: "Ctrl+1", action: "Format Cells", gridFocusOnly: true },
  { combo: "Ctrl+M", action: "Merge Cells", gridFocusOnly: true },
  // Core's grid keyboard (a listener on the grid container).
  { combo: "Ctrl+Alt+V", action: "Paste Special", id: "pastespecial.alt", gridFocusOnly: true },
  // Font toggles (Core's grid keyboard).
  { combo: "Ctrl+B", action: "Bold", gridFocusOnly: true },
  { combo: "Ctrl+2", action: "Bold", id: "bold.2", gridFocusOnly: true },
  { combo: "Ctrl+I", action: "Italic", gridFocusOnly: true },
  { combo: "Ctrl+3", action: "Italic", id: "italic.3", gridFocusOnly: true },
  { combo: "Ctrl+U", action: "Underline", gridFocusOnly: true },
  { combo: "Ctrl+4", action: "Underline", id: "underline.4", gridFocusOnly: true },
  { combo: "Ctrl+5", action: "Strikethrough", gridFocusOnly: true },
  // Number formats (Core's grid keyboard; the shifted symbol is the key).
  { combo: "Ctrl+Shift+~", action: "General Number Format", gridFocusOnly: true },
  { combo: "Ctrl+Shift+`", action: "General Number Format", id: "generalnumberformat.backtick", gridFocusOnly: true },
  { combo: "Ctrl+Shift+$", action: "Currency Format", gridFocusOnly: true },
  { combo: "Ctrl+Shift+%", action: "Percentage Format", gridFocusOnly: true },
  { combo: "Ctrl+Shift+^", action: "Scientific Format", gridFocusOnly: true },
  { combo: "Ctrl+Shift+#", action: "Date Format", gridFocusOnly: true },
  { combo: "Ctrl+Shift+@", action: "Time Format", gridFocusOnly: true },
  { combo: "Ctrl+Shift+!", action: "Number Format", gridFocusOnly: true },
  // Data entry into the active cell (Core's grid keyboard).
  { combo: "Ctrl+;", action: "Insert Date", gridFocusOnly: true },
  { combo: "Ctrl+Shift+:", action: "Insert Time", gridFocusOnly: true },
  { combo: "F11", action: "Insert Chart", gridFocusOnly: true },
  // EVERYTHING BELOW acts whatever has the keyboard, so it is refused there too.
  // Format Painter's own window listener checks no focus at all (its registry
  // built-in is grid-scoped, the listener is not).
  { combo: "Ctrl+Shift+C", action: "Format Painter" },
  // Objects and structure built from the selection.
  { combo: "Ctrl+T", action: "Insert Table" },
  { combo: "Ctrl+Shift+L", action: "AutoFilter" },
  { combo: "Alt+Shift+ArrowRight", action: "Group" },
  { combo: "Alt+Shift+ArrowLeft", action: "Ungroup" },
  // Cell-anchored content (extensions' own listeners).
  { combo: "Ctrl+K", action: "Insert Hyperlink" },
  { combo: "Ctrl+E", action: "Flash Fill" },
  { combo: "Ctrl+Alt+M", action: "New Comment" },
  { combo: "Shift+F2", action: "New Note" },
  { combo: "Ctrl+Shift+B", action: "Toggle Bookmark" },
  { combo: "Alt+ArrowDown", action: "Pick From List" },
];

/** The binding/command slug of a refused key (unique; pinned by frKeyRouting.test.ts). */
export function frRefusalSlug(key: { action: string; id?: string }): string {
  return key.id ?? key.action.toLowerCase().replace(/\s+/g, "");
}

/**
 * The grid commands whose ribbon/menu doors act on Core's selection -- ALL of
 * them: cut/copy/paste, the four clears (contents, formatting, comments,
 * hyperlinks) and Clear All, insert/delete row/column, merge/unmerge, and the
 * four fills. Guarded so a button pressed while a range owns the selection is
 * refused rather than run over the hidden cell. The list is Core's own, handed
 * out by @api (it used to be a copied union of 8 of these 18, so the fill,
 * merge and clear-formatting doors could not even be named here).
 */
const GUARDED_GRID_COMMANDS: GridCommand[] = [...GRID_COMMANDS];

export const FR_GRID_COMMAND_REFUSAL =
  "A floating range's cells are selected, so this command would act on a sheet cell you cannot see. " +
  "Click a cell of the sheet first.";

/** A floating range selection (cells, or just the object) on the sheet shown. */
export function frSelectionOnScreen(): boolean {
  const id = getLocalSelection()?.frId ?? getSelectedFloatingRange();
  if (!id) return false;
  const entry = getFloatingRangeById(id);
  return !!entry && entry.sheetIndex === getFrActiveSheetIndex();
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

function hasDomTextSelection(): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().trim() !== "";
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

/**
 * Whether a refused key is refused right now. Wherever the keyboard is,
 * unless the key is `gridFocusOnly` (FR_REFUSED_GRID_KEYS); text fields never
 * see it (the bindings' "not-editing" context).
 */
export function frRefusesKey(key: FrRefusedGridKey): boolean {
  if (isFrEditorOpen() || !frSelectionOnScreen()) return false;
  if (key.textSelectionWins && hasDomTextSelection()) return false;
  return key.gridFocusOnly === true ? keyboardIsTheGrids() : true;
}

/**
 * Install the bindings, their commands and the grid-command guard. `deleteSelection`
 * is the extension's own Delete (index.ts: clear the local selection's cells,
 * or confirm-and-delete the selected object). Returns the cleanup.
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

  for (const key of FR_REFUSED_GRID_KEYS) {
    const slug = frRefusalSlug(key);
    const commandId = `ext.floatingRange.refuse.${slug}`;
    CommandRegistry.register(commandId, () => {
      showToast(
        `${key.action} is not available for a floating range's cells yet. Nothing was changed.`,
        { variant: "info" },
      );
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
          // The refusal must be the ONLY listener that acts: an extension's
          // own window-capture listener for the same key (Ctrl+K, Ctrl+E, ...)
          // would otherwise run the refused action over the hidden cell anyway.
          exclusive: true,
          // Not a shortcut the user looks up or remaps: a "not now" over the
          // real one, which stays listed. Listing them put ~40 rows on the
          // keyboard settings page, each with an Edit that would move the
          // refusal off the key it refuses.
          listed: false,
        },
        () => frRefusesKey(key),
      ),
    );
  }

  cleanups.push(
    gridCommands.registerGuard(GUARDED_GRID_COMMANDS, () =>
      frSelectionOnScreen() ? FR_GRID_COMMAND_REFUSAL : true,
    ),
  );

  return () => {
    for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]();
  };
}
