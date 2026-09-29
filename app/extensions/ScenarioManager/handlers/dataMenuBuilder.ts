//! FILENAME: app/extensions/ScenarioManager/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Scenario Manager items under "What-If Analysis" in the Data menu.

import type { ExtensionContext } from "@api/contract";
import { IconWhatIfAnalysis, IconScenarioManager } from "@api";
import { isSelectionOwned } from "@api/selectionOwner";

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

/** Register the What-If item. Returns its teardown (deactivate): the item
 *  outlived the extension (the D3 class, found in wave C beside W20/W21).
 *  "What-If Analysis" is a SHARED parent -- Goal Seek, What-If Data Table and
 *  Solver register the same id with their own children -- so the teardown
 *  takes back only Scenario Manager's CHILD; the registry drops the parent
 *  with its last child (wave C review: unregistering the parent took the
 *  other three items with it, for good). */
export function registerScenarioMenuItems(context: ExtensionContext): () => void {
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
          // The manager is workbook-level and opens whatever the selection;
          // only its Add... prefill comes from Core's selection -- HIDDEN
          // while something else owns it (a floating grid's selected cell).
          // Then the dialog gets NO selection, and Add... starts empty (W24).
          if (isSelectionOwned()) {
            context.ui.dialogs.show("scenario-manager", {});
            return;
          }
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
  return () => context.ui.menus.unregisterItem("data", "data:whatIf:scenarioManager");
}
