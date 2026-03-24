//! FILENAME: app/extensions/Table/handlers/selectionHandler.ts
// PURPOSE: Track selection context for the Table extension.
// CONTEXT: Shows/hides the contextual Table Design ribbon tab based on whether
//          the current selection is within a table region.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  ExtensionRegistry,
  emitAppEvent,
  onAppEvent,
} from "../../../src/api";
import { getTableAtCell } from "../lib/tableStore";
import { TableDesignTabDefinition, TABLE_DESIGN_TAB_ID } from "../manifest";
import { TableEvents } from "../lib/tableEvents";

// ============================================================================
// State
// ============================================================================

let currentTableId: number | null = null;
let lastCheckedSelection: { row: number; col: number } | null = null;

/** Whether the contextual table ribbon tab is currently registered. */
let designTabRegistered = false;

/** Cleanup function for the TABLE_REQUEST_STATE listener. */
let requestStateCleanup: (() => void) | null = null;

// ============================================================================
// Selection Handler
// ============================================================================

/**
 * Handle selection changes from the extension registry.
 * Checks if the active cell is within a table and shows/hides the Table Design ribbon tab.
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
    currentTableId = table.id;
    addTaskPaneContextKey("table");

    // Register the contextual ribbon tab if not already registered
    if (!designTabRegistered) {
      ExtensionRegistry.registerRibbonTab(TableDesignTabDefinition);
      designTabRegistered = true;
    }

    // Broadcast current table state to the ribbon tab
    emitAppEvent(TableEvents.TABLE_STATE, { table });
  } else {
    // Selection is outside any table
    if (currentTableId !== null) {
      currentTableId = null;
      removeTaskPaneContextKey("table");

      // Unregister the contextual ribbon tab
      if (designTabRegistered) {
        ExtensionRegistry.unregisterRibbonTab(TABLE_DESIGN_TAB_ID);
        designTabRegistered = false;
      }

      // Notify the ribbon tab that the table is deselected
      window.dispatchEvent(new Event("table:deselected"));
    }
  }
}

/**
 * Ensure the contextual table ribbon tab is registered.
 * Called after table creation so the tab appears immediately.
 */
export function ensureDesignTabRegistered(): void {
  if (!designTabRegistered) {
    ExtensionRegistry.registerRibbonTab(TableDesignTabDefinition);
    designTabRegistered = true;
  }
}

/**
 * Initialize the state request listener.
 * The ribbon tab can request the current table state when it mounts
 * (e.g. user switches tabs and comes back).
 */
export function initRequestStateListener(): () => void {
  requestStateCleanup = onAppEvent(TableEvents.TABLE_REQUEST_STATE, () => {
    if (currentTableId !== null) {
      const table = getTableAtCell(
        lastCheckedSelection?.row ?? 0,
        lastCheckedSelection?.col ?? 0,
      );
      if (table) {
        emitAppEvent(TableEvents.TABLE_STATE, { table });
      }
    }
  });
  return () => {
    if (requestStateCleanup) {
      requestStateCleanup();
      requestStateCleanup = null;
    }
  };
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
  if (designTabRegistered) {
    ExtensionRegistry.unregisterRibbonTab(TABLE_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
  if (requestStateCleanup) {
    requestStateCleanup();
    requestStateCleanup = null;
  }
}
