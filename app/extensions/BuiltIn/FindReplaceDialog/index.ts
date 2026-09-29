//! FILENAME: app/extensions/BuiltIn/FindReplaceDialog/index.ts
// PURPOSE: Find & Replace extension module.
// CONTEXT: Registers the Find/Replace dialog and commands.
// NOTE: Default exports an ExtensionModule object per the contract.
// FIX: Import DialogExtensions from API, not Shell (Facade Rule compliance).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { CoreCommands } from "@api/commands";
// FIX: Import from API layer, not directly from Shell
import { DialogExtensions } from "@api/ui";
import { FindReplaceDialog } from "./FindReplaceDialog";
import { useFindStore } from "../../_shared/lib/useFindStore";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;
/** Undoes this activation's command registrations (see deactivate). */
let unregisterCommands: (() => void) | null = null;

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
  // NOTE: Must sync BOTH the Zustand store (for component state) and
  // DialogExtensions (for Shell dialog container rendering).
  context.commands.register(CoreCommands.FIND, () => {
    useFindStore.getState().open(false);
    DialogExtensions.openDialog("find-replace", { mode: "find" });
  });

  context.commands.register(CoreCommands.REPLACE, () => {
    useFindStore.getState().open(true);
    DialogExtensions.openDialog("find-replace", { mode: "replace" });
  });
  // Deactivate takes them away: a deactivated extension must not keep
  // answering the registry's Ctrl+F / Ctrl+H (D3 class).
  unregisterCommands = () => {
    context.commands.unregister(CoreCommands.FIND);
    context.commands.unregister(CoreCommands.REPLACE);
  };

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

  // Unregister commands and dialog
  unregisterCommands?.();
  unregisterCommands = null;
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