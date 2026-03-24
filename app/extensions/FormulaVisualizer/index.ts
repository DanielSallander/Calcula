//! FILENAME: app/extensions/FormulaVisualizer/index.ts
// PURPOSE: FormulaVisualizer extension entry point (visual formula debugger).
// CONTEXT: Registers the dialog, Formulas menu item, and selection tracking.
//          Called from extensions/index.ts during app initialization.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
import { FormulaVisualizer } from "./components/FormulaVisualizer";
import {
  registerFormulaVisualizerMenuItem,
  setCurrentSelection,
} from "./handlers/formulasMenuItemBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerFormulaVisualizerExtension(): void {
  console.log("[FormulaVisualizer] Registering...");

  // 1. Register dialog
  DialogExtensions.registerDialog({
    id: "formula-visualizer",
    component: FormulaVisualizer,
    priority: 111,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("formula-visualizer"));

  // 2. Register menu item in Formulas menu
  registerFormulaVisualizerMenuItem();

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

  console.log("[FormulaVisualizer] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterFormulaVisualizerExtension(): void {
  console.log("[FormulaVisualizer] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[FormulaVisualizer] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[FormulaVisualizer] Unregistered.");
}
