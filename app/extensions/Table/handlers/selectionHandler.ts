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
  setColumnHeaderOverrideProvider,
  registerColumnHeaderClickInterceptor,
} from "../../../src/api";
import type { ColumnHeaderOverride, ColumnHeaderClickResult } from "../../../src/api";
import { getTableAtCell, getAllTables, type Table } from "../lib/tableStore";
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

/** Cleanup function for the column header override provider. */
let headerOverrideCleanup: (() => void) | null = null;

/** Cleanup function for the column header click interceptor. */
let clickInterceptorCleanup: (() => void) | null = null;

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

    // Set column header override provider to show table field names
    // when the header row scrolls above the viewport
    setTableHeaderOverride(table);

    // Broadcast current table state to the ribbon tab
    emitAppEvent(TableEvents.TABLE_STATE, { table });
  } else {
    // Selection is outside any table
    if (currentTableId !== null) {
      currentTableId = null;
      removeTaskPaneContextKey("table");

      // Clear column header overrides
      clearTableHeaderOverride();

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
 * Set the column header override provider for the given table.
 * When the table's header row scrolls above the viewport, the column letters
 * are replaced with the table's field names (like Excel).
 */
function setTableHeaderOverride(table: Table): void {
  // Clean up previous provider
  if (headerOverrideCleanup) {
    headerOverrideCleanup();
  }

  headerOverrideCleanup = setColumnHeaderOverrideProvider(
    (col: number, viewportStartRow: number): ColumnHeaderOverride | null => {
      // Only override columns within the table range
      if (col < table.startCol || col > table.endCol) return null;

      // Only show field names when the header row has scrolled above the viewport
      if (!table.styleOptions.headerRow) return null;
      if (table.startRow >= viewportStartRow) return null;

      const colIdx = col - table.startCol;
      const column = table.columns[colIdx];
      if (!column) return null;

      return {
        text: column.name,
        showFilterButton: table.styleOptions.showFilterButton,
      };
    },
  );
}

/**
 * Clear the column header override provider.
 */
function clearTableHeaderOverride(): void {
  if (headerOverrideCleanup) {
    headerOverrideCleanup();
    headerOverrideCleanup = null;
  }
}

// ============================================================================
// Column Header Click Interceptor
// ============================================================================

/** Size of the filter button in column headers (must match headers.ts constants) */
const FILTER_BUTTON_SIZE = 10;
const FILTER_BUTTON_MARGIN = 3;

/**
 * Column header click interceptor.
 * Handles two behaviors:
 * 1. Filter button clicks: opens the AutoFilter dropdown
 * 2. Table-scoped column selection: selects only the table's data rows
 */
function tableColumnHeaderClickInterceptor(
  col: number,
  canvasX: number,
  _canvasY: number,
  colX: number,
  colWidth: number,
  _colHeaderHeight: number,
): ColumnHeaderClickResult | null {
  // Find if this column belongs to any table with the current selection inside
  const table = currentTableId !== null
    ? getAllTables().find((t) => t.id === currentTableId)
    : null;

  if (!table) return null;
  if (col < table.startCol || col > table.endCol) return null;

  // Check if click is on the filter button area (right side of header cell)
  const filterBtnLeft = colX + colWidth - FILTER_BUTTON_SIZE - FILTER_BUTTON_MARGIN * 2;
  if (
    table.styleOptions.showFilterButton &&
    canvasX >= filterBtnLeft &&
    canvasX <= colX + colWidth
  ) {
    // Dispatch event for AutoFilter extension to open its dropdown
    window.dispatchEvent(
      new CustomEvent("table:filterHeaderClick", { detail: { col } }),
    );
    return { handled: true };
  }

  // Table-scoped column selection: select only the table's data rows
  const dataStartRow = table.styleOptions.headerRow
    ? table.startRow + 1
    : table.startRow;
  const dataEndRow = table.styleOptions.totalRow
    ? table.endRow - 1
    : table.endRow;

  return {
    handled: false,
    selectionOverride: { startRow: dataStartRow, endRow: dataEndRow },
  };
}

/**
 * Initialize the column header click interceptor.
 * Should be called during extension activation.
 * @returns Cleanup function.
 */
export function initClickInterceptor(): () => void {
  clickInterceptorCleanup = registerColumnHeaderClickInterceptor(
    tableColumnHeaderClickInterceptor,
  );
  return () => {
    if (clickInterceptorCleanup) {
      clickInterceptorCleanup();
      clickInterceptorCleanup = null;
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
  clearTableHeaderOverride();
  if (clickInterceptorCleanup) {
    clickInterceptorCleanup();
    clickInterceptorCleanup = null;
  }
  if (designTabRegistered) {
    ExtensionRegistry.unregisterRibbonTab(TABLE_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
  if (requestStateCleanup) {
    requestStateCleanup();
    requestStateCleanup = null;
  }
}
