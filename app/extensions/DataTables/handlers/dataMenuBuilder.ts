//! FILENAME: app/extensions/DataTables/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Data Table items in the Data menu.

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

// ============================================================================
// Menu Registration
// ============================================================================

export function registerDataTableMenuItems(): void {
  registerMenuItem("data", {
    id: "data:dataTable",
    label: "What-If Data Table...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog("data-table", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
        endRow: sel?.endRow ?? 0,
        endCol: sel?.endCol ?? 0,
      });
    },
  });
}
