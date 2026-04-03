//! FILENAME: app/extensions/TextToColumns/index.ts
// PURPOSE: Text to Columns extension entry point.
// CONTEXT: Registers the wizard dialog and Data menu item.
//          Uses ExtensionModule lifecycle (Path A).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
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
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[TextToColumns] Activating...");

  // 1. Register dialog
  context.ui.dialogs.register({
    id: "text-to-columns",
    component: TextToColumnsDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("text-to-columns"));

  // 2. Register menu item in Data menu
  registerTextToColumnsMenuItem(context);

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

  console.log("[TextToColumns] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[TextToColumns] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[TextToColumns] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[TextToColumns] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.text-to-columns",
    name: "Text to Columns",
    version: "1.0.0",
    description: "Split cell text into multiple columns using delimiters or fixed widths.",
  },
  activate,
  deactivate,
};

export default extension;
