//! FILENAME: app/src/core/state/sheetGrouping.ts
// PURPOSE: Global state for multi-sheet selection (sheet grouping).
// CONTEXT: When the user Ctrl+clicks sheet tabs, multiple sheets become "grouped".
// Any editing or formatting action on the active sheet is replicated to all grouped sheets.
// Uses module-level variables for synchronous access (same pattern as globalIsEditing).

/**
 * The set of currently selected (grouped) sheet indices.
 * Always includes the active sheet index when grouping is active.
 * When empty or containing only one sheet, grouping is inactive.
 */
let selectedSheetIndices: number[] = [];

/**
 * Get the currently selected (grouped) sheet indices.
 * Returns an empty array when no multi-selection is active.
 */
export function getSelectedSheetIndices(): number[] {
  return selectedSheetIndices;
}

/**
 * Set the selected (grouped) sheet indices.
 * Pass an empty array or single-element array to clear grouping.
 */
export function setSelectedSheetIndices(indices: number[]): void {
  selectedSheetIndices = [...indices].sort((a, b) => a - b);
}

/**
 * Check if sheet grouping is active (more than one sheet selected).
 */
export function isSheetGroupingActive(): boolean {
  return selectedSheetIndices.length > 1;
}

/**
 * Get the non-active grouped sheet indices (for replication).
 * Returns only the sheets that are NOT the active sheet.
 */
export function getGroupedSheetIndices(activeSheetIndex: number): number[] {
  return selectedSheetIndices.filter(i => i !== activeSheetIndex);
}

/**
 * Clear sheet grouping (deselect all except active).
 */
export function clearSheetGrouping(): void {
  selectedSheetIndices = [];
}

/**
 * Toggle a sheet in the selection.
 * If already selected, removes it. If not, adds it.
 * Always ensures the active sheet remains in the selection.
 */
export function toggleSheetInGroup(
  sheetIndex: number,
  activeSheetIndex: number
): number[] {
  const idx = selectedSheetIndices.indexOf(sheetIndex);
  if (idx >= 0) {
    // Don't allow removing the active sheet
    if (sheetIndex === activeSheetIndex) {
      return selectedSheetIndices;
    }
    selectedSheetIndices = selectedSheetIndices.filter(i => i !== sheetIndex);
  } else {
    // If grouping wasn't active, start it with both active and clicked sheet
    if (selectedSheetIndices.length <= 1) {
      selectedSheetIndices = [activeSheetIndex, sheetIndex].sort((a, b) => a - b);
    } else {
      selectedSheetIndices = [...selectedSheetIndices, sheetIndex].sort((a, b) => a - b);
    }
  }
  return selectedSheetIndices;
}
