//! FILENAME: app/extensions/BuiltIn/ObjectPosition/index.ts
// PURPOSE: SIZE AND POSITION and the GRIP's menu (BUG-0258 design phase 5b):
//          the no-drag route to move and size any floating object.
// CONTEXT: Core owns the grip (core/lib/floatingGrip.ts): it paints it, moves
//          the object when it is dragged, and dispatches
//          `floatingObject:gripClick` (@api/objectGrip) when it is CLICKED, or
//          right-clicked where no family's own menu claimed the point. What a
//          click MEANS is this feature:
//
//            - the grip's MENU (components/GripMenu.tsx), anchored under the
//              grip: "Size and Position..." first, then what other extensions
//              register through @api/objectPosition (the canvas: Bring Forward,
//              Send Backward, Lock);
//            - the Size and Position DIALOG (components/SizePositionDialog.tsx),
//              installed as THE opener of @api/objectPosition, so every family's
//              right-click menu and the canvas's Arrange group open this one
//              dialog without importing it;
//            - the `object.sizeAndPosition` COMMAND, for the selection's primary
//              object (the command palette, a keybinding a user adds).
//
//          A family never learns anything new: the dialog commits through
//          @api/objectGeometry, whose provider for the object's type persists
//          it as ONE undo step.
//
//          And the KEYBOARD of a selected object (BUG-0270,
//          lib/selectedObjectKeys.ts): while any object is selected on a
//          worksheet the selection is the object's -- Delete / Backspace remove
//          it through its family's own delete (one undo step), Escape goes back
//          to the cells, and no door reaches the active cell hidden behind it.
//          Here because this extension activates after every object family and
//          the canvas, so each family's own Delete door wins the tie.

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { registerDialog, registerOverlay, showDialog, showOverlay, unregisterDialog, unregisterOverlay } from "@api/ui";
import { FLOATING_GRIP_CLICK_EVENT, type FloatingGripClickDetail } from "@api/objectGrip";
import { getGridRegions } from "@api/gridOverlays";
import { getPrimaryObjectRegion } from "@api/objectSelection";
import {
  SIZE_AND_POSITION_COMMAND,
  openSizeAndPosition,
  registerSizeAndPositionOpener,
} from "@api/objectPosition";
import { GRIP_MENU_ID, GripMenu } from "./components/GripMenu";
import { SIZE_POSITION_DIALOG_ID, SizePositionDialog } from "./components/SizePositionDialog";
import { installSelectedObjectKeys } from "./lib/selectedObjectKeys";

export { GRIP_MENU_ID } from "./components/GripMenu";
export { SIZE_POSITION_DIALOG_ID } from "./components/SizePositionDialog";

const cleanupFns: Array<() => void> = [];

/**
 * Core's grip click: the grip's menu, anchored at the grip. A click whose
 * object is no longer published (it was deleted in between) opens nothing.
 */
export function handleGripClick(event: Event): void {
  const detail = (event as CustomEvent<FloatingGripClickDetail>).detail;
  if (!detail || typeof detail.regionId !== "string") return;
  if (!getGridRegions().some((r) => r.id === detail.regionId)) return;
  showOverlay(GRIP_MENU_ID, { data: { regionId: detail.regionId }, anchorRect: detail.anchor });
}

function activate(context: ExtensionContext): void {
  registerDialog({ id: SIZE_POSITION_DIALOG_ID, component: SizePositionDialog, priority: 200 });
  cleanupFns.push(() => unregisterDialog(SIZE_POSITION_DIALOG_ID));

  registerOverlay({ id: GRIP_MENU_ID, component: GripMenu, layer: "dropdown" });
  cleanupFns.push(() => unregisterOverlay(GRIP_MENU_ID));

  // THE dialog every door opens (@api/objectPosition is last-wins).
  cleanupFns.push(
    registerSizeAndPositionOpener((region) => {
      showDialog(SIZE_POSITION_DIALOG_ID, { regionId: region.id });
    }),
  );

  window.addEventListener(FLOATING_GRIP_CLICK_EVENT, handleGripClick);
  cleanupFns.push(() => window.removeEventListener(FLOATING_GRIP_CLICK_EVENT, handleGripClick));

  context.commands.register(SIZE_AND_POSITION_COMMAND, () => {
    const region = getPrimaryObjectRegion();
    if (region) openSizeAndPosition(region);
  });
  cleanupFns.push(() => context.commands.unregister(SIZE_AND_POSITION_COMMAND));

  // A selected object owns the keyboard (BUG-0270): Delete, Escape, the claim.
  cleanupFns.push(installSelectedObjectKeys(context, extension.manifest.id));
}

function deactivate(): void {
  for (let i = cleanupFns.length - 1; i >= 0; i--) {
    try {
      cleanupFns[i]();
    } catch (err) {
      console.error("[ObjectPosition] cleanup failed:", err);
    }
  }
  cleanupFns.length = 0;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.object-position",
    name: "Size and Position",
    version: "1.0.0",
    description:
      "Size and Position for floating objects: the grip's menu and the no-drag dialog (X, Y, width, height) every object menu opens; " +
      "and the keyboard of a selected object (Delete removes it, Escape returns to the cell, nothing reaches the cell behind it)",
  },
  activate,
  deactivate,
};

export default extension;
