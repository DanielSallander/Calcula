//! FILENAME: app/src/api/scriptHost/objectCoords.ts
// PURPOSE: Pure coordinate-resolution helpers for the table/namedRange object
//          script types. Kept dependency-free so the host can resolve a logical
//          (dataRow, colIndex) inside a table — or a (row, col) inside a named
//          range — to absolute grid coordinates, and unit tests can pin the
//          math. The host reuses the EXISTING cell ops with these coordinates.

/** The minimal table shape the coord math needs (mirrors backend.ts Table). */
export interface TableLike {
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  styleOptions: { headerRow: boolean; totalRow: boolean };
  columns: Array<{ name: string }>;
}

/** Absolute grid coordinate on a specific sheet. */
export interface GridCoord {
  sheetIndex: number;
  row: number;
  col: number;
}

/**
 * Number of rows occupied by the header (1 if the table shows a header row).
 * The Table struct includes the header in start_row.
 */
export function tableHeaderOffset(table: TableLike): number {
  return table.styleOptions.headerRow ? 1 : 0;
}

/** Number of data rows (excludes header + totals). */
export function tableDataRowCount(table: TableLike): number {
  const headerOffset = tableHeaderOffset(table);
  const totalsOffset = table.styleOptions.totalRow ? 1 : 0;
  const count = table.endRow - table.startRow + 1 - headerOffset - totalsOffset;
  return count > 0 ? count : 0;
}

/**
 * Resolve a logical (0-based data row, 0-based column index) inside a table to
 * an absolute grid coordinate. Returns null if the indices fall outside the
 * table's data area / column range.
 */
export function tableCellCoord(
  table: TableLike,
  dataRow: number,
  colIndex: number,
): GridCoord | null {
  if (dataRow < 0 || colIndex < 0) return null;
  const colCount = table.endCol - table.startCol + 1;
  if (colIndex >= colCount) return null;
  if (dataRow >= tableDataRowCount(table)) return null;
  const row = table.startRow + tableHeaderOffset(table) + dataRow;
  const col = table.startCol + colIndex;
  return { sheetIndex: table.sheetIndex, row, col };
}

/** The table's column header names (in column order). */
export function tableHeaders(table: TableLike): string[] {
  return table.columns.map((c) => c.name);
}

/**
 * Expand a rectangle into the DISTINCT row and column index lists the backend's
 * `apply_formatting` / `apply_formatting_to_sheets` take. Those commands apply
 * the CROSS PRODUCT rows x cols, so the lists must hold each index once —
 * passing coordinate PAIRS (the shape a naive caller reaches for) still covers
 * the rectangle but formats every cell rowCount x colCount times.
 *
 * The corners are normalized, so an inverted rectangle still yields the same
 * (non-empty) lists rather than empty ones.
 */
export function rectRowsCols(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): { rows: number[]; cols: number[] } {
  const firstRow = Math.min(startRow, endRow);
  const lastRow = Math.max(startRow, endRow);
  const firstCol = Math.min(startCol, endCol);
  const lastCol = Math.max(startCol, endCol);
  const rows: number[] = [];
  const cols: number[] = [];
  for (let r = firstRow; r <= lastRow; r++) rows.push(r);
  for (let c = firstCol; c <= lastCol; c++) cols.push(c);
  return { rows, cols };
}

/** Resolved named-range coordinates (mirrors backend.ts NamedRangeCoords). */
export interface NamedRangeCoordsLike {
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Enumerate every cell coordinate in a named range, row-major (top-to-bottom,
 * left-to-right). Used to read/seed the 2D values mirror and to write setValues.
 */
export function namedRangeCells(coords: NamedRangeCoordsLike): GridCoord[] {
  const out: GridCoord[] = [];
  for (let r = coords.startRow; r <= coords.endRow; r++) {
    for (let c = coords.startCol; c <= coords.endCol; c++) {
      out.push({ sheetIndex: coords.sheetIndex, row: r, col: c });
    }
  }
  return out;
}

/** True if (row, col) falls within the named range. */
export function namedRangeContains(
  coords: NamedRangeCoordsLike,
  row: number,
  col: number,
): boolean {
  return (
    row >= coords.startRow &&
    row <= coords.endRow &&
    col >= coords.startCol &&
    col <= coords.endCol
  );
}

/** True if (row, col) falls within the table's full extent (header included). */
export function tableContains(table: TableLike, row: number, col: number): boolean {
  return (
    row >= table.startRow &&
    row <= table.endRow &&
    col >= table.startCol &&
    col <= table.endCol
  );
}
