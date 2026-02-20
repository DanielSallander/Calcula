//! FILENAME: app/extensions/GoalSeek/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Goal Seek..." item in the Data menu.
// CONTEXT: Uses registerMenuItem to append to the existing "data" menu.

import { registerMenuItem, DialogExtensions } from "../../../src/api";

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
 * Register the "Goal Seek..." item in the Data menu.
 * Assumes the "data" menu was already created by AutoFilter.
 */
export function registerGoalSeekMenuItem(): void {
  registerMenuItem("data", {
    id: "data:goalSeek:separator",
    label: "",
    separator: true,
  });

  registerMenuItem("data", {
    id: "data:goalSeek",
    label: "Goal Seek...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog("goal-seek", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });
}
