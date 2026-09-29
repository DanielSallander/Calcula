//! FILENAME: app/extensions/RemoveDuplicates/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Remove Duplicates..." item in the Data menu.
// CONTEXT: Uses ExtensionContext to register menu items and show dialogs.

import type { ExtensionContext } from "@api/contract";
import { IconRemoveDuplicates } from "@api";
import { refuseIfSelectionOwned } from "@api/selectionOwner";

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
 *
 * Returns the cleanup for deactivation: it takes back this extension's OWN
 * items, never the shared Data menu (wave E, Y14).
 */
export function registerRemoveDuplicatesMenuItem(context: ExtensionContext): () => void {
  context.ui.menus.registerItem("data", {
    id: "data:removeDuplicates:separator",
    label: "",
    separator: true,
  });

  context.ui.menus.registerItem("data", {
    id: "data:removeDuplicates",
    label: "Remove Duplicates...",
    icon: IconRemoveDuplicates,
    action: () => {
      // The dialog works on Core's selection, which is HIDDEN while something
      // else owns the selection (a floating grid's selected cell): refuse, once
      // (D4, BUG-0185 class).
      if (refuseIfSelectionOwned("Remove Duplicates")) return;
      const sel = currentSelection;
      context.ui.dialogs.show("remove-duplicates", {
        activeRow: sel?.startRow ?? 0,
        activeCol: sel?.startCol ?? 0,
      });
    },
  });

  return () => {
    context.ui.menus.unregisterItem("data", "data:removeDuplicates:separator");
    context.ui.menus.unregisterItem("data", "data:removeDuplicates");
  };
}
