//! FILENAME: app/extensions/Controls/lib/controlContextMenu.ts
// PURPOSE: Register context menu items for floating control operations.
// CONTEXT: Adds z-order, flip, copy/paste/duplicate items to the grid context menu.
//          Items are only visible when a floating control is selected.

import { gridExtensions } from "@api";
import { AppEvents } from "@api";
import { emitAppEvent } from "@api/events";
import type { GridContextMenuItem, GridMenuContext } from "@api/extensions";
import {
  getSelectedFloatingControl,
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
  getGroupMembers,
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
// Context Menu Item IDs
// ============================================================================

const ITEM_IDS = [
  "controls.duplicate",
  "controls.copy",
  "controls.paste",
  "controls.group",
  "controls.ungroup",
  "controls.order",
  "controls.order.bringToFront",
  "controls.order.bringForward",
  "controls.order.sendBackward",
  "controls.order.sendToBack",
  "controls.flipH",
  "controls.flipV",
  "controls.delete",
];

// ============================================================================
// Helpers
// ============================================================================

/** Check if a floating control is currently selected. */
function isControlSelected(): boolean {
  return getSelectedFloatingControl() !== null;
}

/** Check if multiple controls are selected (for grouping). */
function isMultipleControlsSelected(): boolean {
  return getSelectedControlCount() >= 2;
}

/** Check if a grouped control is selected (for ungrouping). */
function isGroupedControlSelected(): boolean {
  const id = getSelectedFloatingControl();
  if (!id) return false;
  return getGroupForControl(id) !== null;
}

/** Check if the selected control supports flip (shape or image, not button). */
function isFlippableControlSelected(): boolean {
  const id = getSelectedFloatingControl();
  if (!id) return false;
  const ctrl = getFloatingControl(id);
  if (!ctrl) return false;
  return ctrl.controlType === "shape" || ctrl.controlType === "image";
}

/**
 * Toggle a flip property on the selected control.
 */
async function toggleFlip(property: "flipH" | "flipV"): Promise<void> {
  const id = getSelectedFloatingControl();
  if (!id) return;
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
 * Delete the currently selected floating control(s).
 */
async function deleteSelectedControl(): Promise<void> {
  const id = getSelectedFloatingControl();
  if (!id) return;

  // Dispatch custom event that index.ts handles for deletion
  // (reuse the existing deleteFloatingControl logic)
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

function handleUngroup(): void {
  const id = getSelectedFloatingControl();
  if (!id) return;

  const groupId = getGroupForControl(id);
  if (!groupId) return;

  ungroupControls(groupId);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Z-Order Handlers
// ============================================================================

function handleBringToFront(): void {
  const id = getSelectedFloatingControl();
  if (!id) return;
  bringToFront(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleSendToBack(): void {
  const id = getSelectedFloatingControl();
  if (!id) return;
  sendToBack(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleBringForward(): void {
  const id = getSelectedFloatingControl();
  if (!id) return;
  bringForward(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleSendBackward(): void {
  const id = getSelectedFloatingControl();
  if (!id) return;
  sendBackward(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Copy / Paste / Duplicate Handlers
// ============================================================================

async function handleCopy(): Promise<void> {
  const id = getSelectedFloatingControl();
  if (!id) return;
  await copyControl(id);
}

async function handlePaste(context: GridMenuContext): Promise<void> {
  await pasteControl(context.sheetIndex);
}

async function handleDuplicate(): Promise<void> {
  const id = getSelectedFloatingControl();
  if (!id) return;
  await duplicateControl(id);
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Build and register all context menu items for floating controls.
 * Returns a cleanup function that unregisters them.
 */
export function registerControlContextMenu(): () => void {
  const items: GridContextMenuItem[] = [
    // -- Duplicate --
    {
      id: "controls.duplicate",
      label: "Duplicate",
      shortcut: "Ctrl+D",
      group: "controls",
      order: 1,
      visible: () => isControlSelected(),
      onClick: handleDuplicate,
    },

    // -- Copy --
    {
      id: "controls.copy",
      label: "Copy",
      shortcut: "Ctrl+C",
      group: "controls",
      order: 2,
      visible: () => isControlSelected(),
      onClick: handleCopy,
    },

    // -- Paste --
    {
      id: "controls.paste",
      label: "Paste",
      shortcut: "Ctrl+V",
      group: "controls",
      order: 3,
      visible: () => hasClipboardControl(),
      onClick: handlePaste,
    },

    // -- Group --
    {
      id: "controls.group",
      label: "Group",
      shortcut: "Ctrl+G",
      group: "controls",
      order: 5,
      visible: () => isMultipleControlsSelected(),
      onClick: handleGroup,
    },

    // -- Ungroup --
    {
      id: "controls.ungroup",
      label: "Ungroup",
      shortcut: "Ctrl+Shift+G",
      group: "controls",
      order: 6,
      visible: () => isGroupedControlSelected(),
      separatorAfter: true,
      onClick: handleUngroup,
    },

    // -- Order (sub-menu) --
    {
      id: "controls.order",
      label: "Order",
      group: "controls",
      order: 10,
      visible: () => isControlSelected(),
      onClick: () => {},
      children: [
        {
          id: "controls.order.bringToFront",
          label: "Bring to Front",
          onClick: handleBringToFront,
        },
        {
          id: "controls.order.bringForward",
          label: "Bring Forward",
          onClick: handleBringForward,
        },
        {
          id: "controls.order.sendBackward",
          label: "Send Backward",
          onClick: handleSendBackward,
        },
        {
          id: "controls.order.sendToBack",
          label: "Send to Back",
          separatorAfter: true,
          onClick: handleSendToBack,
        },
      ],
    },

    // -- Flip Horizontal --
    {
      id: "controls.flipH",
      label: "Flip Horizontal",
      group: "controls",
      order: 20,
      visible: () => isFlippableControlSelected(),
      onClick: () => toggleFlip("flipH"),
    },

    // -- Flip Vertical --
    {
      id: "controls.flipV",
      label: "Flip Vertical",
      group: "controls",
      order: 21,
      visible: () => isFlippableControlSelected(),
      separatorAfter: true,
      onClick: () => toggleFlip("flipV"),
    },

    // -- Delete --
    {
      id: "controls.delete",
      label: "Delete",
      shortcut: "Del",
      group: "controls",
      order: 30,
      visible: () => isControlSelected(),
      onClick: deleteSelectedControl,
    },
  ];

  gridExtensions.registerContextMenuItems(items);

  return () => {
    for (const id of ITEM_IDS) {
      gridExtensions.unregisterContextMenuItem(id);
    }
  };
}
