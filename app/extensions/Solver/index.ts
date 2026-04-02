//! FILENAME: app/extensions/Solver/index.ts
// PURPOSE: Solver extension entry point.
// CONTEXT: Registers the Solver dialog and Data menu item.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
import { SolverDialog } from "./components/SolverDialog";
import { SolverResultDialog } from "./components/SolverResultDialog";
import {
  registerSolverMenuItems,
  setCurrentSelection,
} from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerSolverExtension(): void {
  console.log("[Solver] Registering...");

  DialogExtensions.registerDialog({
    id: "solver",
    component: SolverDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("solver"));

  DialogExtensions.registerDialog({
    id: "solver-result",
    component: SolverResultDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("solver-result"));

  registerSolverMenuItems();

  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(
      sel
        ? { activeRow: sel.startRow, activeCol: sel.startCol }
        : null,
    );
  });
  cleanupFns.push(unsubSelection);

  console.log("[Solver] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterSolverExtension(): void {
  console.log("[Solver] Unregistering...");
  for (const fn of cleanupFns) {
    try { fn(); } catch (err) { console.error("[Solver] Cleanup error:", err); }
  }
  cleanupFns.length = 0;
  console.log("[Solver] Unregistered.");
}
