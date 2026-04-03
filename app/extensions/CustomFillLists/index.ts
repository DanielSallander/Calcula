//! FILENAME: app/extensions/CustomFillLists/index.ts
// PURPOSE: Custom Fill Lists extension entry point.
// CONTEXT: Registers dialog and Edit menu item for managing custom auto-fill series.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  DialogExtensions,
  registerMenuItem,
} from "@api";
import { CustomFillListsDialog } from "./components/CustomFillListsDialog";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(_context: ExtensionContext): void {
  console.log("[CustomFillLists] Activating...");

  // 1. Register dialog
  DialogExtensions.registerDialog({
    id: "custom-fill-lists",
    component: CustomFillListsDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("custom-fill-lists"));

  // 2. Register menu item in Edit menu (same location as Excel: File > Options > Custom Lists)
  registerMenuItem("edit", {
    id: "customFillLists",
    label: "Custom Lists...",
    action: () => {
      DialogExtensions.openDialog("custom-fill-lists");
    },
  });

  console.log("[CustomFillLists] Activated successfully.");
}

function deactivate(): void {
  console.log("[CustomFillLists] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[CustomFillLists] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[CustomFillLists] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.custom-fill-lists",
    name: "Custom Fill Lists",
    version: "1.0.0",
    description: "Manage custom auto-fill series for drag-fill operations.",
  },
  activate,
  deactivate,
};
export default extension;
