//! FILENAME: app/extensions/BuiltIn/FindReplaceDialog/index.ts
// PURPOSE: Find & Replace extension module.
// CONTEXT: Registers the Find/Replace dialog and commands.
// NOTE: Default exports an ExtensionModule object per the contract.
// FIX: Import DialogExtensions from API, not Shell (Facade Rule compliance).

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import { CoreCommands } from "../../../src/api/commands";
// FIX: Import from API layer, not directly from Shell
import { DialogExtensions } from "../../../src/api/ui";
import { FindReplaceDialog } from "./FindReplaceDialog";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[FindReplaceExtension] Already activated, skipping.");
    return;
  }

  console.log("[FindReplaceExtension] Activating...");

  // Register the dialog component
  DialogExtensions.registerDialog({
    id: "find-replace",
    component: FindReplaceDialog,
  });

  // Register commands
  context.commands.register(CoreCommands.FIND, () => {
    DialogExtensions.openDialog("find-replace", { mode: "find" });
  });

  context.commands.register(CoreCommands.REPLACE, () => {
    DialogExtensions.openDialog("find-replace", { mode: "replace" });
  });

  isActivated = true;
  console.log("[FindReplaceExtension] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) {
    return;
  }

  console.log("[FindReplaceExtension] Deactivating...");

  // Unregister dialog
  DialogExtensions.unregisterDialog("find-replace");

  isActivated = false;
  console.log("[FindReplaceExtension] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.find-replace",
    name: "Find & Replace",
    version: "1.0.0",
    description: "Find and replace text in the spreadsheet.",
  },
  activate,
  deactivate,
};

export default extension;

// Also export the component for backward compatibility
export { FindReplaceDialog } from "./FindReplaceDialog";