//! FILENAME: app/src/shell/FormulaBar/__tests__/nameBoxAddress.test.ts
// PURPOSE: Every form the Name Box accepts, one row at a time.
// CONTEXT: The defect this locks down produced NO ERROR. Typing "A1:A10" and
//          pressing Enter missed the single-cell regex, missed the defined-name
//          lookup and missed `isValidName` (':' is not a name character), so the
//          box quietly put the old address back: no selection, no navigation, no
//          message, nothing in the console. Three more forms Excel accepts
//          failed identically — "$A$1", "Sheet1!A1", "'My Sheet'!A1:B2" — which
//          is why the parser is one module with one table of cases rather than a
//          regex per call site.

import { describe, it, expect } from "vitest";
import {
  parseNameBoxAddress,
  isAddressLike,
  MAX_ROW_INDEX,
  MAX_COL_INDEX,
} from "../NameBox.address";

/**
 * Parse, asserting that it parsed AT ALL. Every "these two spellings mean the
 * same block" case below compares two parses, and two nulls compare equal — so
 * without this, a parser that understood nothing would pass them all. (Measured:
 * disabling the range branch left four of them green.)
 */
function parsed(text: string): NonNullable<ReturnType<typeof parseNameBoxAddress>> {
  const result = parseNameBoxAddress(text);
  expect(result, `"${text}" should parse as an address`).not.toBeNull();
  return result!;
}

describe("parseNameBoxAddress - single cells", () => {
  it("parses a bare cell as a one-cell block on the current sheet", () => {
    expect(parseNameBoxAddress("B3")).toEqual({
      sheetName: null,
      startRow: 2,
      startCol: 1,
      endRow: 2,
      endCol: 1,
      type: "cells",
      isSingleCell: true,
    });
  });

  it("accepts lower case, as Excel does", () => {
    expect(parsed("b3")).toEqual(parsed("B3"));
  });

  it("accepts the absolute spelling and selects the same cell", () => {
    expect(parsed("$A$1")).toEqual(parsed("A1"));
  });

  it("accepts a half-absolute spelling", () => {
    expect(parsed("$A1")).toEqual(parsed("A1"));
    expect(parsed("A$1")).toEqual(parsed("A1"));
  });

  it("ignores surrounding whitespace", () => {
    expect(parsed("  C7  ")).toEqual(parsed("C7"));
  });
});

describe("parseNameBoxAddress - ranges (the form that did nothing at all)", () => {
  it("parses A1:B10 as the block it names", () => {
    expect(parseNameBoxAddress("A1:B10")).toEqual({
      sheetName: null,
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 1,
      type: "cells",
      isSingleCell: false,
    });
  });

  it("parses the absolute spelling of a range", () => {
    expect(parsed("$A$1:$B$10")).toEqual(parsed("A1:B10"));
  });

  it("normalises an inverted range - B10:A1 is the same block as A1:B10", () => {
    // The selection model assumes start <= end; an inverted selection paints
    // nothing, which would look exactly like the silent revert this replaced.
    expect(parsed("B10:A1")).toEqual(parsed("A1:B10"));
  });

  it("reports a degenerate range (A1:A1) as a single cell", () => {
    expect(parsed("A1:A1").isSingleCell).toBe(true);
  });
});

describe("parseNameBoxAddress - whole columns and rows", () => {
  it("parses A:C as a column selection spanning every row", () => {
    expect(parseNameBoxAddress("A:C")).toEqual({
      sheetName: null,
      startRow: 0,
      startCol: 0,
      endRow: MAX_ROW_INDEX,
      endCol: 2,
      type: "columns",
      isSingleCell: false,
    });
  });

  it("parses 2:5 as a row selection spanning every column", () => {
    expect(parseNameBoxAddress("2:5")).toEqual({
      sheetName: null,
      startRow: 1,
      startCol: 0,
      endRow: 4,
      endCol: MAX_COL_INDEX,
      type: "rows",
      isSingleCell: false,
    });
  });

  it("normalises an inverted column or row span", () => {
    expect(parsed("C:A")).toEqual(parsed("A:C"));
    expect(parsed("5:2")).toEqual(parsed("2:5"));
  });
});

describe("parseNameBoxAddress - sheet qualifiers", () => {
  it("parses an unquoted sheet prefix", () => {
    expect(parseNameBoxAddress("Sheet1!A1")).toEqual({
      sheetName: "Sheet1",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      type: "cells",
      isSingleCell: true,
    });
  });

  it("keeps the sheet name's case for the lookup to match on", () => {
    expect(parsed("myData!A1").sheetName).toBe("myData");
  });

  it("parses a quoted sheet name with a space", () => {
    expect(parseNameBoxAddress("'My Sheet'!A1:B2")).toEqual({
      sheetName: "My Sheet",
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
      type: "cells",
      isSingleCell: false,
    });
  });

  it("unescapes the doubled apostrophe Excel uses inside a quoted name", () => {
    expect(parsed("'It''s'!A1").sheetName).toBe("It's");
  });

  it("refuses an unterminated quote instead of guessing a sheet name", () => {
    expect(parseNameBoxAddress("'My Sheet!A1")).toBeNull();
  });

  it("refuses a 3D reference rather than hunting for a sheet called Sheet1:Sheet3", () => {
    expect(parseNameBoxAddress("Sheet1:Sheet3!A1")).toBeNull();
  });

  it("refuses an empty sheet name", () => {
    expect(parseNameBoxAddress("!A1")).toBeNull();
  });
});

describe("parseNameBoxAddress - what is NOT an address", () => {
  it("rejects a defined name", () => {
    expect(parseNameBoxAddress("SalesData")).toBeNull();
  });

  it("rejects a name that merely starts like a column", () => {
    // "ABCD1" is four column letters, which no column has; Excel allows it as a
    // defined name, so the parser must not claim it.
    expect(parseNameBoxAddress("ABCD1")).toBeNull();
  });

  it("rejects a column past XFD", () => {
    expect(parseNameBoxAddress("XFD1")).not.toBeNull();
    expect(parseNameBoxAddress("XFE1")).toBeNull();
  });

  it("rejects a row past the last one", () => {
    expect(parseNameBoxAddress("A1048576")).not.toBeNull();
    expect(parseNameBoxAddress("A1048577")).toBeNull();
  });

  it("rejects row zero", () => {
    expect(parseNameBoxAddress("A0")).toBeNull();
  });

  it("rejects an empty entry", () => {
    expect(parseNameBoxAddress("")).toBeNull();
    expect(parseNameBoxAddress("   ")).toBeNull();
  });
});

describe("isAddressLike - the rule that keeps a name from being an address", () => {
  it("is true for the forms the box navigates to", () => {
    for (const text of ["A1", "$A$1", "A1:B10", "A:C", "2:5", "Sheet1!A1"]) {
      expect(isAddressLike(text)).toBe(true);
    }
  });

  it("is false for names a user may define", () => {
    for (const text of ["SalesData", "_total", "Rate.2026", "ABCD1", "XFE1"]) {
      expect(isAddressLike(text)).toBe(false);
    }
  });
});
