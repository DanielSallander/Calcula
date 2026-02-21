//! FILENAME: app/extensions/Consolidate/handlers/dataMenuBuilder.ts
// PURPOSE: Registers the "Consolidate..." item in the Data menu.
// CONTEXT: Uses registerMenuItem to append to the existing "data" menu.

import { registerMenuItem, DialogExtensions } from "../../../src/api";

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
export function registerConsolidateMenuItem(): void {
  registerMenuItem("data", {
    id: "data:consolidate:separator",
    label: "",
    separator: true,
  });

  registerMenuItem("data", {
    id: "data:consolidate",
    label: "Consolidate...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog("consolidate", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });
}
