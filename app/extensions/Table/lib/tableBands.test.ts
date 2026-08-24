//! FILENAME: app/extensions/Table/lib/tableBands.test.ts
// PURPOSE: Which rows of a table are data, and what each selection gesture
//          offers inside it — one row of the table of cases at a time.
// CONTEXT: Nothing here used to exist, and that is the defect: the grid keyboard
//          had no way to learn that a table was under the cursor, so Ctrl+A,
//          Ctrl+Shift+Space, Ctrl+Space and Shift+Space all selected the whole
//          SHEET. That is not an error the user can see — the selection they
//          asked for and the selection they got are both real selections, and
//          the wrong one is simply bigger.
//
//          The "one row down when there is a header" arithmetic was already
//          written twice (here and in the column-header click interceptor) and
//          the keyboard and the Name Box were about to make a third and fourth
//          copy. Every assertion below is against ONE implementation, which is
//          the point of the module.

import { describe, it, expect } from "vitest";
import {
  tableBands,
  tableDataBlock,
  tableWholeBlock,
  tableSelectionScope,
  type TableGeometry,
} from "./tableBands";

/** A5:C10 — six rows, three columns — with the flags under test. */
function table(flags: { headerRow: boolean; totalRow: boolean }): TableGeometry {
  return {
    startRow: 4,
    startCol: 0,
    endRow: 9,
    endCol: 2,
    styleOptions: flags,
  };
}

describe("tableBands - where the data rows are", () => {
  it("skips the header row and the totals row", () => {
    expect(tableBands(table({ headerRow: true, totalRow: true }))).toEqual({
      headerRow: 4,
      totalsRow: 9,
      dataStartRow: 5,
      dataEndRow: 8,
    });
  });

  it("takes every row when the table shows neither", () => {
    expect(tableBands(table({ headerRow: false, totalRow: false }))).toEqual({
      headerRow: null,
      totalsRow: null,
      dataStartRow: 4,
      dataEndRow: 9,
    });
  });

  it("skips only the header when there is no totals row", () => {
    expect(tableBands(table({ headerRow: true, totalRow: false }))).toMatchObject({
      dataStartRow: 5,
      dataEndRow: 9,
    });
  });

  it("skips only the totals row when there is no header", () => {
    expect(tableBands(table({ headerRow: false, totalRow: true }))).toMatchObject({
      dataStartRow: 4,
      dataEndRow: 8,
    });
  });

  it("reports the whole table when the arithmetic would invert the band", () => {
    // A one-row table that is all header has NO data rows, and the naive
    // subtraction answers startRow 5 > endRow 4 — a block that paints nothing
    // and selects nothing, so a gesture inside the table would look ignored.
    const headerOnly: TableGeometry = {
      startRow: 4,
      startCol: 0,
      endRow: 4,
      endCol: 2,
      styleOptions: { headerRow: true, totalRow: false },
    };
    expect(tableBands(headerOnly)).toMatchObject({ dataStartRow: 4, dataEndRow: 4 });
    expect(tableDataBlock(headerOnly)).toEqual(tableWholeBlock(headerOnly));
  });
});

describe("tableSelectionScope - what each gesture selects inside a table", () => {
  it("Ctrl+A offers the data, then the whole table", () => {
    const scope = tableSelectionScope(table({ headerRow: true, totalRow: true }));
    expect(scope.allSteps).toEqual([
      { startRow: 5, startCol: 0, endRow: 8, endCol: 2 },
      { startRow: 4, startCol: 0, endRow: 9, endCol: 2 },
    ]);
  });

  it("Ctrl+Space offers the column's data rows, then the whole table's rows", () => {
    const scope = tableSelectionScope(table({ headerRow: true, totalRow: true }));
    expect(scope.columnSteps).toEqual([
      { startRow: 5, endRow: 8 },
      { startRow: 4, endRow: 9 },
    ]);
  });

  it("Shift+Space offers the table's columns, and only that", () => {
    // Excel's Shift+Space in a table selects the table's row and then the SHEET
    // row; a "row including the header" step would name two rows, which a row
    // gesture cannot mean.
    const scope = tableSelectionScope(table({ headerRow: true, totalRow: true }));
    expect(scope.rowSteps).toEqual([{ startCol: 0, endCol: 2 }]);
  });

  it("drops the second step when the whole table IS the data", () => {
    // Without a header and without totals the two blocks are identical, and a
    // second press that reselects what is already selected reads as a dead key.
    const scope = tableSelectionScope(table({ headerRow: false, totalRow: false }));
    expect(scope.allSteps).toEqual([{ startRow: 4, startCol: 0, endRow: 9, endCol: 2 }]);
    expect(scope.columnSteps).toEqual([{ startRow: 4, endRow: 9 }]);
  });

  it("keeps the second step when only a totals row makes the table wider", () => {
    const scope = tableSelectionScope(table({ headerRow: false, totalRow: true }));
    expect(scope.allSteps).toHaveLength(2);
    expect(scope.columnSteps).toEqual([
      { startRow: 4, endRow: 8 },
      { startRow: 4, endRow: 9 },
    ]);
  });

  it("orders every gesture NARROWEST FIRST", () => {
    // The grid keyboard walks these in order and stops at the sheet. A list in
    // the other order would widen on the first press and never narrow at all.
    const scope = tableSelectionScope(table({ headerRow: true, totalRow: true }));
    for (const steps of [scope.allSteps]) {
      for (let i = 1; i < steps.length; i++) {
        const prev = steps[i - 1];
        const next = steps[i];
        expect(next.startRow).toBeLessThanOrEqual(prev.startRow);
        expect(next.endRow).toBeGreaterThanOrEqual(prev.endRow);
      }
    }
    for (let i = 1; i < scope.columnSteps.length; i++) {
      expect(scope.columnSteps[i].startRow).toBeLessThanOrEqual(scope.columnSteps[i - 1].startRow);
      expect(scope.columnSteps[i].endRow).toBeGreaterThanOrEqual(scope.columnSteps[i - 1].endRow);
    }
  });
});
