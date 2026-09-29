//! FILENAME: app/extensions/GoalSeek/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Goal Seek..." item under "What-If Analysis" in the Data menu.
// CONTEXT: Uses ExtensionContext to register menu items and show dialogs.

import type { ExtensionContext } from "@api/contract";
import { IconWhatIfAnalysis, IconGoalSeek } from "@api";
import { refuseIfSelectionOwned } from "@api/selectionOwner";

// ============================================================================
// State
// ============================================================================

let currentSelection: {
  activeRow: number;
  activeCol: number;
} | null = null;

export function setCurrentSelection(
  sel: {
    activeRow: number;
    activeCol: number;
  } | null,
): void {
  currentSelection = sel;
}

// ============================================================================
// Menu Registration
// ============================================================================

const GOAL_SEEK_MENU_ITEM_ID = "data:whatIf:goalSeek";

/**
 * Register "Goal Seek..." under the "What-If Analysis" submenu in Data menu.
 * The menu merge logic will combine children from multiple extensions.
 *
 * Returns the cleanup for deactivation. It takes back Goal Seek's own CHILD,
 * never "data:whatIf": What-If Data Table, Solver and Scenario Manager add
 * theirs to the same submenu, which goes with the last of them (X18).
 */
export function registerGoalSeekMenuItem(context: ExtensionContext): () => void {
  context.ui.menus.registerItem("data", {
    id: "data:whatIf",
    label: "What-If Analysis",
    icon: IconWhatIfAnalysis,
    children: [
      {
        id: GOAL_SEEK_MENU_ITEM_ID,
        label: "Goal Seek...",
        icon: IconGoalSeek,
        action: () => {
          // The Set Cell is Core's active cell -- HIDDEN while something else
          // owns the selection (a floating grid's selected cell) -- so refuse,
          // once (D4, BUG-0185 class).
          if (refuseIfSelectionOwned("Goal Seek")) return;
          const sel = currentSelection;
          context.ui.dialogs.show("goal-seek", {
            activeRow: sel?.activeRow ?? 0,
            activeCol: sel?.activeCol ?? 0,
          });
        },
      },
    ],
  });
  return () => context.ui.menus.unregisterItem("data", GOAL_SEEK_MENU_ITEM_ID);
}
