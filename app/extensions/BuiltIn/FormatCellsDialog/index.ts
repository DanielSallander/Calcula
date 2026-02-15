//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/index.ts
// PURPOSE: Format Cells Dialog extension module.
// CONTEXT: Registers the Format Cells dialog and the FORMAT_CELLS command.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import { CoreCommands } from "../../../src/api/commands";
import { DialogExtensions } from "../../../src/api/ui";
import { FormatCellsDialog } from "./FormatCellsDialog";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[FormatCellsExtension] Already activated, skipping.");
    return;
  }

  console.log("[FormatCellsExtension] Activating...");

  // Register the dialog component
  DialogExtensions.registerDialog({
    id: "format-cells",
    component: FormatCellsDialog,
    priority: 200,
  });

  // Register the FORMAT_CELLS command
  context.commands.register(CoreCommands.FORMAT_CELLS, () => {
    DialogExtensions.openDialog("format-cells");
  });

  isActivated = true;
  console.log("[FormatCellsExtension] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) {
    return;
  }

  console.log("[FormatCellsExtension] Deactivating...");
  DialogExtensions.unregisterDialog("format-cells");
  isActivated = false;
  console.log("[FormatCellsExtension] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.format-cells",
    name: "Format Cells Dialog",
    version: "1.0.0",
    description: "Format Cells dialog for comprehensive cell formatting.",
  },
  activate,
  deactivate,
};

export default extension;
