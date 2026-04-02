//! FILENAME: app/extensions/ScenarioManager/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Scenario Manager items in the Data menu.

import { registerMenuItem, DialogExtensions } from "../../../src/api";

// ============================================================================
// State
// ============================================================================

let currentSelection: {
  activeRow: number;
  activeCol: number;
  endRow: number;
  endCol: number;
} | null = null;

export function setCurrentSelection(
  sel: {
    activeRow: number;
    activeCol: number;
    endRow: number;
    endCol: number;
  } | null,
): void {
  currentSelection = sel;
}

export function getCurrentSelection() {
  return currentSelection;
}

// ============================================================================
// Menu Registration
// ============================================================================

export function registerScenarioMenuItems(): void {
  registerMenuItem("data", {
    id: "data:scenarioManager",
    label: "Scenario Manager...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog("scenario-manager", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
        endRow: sel?.endRow ?? 0,
        endCol: sel?.endCol ?? 0,
      });
    },
  });
}
