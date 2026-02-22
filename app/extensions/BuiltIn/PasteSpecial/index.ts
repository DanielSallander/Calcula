//! FILENAME: app/extensions/BuiltIn/PasteSpecial/index.ts
// PURPOSE: Paste Special extension module.
// CONTEXT: Registers the Paste Special dialog and the PASTE_SPECIAL command.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import { CoreCommands } from "../../../src/api/commands";
import { DialogExtensions } from "../../../src/api/ui";
import { PasteSpecialDialog } from "./PasteSpecialDialog";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[PasteSpecialExtension] Already activated, skipping.");
    return;
  }

  console.log("[PasteSpecialExtension] Activating...");

  // Register the dialog component
  DialogExtensions.registerDialog({
    id: "paste-special",
    component: PasteSpecialDialog,
    priority: 200,
  });

  // Register the PASTE_SPECIAL command
  context.commands.register(CoreCommands.PASTE_SPECIAL, () => {
    DialogExtensions.openDialog("paste-special");
  });

  isActivated = true;
  console.log("[PasteSpecialExtension] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) {
    return;
  }

  console.log("[PasteSpecialExtension] Deactivating...");
  DialogExtensions.unregisterDialog("paste-special");
  isActivated = false;
  console.log("[PasteSpecialExtension] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.paste-special",
    name: "Paste Special Dialog",
    version: "1.0.0",
    description: "Paste Special dialog for granular paste control (values, formulas, formats, operations, transpose).",
  },
  activate,
  deactivate,
};

export default extension;
