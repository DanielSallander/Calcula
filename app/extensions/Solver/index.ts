//! FILENAME: app/extensions/Solver/index.ts
// PURPOSE: Solver extension entry point.
// CONTEXT: Registers the Solver dialog and Data menu item.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
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
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[Solver] Activating...");

  context.ui.dialogs.register({
    id: "solver",
    component: SolverDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("solver"));

  context.ui.dialogs.register({
    id: "solver-result",
    component: SolverResultDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("solver-result"));

  registerSolverMenuItems(context);

  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(
      sel
        ? { activeRow: sel.startRow, activeCol: sel.startCol }
        : null,
    );
  });
  cleanupFns.push(unsubSelection);

  console.log("[Solver] Activated successfully.");
}

function deactivate(): void {
  console.log("[Solver] Deactivating...");
  for (const fn of cleanupFns) {
    try { fn(); } catch (err) { console.error("[Solver] Cleanup error:", err); }
  }
  cleanupFns.length = 0;
  console.log("[Solver] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.solver",
    name: "Solver",
    version: "1.0.0",
    description: "Optimization solver for finding optimal cell values subject to constraints.",
  },
  activate,
  deactivate,
};

export default extension;
