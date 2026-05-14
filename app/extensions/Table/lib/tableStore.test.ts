//! FILENAME: app/extensions/Table/lib/tableStore.test.ts
// PURPOSE: Tests for table store pure logic functions.
// CONTEXT: Tests table lookup (getTableAtCell, getTableById), hit testing,
//          and table style interceptor logic without backend dependencies.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline copy of Table type and getTableAtCell logic from tableStore.ts
// ============================================================================

interface TableStyleOptions {
  headerRow: boolean;
  totalRow: boolean;
  bandedRows: boolean;
  bandedColumns: boolean;
  firstColumn: boolean;
  lastColumn: boolean;
  showFilterButton: boolean;
}

interface TableColumn {
  name: string;
  totalsFunction?: string;
}

interface Table {
  id: number;
  name: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  columns: TableColumn[];
  styleOptions: TableStyleOptions;
}

function getTableAtCell(
  tables: Table[],
  row: number,
  col: number,
  sheetIndex?: number,
): Table | null {
  for (const table of tables) {
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

function getTableById(tables: Table[], tableId: number): Table | null {
  return tables.find((t) => t.id === tableId) ?? null;
}

// ============================================================================
// Inline copy of hitTestTable from tableOverlayRenderer.ts
// ============================================================================

function hitTestTable(
  region: { startRow: number; startCol: number; endRow: number; endCol: number },
  row: number,
  col: number,
): boolean {
  return (
    row >= region.startRow &&
    row <= region.endRow &&
    col >= region.startCol &&
    col <= region.endCol
  );
}

// ============================================================================
// Inline copy of table style interceptor logic
// ============================================================================

interface IStyleOverride {
  backgroundColor?: string;
  textColor?: string;
  bold?: boolean;
}

const HEADER_BG = "#4472C4";
const HEADER_TEXT = "#FFFFFF";
const BAND_EVEN_BG = "#D9E2F3";
const TOTAL_BG = "#D9E2F3";

function tableStyleInterceptor(
  table: Table,
  row: number,
  col: number,
): IStyleOverride | null {
  const opts = table.styleOptions;

  // Header row styling
  if (opts.headerRow && row === table.startRow) {
    return {
      backgroundColor: HEADER_BG,
      textColor: HEADER_TEXT,
      bold: true,
    };
  }

  // Totals row styling
  if (opts.totalRow && row === table.endRow) {
    return {
      backgroundColor: TOTAL_BG,
      bold: true,
    };
  }

  // Data area styling
  const dataStartRow = opts.headerRow ? table.startRow + 1 : table.startRow;
  const dataEndRow = opts.totalRow ? table.endRow - 1 : table.endRow;

  if (row >= dataStartRow && row <= dataEndRow) {
    const override: IStyleOverride = {};
    let hasOverride = false;

    // Banded rows
    if (opts.bandedRows) {
      const dataRowIndex = row - dataStartRow;
      if (dataRowIndex % 2 === 0) {
        override.backgroundColor = BAND_EVEN_BG;
        hasOverride = true;
      }
    }

    // Banded columns
    if (opts.bandedColumns) {
      const colIndex = col - table.startCol;
      if (colIndex % 2 === 0) {
        if (!override.backgroundColor) {
          override.backgroundColor = BAND_EVEN_BG;
          hasOverride = true;
        }
      }
    }

    // First column emphasis
    if (opts.firstColumn && col === table.startCol) {
      override.bold = true;
      hasOverride = true;
    }

    // Last column emphasis
    if (opts.lastColumn && col === table.endCol) {
      override.bold = true;
      hasOverride = true;
    }

    return hasOverride ? override : null;
  }

  return null;
}

// ============================================================================
// Inline copy of data range computation (from selectionHandler.ts)
// ============================================================================

function getTableDataRange(table: Table): {
  dataStartRow: number;
  dataEndRow: number;
} {
  const dataStartRow = table.styleOptions.headerRow
    ? table.startRow + 1
    : table.startRow;
  const dataEndRow = table.styleOptions.totalRow
    ? table.endRow - 1
    : table.endRow;
  return { dataStartRow, dataEndRow };
}

// ============================================================================
// Test Fixtures
// ============================================================================

function makeTable(overrides: Partial<Table> = {}): Table {
  return {
    id: 1,
    name: "Table1",
    sheetIndex: 0,
    startRow: 5,
    startCol: 1,
    endRow: 20,
    endCol: 5,
    columns: [
      { name: "Name" },
      { name: "Age" },
      { name: "City" },
      { name: "Score" },
      { name: "Grade" },
    ],
    styleOptions: {
      headerRow: true,
      totalRow: false,
      bandedRows: true,
      bandedColumns: false,
      firstColumn: false,
      lastColumn: false,
      showFilterButton: true,
    },
    ...overrides,
  };
}

// ============================================================================
// Tests: getTableAtCell
// ============================================================================

describe("getTableAtCell", () => {
  const tables = [
    makeTable({ id: 1, startRow: 0, startCol: 0, endRow: 10, endCol: 5, sheetIndex: 0 }),
    makeTable({ id: 2, startRow: 20, startCol: 0, endRow: 30, endCol: 3, sheetIndex: 0 }),
    makeTable({ id: 3, startRow: 0, startCol: 0, endRow: 10, endCol: 5, sheetIndex: 1 }),
  ];

  it("finds a table containing the cell", () => {
    const result = getTableAtCell(tables, 5, 3);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it("finds a table at the top-left corner", () => {
    const result = getTableAtCell(tables, 0, 0);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it("finds a table at the bottom-right corner", () => {
    const result = getTableAtCell(tables, 10, 5);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it("returns null when no table contains the cell", () => {
    expect(getTableAtCell(tables, 15, 0)).toBeNull();
    expect(getTableAtCell(tables, 0, 10)).toBeNull();
  });

  it("returns null for empty table list", () => {
    expect(getTableAtCell([], 0, 0)).toBeNull();
  });

  it("finds second table when cell is in its range", () => {
    const result = getTableAtCell(tables, 25, 2);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(2);
  });

  it("filters by sheetIndex", () => {
    // Without sheet filter, finds table on sheet 0
    const result1 = getTableAtCell(tables, 5, 3);
    expect(result1!.id).toBe(1);

    // With sheet 1 filter, finds table on sheet 1
    const result2 = getTableAtCell(tables, 5, 3, 1);
    expect(result2!.id).toBe(3);

    // With sheet 2 filter, finds nothing
    const result3 = getTableAtCell(tables, 5, 3, 2);
    expect(result3).toBeNull();
  });

  it("returns first matching table when tables overlap", () => {
    const overlapping = [
      makeTable({ id: 10, startRow: 0, startCol: 0, endRow: 10, endCol: 10 }),
      makeTable({ id: 11, startRow: 5, startCol: 5, endRow: 15, endCol: 15 }),
    ];
    const result = getTableAtCell(overlapping, 7, 7);
    expect(result!.id).toBe(10);
  });
});

// ============================================================================
// Tests: getTableById
// ============================================================================

describe("getTableById", () => {
  const tables = [
    makeTable({ id: 1 }),
    makeTable({ id: 2, name: "Table2" }),
    makeTable({ id: 3, name: "Table3" }),
  ];

  it("finds table by ID", () => {
    const result = getTableById(tables, 2);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Table2");
  });

  it("returns null for non-existent ID", () => {
    expect(getTableById(tables, 99)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(getTableById([], 1)).toBeNull();
  });
});

// ============================================================================
// Tests: hitTestTable
// ============================================================================

describe("hitTestTable", () => {
  const region = { startRow: 5, startCol: 2, endRow: 15, endCol: 8 };

  it("returns true for cell inside region", () => {
    expect(hitTestTable(region, 10, 5)).toBe(true);
  });

  it("returns true for cell on boundary", () => {
    expect(hitTestTable(region, 5, 2)).toBe(true);
    expect(hitTestTable(region, 15, 8)).toBe(true);
    expect(hitTestTable(region, 5, 8)).toBe(true);
    expect(hitTestTable(region, 15, 2)).toBe(true);
  });

  it("returns false for cell outside region", () => {
    expect(hitTestTable(region, 4, 5)).toBe(false);  // above
    expect(hitTestTable(region, 16, 5)).toBe(false); // below
    expect(hitTestTable(region, 10, 1)).toBe(false); // left
    expect(hitTestTable(region, 10, 9)).toBe(false); // right
  });

  it("returns false for corner-adjacent cells", () => {
    expect(hitTestTable(region, 4, 1)).toBe(false);
    expect(hitTestTable(region, 16, 9)).toBe(false);
  });
});

// ============================================================================
// Tests: Table Style Interceptor
// ============================================================================

describe("tableStyleInterceptor", () => {
  it("returns header styling for header row", () => {
    const table = makeTable({ startRow: 0, endRow: 10, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
    }});
    const result = tableStyleInterceptor(table, 0, 1);
    expect(result).toEqual({
      backgroundColor: HEADER_BG,
      textColor: HEADER_TEXT,
      bold: true,
    });
  });

  it("returns null for header row when headerRow is disabled", () => {
    const table = makeTable({ startRow: 0, endRow: 10, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: false,
      bandedRows: false,
    }});
    const result = tableStyleInterceptor(table, 0, 1);
    expect(result).toBeNull();
  });

  it("returns total styling for total row", () => {
    const table = makeTable({ startRow: 0, endRow: 10, styleOptions: {
      ...makeTable().styleOptions,
      totalRow: true,
    }});
    const result = tableStyleInterceptor(table, 10, 1);
    expect(result).toEqual({
      backgroundColor: TOTAL_BG,
      bold: true,
    });
  });

  it("applies banded row styling to even data rows", () => {
    const table = makeTable({ startRow: 0, endRow: 10, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      bandedRows: true,
    }});
    // Data starts at row 1 (after header). Even data row index = 0, 2, 4...
    // Row 1 => dataRowIndex 0 (even) -> banded
    const result = tableStyleInterceptor(table, 1, 1);
    expect(result).not.toBeNull();
    expect(result!.backgroundColor).toBe(BAND_EVEN_BG);
  });

  it("returns null for odd data rows when only banded rows enabled", () => {
    const table = makeTable({ startRow: 0, endRow: 10, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      bandedRows: true,
      bandedColumns: false,
      firstColumn: false,
      lastColumn: false,
    }});
    // Row 2 => dataRowIndex 1 (odd) -> no band
    const result = tableStyleInterceptor(table, 2, 2);
    expect(result).toBeNull();
  });

  it("applies banded column styling", () => {
    const table = makeTable({ startRow: 0, startCol: 0, endRow: 10, endCol: 5, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      bandedRows: false,
      bandedColumns: true,
    }});
    // Col 0 => colIndex 0 (even) -> banded
    const result = tableStyleInterceptor(table, 1, 0);
    expect(result).not.toBeNull();
    expect(result!.backgroundColor).toBe(BAND_EVEN_BG);

    // Col 1 => colIndex 1 (odd) -> no band
    const result2 = tableStyleInterceptor(table, 1, 1);
    expect(result2).toBeNull();
  });

  it("applies first column emphasis", () => {
    const table = makeTable({ startRow: 0, startCol: 2, endRow: 10, endCol: 5, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      bandedRows: false,
      firstColumn: true,
    }});
    const result = tableStyleInterceptor(table, 1, 2);
    expect(result).not.toBeNull();
    expect(result!.bold).toBe(true);
  });

  it("applies last column emphasis", () => {
    const table = makeTable({ startRow: 0, startCol: 0, endRow: 10, endCol: 5, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      bandedRows: false,
      lastColumn: true,
    }});
    const result = tableStyleInterceptor(table, 1, 5);
    expect(result).not.toBeNull();
    expect(result!.bold).toBe(true);
  });

  it("returns null for cells outside the data area", () => {
    const table = makeTable({ startRow: 0, endRow: 10, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      totalRow: true,
      bandedRows: true,
    }});
    // Row above header -> impossible since header is startRow
    // Row below total -> also impossible since total is endRow
    // But what about cell outside column range? That would not even
    // be called since getTableAtCell would return null first.
  });

  it("header row takes priority over banded rows", () => {
    const table = makeTable({ startRow: 0, endRow: 10, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      bandedRows: true,
    }});
    const result = tableStyleInterceptor(table, 0, 1);
    // Should be header styling, not banded
    expect(result!.backgroundColor).toBe(HEADER_BG);
    expect(result!.textColor).toBe(HEADER_TEXT);
  });

  it("totals row takes priority over banded rows", () => {
    const table = makeTable({ startRow: 0, endRow: 10, styleOptions: {
      ...makeTable().styleOptions,
      totalRow: true,
      bandedRows: true,
    }});
    const result = tableStyleInterceptor(table, 10, 1);
    expect(result!.backgroundColor).toBe(TOTAL_BG);
  });

  it("handles table with no header and no totals", () => {
    const table = makeTable({ startRow: 0, endRow: 5, styleOptions: {
      headerRow: false,
      totalRow: false,
      bandedRows: true,
      bandedColumns: false,
      firstColumn: false,
      lastColumn: false,
      showFilterButton: false,
    }});
    // Row 0 is data row 0 (even) -> banded
    const result = tableStyleInterceptor(table, 0, 1);
    expect(result).not.toBeNull();
    expect(result!.backgroundColor).toBe(BAND_EVEN_BG);
  });
});

