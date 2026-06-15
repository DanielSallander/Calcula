//! FILENAME: app/src/api/scriptHost/__tests__/objectCoords.test.ts
// PURPOSE: Pin the pure coordinate math used by the table / namedRange object
//          script types (host-side resolution of logical indices -> grid coords).

import { describe, it, expect } from "vitest";
import {
  tableHeaderOffset,
  tableDataRowCount,
  tableCellCoord,
  tableHeaders,
  tableContains,
  namedRangeCells,
  namedRangeContains,
  type TableLike,
  type NamedRangeCoordsLike,
} from "../objectCoords";

function makeTable(overrides: Partial<TableLike> = {}): TableLike {
  return {
    sheetIndex: 0,
    startRow: 5,
    startCol: 2,
    endRow: 10,
    endCol: 4,
    styleOptions: { headerRow: true, totalRow: false },
    columns: [{ name: "Name" }, { name: "Amount" }, { name: "Total" }],
    ...overrides,
  };
}

describe("tableHeaderOffset", () => {
  it("is 1 when a header row is shown, 0 otherwise", () => {
    expect(tableHeaderOffset(makeTable())).toBe(1);
    expect(
      tableHeaderOffset(makeTable({ styleOptions: { headerRow: false, totalRow: false } })),
    ).toBe(0);
  });
});

describe("tableDataRowCount", () => {
  it("excludes the header row", () => {
    // rows 5..10 inclusive = 6 rows; minus 1 header = 5 data rows
    expect(tableDataRowCount(makeTable())).toBe(5);
  });

  it("excludes header AND totals row", () => {
    expect(
      tableDataRowCount(makeTable({ styleOptions: { headerRow: true, totalRow: true } })),
    ).toBe(4);
  });

  it("counts all rows when neither header nor totals shown", () => {
    expect(
      tableDataRowCount(makeTable({ styleOptions: { headerRow: false, totalRow: false } })),
    ).toBe(6);
  });

  it("never goes negative for a degenerate table", () => {
    expect(
      tableDataRowCount(
        makeTable({ startRow: 5, endRow: 5, styleOptions: { headerRow: true, totalRow: true } }),
      ),
    ).toBe(0);
  });
});

describe("tableCellCoord", () => {
  it("maps the first data cell past the header row", () => {
    // header at row 5, first data row = 6, first column = 2
    expect(tableCellCoord(makeTable(), 0, 0)).toEqual({ sheetIndex: 0, row: 6, col: 2 });
  });

  it("maps an interior cell", () => {
    expect(tableCellCoord(makeTable(), 2, 1)).toEqual({ sheetIndex: 0, row: 8, col: 3 });
  });

  it("maps the first data cell with no header row", () => {
    const t = makeTable({ styleOptions: { headerRow: false, totalRow: false } });
    expect(tableCellCoord(t, 0, 0)).toEqual({ sheetIndex: 0, row: 5, col: 2 });
  });

  it("returns null for an out-of-range column", () => {
    expect(tableCellCoord(makeTable(), 0, 3)).toBeNull(); // only 3 cols (0..2)
  });

  it("returns null for a row past the data area", () => {
    expect(tableCellCoord(makeTable(), 5, 0)).toBeNull(); // only 5 data rows (0..4)
  });

  it("returns null for negative indices", () => {
    expect(tableCellCoord(makeTable(), -1, 0)).toBeNull();
    expect(tableCellCoord(makeTable(), 0, -1)).toBeNull();
  });

  it("honors a non-zero sheet index", () => {
    expect(tableCellCoord(makeTable({ sheetIndex: 3 }), 0, 0)).toEqual({
      sheetIndex: 3,
      row: 6,
      col: 2,
    });
  });
});

describe("tableHeaders / tableContains", () => {
  it("returns column names in order", () => {
    expect(tableHeaders(makeTable())).toEqual(["Name", "Amount", "Total"]);
  });

  it("includes the header row in containment", () => {
    const t = makeTable();
    expect(tableContains(t, 5, 2)).toBe(true); // header
    expect(tableContains(t, 10, 4)).toBe(true); // last cell
    expect(tableContains(t, 4, 2)).toBe(false); // above
    expect(tableContains(t, 11, 4)).toBe(false); // below
    expect(tableContains(t, 6, 5)).toBe(false); // right of range
  });
});

describe("namedRange helpers", () => {
  const coords: NamedRangeCoordsLike = {
    sheetIndex: 1,
    startRow: 0,
    startCol: 0,
    endRow: 1,
    endCol: 1,
  };

  it("enumerates cells row-major", () => {
    expect(namedRangeCells(coords)).toEqual([
      { sheetIndex: 1, row: 0, col: 0 },
      { sheetIndex: 1, row: 0, col: 1 },
      { sheetIndex: 1, row: 1, col: 0 },
      { sheetIndex: 1, row: 1, col: 1 },
    ]);
  });

  it("returns empty for an inverted/degenerate range", () => {
    expect(
      namedRangeCells({ sheetIndex: 0, startRow: 5, startCol: 5, endRow: 4, endCol: 4 }),
    ).toEqual([]);
  });

  it("tests containment", () => {
    expect(namedRangeContains(coords, 0, 0)).toBe(true);
    expect(namedRangeContains(coords, 1, 1)).toBe(true);
    expect(namedRangeContains(coords, 2, 0)).toBe(false);
    expect(namedRangeContains(coords, 0, 2)).toBe(false);
  });
});
