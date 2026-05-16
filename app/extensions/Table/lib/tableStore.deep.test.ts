//! FILENAME: app/extensions/Table/lib/tableStore.deep.test.ts
// PURPOSE: Deep tests for table store logic — overlapping tables, resize,
//          structured references, banding edge cases, style interceptor combos.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline types and logic (same approach as tableStore.test.ts)
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

interface IStyleOverride {
  backgroundColor?: string;
  textColor?: string;
  bold?: boolean;
}

const HEADER_BG = "#4472C4";
const HEADER_TEXT = "#FFFFFF";
const BAND_EVEN_BG = "#D9E2F3";
const TOTAL_BG = "#D9E2F3";

function getTableAtCell(
  tables: Table[],
  row: number,
  col: number,
  sheetIndex?: number,
): Table | null {
  for (const table of tables) {
    if (sheetIndex !== undefined && table.sheetIndex !== sheetIndex) continue;
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

function tableStyleInterceptor(
  table: Table,
  row: number,
  col: number,
): IStyleOverride | null {
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
    const override: IStyleOverride = {};
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

// ============================================================================
// Structured reference resolution (pure logic)
// ============================================================================

type StructuredRefKind = "thisRow" | "headers" | "totals" | "data" | "all";

interface StructuredRef {
  kind: StructuredRefKind;
  columnName?: string;
}

function parseStructuredRef(ref: string): StructuredRef | null {
  const trimmed = ref.trim();
  if (trimmed.startsWith("[@") && trimmed.endsWith("]")) {
    return { kind: "thisRow", columnName: trimmed.slice(2, -1) };
  }
  if (trimmed === "[#Headers]") return { kind: "headers" };
  if (trimmed === "[#Totals]") return { kind: "totals" };
  if (trimmed === "[#Data]") return { kind: "data" };
  if (trimmed === "[#All]") return { kind: "all" };
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { kind: "data", columnName: trimmed.slice(1, -1) };
  }
  return null;
}

function resolveStructuredRef(
  table: Table,
  ref: StructuredRef,
  currentRow: number,
): { startRow: number; endRow: number; col: number } | null {
  const colIndex = ref.columnName
    ? table.columns.findIndex((c) => c.name === ref.columnName)
    : -1;

  if (ref.columnName && colIndex === -1) return null;

  const col = ref.columnName ? table.startCol + colIndex : -1;
  const { dataStartRow, dataEndRow } = getTableDataRange(table);

  switch (ref.kind) {
    case "thisRow":
      return col >= 0 ? { startRow: currentRow, endRow: currentRow, col } : null;
    case "headers":
      return table.styleOptions.headerRow
        ? { startRow: table.startRow, endRow: table.startRow, col }
        : null;
    case "totals":
      return table.styleOptions.totalRow
        ? { startRow: table.endRow, endRow: table.endRow, col }
        : null;
    case "data":
      return { startRow: dataStartRow, endRow: dataEndRow, col };
    case "all":
      return { startRow: table.startRow, endRow: table.endRow, col };
    default:
      return null;
  }
}

// ============================================================================
// Rename logic (pure)
// ============================================================================

function renameTable(
  tables: Table[],
  tableId: number,
  newName: string,
): { success: boolean; error?: string } {
  const table = tables.find((t) => t.id === tableId);
  if (!table) return { success: false, error: "Table not found" };
  if (!newName || newName.trim().length === 0) {
    return { success: false, error: "Name cannot be empty" };
  }
  const nameExists = tables.some(
    (t) => t.id !== tableId && t.name.toLowerCase() === newName.toLowerCase(),
  );
  if (nameExists) return { success: false, error: "Name already in use" };
  table.name = newName;
  return { success: true };
}

// ============================================================================
// Resize validation (pure)
// ============================================================================

function validateResize(
  table: Table,
  newStartRow: number,
  newStartCol: number,
  newEndRow: number,
  newEndCol: number,
): { valid: boolean; error?: string } {
  if (newEndRow < newStartRow || newEndCol < newStartCol) {
    return { valid: false, error: "End must be >= start" };
  }
  const minRows = (table.styleOptions.headerRow ? 1 : 0) +
    (table.styleOptions.totalRow ? 1 : 0) + 1; // at least 1 data row
  const rowCount = newEndRow - newStartRow + 1;
  if (rowCount < minRows) {
    return { valid: false, error: "Too few rows for header/total config" };
  }
  return { valid: true };
}

// ============================================================================
// Convert to range (pure)
// ============================================================================

function convertToRange(tables: Table[], tableId: number): Table[] {
  return tables.filter((t) => t.id !== tableId);
}

// ============================================================================
// Overlap detection
// ============================================================================

function tablesOverlap(a: Table, b: Table): boolean {
  if (a.sheetIndex !== b.sheetIndex) return false;
  return !(
    a.endRow < b.startRow ||
    b.endRow < a.startRow ||
    a.endCol < b.startCol ||
    b.endCol < a.startCol
  );
}

// ============================================================================
// Auto-expand check (pure logic)
// ============================================================================

function isAdjacentToTable(
  table: Table,
  row: number,
  col: number,
): "below" | "right" | null {
  if (
    row === table.endRow + 1 &&
    col >= table.startCol &&
    col <= table.endCol
  ) {
    return "below";
  }
  if (
    col === table.endCol + 1 &&
    row >= table.startRow &&
    row <= table.endRow
  ) {
    return "right";
  }
  return null;
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

function makeDefaultOpts(overrides: Partial<TableStyleOptions> = {}): TableStyleOptions {
  return {
    headerRow: true,
    totalRow: false,
    bandedRows: true,
    bandedColumns: false,
    firstColumn: false,
    lastColumn: false,
    showFilterButton: true,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("overlapping tables", () => {
  it("detects full overlap on same sheet", () => {
    const a = makeTable({ id: 1, startRow: 0, startCol: 0, endRow: 10, endCol: 5 });
    const b = makeTable({ id: 2, startRow: 5, startCol: 3, endRow: 15, endCol: 8 });
    expect(tablesOverlap(a, b)).toBe(true);
  });

  it("no overlap when on different sheets", () => {
    const a = makeTable({ id: 1, sheetIndex: 0, startRow: 0, startCol: 0, endRow: 10, endCol: 5 });
    const b = makeTable({ id: 2, sheetIndex: 1, startRow: 0, startCol: 0, endRow: 10, endCol: 5 });
    expect(tablesOverlap(a, b)).toBe(false);
  });

  it("no overlap when adjacent but not intersecting", () => {
    const a = makeTable({ id: 1, startRow: 0, startCol: 0, endRow: 5, endCol: 3 });
    const b = makeTable({ id: 2, startRow: 6, startCol: 0, endRow: 10, endCol: 3 });
    expect(tablesOverlap(a, b)).toBe(false);
  });

  it("overlap when sharing a single cell", () => {
    const a = makeTable({ id: 1, startRow: 0, startCol: 0, endRow: 5, endCol: 5 });
    const b = makeTable({ id: 2, startRow: 5, startCol: 5, endRow: 10, endCol: 10 });
    expect(tablesOverlap(a, b)).toBe(true);
  });

  it("getTableAtCell returns first match when tables overlap", () => {
    const tables = [
      makeTable({ id: 1, startRow: 0, startCol: 0, endRow: 10, endCol: 10 }),
      makeTable({ id: 2, startRow: 5, startCol: 5, endRow: 15, endCol: 15 }),
    ];
    const result = getTableAtCell(tables, 7, 7);
    expect(result!.id).toBe(1);
  });
});

describe("table resize validation", () => {
  it("allows valid resize", () => {
    const table = makeTable({ styleOptions: makeDefaultOpts({ headerRow: true, totalRow: false }) });
    const result = validateResize(table, 5, 1, 25, 5);
    expect(result.valid).toBe(true);
  });

  it("rejects resize with end before start", () => {
    const table = makeTable();
    expect(validateResize(table, 10, 1, 5, 5).valid).toBe(false);
  });

  it("rejects resize too small for header + total + data", () => {
    const table = makeTable({ styleOptions: makeDefaultOpts({ headerRow: true, totalRow: true }) });
    // Need at least 3 rows: header + 1 data + total
    expect(validateResize(table, 0, 0, 1, 5).valid).toBe(false);
  });

  it("allows minimum viable size with header and total", () => {
    const table = makeTable({ styleOptions: makeDefaultOpts({ headerRow: true, totalRow: true }) });
    expect(validateResize(table, 0, 0, 2, 5).valid).toBe(true);
  });

  it("allows single-column resize", () => {
    const table = makeTable({ styleOptions: makeDefaultOpts({ headerRow: true, totalRow: false }) });
    expect(validateResize(table, 0, 0, 5, 0).valid).toBe(true);
  });
});

describe("structured references", () => {
  const table = makeTable({
    startRow: 5,
    startCol: 1,
    endRow: 20,
    endCol: 5,
    styleOptions: makeDefaultOpts({ headerRow: true, totalRow: true }),
  });

  it("parses [@Column] as thisRow ref", () => {
    const ref = parseStructuredRef("[@Score]");
    expect(ref).toEqual({ kind: "thisRow", columnName: "Score" });
  });

  it("parses [#Headers]", () => {
    expect(parseStructuredRef("[#Headers]")).toEqual({ kind: "headers" });
  });

  it("parses [#Totals]", () => {
    expect(parseStructuredRef("[#Totals]")).toEqual({ kind: "totals" });
  });

  it("parses [#All]", () => {
    expect(parseStructuredRef("[#All]")).toEqual({ kind: "all" });
  });

  it("parses [#Data]", () => {
    expect(parseStructuredRef("[#Data]")).toEqual({ kind: "data" });
  });

  it("parses [ColumnName] as data column ref", () => {
    const ref = parseStructuredRef("[Age]");
    expect(ref).toEqual({ kind: "data", columnName: "Age" });
  });

  it("returns null for invalid ref", () => {
    expect(parseStructuredRef("notARef")).toBeNull();
  });

  it("resolves [@Score] to current row, correct column", () => {
    const ref: StructuredRef = { kind: "thisRow", columnName: "Score" };
    const result = resolveStructuredRef(table, ref, 10);
    expect(result).toEqual({ startRow: 10, endRow: 10, col: 4 }); // Score is index 3 -> col 1+3=4
  });

  it("resolves [#Headers] to header row", () => {
    const ref: StructuredRef = { kind: "headers", columnName: "Name" };
    const result = resolveStructuredRef(table, ref, 10);
    expect(result).toEqual({ startRow: 5, endRow: 5, col: 1 });
  });

  it("resolves [#Totals] to total row", () => {
    const ref: StructuredRef = { kind: "totals", columnName: "Age" };
    const result = resolveStructuredRef(table, ref, 10);
    expect(result).toEqual({ startRow: 20, endRow: 20, col: 2 });
  });

  it("resolves [#All] to entire table range", () => {
    const ref: StructuredRef = { kind: "all", columnName: "City" };
    const result = resolveStructuredRef(table, ref, 10);
    expect(result).toEqual({ startRow: 5, endRow: 20, col: 3 });
  });

  it("returns null for headers when headerRow is false", () => {
    const noHeader = makeTable({ styleOptions: makeDefaultOpts({ headerRow: false, totalRow: true }) });
    const ref: StructuredRef = { kind: "headers" };
    expect(resolveStructuredRef(noHeader, ref, 10)).toBeNull();
  });

  it("returns null for non-existent column", () => {
    const ref: StructuredRef = { kind: "thisRow", columnName: "NonExistent" };
    expect(resolveStructuredRef(table, ref, 10)).toBeNull();
  });
});

describe("table style banding with odd/even row counts", () => {
  it("even number of data rows: last row is odd (unbanded)", () => {
    // 4 data rows: indices 0,1,2,3 -> rows 0,2 banded; rows 1,3 not
    const table = makeTable({
      startRow: 0, endRow: 4, // header=0, data=1..4
      styleOptions: makeDefaultOpts({ headerRow: true, bandedRows: true }),
    });
    expect(tableStyleInterceptor(table, 4, 1)?.backgroundColor).toBeUndefined();
  });

  it("odd number of data rows: last row is even (banded)", () => {
    const table = makeTable({
      startRow: 0, endRow: 3, // header=0, data=1..3 -> 3 data rows
      styleOptions: makeDefaultOpts({ headerRow: true, bandedRows: true }),
    });
    // Row 3 -> dataIndex 2 (even) -> banded
    expect(tableStyleInterceptor(table, 3, 1)?.backgroundColor).toBe(BAND_EVEN_BG);
  });

  it("single data row is always banded (index 0)", () => {
    const table = makeTable({
      startRow: 0, endRow: 1,
      styleOptions: makeDefaultOpts({ headerRow: true, bandedRows: true }),
    });
    expect(tableStyleInterceptor(table, 1, 1)?.backgroundColor).toBe(BAND_EVEN_BG);
  });
});

describe("table spanning entire sheet width", () => {
  it("table from col 0 to col 16383 works for lookup", () => {
    const wide = makeTable({
      startCol: 0, endCol: 16383,
      startRow: 0, endRow: 100,
    });
    expect(getTableAtCell([wide], 50, 0)).toBe(wide);
    expect(getTableAtCell([wide], 50, 16383)).toBe(wide);
    expect(getTableAtCell([wide], 50, 16384)).toBeNull();
  });
});

describe("auto-expand adjacency detection", () => {
  const table = makeTable({ startRow: 5, startCol: 1, endRow: 20, endCol: 5 });

  it("cell directly below table is adjacent below", () => {
    expect(isAdjacentToTable(table, 21, 3)).toBe("below");
  });

  it("cell directly right of table is adjacent right", () => {
    expect(isAdjacentToTable(table, 10, 6)).toBe("right");
  });

  it("cell below but outside column range is not adjacent", () => {
    expect(isAdjacentToTable(table, 21, 0)).toBeNull();
    expect(isAdjacentToTable(table, 21, 6)).toBeNull();
  });

  it("cell two rows below is not adjacent", () => {
    expect(isAdjacentToTable(table, 22, 3)).toBeNull();
  });
});

describe("total row functions", () => {
  it("columns can have different totals functions", () => {
    const table = makeTable({
      columns: [
        { name: "Name", totalsFunction: "count" },
        { name: "Amount", totalsFunction: "sum" },
        { name: "Price", totalsFunction: "average" },
        { name: "Max", totalsFunction: "max" },
        { name: "Min", totalsFunction: "min" },
      ],
    });
    expect(table.columns[0].totalsFunction).toBe("count");
    expect(table.columns[1].totalsFunction).toBe("sum");
    expect(table.columns[2].totalsFunction).toBe("average");
    expect(table.columns[3].totalsFunction).toBe("max");
    expect(table.columns[4].totalsFunction).toBe("min");
  });

  it("column without totalsFunction defaults to undefined", () => {
    const table = makeTable();
    expect(table.columns[0].totalsFunction).toBeUndefined();
  });
});

describe("table rename", () => {
  it("renames table successfully", () => {
    const tables = [makeTable({ id: 1, name: "Table1" })];
    const result = renameTable(tables, 1, "Sales");
    expect(result.success).toBe(true);
    expect(tables[0].name).toBe("Sales");
  });

  it("rejects duplicate name (case-insensitive)", () => {
    const tables = [
      makeTable({ id: 1, name: "Table1" }),
      makeTable({ id: 2, name: "Sales" }),
    ];
    const result = renameTable(tables, 1, "sales");
    expect(result.success).toBe(false);
    expect(result.error).toContain("already in use");
  });

  it("rejects empty name", () => {
    const tables = [makeTable({ id: 1 })];
    expect(renameTable(tables, 1, "").success).toBe(false);
    expect(renameTable(tables, 1, "  ").success).toBe(false);
  });

  it("rejects rename of non-existent table", () => {
    expect(renameTable([], 99, "Foo").success).toBe(false);
  });
});

describe("convert table to range", () => {
  it("removes table from list", () => {
    const tables = [
      makeTable({ id: 1 }),
      makeTable({ id: 2, name: "Table2" }),
    ];
    const result = convertToRange(tables, 1);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it("no-op when table not found", () => {
    const tables = [makeTable({ id: 1 })];
    const result = convertToRange(tables, 99);
    expect(result).toHaveLength(1);
  });
});

describe("style interceptor — all banding combinations", () => {
  const baseTable = (opts: Partial<TableStyleOptions>) =>
    makeTable({
      startRow: 0,
      startCol: 0,
      endRow: 10,
      endCol: 5,
      styleOptions: makeDefaultOpts({
        headerRow: true,
        bandedRows: false,
        bandedColumns: false,
        firstColumn: false,
        lastColumn: false,
        ...opts,
      }),
    });

  it("both banded rows and columns: even row + even col gets band", () => {
    const table = baseTable({ bandedRows: true, bandedColumns: true });
    // Row 1 (dataIndex 0, even), col 0 (colIndex 0, even) -> bandedRows sets bg
    const result = tableStyleInterceptor(table, 1, 0);
    expect(result?.backgroundColor).toBe(BAND_EVEN_BG);
  });

  it("both banded: even row + odd col -> bandedRows wins (sets bg first)", () => {
    const table = baseTable({ bandedRows: true, bandedColumns: true });
    const result = tableStyleInterceptor(table, 1, 1); // even row, odd col
    // bandedRows sets bg on even row; bandedColumns skips because bg already set
    expect(result?.backgroundColor).toBe(BAND_EVEN_BG);
  });

  it("both banded: odd row + even col -> bandedColumns sets bg", () => {
    const table = baseTable({ bandedRows: true, bandedColumns: true });
    const result = tableStyleInterceptor(table, 2, 0); // odd row, even col
    expect(result?.backgroundColor).toBe(BAND_EVEN_BG);
  });

  it("both banded: odd row + odd col -> no bg", () => {
    const table = baseTable({ bandedRows: true, bandedColumns: true });
    const result = tableStyleInterceptor(table, 2, 1);
    expect(result).toBeNull();
  });

  it("firstColumn + lastColumn + banded rows on same row", () => {
    const table = baseTable({ bandedRows: true, firstColumn: true, lastColumn: true });
    // First col, even data row
    const r1 = tableStyleInterceptor(table, 1, 0);
    expect(r1?.bold).toBe(true);
    expect(r1?.backgroundColor).toBe(BAND_EVEN_BG);

    // Last col, even data row
    const r2 = tableStyleInterceptor(table, 1, 5);
    expect(r2?.bold).toBe(true);
    expect(r2?.backgroundColor).toBe(BAND_EVEN_BG);
  });

  it("no options enabled returns null for data cells", () => {
    const table = baseTable({});
    expect(tableStyleInterceptor(table, 1, 1)).toBeNull();
  });

  it("header row still styled even when all banding off", () => {
    const table = baseTable({});
    const result = tableStyleInterceptor(table, 0, 1);
    expect(result?.backgroundColor).toBe(HEADER_BG);
  });
});
