//! FILENAME: app/extensions/Table/lib/tableStore-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for table store pure logic.
// CONTEXT: Tests style interceptor banding, getTableAtCell, structured reference parsing.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline types and logic (avoids Tauri import mocking)
// ============================================================================

interface TableStyleOptions {
  bandedRows: boolean;
  bandedColumns: boolean;
  headerRow: boolean;
  totalRow: boolean;
  firstColumn: boolean;
  lastColumn: boolean;
  showFilterButton: boolean;
}

interface Table {
  id: number;
  name: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  styleOptions: TableStyleOptions;
}

interface StyleOverride {
  backgroundColor?: string;
  textColor?: string;
  bold?: boolean;
}

const HEADER_BG = "#4472C4";
const HEADER_TEXT = "#FFFFFF";
const BAND_EVEN_BG = "#D9E2F3";
const TOTAL_BG = "#D9E2F3";

/** Pure style interceptor logic (extracted from tableStyleInterceptor.ts). */
function computeTableStyle(
  table: Table,
  row: number,
  col: number,
): StyleOverride | null {
  const opts = table.styleOptions;

  if (opts.headerRow && row === table.startRow) {
    return { backgroundColor: HEADER_BG, textColor: HEADER_TEXT, bold: true };
  }

  if (opts.totalRow && row === table.endRow) {
    return { backgroundColor: TOTAL_BG, bold: true };
  }

  const dataStartRow = opts.headerRow ? table.startRow + 1 : table.startRow;
  const dataEndRow = opts.totalRow ? table.endRow - 1 : table.endRow;

  if (row >= dataStartRow && row <= dataEndRow) {
    const override: StyleOverride = {};
    let hasOverride = false;

    if (opts.bandedRows) {
      const dataRowIndex = row - dataStartRow;
      if (dataRowIndex % 2 === 0) {
        override.backgroundColor = BAND_EVEN_BG;
        hasOverride = true;
      }
    }

    if (opts.bandedColumns) {
      const colIndex = col - table.startCol;
      if (colIndex % 2 === 0) {
        if (!override.backgroundColor) {
          override.backgroundColor = BAND_EVEN_BG;
          hasOverride = true;
        }
      }
    }

    if (opts.firstColumn && col === table.startCol) {
      override.bold = true;
      hasOverride = true;
    }

    if (opts.lastColumn && col === table.endCol) {
      override.bold = true;
      hasOverride = true;
    }

    return hasOverride ? override : null;
  }

  return null;
}

/** Pure getTableAtCell logic. */
function getTableAtCell(tables: Table[], row: number, col: number, sheetIndex?: number): Table | null {
  for (const table of tables) {
    if (sheetIndex !== undefined && table.sheetIndex !== sheetIndex) continue;
    if (row >= table.startRow && row <= table.endRow && col >= table.startCol && col <= table.endCol) {
      return table;
    }
  }
  return null;
}

/** Parse a structured reference like Table1[Column1] or Table1[[#Headers],[Column1]]. */
interface StructuredRef {
  tableName: string;
  specifier: string | null; // #All, #Data, #Headers, #Totals, #This Row
  columnName: string | null;
}

