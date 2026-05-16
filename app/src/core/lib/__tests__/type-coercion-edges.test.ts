//! FILENAME: app/src/core/lib/__tests__/type-coercion-edges.test.ts
// PURPOSE: Exercise JavaScript type coercion edge cases that can cause subtle bugs
// CONTEXT: Tests core utility functions with inputs that exploit JS loose typing

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types";
import { parseFormulaReferences } from "../formulaRefParser";
import { scrollToVisibleRange } from "../scrollUtils";
import { isNumericValue, isErrorValue } from "../gridRenderer/styles/cellFormatting";

// ---------------------------------------------------------------------------
// columnToLetter with non-standard inputs
// ---------------------------------------------------------------------------

describe("columnToLetter with type-coercion traps", () => {
  it("string number '0' coerced to number gives A", () => {
    // JS: Number("0") === 0, but passing a string to a number param is a common bug
    expect(columnToLetter(Number("0"))).toBe("A");
  });

  it("string number '26' coerced to number gives AA", () => {
    expect(columnToLetter(Number("26"))).toBe("AA");
  });

  it("boolean true coerced to 1 gives B", () => {
    // In JS, true coerces to 1 in numeric context
    expect(columnToLetter(Number(true))).toBe("B");
  });

  it("boolean false coerced to 0 gives A", () => {
    expect(columnToLetter(Number(false))).toBe("A");
  });

  it("NaN input produces some string (does not throw)", () => {
    // columnToLetter(NaN) - the while loop condition NaN >= 0 is false
    // so it returns empty string
    const result = columnToLetter(NaN);
    expect(typeof result).toBe("string");
  });

  it("negative input produces some string (does not throw)", () => {
    const result = columnToLetter(-1);
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// letterToColumn with non-standard inputs
// ---------------------------------------------------------------------------

describe("letterToColumn with type-coercion traps", () => {
  it("numeric input 0 coerced via charCodeAt gives wrong result but does not crash", () => {
    // String(0) === "0", charCodeAt gives 48, 48 - 64 = -16
    const result = letterToColumn(String(0));
    expect(typeof result).toBe("number");
  });

  it("numeric input 26 coerced to string gives nonsensical but stable result", () => {
    const result = letterToColumn(String(26));
    expect(typeof result).toBe("number");
  });

  it("leading whitespace ' A ' is not trimmed - gives wrong column", () => {
    // letterToColumn does not trim, so " A " includes space chars
    const withSpaces = letterToColumn(" A ");
    const clean = letterToColumn("A");
    // They should differ because spaces have different char codes
    expect(withSpaces).not.toBe(clean);
  });

  it("trailing whitespace 'A ' differs from 'A'", () => {
    const withTrailing = letterToColumn("A ");
    const clean = letterToColumn("A");
    expect(withTrailing).not.toBe(clean);
  });

  it("lowercase 'a' differs from uppercase 'A' (no case normalization)", () => {
    // letterToColumn uses charCodeAt - 64, lowercase 'a' is 97 - 64 = 33
    const lower = letterToColumn("a");
    const upper = letterToColumn("A");
    expect(lower).not.toBe(upper);
  });

  it("empty string returns -1", () => {
    // result starts at 0, loop never runs, return 0 - 1 = -1
    expect(letterToColumn("")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// parseFormulaReferences with type-coercion trap formulas
// ---------------------------------------------------------------------------

describe("parseFormulaReferences with coercion-trap formulas", () => {
  it("=TRUE+1 does not extract cell references from TRUE", () => {
    // TRUE should not be parsed as a cell ref (T-R-U-E does not match column pattern)
    // Actually TRUE matches the regex: T is column, RUE... no, the regex needs digits after letters
    const refs = parseFormulaReferences("=TRUE+1");
    // "TRUE" has no row digits, so should not match as a cell ref
    expect(refs).toHaveLength(0);
  });

  it("=1/0 produces no references (division by zero literal)", () => {
    const refs = parseFormulaReferences("=1/0");
    expect(refs).toHaveLength(0);
  });

  it("=A1+TRUE extracts only A1", () => {
    const refs = parseFormulaReferences("=A1+TRUE");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].startCol).toBe(0);
  });

  it("=FALSE*B2 extracts only B2", () => {
    const refs = parseFormulaReferences("=FALSE*B2");
    expect(refs).toHaveLength(1);
    expect(refs[0].startCol).toBe(1);
  });

  it("formula with numeric-looking ref =A0 produces no valid refs (row 0 maps to -1)", () => {
    // Row "0" -> parseInt("0") - 1 = -1, which is < 0, so skipped
    const refs = parseFormulaReferences("=A0");
    expect(refs).toHaveLength(0);
  });

  it("=INFINITY has no cell refs", () => {
    const refs = parseFormulaReferences("=INFINITY");
    expect(refs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scrollToVisibleRange with string dimensions in Map keys
// ---------------------------------------------------------------------------

describe("scrollToVisibleRange with string-typed Map keys", () => {
  it("returns correct range with all-number config", () => {
    const config = {
      defaultCellWidth: 100,
      defaultCellHeight: 25,
      rowHeaderWidth: 50,
      colHeaderHeight: 30,
      totalRows: 1000,
      totalCols: 26,
      frozenRows: 0,
      frozenCols: 0,
    };
    const range = scrollToVisibleRange(0, 0, config as any, 800, 600);
    expect(range.startRow).toBe(0);
    expect(range.startCol).toBe(0);
    expect(typeof range.endRow).toBe("number");
    expect(typeof range.endCol).toBe("number");
  });

  it("string scroll values coerced via Math.floor still produce numbers", () => {
    const config = {
      defaultCellWidth: 100,
      defaultCellHeight: 25,
      rowHeaderWidth: 50,
      colHeaderHeight: 30,
      totalRows: 1000,
      totalCols: 26,
      frozenRows: 0,
      frozenCols: 0,
    };
    // Simulating what happens if scroll values come as strings from DOM
    const range = scrollToVisibleRange(
      Number("250"),
      Number("500"),
      config as any,
      800,
      600,
    );
    expect(range.startRow).toBe(20);
    expect(range.startCol).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// isNumericValue with JS edge cases
// ---------------------------------------------------------------------------

describe("isNumericValue with JS coercion edge cases", () => {
  it("'NaN' is not numeric", () => {
    expect(isNumericValue("NaN")).toBe(false);
  });

  it("'Infinity' is not numeric (isFinite check)", () => {
    expect(isNumericValue("Infinity")).toBe(false);
  });

  it("'-Infinity' is not numeric", () => {
    expect(isNumericValue("-Infinity")).toBe(false);
  });

  it("empty string is not numeric", () => {
    expect(isNumericValue("")).toBe(false);
  });

  it("single space ' ' is not numeric", () => {
    // " " trimmed and stripped -> "", Number("") === 0 but cleaned === ""
    expect(isNumericValue(" ")).toBe(false);
  });

  it("'0x1F' (hex literal) is numeric in JS", () => {
    // Number("0x1F") === 31, isFinite(31) === true
    const result = isNumericValue("0x1F");
    // The function strips $ % , and spaces, leaving "0x1F"
    // Number("0x1F") === 31, so this should be true
    expect(result).toBe(true);
  });

  it("'1e3' (scientific notation) is numeric", () => {
    expect(isNumericValue("1e3")).toBe(true);
  });

  it("'1_000' with underscore separator is NOT numeric in JS", () => {
    // Number("1_000") === NaN in JavaScript
    expect(isNumericValue("1_000")).toBe(false);
  });

  it("'  42  ' with whitespace is numeric after trim", () => {
    expect(isNumericValue("  42  ")).toBe(true);
  });

  it("'$1,000' with currency formatting is numeric", () => {
    expect(isNumericValue("$1,000")).toBe(true);
  });

  it("'(100)' accounting negative is numeric", () => {
    // Cleaned: stripped parens -> "-100"
    expect(isNumericValue("(100)")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isErrorValue with whitespace and case variations
// ---------------------------------------------------------------------------

describe("isErrorValue with whitespace and case edge cases", () => {
  it("' #REF! ' with leading space - toUpperCase still works but startsWith may fail", () => {
    // The function does value.toUpperCase() then checks startsWith
    // " #REF! ".toUpperCase() === " #REF! " - starts with space, not #
    expect(isErrorValue(" #REF! ")).toBe(false);
  });

  it("'#ref!' lowercase is detected (toUpperCase normalizes)", () => {
    expect(isErrorValue("#ref!")).toBe(true);
  });

  it("'#Ref!' mixed case is detected", () => {
    expect(isErrorValue("#Ref!")).toBe(true);
  });

  it("'#VALUE!' exact match works", () => {
    expect(isErrorValue("#VALUE!")).toBe(true);
  });

  it("'#DIV/0!' works", () => {
    expect(isErrorValue("#DIV/0!")).toBe(true);
  });

  it("'#n/a' lowercase works", () => {
    expect(isErrorValue("#n/a")).toBe(true);
  });

  it("'#ERROR' without trailing ! works", () => {
    expect(isErrorValue("#ERROR")).toBe(true);
  });

  it("empty string is not an error", () => {
    expect(isErrorValue("")).toBe(false);
  });
});
