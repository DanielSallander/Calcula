//! FILENAME: app/extensions/CalculationOptions/handlers/formulasMenuItemBuilder.ts
// PURPOSE: Registers "Calculation Options", "Calculate Worksheet", and "Calculate Workbook"
//          items in the Formulas menu.
// CONTEXT: Uses registerMenuItem to append to the existing "formulas" menu
//          (created by the Tracing extension).

import {
  registerMenuItem,
  cellEvents,
  emitAppEvent,
  AppEvents,
  IconCalcOptions,
  IconCalculate,
  IconAutomatic,
  IconManual,
  IconCalcWorkbook,
  IconCalcWorksheet,
} from "@api";
import {
  setCalculationMode,
  getCalculationMode,
  calculateNow,
  calculateSheet,
  getIterationSettings,
  setIterationSettings,
  getPrecisionAsDisplayed,
  setPrecisionAsDisplayed,
  getCalculateBeforeSave,
  setCalculateBeforeSave,
} from "@api/lib";

// ============================================================================
// State
// ============================================================================

/** Current calculation mode. Drives the checked state of submenu items via getters. */
let currentMode: "automatic" | "manual" = "automatic";

/** Current iterative calculation state. */
let iterationEnabled = false;
let iterationMaxIterations = 100;
let iterationMaxChange = 0.001;

/** Precision as displayed setting. */
let precisionAsDisplayed = false;

/** Calculate before save setting. */
let calculateBeforeSave = true;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Apply recalculated cells to the grid so the canvas refreshes.
 */
function applyCellUpdates(
  cells: Array<{
    row: number;
    col: number;
    display: string;
    formula?: string | null;
    sheetIndex?: number;
  }>,
): void {
  for (const cell of cells) {
    // Skip cross-sheet cells (they belong to other sheets)
    if (cell.sheetIndex !== undefined) {
      continue;
    }
    cellEvents.emit({
      row: cell.row,
      col: cell.col,
      oldValue: undefined,
      newValue: cell.display,
      formula: cell.formula ?? null,
    });
  }
}

// ============================================================================
// Menu Registration
// ============================================================================

/**
 * Register the Calculation Options, Calculate Worksheet, and Calculate Workbook
 * items in the Formulas menu.
 * Assumes the "formulas" menu was already created by Tracing.
 */
