//! FILENAME: app/extensions/CubeFormulas/index.ts
// PURPOSE: CUBE Formula authoring extension — a builder dialog that inserts
//          CUBEVALUE/CUBEMEMBER/... formulas from a Calcula BI model.
// CONTEXT: Registers the dialog + a Formulas-menu item and tracks the active
//          cell. Extensions may ONLY import from @api.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
import { CubeFormulaBuilderDialog } from "./components/CubeFormulaBuilderDialog";
import { CalculatedMeasuresDialog } from "./components/CalculatedMeasuresDialog";
import {
  CUBE_DIALOG_ID,
  CALC_MEASURES_DIALOG_ID,
  registerCubeFormulaMenuItem,
  setCurrentSelection,
} from "./handlers/formulasMenuItem";

const cleanupFns: (() => void)[] = [];

function activate(context: ExtensionContext): void {
  // 1. Register the builder dialog.
  context.ui.dialogs.register({
    id: CUBE_DIALOG_ID,
    component: CubeFormulaBuilderDialog,
    priority: 110,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(CUBE_DIALOG_ID));

  context.ui.dialogs.register({
    id: CALC_MEASURES_DIALOG_ID,
    component: CalculatedMeasuresDialog,
    priority: 110,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(CALC_MEASURES_DIALOG_ID));

  // 2. Add the "Insert CUBE Formula..." item to the Formulas menu.
  registerCubeFormulaMenuItem();

  // 3. Track the active cell so the dialog inserts in the right place.
  const unsub = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(sel ? { activeRow: sel.startRow, activeCol: sel.startCol } : null);
  });
  cleanupFns.push(unsub);
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
