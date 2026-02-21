//! FILENAME: app/extensions/Consolidate/index.ts
// PURPOSE: Data Consolidation extension entry point.
// CONTEXT: Registers the dialog and Data menu item.
//          Called from extensions/index.ts during app initialization.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
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
// Registration
// ============================================================================

export function registerConsolidateExtension(): void {
  console.log("[Consolidate] Registering...");

  // 1. Register dialog
  DialogExtensions.registerDialog({
    id: "consolidate",
    component: ConsolidateDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("consolidate"));

  // 2. Register menu item in Data menu
  registerConsolidateMenuItem();

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

  console.log("[Consolidate] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterConsolidateExtension(): void {
  console.log("[Consolidate] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Consolidate] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[Consolidate] Unregistered.");
}
