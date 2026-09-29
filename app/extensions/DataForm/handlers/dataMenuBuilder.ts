//! FILENAME: app/extensions/DataForm/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Data Form..." item in the Data menu.
// CONTEXT: Uses ExtensionContext to register menu items and show dialogs.

import type { ExtensionContext } from "@api/contract";
import { getCurrentRegion, IconDataForm } from "@api";
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

/**
 * Register "Data Form..." as a top-level item in the Data menu.
 *
 * Returns the cleanup for deactivation: it takes back this extension's OWN
 * item, never the shared Data menu (wave E, Y14).
 */
export function registerDataFormMenuItem(context: ExtensionContext): () => void {
  context.ui.menus.registerItem("data", {
    id: "data:dataForm",
    label: "Data Form...",
    icon: IconDataForm,
    action: async () => {
      // The form edits the region around Core's active cell, which is HIDDEN
      // while something else owns the selection (a floating grid's selected
      // cell): refuse, once (D4, BUG-0185 class).
      if (refuseIfSelectionOwned("Data Form")) return;
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

  return () => context.ui.menus.unregisterItem("data", "data:dataForm");
}
