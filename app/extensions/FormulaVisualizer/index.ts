//! FILENAME: app/extensions/FormulaVisualizer/index.ts
// PURPOSE: FormulaVisualizer extension entry point (visual formula debugger).
// CONTEXT: Registers the dialog, Formulas menu item, and selection tracking.
//          Called from extensions/index.ts during app initialization.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
import { FormulaVisualizer } from "./components/FormulaVisualizer";

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

  // 2. Menu item is now registered by EvaluateFormula extension as a submenu child.

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
