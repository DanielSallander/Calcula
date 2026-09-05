//! FILENAME: app/extensions/Controls/lib/controlObjectMenu.ts
// PURPOSE: Make the floating control's right-click menu REACHABLE — the
//          capture-phase `contextmenu` listener that hit-tests the controls this
//          extension owns and shows their own overlay menu.
// CONTEXT: Core deliberately opens NO cell menu over a floating object
//          (Spreadsheet.tsx: "Cell options on an object right-click are always
//          wrong") and emits no event for it either, so an extension that only
//          registers items with `gridExtensions` gets a menu nobody can open.
//          That is exactly what Controls shipped: fifteen items, unreachable.
//          Charts, Slicer, TimelineSlicer and the Floating Range all solve it
//          the same way, and this is that pattern for Controls.

import { registerOverlay, unregisterOverlay, showOverlay, AppEvents } from "@api";
import { emitAppEvent } from "@api/events";
import { ControlContextMenu } from "../components/ControlContextMenu";
import { buildControlObjectMenu } from "./controlContextMenu";
import { floatingControlRegionAtClientPoint } from "./controlHitTest";
import { getFloatingControl, getGroupForControl, getGroupMembers } from "./floatingStore";
import {
  isFloatingControlSelected,
  selectFloatingControl,
  selectFloatingControls,
} from "../Button/floatingSelection";

export const CONTROL_CONTEXT_MENU_ID = "controls:contextMenu";

/**
 * Make the right-clicked control the selection, unless it already is one.
 *
 * Not optional bookkeeping: "Delete" acts on the SELECTION (it goes through
 * `controls:delete-selected`, which expands groups), so a menu opened without
 * selecting would offer to delete some other object entirely. The
 * already-selected guard is what keeps a multi-selection intact, which is what
 * makes "Group" mean anything when you right-click one of the two.
 *
 * Selection happens HERE rather than by dispatching `floatingObject:selected`,
 * the event Core sends on a left mousedown: that handler RUNS a button's script
 * in run mode, and a right-click must never fire a macro.
 */
function selectForMenu(controlId: string): void {
  if (isFloatingControlSelected(controlId)) return;

  const groupId = getGroupForControl(controlId);
  if (groupId) {
    selectFloatingControls(getGroupMembers(groupId));
  } else {
    selectFloatingControl(controlId);
  }
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Register the menu overlay and install the capture-phase listener.
 * Returns the cleanup that removes both (called from the extension's deactivate).
 */
export function installControlObjectMenu(): () => void {
  registerOverlay({
    id: CONTROL_CONTEXT_MENU_ID,
    component: ControlContextMenu,
    layer: "dropdown",
  });

  const handleControlContextMenu = (e: MouseEvent) => {
    if (e.shiftKey) return; // Shift+right-click = the browser's own menu.

    // The listener is on `window`, so it also sees right-clicks in dialogs, the
    // properties pane and the ribbon. Those have client coordinates that can map
    // INTO a control's rect once converted to the canvas basis, which would pop
    // an object menu from a click that never touched the grid. Containment
    // settles it before any geometry runs; text fields keep their own menu.
    const target = e.target as HTMLElement | null;
    const layer = document.querySelector("[data-grid-canvas-layer]");
    if (!target || !layer || !layer.contains(target)) return;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) {
      return;
    }

    const region = floatingControlRegionAtClientPoint(e.clientX, e.clientY);
    if (!region) return; // An empty cell: Core's own cell menu is the right one.

    const control = getFloatingControl(region.id);
    if (!control) return;

    // preventDefault ALSO satisfies Core's `defaultPrevented` check, so the
    // grid's handler stands down before it even runs its own region test.
    e.preventDefault();
    e.stopPropagation();

    selectForMenu(control.id);

    showOverlay(CONTROL_CONTEXT_MENU_ID, {
      data: {
        controlId: control.id,
        screenX: e.clientX,
        screenY: e.clientY,
        // Built at OPEN time: which items apply depends on the control type, on
        // whether anything is on the control clipboard, and on how many controls
        // are selected — all of which change between one right-click and the next.
        items: buildControlObjectMenu(control.id),
      },
    });
  };

  window.addEventListener("contextmenu", handleControlContextMenu, true);

  return () => {
    window.removeEventListener("contextmenu", handleControlContextMenu, true);
    unregisterOverlay(CONTROL_CONTEXT_MENU_ID);
  };
}
