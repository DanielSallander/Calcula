//! FILENAME: app/extensions/DataTables/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Data Table items under "What-If Analysis" in the Data menu.

import type { ExtensionContext } from "@api/contract";
import { IconWhatIfAnalysis, IconDataTable } from "@api";
import { refuseIfSelectionOwned } from "@api/selectionOwner";

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

// ============================================================================
// Menu Registration
// ============================================================================

const DATA_TABLE_MENU_ITEM_ID = "data:whatIf:dataTable";

/**
 * Register "What-If Data Table..." under Data > What-If Analysis. Returns the
 * cleanup for deactivation, which takes back this extension's own CHILD --
 * never "data:whatIf", which Goal Seek, Solver and Scenario Manager share
 * (X18).
 */
export function registerDataTableMenuItems(context: ExtensionContext): () => void {
  context.ui.menus.registerItem("data", {
    id: "data:whatIf",
    label: "What-If Analysis",
    icon: IconWhatIfAnalysis,
    children: [
      {
        id: DATA_TABLE_MENU_ITEM_ID,
        label: "What-If Data Table...",
        icon: IconDataTable,
        action: () => {
          // The table fills Core's selection -- HIDDEN while something else
          // owns the selection (a floating grid's selected cell) -- so refuse,
          // once (D4, BUG-0185 class).
          if (refuseIfSelectionOwned("What-If Data Table")) return;
          const sel = currentSelection;
          context.ui.dialogs.show("data-table", {
            activeRow: sel?.activeRow ?? 0,
            activeCol: sel?.activeCol ?? 0,
            endRow: sel?.endRow ?? 0,
            endCol: sel?.endCol ?? 0,
          });
        },
      },
    ],
  });
  return () => context.ui.menus.unregisterItem("data", DATA_TABLE_MENU_ITEM_ID);
}