export function registerCalculationMenuItems(): void {
  // ---- Separator ----
  registerMenuItem("formulas", {
    id: "formulas:calcOptions:separator",
    label: "",
    separator: true,
  });

  // ---- Build submenu children with getter-based checked state ----
  // Using Object.defineProperty so `checked` is always computed from `currentMode`.
  // The menu dropdown is recreated each time it opens, so getters are read fresh.
  const autoItem = {
    id: "formulas:calcOptions:automatic",
    label: "Automatic",
    icon: IconAutomatic,
    get checked() { return currentMode === "automatic"; },
    action: () => {
      currentMode = "automatic";
      setCalculationMode("automatic")
        .then(() => calculateNow())
        .then((cells) => {
          applyCellUpdates(cells);
          emitAppEvent(AppEvents.GRID_REFRESH);
        })
        .catch((err) => {
          console.error("[CalculationOptions] Failed to set automatic mode:", err);
        });
    },
  };

  const manualItem = {
    id: "formulas:calcOptions:manual",
    label: "Manual",
    icon: IconManual,
    get checked() { return currentMode === "manual"; },
    action: () => {
      currentMode = "manual";
      setCalculationMode("manual").catch((err) => {
        console.error("[CalculationOptions] Failed to set manual mode:", err);
        currentMode = "automatic"; // Revert on error
      });
    },
  };

  // ---- Iterative Calculation submenu items ----
  const iterationToggleItem = {
    id: "formulas:calcOptions:iterationToggle",
    label: "Enable Iterative Calculation",
    get checked() { return iterationEnabled; },
    action: () => {
      iterationEnabled = !iterationEnabled;
      setIterationSettings(iterationEnabled, iterationMaxIterations, iterationMaxChange)
        .then(() => {
          console.log(`[CalculationOptions] Iterative calculation ${iterationEnabled ? "enabled" : "disabled"}`);
        })
        .catch((err: unknown) => {
          console.error("[CalculationOptions] Failed to toggle iteration:", err);
          iterationEnabled = !iterationEnabled; // Revert on error
        });
    },
  };

  const iterationSettingsItem = {
    id: "formulas:calcOptions:iterationSettings",
    label: "Iteration Settings...",
    action: () => {
      const maxIterInput = window.prompt("Maximum Iterations:", String(iterationMaxIterations));
      if (maxIterInput === null) return; // User cancelled
      const maxIter = parseInt(maxIterInput, 10);
      if (isNaN(maxIter) || maxIter < 1) {
        window.alert("Maximum Iterations must be a positive integer.");
        return;
      }

      const maxChangeInput = window.prompt("Maximum Change:", String(iterationMaxChange));
      if (maxChangeInput === null) return; // User cancelled
      const maxChg = parseFloat(maxChangeInput);
      if (isNaN(maxChg) || maxChg <= 0) {
        window.alert("Maximum Change must be a positive number.");
        return;
      }

      iterationMaxIterations = maxIter;
      iterationMaxChange = maxChg;
      setIterationSettings(iterationEnabled, iterationMaxIterations, iterationMaxChange)
        .then(() => {
          console.log(`[CalculationOptions] Iteration settings: maxIterations=${maxIter}, maxChange=${maxChg}`);
        })
        .catch((err: unknown) => {
          console.error("[CalculationOptions] Failed to set iteration settings:", err);
        });
    },
  };

  // ---- Precision As Displayed ----
  const precisionItem = {
    id: "formulas:calcOptions:precisionAsDisplayed",
    label: "Precision As Displayed",
    get checked() { return precisionAsDisplayed; },
    action: () => {
      precisionAsDisplayed = !precisionAsDisplayed;
      setPrecisionAsDisplayed(precisionAsDisplayed)
        .then(() => {
          console.log(`[CalculationOptions] Precision as displayed: ${precisionAsDisplayed}`);
        })
        .catch((err: unknown) => {
          console.error("[CalculationOptions] Failed to set precision as displayed:", err);
          precisionAsDisplayed = !precisionAsDisplayed; // Revert on error
        });
    },
  };

  // ---- Calculate Before Save ----
  const calcBeforeSaveItem = {
    id: "formulas:calcOptions:calculateBeforeSave",
    label: "Calculate Before Save",
    get checked() { return calculateBeforeSave; },
    action: () => {
      calculateBeforeSave = !calculateBeforeSave;
      setCalculateBeforeSave(calculateBeforeSave)
        .then(() => {
          console.log(`[CalculationOptions] Calculate before save: ${calculateBeforeSave}`);
        })
        .catch((err: unknown) => {
          console.error("[CalculationOptions] Failed to set calculate before save:", err);
          calculateBeforeSave = !calculateBeforeSave; // Revert on error
        });
    },
  };

  // ---- Calculation Options (with submenu) ----
  registerMenuItem("formulas", {
    id: "formulas:calcOptions",
    label: "Calculation Options",
    icon: IconCalcOptions,
    children: [
      autoItem,
      manualItem,
      { id: "formulas:calcOptions:iterSep", label: "", separator: true },
      iterationToggleItem,
      iterationSettingsItem,
      { id: "formulas:calcOptions:settingsSep", label: "", separator: true },
      precisionItem,
      calcBeforeSaveItem,
    ],
  });

  // ---- Calculate (with submenu) ----
  registerMenuItem("formulas", {
    id: "formulas:calculate",
    label: "Calculate",
    icon: IconCalculate,
    children: [
      {
        id: "formulas:calculateWorkbook",
        label: "Calculate Workbook",
        icon: IconCalcWorkbook,
        action: () => {
          calculateNow().then((cells) => {
            applyCellUpdates(cells);
            emitAppEvent(AppEvents.GRID_REFRESH);
          });
        },
      },
      {
        id: "formulas:calculateSheet",
        label: "Calculate Worksheet",
        icon: IconCalcWorksheet,
        action: () => {
          calculateSheet().then((cells) => {
            applyCellUpdates(cells);
            emitAppEvent(AppEvents.GRID_REFRESH);
          });
        },
      },
    ],
  });
}

/**
 * Sync the calculation mode from the backend.
 * Called once during extension activation.
 */
export async function syncCalculationMode(): Promise<void> {
  try {
    const mode = await getCalculationMode();
    if (mode === "automatic" || mode === "manual") {
      currentMode = mode;
    }
  } catch (err) {
    console.error("[CalculationOptions] Failed to get calculation mode:", err);
  }

  try {
    const settings = await getIterationSettings();
    iterationEnabled = settings.enabled;
    iterationMaxIterations = settings.maxIterations;
    iterationMaxChange = settings.maxChange;
  } catch (err) {
    console.error("[CalculationOptions] Failed to get iteration settings:", err);
  }

  try {
    precisionAsDisplayed = await getPrecisionAsDisplayed();
  } catch (err) {
    console.error("[CalculationOptions] Failed to get precision as displayed:", err);
  }

  try {
    calculateBeforeSave = await getCalculateBeforeSave();
  } catch (err) {
    console.error("[CalculationOptions] Failed to get calculate before save:", err);
  }
}
