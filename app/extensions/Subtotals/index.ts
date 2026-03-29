//! FILENAME: app/extensions/Subtotals/index.ts
// PURPOSE: Subtotals extension entry point.
// CONTEXT: Registers the dialog and Data menu item for automatic subtotals.
//          Called from extensions/index.ts during app initialization.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
import { SubtotalsDialog } from "./components/SubtotalsDialog";
import {
  registerSubtotalsMenuItem,
  setCurrentSelection,
} from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerSubtotalsExtension(): void {
  console.log("[Subtotals] Registering...");

  // 1. Register dialog
  DialogExtensions.registerDialog({
    id: "subtotals",
    component: SubtotalsDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("subtotals"));

  // 2. Register menu item in Data menu
  registerSubtotalsMenuItem();

  // 3. Track current selection for the dialog context
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(
      sel
        ? {
            startRow: sel.startRow,
            endRow: sel.endRow,
            startCol: sel.startCol,
            endCol: sel.endCol,
          }
        : null,
    );
  });
  cleanupFns.push(unsubSelection);

  console.log("[Subtotals] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterSubtotalsExtension(): void {
  console.log("[Subtotals] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Subtotals] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[Subtotals] Unregistered.");
}
