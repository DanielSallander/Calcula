//! FILENAME: app/extensions/Table/lib/tableStore.ts
// PURPOSE: In-memory table store for tracking table definitions.
// CONTEXT: Temporary frontend-only store. Will be replaced with backend API
//          calls (like pivot/lib/pivot-api.ts) when Rust table support is added.

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
}
