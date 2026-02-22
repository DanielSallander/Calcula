//! FILENAME: app/extensions/Table/lib/tableStore.ts
// PURPOSE: Table store backed by the Rust backend via Tauri commands.
// CONTEXT: All table state lives in the Rust backend. This module provides
//          async wrappers and keeps the grid overlay regions in sync.

import {
  removeGridRegionsByType,
  addGridRegions,
  type GridRegion,
} from "../../../src/api/gridOverlays";
import {
  createTable as backendCreateTable,
  deleteTable as backendDeleteTable,
  getTable as backendGetTable,
  getTableAtCell as backendGetTableAtCell,
  getAllTables as backendGetAllTables,
  updateTableStyle as backendUpdateTableStyle,
  toggleTotalsRow as backendToggleTotalsRow,
  resizeTable as backendResizeTable,
  convertToRange as backendConvertToRange,
  checkTableAutoExpand as backendCheckAutoExpand,
  enforceTableHeader as backendEnforceTableHeader,
  setCalculatedColumn as backendSetCalculatedColumn,
  type Table,
  type TableResult,
  type TableStyleOptions,
  type CreateTableParams,
} from "../../../src/api/backend";

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
export async function deleteTableAsync(tableId: number): Promise<boolean> {
  const result = await backendDeleteTable(tableId);
  if (result.success) {
    await refreshCache();
  }
  return result.success;
}

/**
 * Convert a table to a normal range via the backend.
 */
export async function convertToRangeAsync(tableId: number): Promise<boolean> {
  const result = await backendConvertToRange(tableId);
  if (result.success) {
    await refreshCache();
  }
  return result.success;
}

/**
 * Update table style options via the backend.
 */
export async function updateTableStyleAsync(
  tableId: number,
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
  tableId: number,
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
  tableId: number,
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
  tableId: number,
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
  tableId: number,
  columnName: string,
  formula: string,
): Promise<Table | null> {
  const result = await backendSetCalculatedColumn(tableId, columnName, formula);
  if (result.success && result.table) {
    await refreshCache();
    return result.table;
  }
  return null;
}

// ============================================================================
// Synchronous Accessors (read from local cache)
// ============================================================================

/**
 * Find the table at a given cell position (from cache).
 */
export function getTableAtCell(
  row: number,
  col: number,
  _sheetIndex?: number,
): Table | null {
  for (const table of cachedTables) {
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
export function getTableById(tableId: number): Table | null {
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
): { tableId: number; name: string } {
  // Fire-and-forget async call; return placeholder for legacy callers
  const placeholder = { tableId: -1, name: "Table" };
  createTableAsync(def).catch(console.error);
  return placeholder as any;
}

/**
 * @deprecated Use deleteTableAsync instead
 */
export function deleteTable(tableId: number): void {
  deleteTableAsync(tableId).catch(console.error);
}

/**
 * @deprecated Use updateTableStyleAsync instead
 */
export function updateTableOptions(
  tableId: number,
  options: Partial<TableStyleOptions>,
): void {
  updateTableStyleAsync(tableId, options).catch(console.error);
}

/**
 * @deprecated Use resizeTableAsync instead
 */
export function resizeTable(
  tableId: number,
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
    },
  }));

  if (regions.length > 0) {
    addGridRegions(regions);
  }
}
