//! FILENAME: app/extensions/ScenarioManager/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Scenario Manager items under "What-If Analysis" in the Data menu.

import type { ExtensionContext } from "@api/contract";
import { IconWhatIfAnalysis, IconScenarioManager } from "@api";

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

export function registerScenarioMenuItems(context: ExtensionContext): void {
  context.ui.menus.registerItem("data", {
    id: "data:whatIf",
    label: "What-If Analysis",
    icon: IconWhatIfAnalysis,
    children: [
      {
        id: "data:whatIf:scenarioManager",
        label: "Scenario Manager...",
        icon: IconScenarioManager,
        action: () => {
          const sel = currentSelection;
          context.ui.dialogs.show("scenario-manager", {
            activeRow: sel?.activeRow ?? 0,
            activeCol: sel?.activeCol ?? 0,
            endRow: sel?.endRow ?? 0,
            endCol: sel?.endCol ?? 0,
          });
        },
      },
    ],
  });
}
