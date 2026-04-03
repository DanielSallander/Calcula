//! FILENAME: app/extensions/Consolidate/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Consolidate..." item in the Data menu.
// CONTEXT: Uses context.ui.menus.registerItem to append to the existing "data" menu.

import type { ExtensionContext } from "@api/contract";

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
 * Register the "Consolidate..." item in the Data menu.
 * Assumes the "data" menu was already created by AutoFilter.
 */
export function registerConsolidateMenuItem(context: ExtensionContext): void {
  context.ui.menus.registerItem("data", {
    id: "data:consolidate:separator",
    label: "",
    separator: true,
  });

  context.ui.menus.registerItem("data", {
    id: "data:consolidate",
    label: "Consolidate...",
    action: () => {
      const sel = currentSelection;
      context.ui.dialogs.show("consolidate", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });
}
