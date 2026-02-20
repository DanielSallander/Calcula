//! FILENAME: app/extensions/GoalSeek/index.ts
// PURPOSE: Goal Seek extension entry point.
// CONTEXT: Registers the dialog and Data menu item.
//          Called from extensions/index.ts during app initialization.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
import { GoalSeekDialog } from "./components/GoalSeekDialog";
import {
  registerGoalSeekMenuItem,
  setCurrentSelection,
} from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerGoalSeekExtension(): void {
  console.log("[GoalSeek] Registering...");

  // 1. Register dialog
  DialogExtensions.registerDialog({
    id: "goal-seek",
    component: GoalSeekDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("goal-seek"));

  // 2. Register menu item in Data menu
  registerGoalSeekMenuItem();

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

  console.log("[GoalSeek] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterGoalSeekExtension(): void {
  console.log("[GoalSeek] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[GoalSeek] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[GoalSeek] Unregistered.");
}
