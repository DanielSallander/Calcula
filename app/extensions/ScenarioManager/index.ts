//! FILENAME: app/extensions/ScenarioManager/index.ts
// PURPOSE: Scenario Manager extension entry point.
// CONTEXT: Registers the dialog and Data menu items for What-If Analysis.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
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
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[ScenarioManager] Activating...");

  // 1. Register dialogs
  context.ui.dialogs.register({
    id: "scenario-manager",
    component: ScenarioManagerDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("scenario-manager"));

  context.ui.dialogs.register({
    id: "scenario-summary",
    component: ScenarioSummaryDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("scenario-summary"));

  // 2. Register menu items in Data menu
  registerScenarioMenuItems(context);

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

  console.log("[ScenarioManager] Activated successfully.");
}

function deactivate(): void {
  console.log("[ScenarioManager] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[ScenarioManager] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[ScenarioManager] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.scenario-manager",
    name: "Scenario Manager",
    version: "1.0.0",
    description: "What-If Scenario Manager for comparing multiple input sets.",
  },
  activate,
  deactivate,
};

export default extension;
