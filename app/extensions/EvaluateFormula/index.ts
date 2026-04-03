//! FILENAME: app/extensions/EvaluateFormula/index.ts
// PURPOSE: Evaluate Formula extension entry point (step-by-step formula debugger).
// CONTEXT: Registers the dialog, Formulas menu item, and selection tracking.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
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
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[EvaluateFormula] Activating...");

  // 1. Register dialog
  context.ui.dialogs.register({
    id: "evaluate-formula",
    component: EvaluateFormulaDialog,
    priority: 110,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("evaluate-formula"));

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

  console.log("[EvaluateFormula] Activated successfully.");
}

function deactivate(): void {
  console.log("[EvaluateFormula] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[EvaluateFormula] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[EvaluateFormula] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.evaluate-formula",
    name: "Evaluate Formula",
    version: "1.0.0",
    description: "Step-by-step formula debugger for evaluating formulas.",
  },
  activate,
  deactivate,
};
export default extension;
