//! FILENAME: app/extensions/RemoveDuplicates/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Remove Duplicates..." item in the Data menu.
// CONTEXT: Uses ExtensionContext to register menu items and show dialogs.

import type { ExtensionContext } from "@api/contract";

// ============================================================================
// State
// ============================================================================

let currentSelection: {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  activeRow?: number;
  activeCol?: number;
} | null = null;

export function setCurrentSelection(
  sel: {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
    activeRow?: number;
    activeCol?: number;
  } | null,
): void {
  currentSelection = sel;
}

// ============================================================================
// Menu Registration
// ============================================================================

/**
 * Register the "Remove Duplicates..." item in the Data menu.
 * Assumes the "data" menu was already created by AutoFilter.
 */
export function registerRemoveDuplicatesMenuItem(context: ExtensionContext): void {
  context.ui.menus.registerItem("data", {
    id: "data:removeDuplicates:separator",
    label: "",
    separator: true,
  });

  context.ui.menus.registerItem("data", {
    id: "data:removeDuplicates",
    label: "Remove Duplicates...",
    action: () => {
      const sel = currentSelection;
      context.ui.dialogs.show("remove-duplicates", {
        activeRow: sel?.startRow ?? 0,
        activeCol: sel?.startCol ?? 0,
      });
    },
  });
}
