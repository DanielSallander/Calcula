//! FILENAME: app/extensions/RemoveDuplicates/index.ts
// PURPOSE: Remove Duplicates extension entry point.
// CONTEXT: Registers the dialog and Data menu item.
//          Called from extensions/index.ts during app initialization.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
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
// Registration
// ============================================================================

export function registerRemoveDuplicatesExtension(): void {
  console.log("[RemoveDuplicates] Registering...");

  // 1. Register dialog
  DialogExtensions.registerDialog({
    id: "remove-duplicates",
    component: RemoveDuplicatesDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("remove-duplicates"));

  // 2. Register menu item in Data menu
  registerRemoveDuplicatesMenuItem();

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

  console.log("[RemoveDuplicates] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterRemoveDuplicatesExtension(): void {
  console.log("[RemoveDuplicates] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[RemoveDuplicates] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[RemoveDuplicates] Unregistered.");
}
