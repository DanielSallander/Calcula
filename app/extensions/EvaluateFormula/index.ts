//! FILENAME: app/extensions/EvaluateFormula/index.ts
// PURPOSE: Evaluate Formula extension entry point (step-by-step formula debugger).
// CONTEXT: Registers the dialog, Formulas menu item, and selection tracking.
//          Called from extensions/index.ts during app initialization.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
import { EvaluateFormulaDialog } from "./components/EvaluateFormulaDialog";
import {
  registerEvaluateFormulaMenuItem,
  setCurrentSelection,
} from "./handlers/formulasMenuItemBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerEvaluateFormulaExtension(): void {
  console.log("[EvaluateFormula] Registering...");

  // 1. Register dialog
  DialogExtensions.registerDialog({
    id: "evaluate-formula",
    component: EvaluateFormulaDialog,
    priority: 110,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("evaluate-formula"));

  // 2. Register menu item in Formulas menu
  registerEvaluateFormulaMenuItem();

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

  console.log("[EvaluateFormula] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterEvaluateFormulaExtension(): void {
  console.log("[EvaluateFormula] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[EvaluateFormula] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[EvaluateFormula] Unregistered.");
}
