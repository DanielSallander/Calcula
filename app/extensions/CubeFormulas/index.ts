//! FILENAME: app/extensions/CubeFormulas/index.ts
// PURPOSE: CUBE Formula authoring extension — the guided argument builder for
//          CUBEVALUE/CUBEMEMBER/... and the workbook calculated-measures dialog.
// CONTEXT: The builder is contributed to the shell's Insert Function (fx)
//          dialog through the @api/functionBuilders seam, so CUBE functions are
//          found and inserted exactly where every other function is. There is
//          no longer a "Insert CUBE Formula..." menu item — that private front
//          door was discoverable only by users who already knew it existed.
//          Extensions may ONLY import from @api.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { registerFunctionBuilder, unregisterMenuItem } from "@api";
import { CalculatedMeasuresDialog } from "./components/CalculatedMeasuresDialog";
import {
  CubeFormulaBuilderPanel,
  CUBE_FUNCTION_NAMES,
} from "./components/CubeFormulaBuilderPanel";
import {
  CALC_MEASURES_DIALOG_ID,
  registerCalculatedMeasuresMenuItem,
} from "./handlers/modelMenuItem";

const cleanupFns: (() => void)[] = [];

function activate(context: ExtensionContext): void {
  // 1. Contribute the CUBE argument builder to the fx dialog.
  cleanupFns.push(
    registerFunctionBuilder({
      id: "calcula.cube-formulas.builder",
      functions: CUBE_FUNCTION_NAMES,
      component: CubeFormulaBuilderPanel,
    }),
  );

  // 2. The calculated-measures dialog, opened from the Model menu.
  context.ui.dialogs.register({
    id: CALC_MEASURES_DIALOG_ID,
    component: CalculatedMeasuresDialog,
    priority: 110,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(CALC_MEASURES_DIALOG_ID));

  registerCalculatedMeasuresMenuItem();
  cleanupFns.push(() => unregisterMenuItem("model", "model:calculatedMeasures"));
}

function deactivate(): void {
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[CubeFormulas] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.cube-formulas",
    name: "CUBE Formulas",
    version: "1.0.0",
    description: "Build and insert CUBE formulas from a Calcula BI model.",
  },
  activate,
  deactivate,
};

export default extension;
