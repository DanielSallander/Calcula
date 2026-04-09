//! FILENAME: app/extensions/GoalSeek/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Goal Seek..." item under "What-If Analysis" in the Data menu.
// CONTEXT: Uses ExtensionContext to register menu items and show dialogs.

import type { ExtensionContext } from "@api/contract";
import { IconWhatIfAnalysis, IconGoalSeek } from "@api";

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

/**
 * Register "Goal Seek..." under the "What-If Analysis" submenu in Data menu.
 * The menu merge logic will combine children from multiple extensions.
 */
export function registerGoalSeekMenuItem(context: ExtensionContext): void {
  context.ui.menus.registerItem("data", {
    id: "data:whatIf",
    label: "What-If Analysis",
    icon: IconWhatIfAnalysis,
    children: [
      {
        id: "data:whatIf:goalSeek",
        label: "Goal Seek...",
        icon: IconGoalSeek,
        action: () => {
          const sel = currentSelection;
          context.ui.dialogs.show("goal-seek", {
            activeRow: sel?.activeRow ?? 0,
            activeCol: sel?.activeCol ?? 0,
          });
        },
      },
    ],
  });
}
