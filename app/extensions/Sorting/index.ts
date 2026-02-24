//! FILENAME: app/extensions/Sorting/index.ts
// PURPOSE: Sorting extension entry point.
// CONTEXT: Registers the Sort dialog and Data menu items.
//          Called from extensions/index.ts during app initialization.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
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
// Registration
// ============================================================================

export function registerSortingExtension(): void {
  console.log("[Sorting] Registering...");

  // 1. Register dialog
  DialogExtensions.registerDialog({
    id: "sort-dialog",
    component: SortDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("sort-dialog"));

  // 2. Register menu items in Data menu
  registerSortMenuItems();

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

  console.log("[Sorting] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterSortingExtension(): void {
  console.log("[Sorting] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Sorting] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[Sorting] Unregistered.");
}
