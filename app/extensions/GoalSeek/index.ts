//! FILENAME: app/extensions/GoalSeek/index.ts
// PURPOSE: Goal Seek extension entry point.
// CONTEXT: Registers the dialog and Data menu item.
//          Uses ExtensionModule lifecycle (Path A).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
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
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[GoalSeek] Activating...");

  // 1. Register dialog
  context.ui.dialogs.register({
    id: "goal-seek",
    component: GoalSeekDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("goal-seek"));

  // 2. Register menu item in Data menu
  registerGoalSeekMenuItem(context);

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

  console.log("[GoalSeek] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[GoalSeek] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[GoalSeek] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[GoalSeek] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.goal-seek",
    name: "Goal Seek",
    version: "1.0.0",
    description: "Find the input value needed to achieve a desired formula result.",
  },
  activate,
  deactivate,
};

export default extension;
