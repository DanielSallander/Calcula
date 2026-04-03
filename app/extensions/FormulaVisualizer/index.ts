//! FILENAME: app/extensions/FormulaVisualizer/index.ts
// PURPOSE: FormulaVisualizer extension entry point (visual formula debugger).
// CONTEXT: Registers the dialog. Menu item is registered by EvaluateFormula extension as a submenu child.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { FormulaVisualizer } from "./components/FormulaVisualizer";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[FormulaVisualizer] Activating...");

  // 1. Register dialog
  context.ui.dialogs.register({
    id: "formula-visualizer",
    component: FormulaVisualizer,
    priority: 111,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("formula-visualizer"));

  // 2. Menu item is now registered by EvaluateFormula extension as a submenu child.

  console.log("[FormulaVisualizer] Activated successfully.");
}

function deactivate(): void {
  console.log("[FormulaVisualizer] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[FormulaVisualizer] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[FormulaVisualizer] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.formula-visualizer",
    name: "Formula Visualizer",
    version: "1.0.0",
    description: "Visual formula debugger for understanding formula structure.",
  },
  activate,
  deactivate,
};
export default extension;
