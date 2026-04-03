//! FILENAME: app/extensions/Consolidate/index.ts
// PURPOSE: Data Consolidation extension entry point.
// CONTEXT: Registers the dialog and Data menu item.
//          Loaded by the ExtensionManager during app initialization.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
import { ConsolidateDialog } from "./components/ConsolidateDialog";
import {
  registerConsolidateMenuItem,
  setCurrentSelection,
} from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[Consolidate] Activating...");

  // 1. Register dialog
  context.ui.dialogs.register({
    id: "consolidate",
    component: ConsolidateDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("consolidate"));

  // 2. Register menu item in Data menu
  registerConsolidateMenuItem(context);

  // 3. Track current selection (for menu item to know active cell)
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

  console.log("[Consolidate] Activated successfully.");
}

function deactivate(): void {
  console.log("[Consolidate] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Consolidate] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[Consolidate] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.consolidate",
    name: "Consolidate",
    version: "1.0.0",
    description: "Data consolidation from multiple ranges into a summary.",
  },
  activate,
  deactivate,
};

export default extension;
