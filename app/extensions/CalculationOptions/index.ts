//! FILENAME: app/extensions/CalculationOptions/index.ts
// PURPOSE: Calculation Options extension entry point.
// CONTEXT: Registers Calculation Options, Calculate Worksheet, and Calculate Workbook
//          menu items in the Formulas menu. Controls automatic vs manual calculation mode.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { registerStatusBarItem, unregisterStatusBarItem } from "@api";
import {
  registerCalculationMenuItems,
  syncCalculationMode,
} from "./handlers/formulasMenuItemBuilder";
import { CalculationStatusItem } from "./components/CalculationStatusItem";

/** Status-bar item id for the progress/Cancel/stale indicator. */
const STATUS_ITEM_ID = "calcula.calculation-options.status";

// ============================================================================
// Lifecycle
// ============================================================================

function activate(_context: ExtensionContext): void {
  console.log("[CalculationOptions] Activating...");

  // 1. Register menu items in Formulas menu
  registerCalculationMenuItems();

  // 2. Sync checked state from backend
  syncCalculationMode();

  // 3. Progress + Cancel + the "Calculate" stale marker.
  //
  // This extension owns Calculate Now / Calculate Worksheet, so it owns the
  // affordance for stopping one too — the Cancel button belongs next to the
  // thing that starts the calculation, not in the shell. Left-aligned, so it
  // sits where "Ready" is and reads as the workbook's calculation state.
  registerStatusBarItem({
    id: STATUS_ITEM_ID,
    component: CalculationStatusItem,
    alignment: "left",
    priority: 100,
  });

  console.log("[CalculationOptions] Activated successfully.");
}

function deactivate(): void {
  unregisterStatusBarItem(STATUS_ITEM_ID);
  console.log("[CalculationOptions] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.calculation-options",
    name: "Calculation Options",
    version: "1.0.0",
    description: "Controls automatic vs manual calculation mode with Formulas menu items.",
  },
  activate,
  deactivate,
};
export default extension;
