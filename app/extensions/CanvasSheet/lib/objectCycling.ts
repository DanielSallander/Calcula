//! FILENAME: app/extensions/CanvasSheet/lib/objectCycling.ts
// PURPOSE: The keyboard on a canvas: Tab / Shift+Tab step through the page's
//          objects in paint order (selecting ONE object, whatever was
//          multi-selected), and Escape clears the whole selection set. (A press
//          on the empty page is the marquee's: lib/marquee.ts.)
// CONTEXT: A canvas has no cells, so the grid keyboard is off there (Core) and
//          every family's usual "deselect when the cell selection changes"
//          never fires. These bindings give the canvas its own object keyboard
//          through the object-selection seam (@api/objectSelection), which
//          selects WITHOUT click semantics -- dispatching Core's
//          `floatingObject:selected` from the keyboard would run a button's
//          script and leave pending clicks behind in slicers and charts.
//
//          Precedence. Each binding is registry-guarded (`when`), so it wins
//          over unguarded bindings only while it applies:
//            - only on a CANVAS surface, and only while the grid has focus
//              (Tab inside a dialog, the ribbon or a task pane is left alone);
//            - Tab only when there is something to cycle to (an empty canvas
//              must not swallow Tab and trap focus);
//            - never while an INNER selection owns the key (a floating range's
//              selected cell moves on Tab; a chart walked down to a series goes
//              up a level on Escape) -- the owning family answers that.
//
//          Escape, in order (P4 S10): while Edit interactions is on, it ends
//          the mode (the selection stays); with an object selected it
//          deselects, as before; with nothing selected and no inner selection
//          it clears the page's cross-filter selections -- and applies only
//          when there is one to clear, so it never swallows the key.

import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import { getGridStateSnapshot } from "@api/grid";
import {
  deselectAllObjects,
  getSelectedObjectRegion,
  objectOwnsKey,
  selectableFloatingRegions,
  selectObject,
} from "@api/objectSelection";
import type { GridRegion } from "@api/gridOverlays";
import { clearCrossFilters, getCrossFilters } from "@api/reportFilters";
import { getCanvasSheetSnapshot } from "./canvasSheetStore";
import { INTERACTION_OVERLAY_ATTR, exitEditInteractions, isEditInteractionsActive } from "./editInteractions";

export const CANVAS_NEXT_OBJECT_COMMAND = "canvasSheet.nextObject";
export const CANVAS_PREVIOUS_OBJECT_COMMAND = "canvasSheet.previousObject";
export const CANVAS_DESELECT_OBJECT_COMMAND = "canvasSheet.deselectObject";

function onCanvas(): boolean {
  return getGridStateSnapshot()?.surface === "canvas";
}

/**
 * The region to select when stepping `direction` from the current selection.
 * Nothing selected: forward starts at the first object, backward at the last.
 * Wraps at both ends. Pure over its inputs; exported for tests.
 */
export function stepObject(
  ordered: readonly GridRegion[],
  current: GridRegion | null,
  direction: 1 | -1,
): GridRegion | null {
  if (ordered.length === 0) return null;
  const at = current ? ordered.findIndex((r) => r.id === current.id) : -1;
  if (at < 0) return direction === 1 ? ordered[0] : ordered[ordered.length - 1];
  return ordered[(at + direction + ordered.length) % ordered.length];
}

/** Step the selection on the active canvas. Returns the newly selected region. */
export function stepCanvasObject(direction: 1 | -1): GridRegion | null {
  const ordered = selectableFloatingRegions();
  const next = stepObject(ordered, getSelectedObjectRegion(ordered), direction);
  if (next) selectObject(next);
  return next;
}

/** Guards, exported for tests. */
export function tabApplies(): boolean {
  return onCanvas() && isGridFocused() && selectableFloatingRegions().length > 0 && !objectOwnsKey("Tab");
}

/** The active canvas page's sheet id, or null. */
function activePageId(): string | null {
  return getCanvasSheetSnapshot().active?.sheetId ?? null;
}

/**
 * Whether focus is on the grid, or on Edit interactions' own chrome (its
 * strips on the page, or the ribbon toggle just pressed).
 */
function focusOnGridOrInteractions(): boolean {
  if (isGridFocused()) return true;
  const el = typeof document === "undefined" ? null : document.activeElement;
  return !!el?.closest?.(`[${INTERACTION_OVERLAY_ATTR}], [data-testid="canvas-edit-interactions"]`);
}

/**
 * Escape applies: while Edit interactions is on (it ends the mode); while
 * ANYTHING is selected -- held by a family or by the selection set (a second
 * chart in a multi-selection) -- and nothing inner owns the key (it clears it
 * all); and with nothing selected, while the page has a cross-filter
 * selection to clear.
 */
export function escapeApplies(): boolean {
  if (!onCanvas()) return false;
  if (isEditInteractionsActive()) return focusOnGridOrInteractions();
  if (!isGridFocused()) return false;
  if (getSelectedObjectRegion(selectableFloatingRegions()) !== null) return !objectOwnsKey("Escape");
  const page = activePageId();
  return page !== null && getCrossFilters(page).length > 0;
}

/** What Escape does on a canvas (see {@link escapeApplies}). Exported for tests. */
export function runCanvasEscape(): void {
  if (isEditInteractionsActive()) {
    exitEditInteractions();
    return;
  }
  if (getSelectedObjectRegion(selectableFloatingRegions()) !== null) {
    deselectAllObjects();
    return;
  }
  const page = activePageId();
  if (page !== null) clearCrossFilters(page);
}

/** Register the commands and the three guarded bindings. */
export function installCanvasObjectKeyboard(extensionId: string): Array<() => void> {
  const cleanups: Array<() => void> = [];
  CommandRegistry.register(CANVAS_NEXT_OBJECT_COMMAND, () => {
    stepCanvasObject(1);
  });
  CommandRegistry.register(CANVAS_PREVIOUS_OBJECT_COMMAND, () => {
    stepCanvasObject(-1);
  });
  CommandRegistry.register(CANVAS_DESELECT_OBJECT_COMMAND, () => {
    runCanvasEscape();
  });
  cleanups.push(() => CommandRegistry.unregister(CANVAS_NEXT_OBJECT_COMMAND));
  cleanups.push(() => CommandRegistry.unregister(CANVAS_PREVIOUS_OBJECT_COMMAND));
  cleanups.push(() => CommandRegistry.unregister(CANVAS_DESELECT_OBJECT_COMMAND));

  const binding = (id: string, combo: string, commandId: string, label: string) => ({
    id,
    combo,
    commandId,
    label,
    category: "Canvas",
    context: "not-editing" as const,
    source: "extension" as const,
    extensionId,
  });
  cleanups.push(
    registerKeybinding(
      binding("ext.canvasSheet.nextObject", "Tab", CANVAS_NEXT_OBJECT_COMMAND, "Next Object on Canvas"),
      tabApplies,
    ),
  );
  cleanups.push(
    registerKeybinding(
      binding("ext.canvasSheet.previousObject", "Shift+Tab", CANVAS_PREVIOUS_OBJECT_COMMAND, "Previous Object on Canvas"),
      tabApplies,
    ),
  );
  cleanups.push(
    registerKeybinding(
      binding("ext.canvasSheet.deselectObject", "Escape", CANVAS_DESELECT_OBJECT_COMMAND, "Deselect Object on Canvas"),
      escapeApplies,
    ),
  );
  return cleanups;
}
