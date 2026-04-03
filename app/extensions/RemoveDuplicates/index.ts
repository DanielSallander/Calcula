//! FILENAME: app/extensions/RemoveDuplicates/index.ts
// PURPOSE: Remove Duplicates extension entry point.
// CONTEXT: Registers the dialog and Data menu item.
//          Uses ExtensionModule lifecycle (Path A).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
import { RemoveDuplicatesDialog } from "./components/RemoveDuplicatesDialog";
import {
  registerRemoveDuplicatesMenuItem,
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
  console.log("[RemoveDuplicates] Activating...");

  // 1. Register dialog
  context.ui.dialogs.register({
    id: "remove-duplicates",
    component: RemoveDuplicatesDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("remove-duplicates"));

  // 2. Register menu item in Data menu
  registerRemoveDuplicatesMenuItem(context);

  // 3. Track current selection (for menu item to know active cell)
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(
      sel
        ? {
            startRow: sel.startRow,
            endRow: sel.endRow,
            startCol: sel.startCol,
            endCol: sel.endCol,
            activeRow: sel.startRow,
            activeCol: sel.startCol,
          }
        : null,
    );
  });
  cleanupFns.push(unsubSelection);

  console.log("[RemoveDuplicates] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[RemoveDuplicates] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[RemoveDuplicates] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[RemoveDuplicates] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.remove-duplicates",
    name: "Remove Duplicates",
    version: "1.0.0",
    description: "Remove duplicate rows from a data range.",
  },
  activate,
  deactivate,
};

export default extension;
