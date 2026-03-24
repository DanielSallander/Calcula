//! FILENAME: app/extensions/FormulaVisualizer/handlers/formulasMenuItemBuilder.ts
// PURPOSE: Registers the "Visualize Formula..." item in the Formulas menu.

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
 * Register the "Visualize Formula..." item in the Formulas menu.
 * Assumes the "formulas" menu was already created by Tracing.
 */
export function registerFormulaVisualizerMenuItem(): void {
  registerMenuItem("formulas", {
    id: "formulas:formulaVisualizer:separator",
    label: "",
    separator: true,
  });

  registerMenuItem("formulas", {
    id: "formulas:formulaVisualizer",
    label: "Visualize Formula...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog("formula-visualizer", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });
}
