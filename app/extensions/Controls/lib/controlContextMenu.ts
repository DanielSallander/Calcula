//! FILENAME: app/extensions/Controls/lib/controlContextMenu.ts
// PURPOSE: The item MODEL and the actions for a floating control's own
//          right-click menu (Duplicate, Copy, Paste, Group, Order, Flip, Edit
//          Script, Apply Template, Delete).
// CONTEXT: Every item here used to be registered into `gridExtensions`, the
//          registry only `GridContextMenuHost` renders — and that host opens
//          solely on `AppEvents.CONTEXT_MENU_REQUEST`, which Core deliberately
//          does NOT emit for a right-click that lands on a floating object
//          ("Cell options on an object right-click are always wrong",
//          Spreadsheet.tsx). Right-clicking a button, a shape or a picture
//          therefore produced NOTHING: fifteen items, registered, ordered,
//          gated, and unreachable.
//
//          The working precedent is Charts / Slicer / TimelineSlicer / the
//          Floating Range: the object's own extension owns a capture-phase
//          `contextmenu` listener and shows its OWN overlay menu. That listener
//          is `lib/controlObjectMenu.ts`; this module is the part worth
//          keeping — the items and what they do — so there is still exactly one
//          place that decides what a control's menu offers.
//
//          ONE item stays registered with `gridExtensions`: "Paste", whose
//          context is a CELL ("put the copied control here"), not an object.
//          Core does open the cell menu there, so that one was never dead.

import { gridExtensions } from "@api";
import { AppEvents } from "@api";
import { emitAppEvent } from "@api/events";
import type { GridContextMenuItem, GridMenuContext } from "@api/extensions";
import {
  getSelectedFloatingControls,
  getSelectedControlCount,
} from "../Button/floatingSelection";
import {
  getFloatingControl,
  bringToFront,
  sendToBack,
  bringForward,
  sendBackward,
  syncFloatingControlRegions,
  groupControls,
  ungroupControls,
  getGroupForControl,
} from "./floatingStore";
import {
  setControlProperty,
  getControlMetadata,
} from "./controlApi";
import {
  copyControl,
  pasteControl,
  duplicateControl,
  hasClipboardControl,
} from "./controlClipboard";
import {
  invalidateShapeCache,
} from "../Shape/shapeRenderer";
import {
  invalidateImageCache,
} from "../Image/imageRenderer";
import {
  invalidateFloatingButtonCache,
} from "../Button/floatingRenderer";

// ============================================================================
// Menu Item Model
// ============================================================================

/**
 * One entry in a floating control's object menu.
 *
 * There is no `enabled` flag on purpose: `buildControlObjectMenu` returns only
 * the items that apply to the control that was actually clicked, so the rule
 * "a Flip that cannot flip is never offered" lives in ONE function instead of
 * being re-decided by whatever paints the list.
 */
export interface ControlMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  separatorAfter?: boolean;
  /** Marks a destructive action so the menu can paint it as one. */
  destructive?: boolean;
  /** A submenu (Order). Children are always offered when the parent is. */
  children?: ControlMenuItem[];
  run(): void;
}

/**
 * "Paste" — the one id that appears in BOTH menus, because it is the one action
 * whose question ("where should the copy go?") a cell can answer as well as an
 * object can. Spelled once so the two menus cannot drift apart.
 */
const PASTE_ITEM_ID = "controls.paste";

// ============================================================================
// Helpers
// ============================================================================

/** Check if multiple controls are selected (for grouping). */
function isMultipleControlsSelected(): boolean {
  return getSelectedControlCount() >= 2;
}

/**
 * Toggle a flip property on one control.
 *
 * The id is passed in rather than re-read from the selection: the menu opens
 * for the object the pointer is over, and with two controls selected the
 * selection's "primary" is whichever was picked first — acting on that one
 * would flip a shape the user did not right-click.
 */
