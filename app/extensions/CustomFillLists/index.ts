//! FILENAME: app/extensions/CustomFillLists/index.ts
// PURPOSE: Custom Fill Lists extension entry point.
// CONTEXT: Registers dialog and Edit menu item for managing custom auto-fill series.

import {
  DialogExtensions,
  registerMenuItem,
} from "../../src/api";
import { CustomFillListsDialog } from "./components/CustomFillListsDialog";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerCustomFillListsExtension(): void {
  console.log("[CustomFillLists] Registering...");

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

  console.log("[CustomFillLists] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterCustomFillListsExtension(): void {
  console.log("[CustomFillLists] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[CustomFillLists] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[CustomFillLists] Unregistered.");
}
