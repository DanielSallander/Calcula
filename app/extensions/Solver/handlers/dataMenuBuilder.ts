//! FILENAME: app/extensions/Solver/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Solver item under "What-If Analysis" in the Data menu.

import type { ExtensionContext } from "@api/contract";
import { IconWhatIfAnalysis, IconSolver } from "@api";
import { refuseIfSelectionOwned } from "@api/selectionOwner";

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

const SOLVER_MENU_ITEM_ID = "data:whatIf:solver";

/**
 * Register "Solver..." under Data > What-If Analysis. Returns the cleanup for
 * deactivation, which takes back Solver's own CHILD -- never "data:whatIf",
 * which Goal Seek, What-If Data Table and Scenario Manager share (X18).
 */
export function registerSolverMenuItems(context: ExtensionContext): () => void {
  context.ui.menus.registerItem("data", {
    id: "data:whatIf",
    label: "What-If Analysis",
    icon: IconWhatIfAnalysis,
    children: [
      {
        id: SOLVER_MENU_ITEM_ID,
        label: "Solver...",
        icon: IconSolver,
        action: () => {
          // The objective cell is prefilled from Core's active cell -- HIDDEN
          // while something else owns the selection (a floating grid's
          // selected cell) -- so refuse, once (D4, BUG-0185 class).
          if (refuseIfSelectionOwned("Solver")) return;
          const sel = currentSelection;
          context.ui.dialogs.show("solver", {
            activeRow: sel?.activeRow ?? 0,
            activeCol: sel?.activeCol ?? 0,
          });
        },
      },
    ],
  });
  return () => context.ui.menus.unregisterItem("data", SOLVER_MENU_ITEM_ID);
}
