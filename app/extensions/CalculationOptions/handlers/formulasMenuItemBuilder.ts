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
} from "../../../src/api";
import {
  setCalculationMode,
  getCalculationMode,
  calculateNow,
  calculateSheet,
} from "../../../src/api/lib";

// ============================================================================
// State
// ============================================================================

/** Current calculation mode. Drives the checked state of submenu items via getters. */
let currentMode: "automatic" | "manual" = "automatic";

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

  // ---- Calculation Options (with submenu) ----
  registerMenuItem("formulas", {
    id: "formulas:calcOptions",
    label: "Calculation Options",
    icon: IconCalcOptions,
    children: [autoItem, manualItem],
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
}
