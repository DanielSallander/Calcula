//! FILENAME: app/extensions/TextToColumns/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Text to Columns..." item in the Data menu.
// CONTEXT: Uses ExtensionContext to register menu items and show dialogs.

import type { ExtensionContext } from "@api/contract";
import { IconTextToColumns } from "@api";
import { refuseIfSelectionOwned } from "@api/selectionOwner";

// ============================================================================
// State
// ============================================================================

let currentSelection: {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
} | null = null;

export function setCurrentSelection(
  sel: {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
  } | null,
): void {
  currentSelection = sel;
}

// ============================================================================
// Menu Registration
// ============================================================================

/**
 * Register the "Text to Columns..." item in the Data menu.
 * Assumes the "data" menu was already created by AutoFilter or another extension.
 *
 * Returns the cleanup for deactivation: it takes back this extension's OWN
 * items, never the shared Data menu (wave E, Y14).
 */
export function registerTextToColumnsMenuItem(context: ExtensionContext): () => void {
  context.ui.menus.registerItem("data", {
    id: "data:textToColumns:separator",
    label: "",
    separator: true,
  });

  context.ui.menus.registerItem("data", {
    id: "data:textToColumns",
    label: "Text to Columns...",
    icon: IconTextToColumns,
    action: () => {
      // The dialog splits Core's selection, which is HIDDEN while something
      // else owns the selection (a floating grid's selected cell): refuse, once
      // (D4, BUG-0185 class).
      if (refuseIfSelectionOwned("Text to Columns")) return;
      const sel = currentSelection;
      context.ui.dialogs.show("text-to-columns", {
        startRow: sel?.startRow ?? 0,
        startCol: sel?.startCol ?? 0,
        endRow: sel?.endRow ?? 0,
        endCol: sel?.endCol ?? 0,
      });
    },
  });

  return () => {
    context.ui.menus.unregisterItem("data", "data:textToColumns:separator");
    context.ui.menus.unregisterItem("data", "data:textToColumns");
  };
}
