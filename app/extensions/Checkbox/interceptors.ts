//! FILENAME: app/extensions/Checkbox/interceptors.ts
// PURPOSE: Click, style, and keyboard interceptors for in-cell checkboxes.
// CONTEXT: Handles checkbox toggling via mouse clicks and Spacebar,
//          suppresses TRUE/FALSE text display for checkbox cells,
//          and handles non-boolean input and deletion.
//          A click toggles on the RELEASE on the checkbox's own cell, and a
//          press that slides off toggles nothing -- the Windows checkbox rule,
//          through the release seam the in-cell buttons use
//          (@api/cellClickInterceptors `actOnCellRelease`, held by Core's press
//          session; owner question 26, 2026-10-02).

import type { Selection, StyleData } from "@api";
import type { IStyleOverride, BaseStyleInfo, CellCoords } from "@api/styleInterceptors";
import { actOnCellRelease, type CellClickAnswer } from "@api/cellClickInterceptors";
import { showToast } from "@api/notifications";

// ============================================================================
// State
// ============================================================================

/** Module-level style cache, refreshed from getAllStyles() API calls. */
let cachedStyles: Map<number, StyleData> = new Map();
/** Set of style indices that have checkbox=true (for synchronous lookups). */
export const checkboxStyleIndices: Set<number> = new Set();
let currentSelection: Selection | null = null;

/**
 * Refresh the module-level style cache from the backend.
 * Called on extension init and whenever styles may have changed.
 */
export async function refreshStyleCache(): Promise<void> {
  const { getAllStyles } = await import("../../src/api/lib");
  const styles = await getAllStyles();
  cachedStyles = new Map();
  checkboxStyleIndices.clear();
  // getAllStyles() returns StyleData[] where array index = style index
  styles.forEach((style, index) => {
    cachedStyles.set(index, style);
    if (style.checkbox) {
      checkboxStyleIndices.add(index);
    }
  });
}

/**
 * Track the current selection for keyboard toggling.
 */
export function setCurrentSelection(sel: Selection | null): void {
  currentSelection = sel;
}

/**
 * Get the current selection (tracked via onSelectionChange).
 */
export function getCurrentSelection(): Selection | null {
  return currentSelection;
}

// ============================================================================
// Style Interceptor - Suppress TRUE/FALSE text for checkbox cells
// ============================================================================

/**
 * Style interceptor that makes text invisible for checkbox cells.
 * The checkbox graphic is drawn by the cell decoration instead.
 * Runs synchronously during render - uses the cached style data.
 */
export function checkboxStyleInterceptor(
  _cellValue: string,
  baseStyle: BaseStyleInfo,
  _coords: CellCoords
): IStyleOverride | null {
  const style = cachedStyles.get(baseStyle.styleIndex);
  if (!style || !style.checkbox) {
    return null;
  }

  // Make text color fully transparent to hide TRUE/FALSE text
  // The checkbox decoration draws the visual representation instead
  return { textColor: "rgba(0,0,0,0)" };
}

// ============================================================================
// Cell Click Interceptor - Toggle checkbox on click
// ============================================================================

/**
 * Check if a cell has checkbox formatting using the cached styles.
 */
function isCellCheckbox(styleIndex: number): boolean {
  const style = cachedStyles.get(styleIndex);
  return style?.checkbox === true;
}

/**
 * Check if a cell has checkbox formatting - async version that fetches fresh style data.
 */
async function isCellCheckboxAsync(styleIndex: number): Promise<boolean> {
  const { getStyle } = await import("../../src/api/lib");
  const style = await getStyle(styleIndex);
  return style?.checkbox === true;
}

/**
 * Cell click interceptor for checkbox toggling. A press on a checkbox cell is
 * CLAIMED for its release on that same cell (a release claim): the cell is
 * selected at the press -- the keyboard follows the press, as a Windows
 * checkbox takes the focus -- and the value flips only when the press is
 * released on the cell; a press that slides off flips nothing. Returns false
 * for a cell that is not a checkbox (Core selects it as before).
 */
export async function checkboxClickInterceptor(
  row: number,
  col: number,
  _event: { clientX: number; clientY: number },
): Promise<CellClickAnswer> {
  const { getCell } = await import("../../src/api/lib");
  const { dispatchGridAction } = await import("../../src/api/gridDispatch");
  const { setSelection } = await import("../../src/api/grid");

  // Get cell data to check if it has checkbox formatting
  const cellData = await getCell(row, col);
  if (!cellData) {
    return false;
  }

  // Use async check for fresh style data
  const isCheckbox = await isCellCheckboxAsync(cellData.styleIndex);
  if (!isCheckbox) {
    return false;
  }

  // Set selection to this cell at the press (so the user sees it selected)
  dispatchGridAction(setSelection({
    startRow: row,
    startCol: col,
    endRow: row,
    endCol: col,
    type: "cells",
  }));

  // Toggle at the RELEASE on this cell (Core holds the press; sliding off cancels).
  return actOnCellRelease(row, col, () => toggleCheckboxAt(row, col));
}

/**
 * The release of a press on a checkbox: flip the value the cell holds NOW
 * (TRUE -> FALSE; FALSE, empty or anything else -> TRUE), through the normal
 * (undoable) cell write. A cell that is no longer a checkbox is left alone.
 */
