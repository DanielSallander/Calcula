//! FILENAME: app/extensions/CanvasSheet/lib/canvasClipboard.ts
// PURPOSE: Ctrl+C / Ctrl+V / Ctrl+D on a CANVAS copy, paste and duplicate the
//          selected OBJECTS -- every one of them, across families -- through
//          the object clipboard (@api/objectClipboard). A paste or duplicate
//          of several is ONE undo step; the copies land offset and become the
//          selection.
// CONTEXT: W25 (the copy/duplicate half of open-items 2.af row 1). A canvas
//          selection spans families (a chart, a second chart the selection
//          set holds, a shape), and only Controls had a copy at all: its keys
//          REFUSED a selection that held anything else (the wave A interim),
//          and with no control in the selection the keys fell through to the
//          grid's Copy / Paste / Fill Down, which have nothing to act on on a
//          page without cells. This is the canvas's ONE door for the three:
//
//            - guarded registry bindings (`when`), so they beat the unguarded
//              built-ins on a canvas and nowhere else; Controls' own
//              Copy / Paste / Duplicate bindings stand aside on a canvas
//              (`canvasOwnsObjectClipboard`) -- registered earlier, they would
//              otherwise win the tie and act on the controls alone;
//            - Copy and Duplicate apply with at least one object selected,
//              Paste whenever the object clipboard holds something (a canvas
//              has no cells to paste into), all with the grid focused;
//            - never while an INNER selection owns the clipboard keys
//              (`objectOwnsKey("Clipboard")`): a floating range with a selected
//              cell keeps them for its cells;
//            - Copy yields to a real DOM text selection, as every Copy does;
//            - Paste and Duplicate on a SUBSCRIBED canvas (the publisher's
//              page) are refused with the canvas's one sentence; Copy is a
//              read and stays allowed there.
//
//          What the families can copy is theirs to say (their providers'
//          `copyObjects` / `pasteObjects`): today charts and controls (shapes,
//          buttons, pictures). A slicer, a timeline, a floating grid and a
//          pivot box are left out of a copy and named in one toast.

import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import { getSelectedObjectRegions } from "@api/objectSelection";
import {
  OBJECT_COPY_COMMAND,
  OBJECT_PASTE_COMMAND,
  canvasOwnsObjectClipboard,
  copySelectedObjects,
  duplicateSelectedObjects,
  hasObjectClipboard,
  objectClipboardHasClipboardKeys,
  pasteObjectClipboard,
} from "@api/objectClipboard";
import { showToast } from "@api/notifications";
import { getCanvasSheetSnapshot } from "./canvasSheetStore";
import { SUBSCRIBED_NOTE } from "./canvasNotes";

// Copy and Paste register under the ids @api/objectClipboard names, so the
// Edit menu's and the Home tab's doors (`clipboardDoorCommand`) run exactly
// these commands (wave E, Y11: one rule, one spelling of the ids).
export const CANVAS_COPY_SELECTION_COMMAND = OBJECT_COPY_COMMAND;
export const CANVAS_PASTE_OBJECTS_COMMAND = OBJECT_PASTE_COMMAND;
export const CANVAS_DUPLICATE_SELECTION_COMMAND = "canvasSheet.duplicateSelection";

/** Whether the browser holds a real text selection (a copy yields to it). */
function hasDomTextSelection(): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().trim() !== "";
}

/** The part of every guard: the object clipboard holds the clipboard keys (a
 *  canvas, no inner selection claiming them -- @api/objectClipboard's ONE
 *  rule, the one the Edit menu and the Home tab ask) and the grid has the keyboard. */
function canvasKeysApply(): boolean {
  return objectClipboardHasClipboardKeys() && isGridFocused();
}

/** Ctrl+C's guard (exported for tests). */
export function canvasCopyApplies(): boolean {
  return canvasKeysApply() && !hasDomTextSelection() && getSelectedObjectRegions().length > 0;
}

/** Ctrl+V's guard (exported for tests). */
export function canvasPasteApplies(): boolean {
  return canvasKeysApply() && hasObjectClipboard();
}

/** Ctrl+D's guard (exported for tests). */
export function canvasDuplicateApplies(): boolean {
  return canvasKeysApply() && getSelectedObjectRegions().length > 0;
}

/** A paste or duplicate would ADD objects to a page that is the publisher's: say so, once. */
function refusedOnSubscribedCanvas(): boolean {
  if (!getCanvasSheetSnapshot().activeSubscribed) return false;
  showToast(SUBSCRIBED_NOTE, { type: "info" });
  return true;
}

function report(what: string) {
  return (err: unknown): void => {
    console.error(`[CanvasSheet] ${what} failed:`, err);
  };
}

/** Register the three commands and their guarded bindings; returns the cleanups. */
export function installCanvasObjectClipboard(extensionId: string): Array<() => void> {
  const cleanups: Array<() => void> = [];

  // Each command re-checks at run time: the palette or a script may execute
  // it anywhere -- on a worksheet each family keeps its own door.
  CommandRegistry.register(CANVAS_COPY_SELECTION_COMMAND, () => {
    if (!canvasOwnsObjectClipboard() || getSelectedObjectRegions().length === 0) return;
    void copySelectedObjects().catch(report("Copy"));
  });
  CommandRegistry.register(CANVAS_PASTE_OBJECTS_COMMAND, () => {
    if (!canvasOwnsObjectClipboard() || !hasObjectClipboard()) return;
    if (refusedOnSubscribedCanvas()) return;
    void pasteObjectClipboard().catch(report("Paste"));
  });
  CommandRegistry.register(CANVAS_DUPLICATE_SELECTION_COMMAND, () => {
    if (!canvasOwnsObjectClipboard() || getSelectedObjectRegions().length === 0) return;
    if (refusedOnSubscribedCanvas()) return;
    void duplicateSelectedObjects().catch(report("Duplicate"));
  });
  for (const id of [
    CANVAS_COPY_SELECTION_COMMAND,
    CANVAS_PASTE_OBJECTS_COMMAND,
    CANVAS_DUPLICATE_SELECTION_COMMAND,
  ]) {
    cleanups.push(() => CommandRegistry.unregister(id));
  }

  const bind = (slug: string, combo: string, commandId: string, label: string, when: () => boolean): void => {
    cleanups.push(
      registerKeybinding(
        {
          id: `ext.canvasSheet.${slug}`,
          combo,
          commandId,
          label,
          category: "Canvas",
          context: "not-editing",
          source: "extension",
          extensionId,
        },
        when,
      ),
    );
  };
  bind("copySelection", "Ctrl+C", CANVAS_COPY_SELECTION_COMMAND, "Copy Selected Objects", canvasCopyApplies);
  bind("pasteObjects", "Ctrl+V", CANVAS_PASTE_OBJECTS_COMMAND, "Paste Objects", canvasPasteApplies);
  bind(
    "duplicateSelection",
    "Ctrl+D",
    CANVAS_DUPLICATE_SELECTION_COMMAND,
    "Duplicate Selected Objects",
    canvasDuplicateApplies,
  );
  return cleanups;
}
