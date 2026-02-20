//! FILENAME: app/extensions/TextToColumns/index.ts
// PURPOSE: Text to Columns extension entry point.
// CONTEXT: Registers the wizard dialog and Data menu item.
//          Called from extensions/index.ts during app initialization.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
import { TextToColumnsDialog } from "./components/TextToColumnsDialog";
import {
  registerTextToColumnsMenuItem,
  setCurrentSelection,
} from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerTextToColumnsExtension(): void {
  console.log("[TextToColumns] Registering...");

  // 1. Register dialog
  DialogExtensions.registerDialog({
    id: "text-to-columns",
    component: TextToColumnsDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("text-to-columns"));

  // 2. Register menu item in Data menu
  registerTextToColumnsMenuItem();

  // 3. Track current selection (for menu item to know active range)
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

  console.log("[TextToColumns] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterTextToColumnsExtension(): void {
  console.log("[TextToColumns] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[TextToColumns] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[TextToColumns] Unregistered.");
}
