//! FILENAME: app/extensions/BuiltIn/ObjectPane/index.ts
// PURPOSE: THE object pane (WP-C D-PANE + D-FORMAT): one side pane that
//          follows the PRIMARY selected floating object and shows its family's
//          build tabs plus the shared Format tab.
// CONTEXT: This extension is the HOST of @api/objectPane. It installs:
//
//            - the task-pane view (manifest.ts) and the host
//              (`registerObjectPaneHost`, lib/objectPaneHost.ts);
//            - the open policy (lib/objectPanePolicy.ts): a click on a canvas
//              object opens it, keyboard selection retargets it, a deselect
//              closes it, View > Show reopens it, File > New / Open resets it;
//            - the DOORS: the commands `objectPane.format` (open the primary
//              object on Format -- Ctrl+1 while an object with a pane is
//              selected and the grid has the keyboard; otherwise Ctrl+1 stays
//              Format Cells) and `objectPane.show` (its default tab), and the
//              grip menu's "Format...".
//
//          Families contribute through the seams only (@api/objectPane build
//          tabs, @api/objectFormat format providers); nothing here imports a
//          family, and a family never imports this.
//
//          Activates after the families and the canvas (manifest order), so
//          every provider is registered before the policy first reads the
//          selection -- though nothing depends on it: providers are read at
//          the moment of each open.

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { registerTaskPane, unregisterTaskPane } from "@api/ui";
import { isGridFocused, registerKeybinding } from "@api/keybindings";
import { getPrimaryObjectRegion } from "@api/objectSelection";
import { registerObjectGripMenuItem } from "@api/objectPosition";
import { selectionOwnerReceivesTyping } from "@api/selectionOwner";
import {
  OBJECT_PANE_COMMAND_FORMAT,
  OBJECT_PANE_COMMAND_SHOW,
  OBJECT_PANE_FORMAT_LABEL,
  OBJECT_PANE_FORMAT_TAB,
  OBJECT_PANE_ID,
  hasObjectPaneProvider,
  openObjectPane,
  registerObjectPaneHost,
} from "@api/objectPane";
import { ObjectPaneManifest, ObjectPanePaneDefinition } from "./manifest";
import { createObjectPaneHost } from "./lib/objectPaneHost";
import { installObjectPanePolicy } from "./lib/objectPanePolicy";
import { resetPaneState } from "./lib/paneState";

/** The Ctrl+1 binding's id. */
export const OBJECT_PANE_FORMAT_BINDING_ID = "ext.objectPane.format";

/**
 * The grip menu item's order: directly below Size and Position (which the menu
 * lists first) and ABOVE the canvas's Bring Forward (10) / Send Backward (20) /
 * Lock (30). It was 10, which tied with Bring Forward; this extension activates
 * after the canvas (manifest order), so the tie went to registration order and
 * "Format..." landed BETWEEN Bring Forward and Send Backward (moving-objects
 * journey 21, proved live 2026-10-16).
 */
export const OBJECT_PANE_GRIP_ORDER = 5;

/**
 * Whether Ctrl+1 formats the selected OBJECT: an object with a pane is the
 * primary selection and the grid has the keyboard. Otherwise the cells'
 * Format Cells keeps the key (a guarded binding that says no is skipped).
 *
 * Not while one of the object's own CELLS holds the selection (a floating
 * grid's selected cell: the selection owner's `receivesTyping`). Ctrl+1 there
 * means "format these cells" -- Format Cells, which the floating grid refuses
 * once with its sentence (BUG-0185) -- never "format the box around them".
 * Opening the container's Format tab instead swallowed the key silently
 * (fixall-edit "Ctrl+1", proved live 2026-10-16).
 */
export function objectPaneFormatApplies(): boolean {
  const primary = getPrimaryObjectRegion();
  return primary !== null && hasObjectPaneProvider(primary.type) && isGridFocused() && !selectionOwnerReceivesTyping();
}

const cleanupFns: Array<() => void> = [];

function activate(context: ExtensionContext): void {
  registerTaskPane(ObjectPanePaneDefinition);
  cleanupFns.push(() => unregisterTaskPane(OBJECT_PANE_ID));

  cleanupFns.push(registerObjectPaneHost(createObjectPaneHost()));
  cleanupFns.push(installObjectPanePolicy());

  context.commands.register(OBJECT_PANE_COMMAND_FORMAT, () => {
    openObjectPane({ tab: OBJECT_PANE_FORMAT_TAB, reason: "command" });
  });
  cleanupFns.push(() => context.commands.unregister(OBJECT_PANE_COMMAND_FORMAT));

  context.commands.register(OBJECT_PANE_COMMAND_SHOW, () => {
    openObjectPane({ reason: "command" });
  });
  cleanupFns.push(() => context.commands.unregister(OBJECT_PANE_COMMAND_SHOW));

  cleanupFns.push(
    registerKeybinding(
      {
        id: OBJECT_PANE_FORMAT_BINDING_ID,
        combo: "Ctrl+1",
        commandId: OBJECT_PANE_COMMAND_FORMAT,
        label: "Format Object",
        category: "Formatting",
        context: "not-editing",
        source: "extension",
        extensionId: ObjectPaneManifest.id,
      },
      objectPaneFormatApplies,
    ),
  );

  cleanupFns.push(
    registerObjectGripMenuItem({
      id: OBJECT_PANE_COMMAND_FORMAT,
      label: OBJECT_PANE_FORMAT_LABEL,
      order: OBJECT_PANE_GRIP_ORDER,
      visible: (r) => hasObjectPaneProvider(r.type),
      run: (r) => {
        openObjectPane({ region: r, tab: OBJECT_PANE_FORMAT_TAB, reason: "command" });
      },
    }),
  );
}

function deactivate(): void {
  for (let i = cleanupFns.length - 1; i >= 0; i--) {
    try {
      cleanupFns[i]();
    } catch (err) {
      console.error("[ObjectPane] cleanup failed:", err);
    }
  }
  cleanupFns.length = 0;
  resetPaneState();
}

const extension: ExtensionModule = {
  manifest: ObjectPaneManifest,
  activate,
  deactivate,
};

export default extension;
