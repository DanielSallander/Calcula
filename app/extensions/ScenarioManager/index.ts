//! FILENAME: app/extensions/ScenarioManager/index.ts
// PURPOSE: Scenario Manager extension entry point.
// CONTEXT: Registers the dialog and Data menu items for What-If Analysis.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
import { ScenarioManagerDialog } from "./components/ScenarioManagerDialog";
import { ScenarioSummaryDialog } from "./components/ScenarioSummaryDialog";
import {
  registerScenarioMenuItems,
  setCurrentSelection,
} from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerScenarioManagerExtension(): void {
  console.log("[ScenarioManager] Registering...");

  // 1. Register dialogs
  DialogExtensions.registerDialog({
    id: "scenario-manager",
    component: ScenarioManagerDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("scenario-manager"));

  DialogExtensions.registerDialog({
    id: "scenario-summary",
    component: ScenarioSummaryDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("scenario-summary"));

  // 2. Register menu items in Data menu
  registerScenarioMenuItems();

  // 3. Track current selection
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(
      sel
        ? {
            activeRow: sel.startRow,
            activeCol: sel.startCol,
            endRow: sel.endRow,
            endCol: sel.endCol,
          }
        : null,
    );
  });
  cleanupFns.push(unsubSelection);

  console.log("[ScenarioManager] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterScenarioManagerExtension(): void {
  console.log("[ScenarioManager] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[ScenarioManager] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[ScenarioManager] Unregistered.");
}
