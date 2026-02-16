//! FILENAME: app/extensions/Table/handlers/selectionHandler.ts
// PURPOSE: Track selection context for the Table extension.
// CONTEXT: Shows/hides the contextual Table menu based on whether the
//          current selection is within a table region.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
} from "../../../src/api";
import { registerMenu } from "../../../src/api/ui";
import { getTableAtCell } from "../lib/tableStore";
import { buildTableMenu } from "./tableMenuBuilder";

// ============================================================================
// State
// ============================================================================

let currentTableId: number | null = null;
let lastCheckedSelection: { row: number; col: number } | null = null;

// ============================================================================
// Selection Handler
// ============================================================================

/**
 * Handle selection changes from the extension registry.
 * Checks if the active cell is within a table and shows/hides the Table menu.
 */
export function handleSelectionChange(
  selection: { endRow: number; endCol: number } | null,
): void {
  if (!selection) return;

  const row = selection.endRow;
  const col = selection.endCol;

  // Skip if already checked this cell
  if (
    lastCheckedSelection?.row === row &&
    lastCheckedSelection?.col === col
  ) {
    return;
  }
  lastCheckedSelection = { row, col };

  const table = getTableAtCell(row, col);

  if (table) {
    // Selection is within a table
    currentTableId = table.tableId;
    addTaskPaneContextKey("table");
    // Register menu as visible with current table's options
    registerMenu(buildTableMenu(table, false));
  } else {
    // Selection is outside any table
    if (currentTableId !== null) {
      currentTableId = null;
      removeTaskPaneContextKey("table");
      // Register menu as hidden
      registerMenu(buildTableMenu(null, true));
    }
  }
}

/**
 * Get the ID of the table the selection is currently within.
 */
export function getCurrentTableId(): number | null {
  return currentTableId;
}

/**
 * Reset all selection handler state (used during extension deactivation).
 */
export function resetSelectionHandlerState(): void {
  currentTableId = null;
  lastCheckedSelection = null;
}
