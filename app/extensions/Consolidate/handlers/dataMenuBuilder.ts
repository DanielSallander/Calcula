//! FILENAME: app/extensions/Consolidate/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Consolidate..." item in the Data menu.
// CONTEXT: Uses context.ui.menus.registerItem to append to the existing "data" menu.

import type { ExtensionContext } from "@api/contract";
import { IconConsolidate } from "@api";
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
 * Register the "Consolidate..." item in the Data menu.
 * Assumes the "data" menu was already created by AutoFilter.
 *
 * Returns the cleanup for deactivation: it takes back this extension's OWN
 * items, never the shared Data menu (wave E, Y14).
 */
export function registerConsolidateMenuItem(context: ExtensionContext): () => void {
  context.ui.menus.registerItem("data", {
    id: "data:consolidate:separator",
    label: "",
    separator: true,
  });

  context.ui.menus.registerItem("data", {
    id: "data:consolidate",
    label: "Consolidate...",
    icon: IconConsolidate,
    action: () => {
      // The destination is Core's active cell, which is HIDDEN while something
      // else owns the selection (a floating grid's selected cell): refuse, once
      // (D4, BUG-0185 class).
      if (refuseIfSelectionOwned("Consolidate")) return;
      const sel = currentSelection;
      context.ui.dialogs.show("consolidate", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });

  return () => {
    context.ui.menus.unregisterItem("data", "data:consolidate:separator");
    context.ui.menus.unregisterItem("data", "data:consolidate");
  };
}
