//! FILENAME: app/extensions/CubeFormulas/handlers/formulasMenuItem.ts
// PURPOSE: Registers "Insert CUBE Formula..." in the Formulas menu and tracks
//          the active cell so the builder dialog inserts in the right place.

import { registerMenuItem, DialogExtensions, IconCube, IconCalculatedMeasure } from "@api";

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
    icon: IconCube,
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog(CUBE_DIALOG_ID, {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });

  // Calculated measures are model objects, so they live in the Model menu's
  // authoring section (next to the Model Editor), not under Formulas.
  registerMenuItem("model", {
    id: "model:calculatedMeasures",
    label: "Calculated Measures...",
    icon: IconCalculatedMeasure,
    order: 15,
    action: () => DialogExtensions.openDialog(CALC_MEASURES_DIALOG_ID, {}),
  });
}
