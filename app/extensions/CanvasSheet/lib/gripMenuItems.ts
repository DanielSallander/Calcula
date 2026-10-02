//! FILENAME: app/extensions/CanvasSheet/lib/gripMenuItems.ts
// PURPOSE: What a CANVAS adds to an object's grip menu (BUG-0258 design phase
//          5b): Bring Forward, Send Backward and Lock, under the menu's
//          "Size and Position..." (@api/objectPosition `registerObjectGripMenuItem`).
// CONTEXT: On a canvas the selected object shows the grip whatever its family
//          (Power BI's visual header), so the grip's menu is the natural home
//          for the page-level verbs the Arrange group carries. Each item acts
//          on the object whose grip was clicked -- never on the whole
//          selection: on a multi-selection only the PRIMARY member shows a
//          grip, and a click on it means that object.
//
//          The commands are the Arrange group's own (lib/zOrderStore.ts:
//          `restackObjects`, `setObjectsLocked`), so the page's one zOrder and
//          lock list change the same way from either door, each as one undo
//          step. On a worksheet none of them applies (no page, no zOrder, no
//          lock), so none is listed there.

import { registerObjectGripMenuItem } from "@api/objectPosition";
import { objectRefOf } from "@api/objectSelection";
import type { GridRegion } from "@api/gridOverlays";
import { getCanvasSheetSnapshot } from "./canvasSheetStore";
import { STACKING_LABELS, allLocked, restackObjects, setObjectsLocked } from "./zOrderStore";

/** The canvas's grip-menu item ids. */
export const CANVAS_GRIP_ITEM_IDS = {
  bringForward: "canvas.grip.bringForward",
  sendBackward: "canvas.grip.sendBackward",
  lock: "canvas.grip.lock",
} as const;

/** Whether `region` is an object on the ACTIVE canvas the page can name (restack and lock need its ref). */
export function onActiveCanvas(region: GridRegion): boolean {
  return getCanvasSheetSnapshot().active !== null && objectRefOf(region) !== null;
}

/** Whether the page's layout may change (a subscribed canvas is the publisher's). */
function layoutEditable(): boolean {
  return !getCanvasSheetSnapshot().activeSubscribed;
}

/** Register the canvas's three grip-menu items; returns the cleanups. */
export function installCanvasGripMenuItems(): Array<() => void> {
  return [
    registerObjectGripMenuItem({
      id: CANVAS_GRIP_ITEM_IDS.bringForward,
      label: STACKING_LABELS.bringForward,
      order: 10,
      visible: onActiveCanvas,
      enabled: layoutEditable,
      run: (region) => restackObjects("bringForward", [region]),
    }),
    registerObjectGripMenuItem({
      id: CANVAS_GRIP_ITEM_IDS.sendBackward,
      label: STACKING_LABELS.sendBackward,
      order: 20,
      visible: onActiveCanvas,
      enabled: layoutEditable,
      run: (region) => restackObjects("sendBackward", [region]),
    }),
    registerObjectGripMenuItem({
      id: CANVAS_GRIP_ITEM_IDS.lock,
      label: "Lock",
      order: 30,
      visible: onActiveCanvas,
      // A locked object shows no grip; a menu still open when it was locked
      // offers nothing more to lock.
      enabled: (region) => layoutEditable() && !allLocked([region]),
      run: (region) => setObjectsLocked(true, [region]),
    }),
  ];
}
