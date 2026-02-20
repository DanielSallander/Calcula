//! FILENAME: app/extensions/TextToColumns/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Text to Columns..." item in the Data menu.
// CONTEXT: Uses registerMenuItem to append to the existing "data" menu.
//          Pattern follows RemoveDuplicates/handlers/dataMenuBuilder.ts.

import { registerMenuItem, DialogExtensions } from "../../../src/api";

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
 */
export function registerTextToColumnsMenuItem(): void {
  registerMenuItem("data", {
    id: "data:textToColumns:separator",
    label: "",
    separator: true,
  });

  registerMenuItem("data", {
    id: "data:textToColumns",
    label: "Text to Columns...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog("text-to-columns", {
        startRow: sel?.startRow ?? 0,
        startCol: sel?.startCol ?? 0,
        endRow: sel?.endRow ?? 0,
        endCol: sel?.endCol ?? 0,
      });
    },
  });
}
