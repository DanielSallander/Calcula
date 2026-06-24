//! FILENAME: app/extensions/CubeFormulas/handlers/formulasMenuItem.ts
// PURPOSE: Registers "Insert CUBE Formula..." in the Formulas menu and tracks
//          the active cell so the builder dialog inserts in the right place.

import { registerMenuItem, DialogExtensions } from "@api";

export const CUBE_DIALOG_ID = "cube-formula-builder";
export const CALC_MEASURES_DIALOG_ID = "cube-calculated-measures";

let currentSelection: { activeRow: number; activeCol: number } | null = null;

export function setCurrentSelection(
  sel: { activeRow: number; activeCol: number } | null,
): void {
  currentSelection = sel;
}

/** Append the CUBE builder item to the Formulas menu (created by Tracing). */
export function registerCubeFormulaMenuItem(): void {
  registerMenuItem("formulas", {
    id: "formulas:cubeFormula:separator",
    label: "",
    separator: true,
  });
  registerMenuItem("formulas", {
    id: "formulas:cubeFormula",
    label: "Insert CUBE Formula...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog(CUBE_DIALOG_ID, {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });

  registerMenuItem("formulas", {
    id: "formulas:calculatedMeasures",
    label: "Calculated Measures...",
    action: () => DialogExtensions.openDialog(CALC_MEASURES_DIALOG_ID, {}),
  });
}
