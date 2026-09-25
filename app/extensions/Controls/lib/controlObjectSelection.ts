//! FILENAME: app/extensions/Controls/lib/controlObjectSelection.ts
// PURPOSE: Controls' provider for @api/objectSelection — select, deselect and
//          report floating controls (buttons, shapes, pictures) for a caller
//          that is NOT a mouse press: a canvas sheet's Tab / Shift+Tab object
//          cycling, its Escape, its click on the empty page.
// CONTEXT: The only other way a control becomes selected is Core's
//          `floatingObject:selected`, and Controls' handler for that event is a
//          CLICK handler: in run mode it emits `button:clicked` and runs the
//          button's script (macro link, inline onSelect, object script), it
//          emits `shape:clicked` to object scripts, and it opens the Properties
//          pane. A keyboard user cycling past a "Delete all rows" button must
//          never press it. So "select" here means: the selection set changes,
//          the canvas repaints, and NOTHING else happens — no event a script
//          can hear, no pane, no run.
//
//          Group expansion is the SAME rule the right-click menu uses
//          (`selectControlWithGroup`, shared with controlObjectMenu.ts): a
//          grouped control is selected together with its group, because every
//          operation on the selection (Delete, move, the Group/Ungroup items)
//          acts on the group.

import { AppEvents } from "@api";
import { emitAppEvent } from "@api/events";
import type { GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { FLOATING_CONTROL_REGION_TYPE } from "./controlHitTest";
import { getFloatingControl, getGroupForControl, getGroupMembers } from "./floatingStore";
import {
  deselectFloatingControl,
  getSelectedControlCount,
  isFloatingControlSelected,
  selectFloatingControl,
  selectFloatingControls,
} from "../Button/floatingSelection";

/**
 * Make `controlId` — expanded to its whole group when it has one — THE
 * selection, replacing whatever was selected before. No repaint, no event:
 * callers decide what else a selection change means for them.
 */
export function selectControlWithGroup(controlId: string): void {
  const groupId = getGroupForControl(controlId);
  if (groupId) {
    selectFloatingControls(getGroupMembers(groupId));
  } else {
    selectFloatingControl(controlId);
  }
}

/** The provider object (exported for tests; register it through
 *  `registerControlObjectSelection`). */
export function createControlSelectionProvider(): ObjectSelectionProvider {
  return {
    types: [FLOATING_CONTROL_REGION_TYPE],

    isSelected(region: GridRegion): boolean {
      return isFloatingControlSelected(region.id);
    },

    select(region: GridRegion): void {
      // A region whose control is not in the store (a stale list, a sheet
      // switch mid-cycle) selects nothing rather than a phantom id.
      if (!getFloatingControl(region.id)) return;
      selectControlWithGroup(region.id);
      emitAppEvent(AppEvents.GRID_REFRESH);
    },

    deselectAll(): void {
      // `selectObject` calls this on every family that is NOT the target, on
      // every Tab press — so an already-empty selection must not repaint.
      if (getSelectedControlCount() === 0) return;
      deselectFloatingControl();
      emitAppEvent(AppEvents.GRID_REFRESH);
    },
  };
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerControlObjectSelection(): () => void {
  return registerObjectSelectionProvider(createControlSelectionProvider());
}
