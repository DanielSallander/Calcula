//! FILENAME: app/extensions/CubeFormulas/handlers/modelMenuItem.ts
// PURPOSE: Registers "Calculated Measures..." in the Model menu.
// CONTEXT: This file used to also register "Insert CUBE Formula..." in the
//          Formulas menu. That item is gone: CUBE functions are now inserted
//          from the fx dialog like every other function, and the builder it
//          used to open is registered through @api/functionBuilders instead.
//          Calculated measures are MODEL objects, not a formula-authoring
//          gesture, so they stay in the Model menu next to the Model Editor.

import { registerMenuItem, DialogExtensions, IconCalculatedMeasure } from "@api";

export const CALC_MEASURES_DIALOG_ID = "cube-calculated-measures";

/** Append the calculated-measures item to the Model menu. */
export function registerCalculatedMeasuresMenuItem(): void {
  registerMenuItem("model", {
    id: "model:calculatedMeasures",
    label: "Calculated Measures...",
    icon: IconCalculatedMeasure,
    order: 15,
    action: () => DialogExtensions.openDialog(CALC_MEASURES_DIALOG_ID, {}),
  });
}
