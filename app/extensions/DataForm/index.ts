//! FILENAME: app/extensions/DataForm/index.ts
// PURPOSE: Data Form extension entry point.
// CONTEXT: Registers the dialog and Data menu item.
//          Provides a form-based interface for viewing/editing rows.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
import { DataFormDialog } from "./components/DataFormDialog";
import {
  registerDataFormMenuItem,
  setCurrentSelection,
} from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[DataForm] Activating...");

  // 1. Register dialog
  context.ui.dialogs.register({
    id: "data-form",
    component: DataFormDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("data-form"));

  // 2. Register menu item in Data menu
  registerDataFormMenuItem(context);

  // 3. Track current selection
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(
      sel
        ? {
            activeRow: sel.startRow,
            activeCol: sel.startCol,
          }
        : null,
    );
  });
  cleanupFns.push(unsubSelection);

  console.log("[DataForm] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[DataForm] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[DataForm] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[DataForm] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.data-form",
    name: "Data Form",
    version: "1.0.0",
    description:
      "Form-based interface for viewing, editing, adding, and deleting rows in a data range.",
  },
  activate,
  deactivate,
};

export default extension;