async function toggleCheckboxAt(row: number, col: number): Promise<void> {
  const { getCell, updateCell } = await import("../../src/api/lib");

  const cellData = await getCell(row, col);
  if (!cellData) {
    return;
  }
  if (!(await isCellCheckboxAsync(cellData.styleIndex))) {
    return;
  }

  // Toggle the value
  const currentDisplay = cellData.display?.toUpperCase() ?? "";
  let newValue: string;

  if (currentDisplay === "TRUE") {
    newValue = "FALSE";
  } else {
    // FALSE, empty (ghost), or any other value -> TRUE
    newValue = "TRUE";
  }

  // Update the cell value
  await updateCell(row, col, newValue);

  // Trigger renderer refresh so the checkbox graphic updates
  window.dispatchEvent(new CustomEvent("styles:refresh"));
}

// ============================================================================
// Keyboard Toggle - Spacebar handler
// ============================================================================

/**
 * Toggle checkboxes for the current selection via Spacebar.
 * Multi-cell behavior: reads active cell state and applies opposite to all.
 */
export async function toggleCheckboxesInSelection(): Promise<void> {
  const sel = currentSelection;
  if (!sel) return;

  const { getCell, updateCellsBatch } = await import("../../src/api/lib");

  // Determine the active cell (endRow, endCol is the active cell)
  const activeRow = sel.endRow;
  const activeCol = sel.endCol;
  const activeCellData = await getCell(activeRow, activeCol);

  if (!activeCellData) {
    return;
  }

  // Use async check for fresh data
  const isCheckbox = await isCellCheckboxAsync(activeCellData.styleIndex);
  if (!isCheckbox) {
    return; // Active cell doesn't have checkbox - do nothing
  }

  // Determine the new value: opposite of active cell
  const activeValue = activeCellData.display?.toUpperCase() ?? "";
  const newValue = activeValue === "TRUE" ? "FALSE" : "TRUE";

  // Collect all checkbox cells in the selection
  const minRow = Math.min(sel.startRow, sel.endRow);
  const maxRow = Math.max(sel.startRow, sel.endRow);
  const minCol = Math.min(sel.startCol, sel.endCol);
  const maxCol = Math.max(sel.startCol, sel.endCol);

  const updates: Array<{ row: number; col: number; value: string }> = [];

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      const cellData = await getCell(r, c);
      if (cellData) {
        const cb = await isCellCheckboxAsync(cellData.styleIndex);
        if (cb) {
          updates.push({ row: r, col: c, value: newValue });
        }
      }
    }
  }

  // Also check additional selection ranges
  if (sel.additionalRanges) {
    for (const range of sel.additionalRanges) {
      const rMin = Math.min(range.startRow, range.endRow);
      const rMax = Math.max(range.startRow, range.endRow);
      const cMin = Math.min(range.startCol, range.endCol);
      const cMax = Math.max(range.startCol, range.endCol);

      for (let r = rMin; r <= rMax; r++) {
        for (let c = cMin; c <= cMax; c++) {
          const cellData = await getCell(r, c);
          if (cellData) {
            const cb = await isCellCheckboxAsync(cellData.styleIndex);
            if (cb) {
              updates.push({ row: r, col: c, value: newValue });
            }
          }
        }
      }
    }
  }

  if (updates.length > 0) {
    try {
      await updateCellsBatch(updates);
    } catch (err) {
      // REFUSED -- a checkbox inside a pivot / report output region, or a
      // protected sheet. Say why, ONCE, with the backend's reason (it names
      // the cell); nothing changed, so nothing repaints. Never rethrown: the
      // doors that run checkbox.toggle (Space, a button bound to it) would
      // only drop the rejection or say it a second time (wave F, Z7).
      showToast(err instanceof Error ? err.message : String(err), { variant: "error" });
      return;
    }
    // Trigger renderer refresh so the checkbox graphics update
    window.dispatchEvent(new CustomEvent("styles:refresh"));
  }
}

// ============================================================================
// Non-boolean Input Handler - Remove checkbox when non-boolean is entered
// ============================================================================

/**
 * Handle cell value changes. If a checkbox cell receives a non-boolean value,
 * remove the checkbox formatting. If a checkbox cell is cleared (Delete),
 * also remove the checkbox formatting.
 */
export async function handleCellChange(
  row: number,
  col: number,
  _oldValue: string | null,
  newValue: string | null,
): Promise<void> {
  const { getCell, applyFormatting } = await import("../../src/api/lib");

  const cellData = await getCell(row, col);
  if (!cellData) return;

  const isCheckbox = await isCellCheckboxAsync(cellData.styleIndex);
  if (!isCheckbox) {
    return;
  }

  const upper = (newValue ?? "").toUpperCase().trim();

  // If the cell was cleared or received a non-boolean value, remove checkbox
  if (newValue === null || newValue === "") {
    // Cell was deleted/cleared -> remove checkbox formatting
    await applyFormatting([row], [col], { checkbox: false });
  } else if (upper !== "TRUE" && upper !== "FALSE") {
    // Non-boolean input -> remove checkbox formatting
    await applyFormatting([row], [col], { checkbox: false });
  }

  // Refresh style cache since formatting may have changed
  await refreshStyleCache();
}
