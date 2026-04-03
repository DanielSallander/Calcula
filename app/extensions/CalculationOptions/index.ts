//! FILENAME: app/extensions/CalculationOptions/index.ts
// PURPOSE: Calculation Options extension entry point.
// CONTEXT: Registers Calculation Options, Calculate Worksheet, and Calculate Workbook
//          menu items in the Formulas menu. Controls automatic vs manual calculation mode.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerCalculationMenuItems,
  syncCalculationMode,
} from "./handlers/formulasMenuItemBuilder";

// ============================================================================
// Lifecycle
// ============================================================================

function activate(_context: ExtensionContext): void {
  console.log("[CalculationOptions] Activating...");

  // 1. Register menu items in Formulas menu
  registerCalculationMenuItems();

  // 2. Sync checked state from backend
  syncCalculationMode();

  console.log("[CalculationOptions] Activated successfully.");
}

function deactivate(): void {
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