async function toggleFlip(id: string, property: "flipH" | "flipV"): Promise<void> {
  const ctrl = getFloatingControl(id);
  if (!ctrl) return;

  const metadata = await getControlMetadata(ctrl.sheetIndex, ctrl.row, ctrl.col);
  if (!metadata) return;

  const currentValue = metadata.properties[property]?.value === "true";
  const newValue = !currentValue;

  await setControlProperty(
    ctrl.sheetIndex,
    ctrl.row,
    ctrl.col,
    ctrl.controlType,
    property,
    "static",
    String(newValue),
  );

  // Invalidate cache and refresh
  invalidateShapeCache(id);
  invalidateImageCache(id);
  invalidateFloatingButtonCache(id);
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Delete the selected floating control(s).
 *
 * Still routed through the `controls:delete-selected` event that index.ts owns:
 * deletion has to release backend metadata, render caches, group membership and
 * the properties pane together, and that whole sequence lives with the
 * lifecycle owner rather than being re-derived here.
 */
function deleteSelectedControl(): void {
  window.dispatchEvent(new CustomEvent("controls:delete-selected"));
}

// ============================================================================
// Group / Ungroup Handlers
// ============================================================================

function handleGroup(): void {
  const selectedIds = getSelectedFloatingControls();
  if (selectedIds.size < 2) return;

  groupControls([...selectedIds]);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleUngroup(id: string): void {
  const groupId = getGroupForControl(id);
  if (!groupId) return;

  ungroupControls(groupId);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Z-Order Handlers
// ============================================================================

function handleBringToFront(id: string): void {
  bringToFront(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleSendToBack(id: string): void {
  sendToBack(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleBringForward(id: string): void {
  bringForward(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleSendBackward(id: string): void {
  sendBackward(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Copy / Paste / Duplicate Handlers
// ============================================================================

async function handleCopy(id: string): Promise<void> {
  await copyControl(id);
}

async function handlePaste(sheetIndex: number): Promise<void> {
  await pasteControl(sheetIndex);
}

async function handleDuplicate(id: string): Promise<void> {
  await duplicateControl(id);
}

// ============================================================================
// The Object Menu
// ============================================================================

/**
 * Build the right-click menu for ONE floating control.
 *
 * Evaluated at OPEN time, against the control the pointer is actually over, so
 * the offer matches the object: a button has no Flip and no Edit Script, a
 * shape has both, and Group appears only when a second control is selected to
 * group it with.
 *
 * Items that do not apply are OMITTED, never greyed out — the same rule the
 * `visible()` predicates carried when these items still lived in the grid
 * registry.
 */
export function buildControlObjectMenu(controlId: string): ControlMenuItem[] {
  const ctrl = getFloatingControl(controlId);
  if (!ctrl) return [];

  const isShape = ctrl.controlType === "shape";
  const isFlippable = isShape || ctrl.controlType === "image";
  const items: ControlMenuItem[] = [];

  items.push({
    id: "controls.duplicate",
    label: "Duplicate",
    shortcut: "Ctrl+D",
    run: () => void handleDuplicate(controlId),
  });

  items.push({
    id: "controls.copy",
    label: "Copy",
    shortcut: "Ctrl+C",
    run: () => void handleCopy(controlId),
  });

  if (hasClipboardControl()) {
    items.push({
      id: PASTE_ITEM_ID,
      label: "Paste",
      shortcut: "Ctrl+V",
      // The control's OWN sheet, not the active sheet: the menu is anchored to
      // an object, and the object knows which sheet it lives on.
      run: () => void handlePaste(ctrl.sheetIndex),
    });
  }

  if (isMultipleControlsSelected()) {
    items.push({
      id: "controls.group",
      label: "Group",
      shortcut: "Ctrl+G",
      run: handleGroup,
    });
  }

  if (getGroupForControl(controlId) !== null) {
    items.push({
      id: "controls.ungroup",
      label: "Ungroup",
      shortcut: "Ctrl+Shift+G",
      run: () => handleUngroup(controlId),
    });
  }

  items.push({
    id: "controls.order",
    label: "Order",
    separatorAfter: true,
    run: () => {
      /* Parent of a submenu: opening it is the whole action. */
    },
    children: [
      {
        id: "controls.order.bringToFront",
        label: "Bring to Front",
        run: () => handleBringToFront(controlId),
      },
      {
        id: "controls.order.bringForward",
        label: "Bring Forward",
        run: () => handleBringForward(controlId),
      },
      {
        id: "controls.order.sendBackward",
        label: "Send Backward",
        run: () => handleSendBackward(controlId),
      },
      {
        id: "controls.order.sendToBack",
        label: "Send to Back",
        run: () => handleSendToBack(controlId),
      },
    ],
  });

  if (isFlippable) {
    items.push({
      id: "controls.flipH",
      label: "Flip Horizontal",
      run: () => void toggleFlip(controlId, "flipH"),
    });
    items.push({
      id: "controls.flipV",
      label: "Flip Vertical",
      separatorAfter: true,
      run: () => void toggleFlip(controlId, "flipV"),
    });
  }

  if (isShape) {
    items.push({
      id: "controls.editScript",
      label: "Edit Script...",
      run: () => {
        emitAppEvent("scriptable-objects:edit-script", {
          objectType: "shape",
          instanceId: controlId,
          objectName: `Shape (${ctrl.row}, ${ctrl.col})`,
        });
      },
    });
    items.push({
      id: "controls.applyTemplate",
      label: "Apply Template...",
      separatorAfter: true,
      run: () => emitAppEvent("shape:openTemplateGallery", { instanceId: controlId }),
    });
  }

  items.push({
    id: "controls.delete",
    label: "Delete",
    shortcut: "Del",
    destructive: true,
    run: deleteSelectedControl,
  });

  // A separator declared by an item that ended up LAST would paint a rule under
  // the menu's bottom edge. The flag is a "there is more below" marker, so the
  // last item never carries one.
  const last = items[items.length - 1];
  if (last?.separatorAfter) items[items.length - 1] = { ...last, separatorAfter: false };

  return items;
}

// ============================================================================
// Cell Menu Registration
// ============================================================================

/**
 * Register the one control item whose context is a CELL rather than an object:
 * "Paste", which answers "put the copied control HERE".
 *
 * Core does open its cell menu on an empty cell, so this item — unlike the
 * fourteen object items that used to sit beside it — has always been reachable,
 * and it is the only route to paste a control when none is selected (the
 * Ctrl+V handler in index.ts requires a selected control before it intercepts).
 * Returns a cleanup function that unregisters it.
 */
export function registerControlContextMenu(): () => void {
  const items: GridContextMenuItem[] = [
    {
      id: PASTE_ITEM_ID,
      label: "Paste",
      shortcut: "Ctrl+V",
      group: "controls",
      order: 3,
      visible: () => hasClipboardControl(),
      onClick: (context: GridMenuContext) => void handlePaste(context.sheetIndex),
    },
  ];

  gridExtensions.registerContextMenuItems(items);

  return () => {
    gridExtensions.unregisterContextMenuItem(PASTE_ITEM_ID);
  };
}
