//! FILENAME: app/extensions/CalculationOptions/index.ts
// PURPOSE: Calculation Options extension entry point.
// CONTEXT: Registers Calculation Options, Calculate Worksheet, and Calculate Workbook
//          menu items in the Formulas menu. Controls automatic vs manual calculation mode.
//          Called from extensions/index.ts during app initialization.

import {
  registerCalculationMenuItems,
  syncCalculationMode,
} from "./handlers/formulasMenuItemBuilder";

// ============================================================================
// Registration
// ============================================================================

export function registerCalculationOptionsExtension(): void {
  console.log("[CalculationOptions] Registering...");

  // 1. Register menu items in Formulas menu
  registerCalculationMenuItems();

  // 2. Sync checked state from backend
  syncCalculationMode();

  console.log("[CalculationOptions] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterCalculationOptionsExtension(): void {
  console.log("[CalculationOptions] Unregistered.");
}
