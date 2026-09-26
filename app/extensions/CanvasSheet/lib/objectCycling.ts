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

/**
 * Escape applies while ANYTHING is selected -- held by a family or by the
 * selection set (a second chart in a multi-selection) -- and clears it all.
 */
export function escapeApplies(): boolean {
  return (
    onCanvas() &&
    isGridFocused() &&
    getSelectedObjectRegion(selectableFloatingRegions()) !== null &&
    !objectOwnsKey("Escape")
  );
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
    deselectAllObjects();
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
