//! FILENAME: app/extensions/DataForm/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Data Form..." item in the Data menu.
// CONTEXT: Uses ExtensionContext to register menu items and show dialogs.

import type { ExtensionContext } from "@api/contract";
import { getCurrentRegion } from "@api";

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
 * Register "Data Form..." as a top-level item in the Data menu.
 */
export function registerDataFormMenuItem(context: ExtensionContext): void {
  context.ui.menus.registerItem("data", {
    id: "data:dataForm",
    label: "Data Form...",
    action: async () => {
      const sel = currentSelection;
      const row = sel?.activeRow ?? 0;
      const col = sel?.activeCol ?? 0;

      // Detect the data region around the current cell
      const region = await getCurrentRegion(row, col);

      if (region.empty) {
        // No data region found - still open form at the single cell
        context.ui.dialogs.show("data-form", {
          startRow: row,
          startCol: col,
          endRow: row,
          endCol: col,
        });
        return;
      }

      context.ui.dialogs.show("data-form", {
        startRow: region.startRow,
        startCol: region.startCol,
        endRow: region.endRow,
        endCol: region.endCol,
      });
    },
  });
}
