//! FILENAME: app/extensions/Solver/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Solver item in the Data menu.

import type { ExtensionContext } from "@api/contract";

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

export function registerSolverMenuItems(context: ExtensionContext): void {
  context.ui.menus.registerItem("data", {
    id: "data:solver",
    label: "Solver...",
    action: () => {
      const sel = currentSelection;
      context.ui.dialogs.show("solver", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });
}
