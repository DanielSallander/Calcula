//! FILENAME: app/extensions/Solver/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Solver item in the Data menu.

import { registerMenuItem, DialogExtensions } from "../../../src/api";

// ============================================================================
// State
// ============================================================================

let currentSelection: {
  activeRow: number;
  activeCol: number;
} | null = null;

export function setCurrentSelection(
  sel: { activeRow: number; activeCol: number } | null,
): void {
  currentSelection = sel;
}

// ============================================================================
// Menu Registration
// ============================================================================

export function registerSolverMenuItems(): void {
  registerMenuItem("data", {
    id: "data:solver",
    label: "Solver...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog("solver", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });
}
