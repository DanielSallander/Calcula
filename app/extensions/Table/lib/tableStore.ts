//! FILENAME: app/extensions/Table/lib/tableStore.ts
// PURPOSE: In-memory table store for tracking table definitions.
// CONTEXT: Temporary frontend-only store. Will be replaced with backend API
//          calls (like pivot/lib/pivot-api.ts) when Rust table support is added.

import {
  removeGridRegionsByType,
  addGridRegions,
  type GridRegion,
} from "../../../src/api/gridOverlays";

// ============================================================================
// Types
// ============================================================================

export interface TableOptions {
  headerRow: boolean;
  totalRow: boolean;
  bandedRows: boolean;
  bandedColumns: boolean;
  firstColumn: boolean;
  lastColumn: boolean;
}

export interface TableDefinition {
  /** Unique table ID */
  tableId: number;
  /** Table name (e.g., "Table1") */
  name: string;
  /** Sheet index where the table lives */
  sheetIndex: number;
  /** Table region (0-indexed, inclusive) */
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Whether the first row is a header row */
  hasHeaders: boolean;
  /** Display options */
  options: TableOptions;
}

// ============================================================================
// Store State
// ============================================================================

let nextTableId = 1;
let tables: TableDefinition[] = [];

// ============================================================================
// Store Operations
// ============================================================================

/**
 * Create a new table and add it to the store.
 * Returns the created table definition.
 */
export function createTable(
  def: Omit<TableDefinition, "tableId" | "name" | "options">,
): TableDefinition {
  const id = nextTableId++;
  const name = `Table${id}`;
  const table: TableDefinition = {
    ...def,
    tableId: id,
    name,
    options: {
      headerRow: def.hasHeaders,
      totalRow: false,
      bandedRows: true,
      bandedColumns: false,
      firstColumn: false,
      lastColumn: false,
    },
  };
  tables.push(table);
  return table;
}

/**
 * Find the table at a given cell position.
 * Returns null if no table contains the cell.
 */
export function getTableAtCell(
  row: number,
  col: number,
  sheetIndex?: number,
): TableDefinition | null {
  for (const table of tables) {
    if (
      (sheetIndex === undefined || table.sheetIndex === sheetIndex) &&
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
 * Find a table by its ID.
 */
export function getTableById(tableId: number): TableDefinition | null {
  return tables.find((t) => t.tableId === tableId) ?? null;
}

/**
 * Get all table definitions.
 */
export function getAllTables(): TableDefinition[] {
  return [...tables];
}

/**
 * Update display options for a table.
 */
export function updateTableOptions(
  tableId: number,
  options: Partial<TableOptions>,
): void {
  const table = tables.find((t) => t.tableId === tableId);
  if (table) {
    table.options = { ...table.options, ...options };
  }
}

/**
 * Delete a table from the store.
 */
export function deleteTable(tableId: number): void {
  tables = tables.filter((t) => t.tableId !== tableId);
}

/**
 * Resize a table's region.
 */
export function resizeTable(
  tableId: number,
  endRow: number,
  endCol: number,
): void {
  const table = tables.find((t) => t.tableId === tableId);
  if (table) {
    table.endRow = endRow;
    table.endCol = endCol;
  }
}

/**
 * Reset the entire table store (used during extension deactivation).
 */
export function resetTableStore(): void {
  tables = [];
  nextTableId = 1;
  removeGridRegionsByType("table");
}

// ============================================================================
// Structural Change Handlers
// ============================================================================

/**
 * Shift table boundaries when rows are inserted.
 * Tables entirely below the insertion point are shifted down.
 * Tables spanning the insertion point (including at startRow) expand.
 */
export function shiftTablesForRowInsert(fromRow: number, count: number): void {
  for (const table of tables) {
    if (table.startRow > fromRow) {
      // Insertion is strictly before the table - shift entire table down
      table.startRow += count;
      table.endRow += count;
    } else if (table.endRow >= fromRow) {
      // Insertion is inside the table (including at startRow) - expand
      table.endRow += count;
    }
  }
}

/**
 * Shift table boundaries when columns are inserted.
 * Tables entirely to the right of the insertion point are shifted right.
 * Tables spanning the insertion point (including at startCol) expand.
 */
export function shiftTablesForColInsert(fromCol: number, count: number): void {
  for (const table of tables) {
    if (table.startCol > fromCol) {
      // Insertion is strictly before the table - shift entire table right
      table.startCol += count;
      table.endCol += count;
    } else if (table.endCol >= fromCol) {
      // Insertion is inside the table (including at startCol) - expand
      table.endCol += count;
    }
  }
}

/**
 * Shift table boundaries when rows are deleted.
 * Tables fully within the deleted range are removed.
 */
export function shiftTablesForRowDelete(fromRow: number, count: number): void {
  const deleteEnd = fromRow + count;

  // Remove tables fully within the deleted range
  tables = tables.filter(
    (t) => !(t.startRow >= fromRow && t.endRow < deleteEnd),
  );

  // Shift remaining table boundaries
  for (const table of tables) {
    if (table.startRow >= deleteEnd) {
      // Entire table is below deleted range - shift up
      table.startRow -= count;
      table.endRow -= count;
    } else if (table.startRow >= fromRow) {
      // Table starts within deleted range but extends beyond - shrink from top
      table.startRow = fromRow;
      table.endRow -= count;
    } else if (table.endRow >= deleteEnd) {
      // Table spans entire deleted range - shrink
      table.endRow -= count;
    } else if (table.endRow >= fromRow) {
      // Table end is within deleted range - shrink from bottom
      table.endRow = Math.max(fromRow - 1, table.startRow);
    }
  }
}

/**
 * Shift table boundaries when columns are deleted.
 * Tables fully within the deleted range are removed.
 */
export function shiftTablesForColDelete(fromCol: number, count: number): void {
  const deleteEnd = fromCol + count;

  // Remove tables fully within the deleted range
  tables = tables.filter(
    (t) => !(t.startCol >= fromCol && t.endCol < deleteEnd),
  );

  // Shift remaining table boundaries
  for (const table of tables) {
    if (table.startCol >= deleteEnd) {
      // Entire table is right of deleted range - shift left
      table.startCol -= count;
      table.endCol -= count;
    } else if (table.startCol >= fromCol) {
      // Table starts within deleted range but extends beyond - shrink from left
      table.startCol = fromCol;
      table.endCol -= count;
    } else if (table.endCol >= deleteEnd) {
      // Table spans entire deleted range - shrink
      table.endCol -= count;
    } else if (table.endCol >= fromCol) {
      // Table end is within deleted range - shrink from right
      table.endCol = Math.max(fromCol - 1, table.startCol);
    }
  }
}

// ============================================================================
// Grid Overlay Sync
// ============================================================================

/**
 * Sync all table definitions to the grid overlay system.
 * Call this after any mutation (create, resize, delete, options change)
 * so the canvas renders table borders correctly.
 */
export function syncTableRegions(): void {
  // Remove old table overlay regions
  removeGridRegionsByType("table");

  // Convert all tables to grid regions
  const regions: GridRegion[] = tables.map((table) => ({
    id: `table-${table.tableId}`,
    type: "table",
    startRow: table.startRow,
    startCol: table.startCol,
    endRow: table.endRow,
    endCol: table.endCol,
    data: {
      tableId: table.tableId,
      name: table.name,
      hasHeaders: table.hasHeaders,
    },
  }));

  if (regions.length > 0) {
    addGridRegions(regions);
  }
}
