//! FILENAME: app/extensions/Table/lib/tableStore.ts
// PURPOSE: Table store backed by the Rust backend via Tauri commands.
// CONTEXT: All table state lives in the Rust backend. This module provides
//          async wrappers and keeps the grid overlay regions in sync.

import {
  removeGridRegionsByType,
  addGridRegions,
  type GridRegion,
} from "@api/gridOverlays";
import {
  createTable as backendCreateTable,
  deleteTable as backendDeleteTable,
  getTable as backendGetTable,
  getTableAtCell as backendGetTableAtCell,
  getAllTables as backendGetAllTables,
  updateTableStyle as backendUpdateTableStyle,
  toggleTotalsRow as backendToggleTotalsRow,
  resizeTable as backendResizeTable,
  renameTable as backendRenameTable,
  convertToRange as backendConvertToRange,
  checkTableAutoExpand as backendCheckAutoExpand,
  enforceTableHeader as backendEnforceTableHeader,
  setCalculatedColumn as backendSetCalculatedColumn,
  convertFormulaToTableRefs as backendConvertFormulaToTableRefs,
  type Table,
  type TableResult,
  type TableStyleOptions,
  type CreateTableParams,
} from "@api/backend";
import { cellEvents } from "@api";
import { emitAppEvent, AppEvents } from "@api/events";
import { tableSelectionScope } from "./tableBands";

/**
 * Announce that the set of TABLES changed, and that the change cascaded into
 * other object stores (§3bn).
 *
 * THE CASCADE HALF. Deleting a table deletes the slicers bound to it,
 * backend-side. The Slicer extension holds its own cache and its overlay claims
 * a rectangle on the grid, so without this the removed slicer keeps PAINTING and
 * keeps swallowing every click that lands on it -- which is exactly the symptom
 * that turned the orphan into a 120 s click-retry timeout in the invariant
 * runner.
 *
 * THE OWN-DOMAIN HALF, and why it is here rather than at the call sites
 * (BUG-0051). `objects` is the Table's OWN domain, and this announcement used
 * to leave it out on the reasoning that a route which re-reads its own cache
 * needs no announcement for itself. That reasoning covers the CACHE and nothing
 * else. The contextual "Table Design" tab is not the cache: it is re-derived by
 * `syncDesignTabToTables`, which runs on TABLE_DEFINITIONS_UPDATED -- an event
 * the `objects` domain dispatches and that nothing else in the delete path
 * does. So the store deleted the last table, refreshed its own cache to empty,
 * and the ribbon went on offering a tab whose every button addressed an object
 * that no longer existed. Two callers papered over it by emitting
 * TABLE_DEFINITIONS_UPDATED by hand after awaiting the store; every other
 * caller (a script, an MCP tool, the E2E walker) got the ghost. The announcement
 * belongs to the mutation, not to the button that happened to start it, so the
 * hand-written emits are gone and this is the one announcer.
 *
 * A domain announcement rather than a feature event: the Shell translator owns
 * the mapping from "slicer" to "slicers:refresh" and from "objects" to
 * TABLE_DEFINITIONS_UPDATED, and an extension naming another extension's event
 * would be the seam violation the domains exist to prevent. Emitted
 * unconditionally -- a refresh with nothing to refresh is a cache re-read, while
 * a missed one is a ghost control.
 */
function announceTableObjectChange(): void {
  emitAppEvent(AppEvents.MUTATION_REFRESH, {
    domains: ["objects", "slicer", "ribbonFilter"],
    source: "commit",
  });
}

// Re-export backend types for consumers
export type { Table, TableResult, TableStyleOptions };

// ============================================================================
// Legacy type alias (for gradual migration of callers)
// ============================================================================

/**
 * TableDefinition is now just the backend Table type.
 * Kept as an alias for backwards compatibility with existing handlers.
 */
export type TableDefinition = Table;

/**
 * TableOptions maps to the backend TableStyleOptions.
 */
export type TableOptions = TableStyleOptions;

// ============================================================================
// Cache (local mirror of backend state for sync operations)
// ============================================================================

let cachedTables: Table[] = [];

// ============================================================================
// Store Operations (async, backed by Rust)
// ============================================================================

/**
 * Create a new table via the backend.
 * The backend reads header text from the grid and enforces uniqueness.
 */
export async function createTableAsync(params: {
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  hasHeaders: boolean;
}): Promise<Table | null> {
  const createParams: CreateTableParams = {
    name: "", // Empty = auto-generate
    startRow: params.startRow,
    startCol: params.startCol,
    endRow: params.endRow,
    endCol: params.endCol,
    hasHeaders: params.hasHeaders,
  };
  const result = await backendCreateTable(createParams);
  if (result.success && result.table) {
    await refreshCache();
    return result.table;
  }
  console.error("[TableStore] create failed:", result.error);
  return null;
}

