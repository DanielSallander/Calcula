//! FILENAME: app/extensions/DataTables/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Data Table items under "What-If Analysis" in the Data menu.

import type { ExtensionContext } from "@api/contract";
import { IconWhatIfAnalysis, IconDataTable } from "@api";

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

export function registerDataTableMenuItems(context: ExtensionContext): void {
  context.ui.menus.registerItem("data", {
    id: "data:whatIf",
    label: "What-If Analysis",
    icon: IconWhatIfAnalysis,
    children: [
      {
        id: "data:whatIf:dataTable",
        label: "What-If Data Table...",
        icon: IconDataTable,
        action: () => {
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
}
