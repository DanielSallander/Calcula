//! FILENAME: app/extensions/EvaluateFormula/handlers/formulasMenuItemBuilder.ts
// PURPOSE: Registers the "Evaluate Formula..." item in the Formulas menu.
// CONTEXT: Uses registerMenuItem to append to the existing "formulas" menu
//          (created by the Tracing extension).

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
 * Register the "Evaluate Formula..." item in the Formulas menu.
 * Assumes the "formulas" menu was already created by Tracing.
 */
export function registerEvaluateFormulaMenuItem(): void {
  registerMenuItem("formulas", {
    id: "formulas:evalFormula:separator",
    label: "",
    separator: true,
  });

  registerMenuItem("formulas", {
    id: "formulas:evalFormula",
    label: "Evaluate Formula...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog("evaluate-formula", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });
}
