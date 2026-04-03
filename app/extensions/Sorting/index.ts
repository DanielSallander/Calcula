//! FILENAME: app/extensions/Sorting/index.ts
// PURPOSE: Sorting extension entry point.
// CONTEXT: Registers the Sort dialog and Data menu items.
//          Uses ExtensionModule lifecycle (Path A).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
import { SortDialog } from "./components/SortDialog";
import {
  registerSortMenuItems,
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
  console.log("[Sorting] Activating...");

  // 1. Register dialog
  context.ui.dialogs.register({
    id: "sort-dialog",
    component: SortDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("sort-dialog"));

  // 2. Register menu items in Data menu
  registerSortMenuItems(context);

  // 3. Track current selection (for quick sort and dialog context)
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(
      sel
        ? {
            startRow: sel.startRow,
            endRow: sel.endRow,
            startCol: sel.startCol,
            endCol: sel.endCol,
            activeRow: sel.endRow,
            activeCol: sel.endCol,
          }
        : null,
    );
  });
  cleanupFns.push(unsubSelection);

  console.log("[Sorting] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[Sorting] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Sorting] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[Sorting] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.sorting",
    name: "Sorting",
    version: "1.0.0",
    description: "Sort data by columns with quick sort and custom multi-level sort dialog.",
  },
  activate,
  deactivate,
};

export default extension;