function parseStructuredReference(ref: string): StructuredRef | null {
  // Table1[@Column1] (this-row shorthand) - check before simple
  const thisRow = ref.match(/^(\w+)\[@([^\]]+)\]$/);
  if (thisRow) {
    return { tableName: thisRow[1], specifier: "#This Row", columnName: thisRow[2] };
  }
  // Table1[Column1]
  const simple = ref.match(/^(\w+)\[([^\[\]#@]+)\]$/);
  if (simple) {
    return { tableName: simple[1], specifier: null, columnName: simple[2] };
  }
  // Table1[[#Specifier],[Column1]]
  const withSpec = ref.match(/^(\w+)\[\[(#\w[\w\s]*)\],\[([^\]]+)\]\]$/);
  if (withSpec) {
    return { tableName: withSpec[1], specifier: withSpec[2], columnName: withSpec[3] };
  }
  // Table1[[#Specifier]]
  const specOnly = ref.match(/^(\w+)\[\[(#\w[\w\s]*)\]\]$/);
  if (specOnly) {
    return { tableName: specOnly[1], specifier: specOnly[2], columnName: null };
  }
  // Table1[] (whole table)
  const whole = ref.match(/^(\w+)\[\]$/);
  if (whole) {
    return { tableName: whole[1], specifier: "#All", columnName: null };
  }
  return null;
}

// ============================================================================
// Helper: create a table for tests
// ============================================================================

function makeTable(overrides?: Partial<Table> & { opts?: Partial<TableStyleOptions> }): Table {
  const defaultOpts: TableStyleOptions = {
    bandedRows: true,
    bandedColumns: false,
    headerRow: true,
    totalRow: false,
    firstColumn: false,
    lastColumn: false,
    showFilterButton: true,
  };
  return {
    id: 1,
    name: "Table1",
    sheetIndex: 0,
    startRow: 0,
    startCol: 0,
    endRow: 10,
    endCol: 5,
    styleOptions: { ...defaultOpts, ...overrides?.opts },
    ...overrides,
  };
}

// ============================================================================
// 1. Style interceptor with all banding combos = 16 tests
// ============================================================================

describe("Table: Style interceptor banding combos", () => {
  const bandedRowsOptions = [false, true];
  const bandedColsOptions = [false, true];
  const firstColOptions = [false, true];
  const lastColOptions = [false, true];

  const cases: Array<{
    bandedRows: boolean;
    bandedColumns: boolean;
    firstColumn: boolean;
    lastColumn: boolean;
  }> = [];

  for (const br of bandedRowsOptions) {
    for (const bc of bandedColsOptions) {
      for (const fc of firstColOptions) {
        for (const lc of lastColOptions) {
          cases.push({ bandedRows: br, bandedColumns: bc, firstColumn: fc, lastColumn: lc });
        }
      }
    }
  }

  it.each(cases)(
    "bandedRows=$bandedRows bandedCols=$bandedColumns firstCol=$firstColumn lastCol=$lastColumn",
    ({ bandedRows, bandedColumns, firstColumn, lastColumn }) => {
      const table = makeTable({
        opts: { bandedRows, bandedColumns, firstColumn, lastColumn, headerRow: true, totalRow: false },
      });

      // Test header row always gets header style
      const headerStyle = computeTableStyle(table, 0, 0);
      expect(headerStyle).toEqual({ backgroundColor: HEADER_BG, textColor: HEADER_TEXT, bold: true });

      // Test even data row (row 1 = index 0 in data area)
      const evenStyle = computeTableStyle(table, 1, 0);
      // Test odd data row (row 2 = index 1 in data area)
      const oddStyle = computeTableStyle(table, 2, 0);

      if (bandedRows) {
        // Even data rows get banding
        expect(evenStyle?.backgroundColor).toBe(BAND_EVEN_BG);
        // Odd data rows: no banding from rows
        if (!firstColumn && !bandedColumns) {
          expect(oddStyle).toBeNull();
        }
      }

      if (firstColumn) {
        // First column cells should be bold
        const fcStyle = computeTableStyle(table, 2, 0);
        expect(fcStyle?.bold).toBe(true);
      }

      if (lastColumn) {
        // Last column cells should be bold
        const lcStyle = computeTableStyle(table, 2, 5);
        expect(lcStyle?.bold).toBe(true);
      }

      if (bandedColumns && !bandedRows) {
        // Even column gets banding on odd rows (where row banding doesn't apply)
        const colStyle = computeTableStyle(table, 2, 0); // col index 0 = even
        if (!firstColumn) {
          expect(colStyle?.backgroundColor).toBe(BAND_EVEN_BG);
        }
      }
    },
  );
});

// ============================================================================
// 2. getTableAtCell for 30 cell positions
// ============================================================================

describe("Table: getTableAtCell for 30 positions", () => {
  const tables: Table[] = [
    makeTable({ id: 1, name: "Table1", startRow: 2, startCol: 1, endRow: 10, endCol: 5, sheetIndex: 0 }),
    makeTable({ id: 2, name: "Table2", startRow: 15, startCol: 0, endRow: 25, endCol: 3, sheetIndex: 0 }),
    makeTable({ id: 3, name: "Table3", startRow: 0, startCol: 0, endRow: 5, endCol: 2, sheetIndex: 1 }),
  ];

  const cases: Array<{
    desc: string;
    row: number;
    col: number;
    sheetIndex: number | undefined;
    expectedTableName: string | null;
  }> = [
    // Inside Table1
    { desc: "T1 top-left corner", row: 2, col: 1, sheetIndex: 0, expectedTableName: "Table1" },
    { desc: "T1 top-right corner", row: 2, col: 5, sheetIndex: 0, expectedTableName: "Table1" },
    { desc: "T1 bottom-left corner", row: 10, col: 1, sheetIndex: 0, expectedTableName: "Table1" },
    { desc: "T1 bottom-right corner", row: 10, col: 5, sheetIndex: 0, expectedTableName: "Table1" },
    { desc: "T1 center", row: 6, col: 3, sheetIndex: 0, expectedTableName: "Table1" },
    { desc: "T1 first data row", row: 3, col: 2, sheetIndex: 0, expectedTableName: "Table1" },
    // Inside Table2
    { desc: "T2 top-left", row: 15, col: 0, sheetIndex: 0, expectedTableName: "Table2" },
    { desc: "T2 center", row: 20, col: 2, sheetIndex: 0, expectedTableName: "Table2" },
    { desc: "T2 bottom-right", row: 25, col: 3, sheetIndex: 0, expectedTableName: "Table2" },
    { desc: "T2 last row", row: 25, col: 1, sheetIndex: 0, expectedTableName: "Table2" },
    // Inside Table3 (different sheet)
    { desc: "T3 on sheet 1", row: 0, col: 0, sheetIndex: 1, expectedTableName: "Table3" },
    { desc: "T3 center", row: 3, col: 1, sheetIndex: 1, expectedTableName: "Table3" },
    { desc: "T3 bottom-right", row: 5, col: 2, sheetIndex: 1, expectedTableName: "Table3" },
    // Outside all tables
    { desc: "above T1", row: 1, col: 3, sheetIndex: 0, expectedTableName: null },
    { desc: "below T1 above T2", row: 12, col: 3, sheetIndex: 0, expectedTableName: null },
    { desc: "right of T1", row: 5, col: 6, sheetIndex: 0, expectedTableName: null },
    { desc: "left of T1", row: 5, col: 0, sheetIndex: 0, expectedTableName: null },
    { desc: "below T2", row: 26, col: 2, sheetIndex: 0, expectedTableName: null },
    { desc: "right of T2", row: 20, col: 4, sheetIndex: 0, expectedTableName: null },
    { desc: "far away", row: 100, col: 100, sheetIndex: 0, expectedTableName: null },
    { desc: "negative row", row: -1, col: 0, sheetIndex: 0, expectedTableName: null },
    { desc: "T3 coords on wrong sheet", row: 0, col: 0, sheetIndex: 0, expectedTableName: null },
    // No sheet filter
    { desc: "T1 area no sheet filter", row: 5, col: 3, sheetIndex: undefined, expectedTableName: "Table1" },
    { desc: "T3 area no sheet filter (T3 is at 0,0 on sheet 1)", row: 0, col: 0, sheetIndex: undefined, expectedTableName: "Table3" },
    // Edge: just outside boundaries
    { desc: "row just above T1", row: 1, col: 1, sheetIndex: 0, expectedTableName: null },
    { desc: "row just below T1", row: 11, col: 1, sheetIndex: 0, expectedTableName: null },
    { desc: "col just left of T1", row: 5, col: 0, sheetIndex: 0, expectedTableName: null },
    { desc: "col just right of T1", row: 5, col: 6, sheetIndex: 0, expectedTableName: null },
    { desc: "row just above T2", row: 14, col: 2, sheetIndex: 0, expectedTableName: null },
    { desc: "row just below T2", row: 26, col: 0, sheetIndex: 0, expectedTableName: null },
  ];

  it.each(cases)(
    "$desc => $expectedTableName",
    ({ row, col, sheetIndex, expectedTableName }) => {
      const result = getTableAtCell(tables, row, col, sheetIndex);
      if (expectedTableName === null) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        expect(result!.name).toBe(expectedTableName);
      }
    },
  );
});

// ============================================================================
// 3. Structured reference parsing for 20 patterns
// ============================================================================

describe("Table: Structured reference parsing", () => {
  const cases: Array<{
    input: string;
    tableName: string | null;
    specifier: string | null;
    columnName: string | null;
  }> = [
    // Simple column references
    { input: "Table1[Amount]", tableName: "Table1", specifier: null, columnName: "Amount" },
    { input: "Table1[Name]", tableName: "Table1", specifier: null, columnName: "Name" },
    { input: "Sales[Revenue]", tableName: "Sales", specifier: null, columnName: "Revenue" },
    { input: "T1[Col1]", tableName: "T1", specifier: null, columnName: "Col1" },
    // With specifiers
    { input: "Table1[[#Headers],[Amount]]", tableName: "Table1", specifier: "#Headers", columnName: "Amount" },
    { input: "Table1[[#Totals],[Amount]]", tableName: "Table1", specifier: "#Totals", columnName: "Amount" },
    { input: "Table1[[#Data],[Name]]", tableName: "Table1", specifier: "#Data", columnName: "Name" },
    { input: "Table1[[#All],[Price]]", tableName: "Table1", specifier: "#All", columnName: "Price" },
    { input: "Table1[[#This Row],[Qty]]", tableName: "Table1", specifier: "#This Row", columnName: "Qty" },
    // Specifier only (no column)
    { input: "Table1[[#Headers]]", tableName: "Table1", specifier: "#Headers", columnName: null },
    { input: "Table1[[#Totals]]", tableName: "Table1", specifier: "#Totals", columnName: null },
    { input: "Table1[[#Data]]", tableName: "Table1", specifier: "#Data", columnName: null },
    { input: "Table1[[#All]]", tableName: "Table1", specifier: "#All", columnName: null },
    // This-row shorthand
    { input: "Table1[@Amount]", tableName: "Table1", specifier: "#This Row", columnName: "Amount" },
    { input: "Sales[@Total]", tableName: "Sales", specifier: "#This Row", columnName: "Total" },
    // Whole table
    { input: "Table1[]", tableName: "Table1", specifier: "#All", columnName: null },
    { input: "Sales[]", tableName: "Sales", specifier: "#All", columnName: null },
    // Invalid patterns
    { input: "NotARef", tableName: null, specifier: null, columnName: null },
    { input: "[Column]", tableName: null, specifier: null, columnName: null },
    { input: "Table1", tableName: null, specifier: null, columnName: null },
  ];

  it.each(cases)(
    "parse: $input",
    ({ input, tableName, specifier, columnName }) => {
      const result = parseStructuredReference(input);
      if (tableName === null) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        expect(result!.tableName).toBe(tableName);
        expect(result!.specifier).toBe(specifier);
        expect(result!.columnName).toBe(columnName);
      }
    },
  );
});
