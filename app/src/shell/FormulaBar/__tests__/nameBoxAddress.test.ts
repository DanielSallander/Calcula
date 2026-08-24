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
  hasTableBracket,
  parseStructuredReference,
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

// ---------------------------------------------------------------------------
// Structured (table) references
// ---------------------------------------------------------------------------
// SAME CLASS OF SILENT FAILURE as the range above, one namespace over. A table
// reference carries a '[', which is neither an address character nor a name
// character, so every bracketed spelling missed the address branch, missed the
// defined-name lookup and missed `isValidName` — and the box refused the exact
// text it had just displayed for the selection, with a sentence about cell
// references.

describe("parseStructuredReference - what a table entry looks like", () => {
  it("reads a column reference", () => {
    expect(parseStructuredReference("Sales[Margin]")).toEqual({
      tableName: "Sales",
      specifier: "Margin",
    });
  });

  it("reads the whole-table and part specifiers", () => {
    expect(parseStructuredReference("Sales[#All]")).toEqual({
      tableName: "Sales",
      specifier: "#All",
    });
    expect(parseStructuredReference("Sales[#Headers]")).toEqual({
      tableName: "Sales",
      specifier: "#Headers",
    });
  });

  it("reads the doubled-bracket spelling Excel writes", () => {
    expect(parseStructuredReference("Sales[[#Data]]")).toEqual({
      tableName: "Sales",
      specifier: "[#Data]",
    });
  });

  it("keeps a column name with spaces intact", () => {
    expect(parseStructuredReference("Q1 Sales[Unit Price]")).toBeNull();
    expect(parseStructuredReference("Sales[Unit Price]")).toEqual({
      tableName: "Sales",
      specifier: "Unit Price",
    });
  });

  it("ignores surrounding whitespace", () => {
    expect(parseStructuredReference("  Sales[Margin]  ")).toEqual({
      tableName: "Sales",
      specifier: "Margin",
    });
  });

  it("refuses an unbalanced or trailing bracket", () => {
    expect(parseStructuredReference("Sales[Margin")).toBeNull();
    expect(parseStructuredReference("Sales[[#Data]")).toBeNull();
    expect(parseStructuredReference("Sales[Margin]]")).toBeNull();
    expect(parseStructuredReference("Sales[Margin]x")).toBeNull();
  });

  it("refuses TWO references pasted together", () => {
    // Both end in ']' and both balance overall, so only walking the brackets
    // from the first one catches them. Left in, "Sales[Margin]Costs[Units]"
    // would be sent to the backend as the table Sales with the specifier
    // "Margin]Costs[Units" — a refusal phrased in terms of a reference the user
    // never typed.
    expect(parseStructuredReference("Sales[Margin]Costs[Units]")).toBeNull();
    expect(parseStructuredReference("Sales[Margin] Sales[Units]")).toBeNull();
  });

  it("refuses an empty table name or an empty specifier", () => {
    expect(parseStructuredReference("[Margin]")).toBeNull();
    expect(parseStructuredReference("Sales[]")).toBeNull();
    expect(parseStructuredReference("Sales[  ]")).toBeNull();
  });

  it("refuses a table name that is not a name", () => {
    expect(parseStructuredReference("1Sales[Margin]")).toBeNull();
    expect(parseStructuredReference("Sa les[Margin]")).toBeNull();
  });

  it("is null for an entry with no bracket at all — that is a name, not a table", () => {
    expect(parseStructuredReference("Sales")).toBeNull();
    expect(parseStructuredReference("A1:B2")).toBeNull();
  });
});

describe("hasTableBracket - telling 'not a table reference' from 'a broken one'", () => {
  it("is true as soon as a bracket appears, parseable or not", () => {
    expect(hasTableBracket("Sales[Margin]")).toBe(true);
    // The malformed ones matter most: the caller must REPORT these rather than
    // pass them to the create-a-name branch, which refuses them with the wrong
    // sentence.
    expect(hasTableBracket("Sales[Margin")).toBe(true);
    expect(hasTableBracket("Sales[]")).toBe(true);
  });

  it("is false for the entries the other branches own", () => {
    for (const text of ["A1", "A1:B10", "Sheet1!A1", "SalesData"]) {
      expect(hasTableBracket(text)).toBe(false);
    }
  });
});
