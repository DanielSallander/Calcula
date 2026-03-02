//! FILENAME: app/extensions/Controls/Button/interceptors.ts
// PURPOSE: Click, style, and cursor interceptors for in-cell button controls.
// CONTEXT: Handles button click behavior (design mode vs. run mode),
//          suppresses default cell text for button cells,
//          and changes cursor on hover.

import type { Selection, StyleData } from "../../../src/core/types";
import type {
  IStyleOverride,
  BaseStyleInfo,
  CellCoords,
} from "../../../src/api/styleInterceptors";
import { getDesignMode } from "../lib/designMode";

// ============================================================================
// State
// ============================================================================

/** Module-level style cache, refreshed from getAllStyles() API calls. */
let cachedStyles: Map<number, StyleData> = new Map();
/** Set of style indices that have button=true (for synchronous lookups). */
export const buttonStyleIndices: Set<number> = new Set();
let currentSelection: Selection | null = null;

/**
 * Refresh the module-level style cache from the backend.
 * Called on extension init and whenever styles may have changed.
 */
export async function refreshStyleCache(): Promise<void> {
  const { getAllStyles } = await import("../../../src/api/lib");
  const styles = await getAllStyles();
  cachedStyles = new Map();
  buttonStyleIndices.clear();
  styles.forEach((style, index) => {
    cachedStyles.set(index, style);
    if (style.button) {
      buttonStyleIndices.add(index);
    }
  });
}

/**
 * Track the current selection for button interactions.
 */
export function setCurrentSelection(sel: Selection | null): void {
  currentSelection = sel;
}

/**
 * Get the current selection.
 */
export function getCurrentSelection(): Selection | null {
  return currentSelection;
}

// ============================================================================
// Style Interceptor - Suppress default text rendering for button cells
// ============================================================================

/**
 * Style interceptor that makes text invisible for button cells.
 * The button decoration draws the text itself with proper centering.
 */
export function buttonStyleInterceptor(
  _cellValue: string,
  baseStyle: BaseStyleInfo,
  _coords: CellCoords,
): IStyleOverride | null {
  const style = cachedStyles.get(baseStyle.styleIndex);
  if (!style || !style.button) {
    return null;
  }

  // Make text color fully transparent - the button decoration draws its own text
  return { textColor: "rgba(0,0,0,0)" };
}

// ============================================================================
// Cell Click Interceptor - Design mode vs. run mode
// ============================================================================

/**
 * Cell click interceptor for buttons.
 * - Design mode ON: let default selection happen (return false)
 * - Design mode OFF: execute the button's onSelect script (return true)
 */
export async function buttonClickInterceptor(
  row: number,
  col: number,
  _event: { clientX: number; clientY: number },
): Promise<boolean> {
  const { getCell } = await import("../../../src/api/lib");

  const cellData = await getCell(row, col);
  if (!cellData) return false;

  // Check if cell is a button
  const style = cachedStyles.get(cellData.styleIndex);
  if (!style || !style.button) return false;

  // Design mode: allow normal selection, don't intercept
  if (getDesignMode()) {
    return false;
  }

  // Run mode: execute the button's onSelect script
  await executeButtonAction(row, col);
  return true; // Consume the click
}

/**
 * Execute the button's associated script action.
 */
async function executeButtonAction(row: number, col: number): Promise<void> {
  const { getControlMetadata } = await import("../lib/controlApi");
  const { runScript } = await import("../../ScriptEditor/lib/scriptApi");
  const { getScript } = await import("../../ScriptEditor/lib/scriptApi");

  // Get the active sheet index
  const { getGridStateSnapshot } = await import("../../../src/api/grid");
  const gridState = getGridStateSnapshot();
  const sheetIndex = gridState?.config?.activeSheet ?? 0;

  const metadata = await getControlMetadata(sheetIndex, row, col);
  if (!metadata) return;

  const onSelect = metadata.properties["onSelect"];
  if (!onSelect || !onSelect.value) return;

  try {
    // The onSelect value is a script ID
    const script = await getScript(onSelect.value);
    if (script && script.source) {
      const result = await runScript(script.source, script.name || "button_script.js");

      if (result.type === "success" && result.cellsModified > 0) {
        // Refresh grid if cells were modified
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      } else if (result.type === "error") {
        console.error(`[Controls] Button script error: ${result.message}`);
      }
    }
  } catch (err) {
    console.error("[Controls] Failed to execute button script:", err);
  }
}

// ============================================================================
// Non-boolean Input Handler - Remove button when non-button content entered
// ============================================================================

/**
 * Handle cell value changes for button cells.
 * If a button cell is cleared (Delete key), remove the button formatting and metadata.
 */
export async function handleButtonCellChange(
  row: number,
  col: number,
  _oldValue: string | null,
  newValue: string | null,
): Promise<void> {
  const { getCell, applyFormatting } = await import("../../../src/api/lib");

  const cellData = await getCell(row, col);
  if (!cellData) return;

  const style = cachedStyles.get(cellData.styleIndex);
  if (!style || !style.button) return;

  // If the cell was cleared, remove button formatting and metadata
  if (newValue === null || newValue === "") {
    await applyFormatting([row], [col], { button: false });

    const { removeControlMetadata } = await import("../lib/controlApi");
    const { getGridStateSnapshot } = await import("../../../src/api/grid");
    const gridState = getGridStateSnapshot();
    const sheetIndex = gridState?.config?.activeSheet ?? 0;
    await removeControlMetadata(sheetIndex, row, col);

    await refreshStyleCache();
  }
}