/**
 * Delete a table via the backend.
 */
export async function deleteTableAsync(tableId: string): Promise<boolean> {
  const result = await backendDeleteTable(tableId);
  if (result.success) {
    await refreshCache();
    announceTableObjectChange();
  }
  return result.success;
}

/**
 * Rename a table via the backend.
 *
 * Returns the backend's error message on failure (duplicate name, invalid
 * identifier) so the caller can surface it — a rename that silently does
 * nothing is worse than one that explains itself.
 */
export async function renameTableAsync(
  tableId: string,
  newName: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await backendRenameTable(tableId, newName);
  if (result.success) {
    await refreshCache();
    return { ok: true };
  }
  return { ok: false, error: result.error ?? "Rename failed" };
}

/**
 * Convert a table to a normal range via the backend.
 */
export async function convertToRangeAsync(tableId: string): Promise<boolean> {
  const result = await backendConvertToRange(tableId);
  if (result.success) {
    await refreshCache();
    // Convert to Range destroys the table object, so it carries the identical
    // cascade to a delete -- including the slicers Excel removes with it, and
    // the contextual tab that must stop offering to restyle it.
    announceTableObjectChange();
  }
  return result.success;
}

/**
 * Update table style options via the backend.
 */
export async function updateTableStyleAsync(
  tableId: string,
  options: Partial<TableStyleOptions>,
): Promise<Table | null> {
  // Merge with current options
  const table = cachedTables.find((t) => t.id === tableId);
  if (!table) return null;

  const merged: TableStyleOptions = { ...table.styleOptions, ...options };
  const result = await backendUpdateTableStyle({
    tableId,
    styleOptions: merged,
  });
  if (result.success && result.table) {
    await refreshCache();
    return result.table;
  }
  return null;
}

/**
 * Toggle the totals row via the backend.
 */
export async function toggleTotalsRowAsync(
  tableId: string,
  show: boolean,
): Promise<Table | null> {
  const result = await backendToggleTotalsRow(tableId, show);
  if (result.success && result.table) {
    await refreshCache();
    return result.table;
  }
  return null;
}

/**
 * Resize a table via the backend.
 */
