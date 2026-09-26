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
import { canvasObjectRef } from "@api/canvasSheet";
import type { CanvasObjectRef } from "@api";
import { FLOATING_CONTROL_REGION_TYPE } from "./controlHitTest";
import {
  getFloatingControl,
  getGroupForControl,
  getGroupMembers,
  parseFloatingControlId,
} from "./floatingStore";
import {
  addFloatingControlsToSelection,
  deselectFloatingControl,
  getSelectedControlCount,
  isFloatingControlSelected,
  removeFloatingControlsFromSelection,
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

/**
 * A control's canvas identity: kind "control", id = its ANCHOR `${row}:${col}`.
 * Not the region id -- that embeds the sheet INDEX, which shifts when sheets
 * are reordered, while a control's anchor is how the backend keys it. The
 * published region data carries the anchor; the id's own parser is the
 * fallback for a region published without it.
 */
export function controlRefOf(region: GridRegion): CanvasObjectRef | null {
  const row = region.data?.row;
  const col = region.data?.col;
  if (typeof row === "number" && typeof col === "number") {
    return canvasObjectRef("control", `${row}:${col}`);
  }
  const anchor = parseFloatingControlId(region.id);
  return anchor ? canvasObjectRef("control", `${anchor.row}:${anchor.col}`) : null;
}

/** `controlId` and, when it is grouped, every member of its group. */
function withGroup(controlId: string): string[] {
  const groupId = getGroupForControl(controlId);
  return groupId ? getGroupMembers(groupId) : [controlId];
}

/** The generic word the Name Box shows for a control of `controlType`. */
const CONTROL_TYPE_LABELS: ReadonlyMap<string, string> = new Map([
  ["button", "Button"],
  ["shape", "Shape"],
  ["image", "Picture"],
]);

/**
 * What the Name Box calls a control. A control's user-given name lives in its
 * backend metadata, which is read asynchronously and is not cached here, so
 * the label is the control's KIND ("Button", "Shape", "Picture") -- a truthful
 * answer to "what is selected" that needs no round trip.
 */
export function controlLabelOf(region: GridRegion): string | null {
  const type = region.data?.controlType;
  if (typeof type !== "string" || type === "") return null;
  return CONTROL_TYPE_LABELS.get(type) ?? type.charAt(0).toUpperCase() + type.slice(1);
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

    refOf: controlRefOf,

    // Controls hold several (the Ctrl+click set), so a canvas multi-selection
    // keeps every control in it -- and the Controls drag co-moves them. A
    // grouped control joins and leaves together with its group, the rule
    // `select` follows.
    addToSelection(region: GridRegion): void {
      if (!getFloatingControl(region.id) || isFloatingControlSelected(region.id)) return;
      addFloatingControlsToSelection(withGroup(region.id));
      emitAppEvent(AppEvents.GRID_REFRESH);
    },

    removeFromSelection(region: GridRegion): void {
      if (!isFloatingControlSelected(region.id)) return;
      removeFloatingControlsFromSelection(withGroup(region.id));
      emitAppEvent(AppEvents.GRID_REFRESH);
    },

    labelOf: controlLabelOf,
  };
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerControlObjectSelection(): () => void {
  return registerObjectSelectionProvider(createControlSelectionProvider());
}
