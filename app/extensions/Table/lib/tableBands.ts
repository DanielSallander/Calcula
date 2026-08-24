//! FILENAME: app/extensions/Table/lib/tableBands.ts
// PURPOSE: Where a table's HEADER, DATA and TOTALS rows are, and what the three
//          Excel selection gestures should select inside it.
// CONTEXT: "the data starts one row down when there is a header, and stops one
//          row short when there is a totals row" is a RECIPE, and a copied
//          recipe is a second source of truth that drifts on the owner's first
//          default change. It was already written twice — the column-header
//          click interceptor scoped a header click to the data rows with its
//          own copy — and the grid keyboard and the Name Box were about to make
//          a third and a fourth. This module is the extension's single copy;
//          the backend's `data_start_row()` / `data_end_row()` is the one on the
//          other side of IPC, which is why anything that can ASK the backend
//          (the Name Box resolves `Table1[#Data]`) asks instead of re-deriving.
// NOTE:    Pure. No @api import, no React, no backend reach — the input is a
//          structural subset of the backend `Table`, so one row of the table of
//          cases below is one test.

/**
 * The part of a backend `Table` this module needs. Structural on purpose: a
 * `Table` is assignable to it, and a test can write a five-field literal
 * instead of a twelve-field one.
 */
export interface TableGeometry {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  styleOptions: { headerRow: boolean; totalRow: boolean };
}

/** A block of cells, in the grid's own 0-based inclusive coordinates. */
export interface CellBlock {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Which rows of a table are what. */
export interface TableBands {
  /** The header row's index, or null when the table shows no header. */
  headerRow: number | null;
  /** The totals row's index, or null when the table shows no totals row. */
  totalsRow: number | null;
  /** First data row (inclusive). */
  dataStartRow: number;
  /** Last data row (inclusive). */
  dataEndRow: number;
}

/**
 * The progressive blocks a selection gesture offers inside a region, NARROWEST
 * FIRST. Each gesture's last stop is the whole sheet, which the grid decides on
 * its own — so a region declares only what is narrower than that.
 *
 * The grid keyboard reads this off the region's `data` bag
 * (`@api/gridOverlays`), which is how a table's geometry reaches Core without
 * Core learning what a table is. Keep the field names in step with
 * `RegionSelectionScope` in `app/src/core/hooks/useGridKeyboard.ts`; the pairing
 * is pinned by `tableSelectionScope.test.ts`, which reads that file.
 */
export interface RegionSelectionScope {
  /** Row bands for the column gesture (Ctrl+Space); the gesture supplies the column. */
  columnSteps: Array<{ startRow: number; endRow: number }>;
  /** Column bands for the row gesture (Shift+Space); the gesture supplies the row. */
  rowSteps: Array<{ startCol: number; endCol: number }>;
  /** Whole blocks for the select-all gesture (Ctrl+A / Ctrl+Shift+Space). */
  allSteps: CellBlock[];
}

/**
 * Split a table into its header / data / totals rows.
 *
 * A table with a header and nothing under it has NO data rows, and the naive
 * arithmetic answers with an inverted band (dataStartRow > dataEndRow) that
 * paints nothing and selects nothing. Such a table reports the whole table as
 * its data band instead: a gesture inside it must still select something inside
 * it, and "the rows that are there" is the only honest answer.
 */
export function tableBands(table: TableGeometry): TableBands {
  const headerRow = table.styleOptions.headerRow ? table.startRow : null;
  const totalsRow = table.styleOptions.totalRow ? table.endRow : null;

  const dataStartRow = headerRow === null ? table.startRow : table.startRow + 1;
  const dataEndRow = totalsRow === null ? table.endRow : table.endRow - 1;

  if (dataStartRow > dataEndRow) {
    return {
      headerRow,
      totalsRow,
      dataStartRow: table.startRow,
      dataEndRow: table.endRow,
    };
  }

  return { headerRow, totalsRow, dataStartRow, dataEndRow };
}

/** The table's data body: the rows between the header and the totals row. */
export function tableDataBlock(table: TableGeometry): CellBlock {
  const bands = tableBands(table);
  return {
    startRow: bands.dataStartRow,
    startCol: table.startCol,
    endRow: bands.dataEndRow,
    endCol: table.endCol,
  };
}

/** The whole table, header and totals row included. */
export function tableWholeBlock(table: TableGeometry): CellBlock {
  return {
    startRow: table.startRow,
    startCol: table.startCol,
    endRow: table.endRow,
    endCol: table.endCol,
  };
}

function sameBlock(a: CellBlock, b: CellBlock): boolean {
  return (
    a.startRow === b.startRow &&
    a.startCol === b.startCol &&
    a.endRow === b.endRow &&
    a.endCol === b.endCol
  );
}

/**
 * What Ctrl+Space, Shift+Space and Ctrl+A should select inside this table,
 * following Excel exactly:
 *
 *   Ctrl+Space   the column's DATA, then the whole table column (header and
 *                totals included), then the sheet column.
 *   Shift+Space  the table's row, then the sheet row.
 *   Ctrl+A       the table's data, then the whole table, then the sheet.
 *
 * A table with neither a header nor a totals row has only ONE narrower block on
 * the column and select-all gestures, and the duplicate step is dropped rather
 * than left in — a step that selects what is already selected reads as a dead
 * keypress.
 */
export function tableSelectionScope(table: TableGeometry): RegionSelectionScope {
  const data = tableDataBlock(table);
  const whole = tableWholeBlock(table);
  const wholeIsWider = !sameBlock(data, whole);

  const columnSteps = [{ startRow: data.startRow, endRow: data.endRow }];
  if (wholeIsWider) {
    columnSteps.push({ startRow: whole.startRow, endRow: whole.endRow });
  }

  const allSteps = [data];
  if (wholeIsWider) {
    allSteps.push(whole);
  }

  return {
    columnSteps,
    // One step only: Excel's Shift+Space inside a table selects the table's row
    // and then the sheet row. There is no "table row including the header",
    // because a row gesture already names ONE row.
    rowSteps: [{ startCol: table.startCol, endCol: table.endCol }],
    allSteps,
  };
}
