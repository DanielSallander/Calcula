//! FILENAME: app/extensions/DataValidation/lib/validationStore.ts
// PURPOSE: Module-level state management for the Data Validation extension.
// CONTEXT: Caches validation ranges, tracks invalid cells, manages dropdown/prompt state.

import {
  getAllDataValidations,
  getInvalidCells,
  addGridRegions,
  removeGridRegionsByType,
  requestOverlayRedraw,
  emitAppEvent,
  type GridRegion,
  type ValidationRange,
} from "../../../src/api";
import type { ValidationState } from "../types";
import { ValidationEvents } from "./validationEvents";

// ============================================================================
// State
// ============================================================================

let state: ValidationState = {
  validationRanges: [],
  invalidCells: null,
  openDropdownCell: null,
  promptVisible: false,
  promptCell: null,
};

let currentSelection: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  activeRow: number;
  activeCol: number;
} | null = null;

// ============================================================================
// Getters
// ============================================================================

export function getValidationState(): ValidationState {
  return state;
}

export function getValidationRanges(): ValidationRange[] {
  return state.validationRanges;
}

export function getInvalidCellsList(): [number, number][] | null {
  return state.invalidCells;
}

export function isCirclesActive(): boolean {
  return state.invalidCells !== null;
}

export function getOpenDropdownCell(): { row: number; col: number } | null {
  return state.openDropdownCell;
}

export function getCurrentSelection() {
  return currentSelection;
}

// ============================================================================
// Setters
// ============================================================================

export function setCurrentSelection(
  sel: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    activeRow: number;
    activeCol: number;
  } | null
): void {
  currentSelection = sel;
}

export function setOpenDropdownCell(cell: { row: number; col: number } | null): void {
  state.openDropdownCell = cell;
}

export function setPromptState(visible: boolean, cell: { row: number; col: number } | null): void {
  state.promptVisible = visible;
  state.promptCell = cell;
}

// ============================================================================
// Refresh & Sync
// ============================================================================

/**
 * Refresh the cached validation ranges from the backend
 * and sync grid overlay regions for dropdown chevrons.
 */
export async function refreshValidationState(): Promise<void> {
  try {
    const ranges = await getAllDataValidations();
    state.validationRanges = ranges;
    syncDropdownChevronRegions();

    // If circles are active, refresh them too
    if (state.invalidCells !== null) {
      await refreshInvalidCells();
    }

    emitAppEvent(ValidationEvents.VALIDATION_CHANGED);
    requestOverlayRedraw();
  } catch (error) {
    console.error("[DataValidation] Failed to refresh validation state:", error);
  }
}

/**
 * Sync grid regions for cells that have list validation with in-cell dropdown.
 * These regions are used by the dropdownChevronRenderer to draw dropdown arrows.
 */
function syncDropdownChevronRegions(): void {
  // Remove existing chevron regions
  removeGridRegionsByType("validation-dropdown");

  // Find all cells with list validation + inCellDropdown
  const regions: GridRegion[] = [];
  for (const vr of state.validationRanges) {
    const rule = vr.validation.rule;
    // Check if this is a list rule with in-cell dropdown
    if ("list" in rule && rule.list.inCellDropdown) {
      // Create one region per row in the range for better hit-testing
      for (let row = vr.startRow; row <= vr.endRow; row++) {
        for (let col = vr.startCol; col <= vr.endCol; col++) {
          regions.push({
            id: `validation-dropdown-${row}-${col}`,
            type: "validation-dropdown",
            startRow: row,
            startCol: col,
            endRow: row,
            endCol: col,
          });
        }
      }
    }
  }

  if (regions.length > 0) {
    addGridRegions(regions);
  }
}

/**
 * Refresh the list of invalid cells from the backend
 * and sync grid overlay regions for red circles.
 */
async function refreshInvalidCells(): Promise<void> {
  try {
    const result = await getInvalidCells();
    state.invalidCells = result.cells;
    syncInvalidCellRegions();
  } catch (error) {
    console.error("[DataValidation] Failed to refresh invalid cells:", error);
  }
}

/**
 * Sync grid regions for invalid cells (for "Circle Invalid Data" rendering).
 */
function syncInvalidCellRegions(): void {
  removeGridRegionsByType("validation-invalid");

  if (!state.invalidCells || state.invalidCells.length === 0) {
    return;
  }

  const regions: GridRegion[] = state.invalidCells.map(([row, col]) => ({
    id: `validation-invalid-${row}-${col}`,
    type: "validation-invalid",
    startRow: row,
    startCol: col,
    endRow: row,
    endCol: col,
  }));

  addGridRegions(regions);
}

/**
 * Toggle "Circle Invalid Data" on/off.
 */
export async function toggleCircleInvalidData(): Promise<void> {
  if (state.invalidCells !== null) {
    // Currently showing - turn off
    clearCircles();
  } else {
    // Currently hidden - turn on
    await refreshInvalidCells();
    emitAppEvent(ValidationEvents.CIRCLES_TOGGLED, { active: true });
    requestOverlayRedraw();
  }
}

/**
 * Clear invalid data circles.
 */
export function clearCircles(): void {
  state.invalidCells = null;
  removeGridRegionsByType("validation-invalid");
  emitAppEvent(ValidationEvents.CIRCLES_TOGGLED, { active: false });
  requestOverlayRedraw();
}

/**
 * Reset all extension state (called on unregister or sheet switch).
 */
export function resetState(): void {
  state = {
    validationRanges: [],
    invalidCells: null,
    openDropdownCell: null,
    promptVisible: false,
    promptCell: null,
  };
  currentSelection = null;
  removeGridRegionsByType("validation-dropdown");
  removeGridRegionsByType("validation-invalid");
}