export async function resizeTableAsync(
  tableId: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<boolean> {
  const result = await backendResizeTable({
    tableId,
    startRow,
    startCol,
    endRow,
    endCol,
  });
  if (result.success) {
    await refreshCache();
  }
  return result.success;
}

/**
 * Check if a cell edit should trigger table auto-expansion.
 * Returns the expanded table if expansion occurred.
 */
export async function checkAutoExpand(
  row: number,
  col: number,
): Promise<Table | null> {
  const expanded = await backendCheckAutoExpand(row, col);
  if (expanded) {
    await refreshCache();
  }
  return expanded;
}

/**
 * Enforce header uniqueness after user edits a header cell.
 */
export async function enforceHeaderAsync(
  tableId: string,
  columnIndex: number,
  newValue: string,
): Promise<Table | null> {
  const result = await backendEnforceTableHeader(tableId, columnIndex, newValue);
  if (result.success && result.table) {
    await refreshCache();
    return result.table;
  }
  return null;
}

/**
 * Set a calculated column formula that auto-fills to all data rows.
 */
export async function setCalculatedColumnAsync(
  tableId: string,
  columnName: string,
  formula: string,
): Promise<Table | null> {
  const result = await backendSetCalculatedColumn(tableId, columnName, formula);
  if (result.success && result.table) {
    // Push computed cell values directly into the canvas via cellEvents.
    // This bypasses the viewport re-fetch and immediately shows the values,
    // matching what "Calculate Sheets" does.
    if (result.computedCells) {
      for (const cell of result.computedCells) {
        cellEvents.emit({
          row: cell.row,
          col: cell.col,
          oldValue: undefined,
          newValue: cell.display,
          formula: cell.formula ?? null,
        });
      }
    }
    await refreshCache();
    return result.table;
  }
  return null;
}

/**
 * Convert cell references in a formula to structured table references.
 * Same-row cell references within the table range become [@ColumnName] syntax.
 */
export async function convertFormulaToTableRefsAsync(
  tableId: string,
  formula: string,
  formulaRow: number,
): Promise<string> {
  try {
    return await backendConvertFormulaToTableRefs(tableId, formula, formulaRow);
  } catch (err) {
    console.error("[TableStore] convertFormulaToTableRefs failed:", err);
    return formula; // Return original formula on error
  }
}

// ============================================================================
// Synchronous Accessors (read from local cache)
// ============================================================================

/**
 * Find the table at a given cell position (from cache).
 * If sheetIndex is provided, only tables on that sheet are considered.
 */
export function getTableAtCell(
  row: number,
  col: number,
  sheetIndex?: number,
): Table | null {
  for (const table of cachedTables) {
    if (sheetIndex !== undefined && table.sheetIndex !== sheetIndex) {
      continue;
    }
    if (
      row >= table.startRow &&
      row <= table.endRow &&
      col >= table.startCol &&
      col <= table.endCol
    ) {
      return table;
    }
  }
  return null;
}

/**
 * Find a table by its ID (from cache).
 */
export function getTableById(tableId: string): Table | null {
  return cachedTables.find((t) => t.id === tableId) ?? null;
}

/**
 * Get all table definitions (from cache).
 */
export function getAllTables(): Table[] {
  return [...cachedTables];
}

// ============================================================================
// Legacy synchronous wrappers (deprecated - use async versions)
// ============================================================================

/**
 * @deprecated Use createTableAsync instead
 */
export function createTable(
  def: { sheetIndex: number; startRow: number; startCol: number; endRow: number; endCol: number; hasHeaders: boolean },
): { tableId: string; name: string } {
  // Fire-and-forget async call; return placeholder for legacy callers
  const placeholder = { tableId: "", name: "Table" };
  createTableAsync(def).catch(console.error);
  return placeholder as any;
}

/**
 * @deprecated Use deleteTableAsync instead
 */
export function deleteTable(tableId: string): void {
  deleteTableAsync(tableId).catch(console.error);
}

/**
 * @deprecated Use updateTableStyleAsync instead
 */
export function updateTableOptions(
  tableId: string,
  options: Partial<TableStyleOptions>,
): void {
  updateTableStyleAsync(tableId, options).catch(console.error);
}

/**
 * @deprecated Use resizeTableAsync instead
 */
export function resizeTable(
  tableId: string,
  endRow: number,
  endCol: number,
): void {
  const table = cachedTables.find((t) => t.id === tableId);
  if (table) {
    resizeTableAsync(tableId, table.startRow, table.startCol, endRow, endCol).catch(console.error);
  }
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Refresh the local cache from the backend and sync overlay regions.
 */
export async function refreshCache(): Promise<void> {
  try {
    cachedTables = await backendGetAllTables();
  } catch (err) {
    console.error("[TableStore] Failed to refresh cache:", err);
    cachedTables = [];
  }
  syncTableRegions();
}

/**
 * Reset the store (used during extension deactivation).
 */
export function resetTableStore(): void {
  cachedTables = [];
  removeGridRegionsByType("table");
}

// ============================================================================
// Structural Change Handlers
// ============================================================================

// Structural changes (row/col insert/delete) are handled by the backend
// via resize_table calls. The frontend just needs to refresh the cache.

/**
 * Refresh cache after rows are inserted.
 * The backend is the source of truth for table boundaries.
 */
export function shiftTablesForRowInsert(_fromRow: number, _count: number): void {
  refreshCache().catch(console.error);
}

/**
 * Refresh cache after columns are inserted.
 */
export function shiftTablesForColInsert(_fromCol: number, _count: number): void {
  refreshCache().catch(console.error);
}

/**
 * Refresh cache after rows are deleted.
 */
export function shiftTablesForRowDelete(_fromRow: number, _count: number): void {
  refreshCache().catch(console.error);
}

/**
 * Refresh cache after columns are deleted.
 */
export function shiftTablesForColDelete(_fromCol: number, _count: number): void {
  refreshCache().catch(console.error);
}

// ============================================================================
// Grid Overlay Sync
// ============================================================================

/**
 * Sync all table definitions to the grid overlay system.
 * Call this after any mutation so the canvas renders table borders correctly.
 */
export function syncTableRegions(): void {
  // Remove old table overlay regions
  removeGridRegionsByType("table");

  // Convert all cached tables to grid regions
  const regions: GridRegion[] = cachedTables.map((table) => ({
    id: `table-${table.id}`,
    type: "table",
    startRow: table.startRow,
    startCol: table.startCol,
    endRow: table.endRow,
    endCol: table.endCol,
    data: {
      tableId: table.id,
      name: table.name,
      hasHeaders: table.styleOptions.headerRow,
      columns: table.columns,
      styleOptions: table.styleOptions,
      // What Ctrl+Space / Shift+Space / Ctrl+A should select inside this table.
      // The grid keyboard used to select the whole SHEET for all four gestures,
      // whether or not the cursor sat in a table, because nothing on this side
      // of the boundary ever told it a table was there. It reads this off the
      // region rather than asking what kind of object the region is — the
      // owner says WHAT the gesture selects, Core decides nothing about tables.
      selectionScope: tableSelectionScope(table),
    },
  }));

  if (regions.length > 0) {
    addGridRegions(regions);
  }
}