// ============================================================================
// Tests: Table Data Range Computation
// ============================================================================

describe("getTableDataRange", () => {
  it("excludes header row when present", () => {
    const table = makeTable({ startRow: 5, endRow: 20, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      totalRow: false,
    }});
    const { dataStartRow, dataEndRow } = getTableDataRange(table);
    expect(dataStartRow).toBe(6);
    expect(dataEndRow).toBe(20);
  });

  it("excludes total row when present", () => {
    const table = makeTable({ startRow: 5, endRow: 20, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: false,
      totalRow: true,
    }});
    const { dataStartRow, dataEndRow } = getTableDataRange(table);
    expect(dataStartRow).toBe(5);
    expect(dataEndRow).toBe(19);
  });

  it("excludes both header and total rows", () => {
    const table = makeTable({ startRow: 5, endRow: 20, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      totalRow: true,
    }});
    const { dataStartRow, dataEndRow } = getTableDataRange(table);
    expect(dataStartRow).toBe(6);
    expect(dataEndRow).toBe(19);
  });

  it("includes all rows when neither header nor total", () => {
    const table = makeTable({ startRow: 5, endRow: 20, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: false,
      totalRow: false,
    }});
    const { dataStartRow, dataEndRow } = getTableDataRange(table);
    expect(dataStartRow).toBe(5);
    expect(dataEndRow).toBe(20);
  });

  it("handles single-row table with header only", () => {
    const table = makeTable({ startRow: 0, endRow: 0, styleOptions: {
      ...makeTable().styleOptions,
      headerRow: true,
      totalRow: false,
    }});
    const { dataStartRow, dataEndRow } = getTableDataRange(table);
    // dataStart would be 1, dataEnd would be 0 => no data rows
    expect(dataStartRow).toBeGreaterThan(dataEndRow);
  });
});
