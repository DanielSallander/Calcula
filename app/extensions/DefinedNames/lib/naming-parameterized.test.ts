//! FILENAME: app/extensions/DefinedNames/lib/naming-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for name validation, ref round-trips, and LAMBDA parsing.

import { describe, it, expect, vi } from "vitest";

// Mock @api to avoid pulling in heavy dependencies.
vi.mock("@api", () => ({
  columnToLetter(col: number): string {
    let result = "";
    let c = col;
    while (c >= 0) {
      result = String.fromCharCode((c % 26) + 65) + result;
      c = Math.floor(c / 26) - 1;
    }
    return result;
  },
  letterToColumn(letters: string): number {
    let result = 0;
    for (let i = 0; i < letters.length; i++) {
      result = result * 26 + (letters.charCodeAt(i) - 64);
    }
    return result - 1;
  },
}));

// Mock @api/lib for lambdaUtils
vi.mock("@api/lib", () => ({}));

import { isValidName, formatRefersTo, parseRefersTo } from "./nameUtils";
import { buildLambdaRefersTo, parseLambdaRefersTo } from "./lambdaUtils";

// ============================================================================
// isValidName - 100 test cases
// ============================================================================

describe("isValidName", () => {
  // 40 valid names
  const validNames: [string, string][] = [
    ["MyName", "simple alpha"],
    ["_private", "starts with underscore"],
    ["\\backslash", "starts with backslash"],
    ["a", "single lowercase letter"],
    ["Z", "single uppercase letter"],
    ["_", "single underscore"],
    ["Name1", "alpha with trailing digit"],
    ["Revenue2024", "alpha with digits"],
    ["my.range", "contains dot"],
    ["_hidden.value", "underscore then dot"],
    ["TaxRate", "camelCase"],
    ["TOTAL", "all caps"],
    ["x1y2z3", "mixed alpha digits"],
    ["data_set", "contains underscore mid"],
    ["\\path.name", "backslash with dot"],
    ["A_very_long_name_with_underscores", "long with underscores"],
    ["col1.row2", "dot separated parts"],
    ["SUM_CUSTOM", "looks like function"],
    ["PI_VALUE", "looks like constant"],
    ["_1", "underscore then digit"],
    ["__double", "double underscore prefix"],
    ["abc123def456", "interleaved alpha digits"],
    ["Budget.Q1.2024", "multiple dots"],
    ["_a.b.c.d.e", "many dot segments"],
    ["MyNameIsVeryVeryLongButStillValid123", "long name"],
    ["AAAA", "repeated letters not a cell ref beyond col range"],
    ["XFEA1", "looks like cell ref but col > 16384"],
    ["XGG1", "col XGG beyond valid range"],
    ["\\sheet1", "backslash prefix"],
    ["Rate_2024.Q2", "complex mixed"],
    ["m", "single char lowercase"],
    ["N", "single char uppercase"],
    ["r1c1", "r1c1 style not blocked by cell ref check (valid col)"],
    ["item99.price", "dot with digits"],
    ["_0", "underscore zero"],
    ["Profit_Loss", "words with underscore"],
    ["v1x", "short alpha digit with trailing letter"],
    ["\\1", "backslash digit"],
    ["YearEnd", "two words"],
    ["XFED1048577", "cell ref but row > 1048576"],
  ];

  it.each(validNames)("valid: %s (%s)", (name) => {
    expect(isValidName(name)).toBe(true);
  });

  // 40 invalid names
  const invalidNames: [string, string][] = [
    ["1abc", "starts with digit"],
    ["123", "all digits"],
    ["0_start", "starts with zero"],
    ["9lives", "starts with 9"],
    ["my name", "contains space"],
    ["name!", "contains exclamation"],
    ["na@me", "contains at sign"],
    ["col#1", "contains hash"],
    ["val$ue", "contains dollar"],
    ["50%", "starts digit contains percent"],
    ["a b", "space in middle"],
    ["TRUE", "reserved word TRUE"],
    ["FALSE", "reserved word FALSE"],
    ["NULL", "reserved word NULL"],
    ["true", "reserved lowercase true"],
    ["false", "reserved lowercase false"],
    ["null", "reserved lowercase null"],
    ["True", "reserved mixed True"],
    ["False", "reserved mixed False"],
    ["Null", "reserved mixed Null"],
    ["A1", "cell reference A1"],
    ["B2", "cell reference B2"],
    ["Z100", "cell reference Z100"],
    ["AA1", "cell reference AA1"],
    ["XFD1", "cell reference XFD1 (last valid col)"],
    ["A1048576", "cell reference max row"],
    ["AB999", "cell reference AB999"],
    ["", "empty string"],
    ["name space", "contains space"],
    ["(parens)", "parentheses"],
    ["a+b", "plus sign"],
    ["a-b", "minus sign"],
    ["a*b", "asterisk"],
    ["a/b", "slash"],
    ["a=b", "equals sign"],
    ["a:b", "colon"],
    ["a;b", "semicolon"],
    ["a,b", "comma"],
    ["a&b", "ampersand"],
    ["a{b}", "braces"],
  ];

  it.each(invalidNames)("invalid: %s (%s)", (name) => {
    expect(isValidName(name)).toBe(false);
  });

  // 20 boundary cases
  const boundaryNames: [string, string, boolean][] = [
    ["_A1", "underscore prefix avoids cell ref", true],
    ["\\A1", "backslash prefix avoids cell ref", true],
    ["A1048577", "row beyond max", true],
    ["XFE1", "col XFE = 16385 > 16384", true],
    ["ZZZZZ1", "very large col letters", true],
    ["A0", "row 0 not valid cell ref so valid name", true],
    ["XFD1048576", "max valid cell ref", false],
    ["B1048576", "max row valid col", false],
    ["IV256", "old Excel max", false],
    ["C1", "simple cell ref", false],
    ["D10", "cell ref D10", false],
    ["E100", "cell ref E100", false],
    ["F1000", "cell ref F1000", false],
    ["G10000", "cell ref G10000", false],
    ["H100000", "cell ref H100000", false],
    ["I1000000", "cell ref I1000000", false],
    ["tRuE", "mixed case TRUE", false],
    ["fAlSe", "mixed case FALSE", false],
    ["nUlL", "mixed case NULL", false],
    ["AB12345", "multi-letter col with digits", false],
  ];

  it.each(boundaryNames)("boundary: %s (%s) -> %s", (name, _desc, expected) => {
    expect(isValidName(name)).toBe(expected);
  });
});

// ============================================================================
// formatRefersTo <-> parseRefersTo round-trip - 50 combos
// ============================================================================

describe("formatRefersTo / parseRefersTo round-trip", () => {
  const coordCombos: [string, number, number, number, number][] = [
    ["Sheet1", 0, 0, 0, 0],
    ["Sheet1", 0, 0, 0, 1],
    ["Sheet1", 0, 0, 1, 0],
    ["Sheet1", 0, 0, 9, 9],
    ["Sheet1", 5, 3, 5, 3],
    ["Sheet1", 0, 25, 0, 25],
    ["Sheet1", 0, 26, 0, 26],
    ["Sheet1", 99, 51, 99, 51],
    ["Sheet1", 0, 0, 99, 99],
    ["Sheet1", 10, 10, 20, 20],
    ["Data", 0, 0, 0, 0],
    ["Data", 1, 1, 5, 5],
    ["Data", 100, 0, 200, 0],
    ["Data", 0, 100, 0, 200],
    ["Summary", 0, 0, 999, 25],
    ["Summary", 50, 50, 50, 50],
    ["Sheet2", 0, 0, 0, 2],
    ["Sheet2", 3, 0, 3, 2],
    ["Sheet2", 0, 3, 2, 3],
    ["Sheet2", 1, 1, 1, 1],
    ["Budget", 0, 0, 11, 3],
    ["Budget", 5, 0, 5, 25],
    ["Sales", 0, 0, 49, 9],
    ["Sales", 10, 5, 20, 15],
    ["Q1", 0, 0, 0, 0],
    ["Q1", 1, 0, 1, 0],
    ["Q1", 0, 1, 0, 1],
    ["MySheet", 999, 0, 999, 0],
    ["MySheet", 0, 255, 0, 255],
    ["MySheet", 0, 256, 0, 256],
    ["Report", 0, 0, 0, 3],
    ["Report", 0, 0, 3, 0],
    ["Report", 2, 2, 8, 8],
    ["Report", 100, 100, 100, 100],
    ["Tab1", 0, 0, 1000, 100],
    ["Tab1", 50, 0, 50, 0],
    ["Tab2", 0, 50, 0, 50],
    ["Tab2", 999, 999, 999, 999],
    ["Sheet3", 5, 10, 15, 20],
    ["Sheet3", 0, 0, 0, 51],
    ["Main", 0, 0, 0, 0],
    ["Main", 10, 0, 20, 5],
    ["Aux", 3, 3, 7, 7],
    ["Aux", 0, 0, 49, 49],
    ["Raw", 0, 0, 0, 0],
    ["Raw", 500, 0, 500, 10],
    ["Calc", 0, 0, 0, 0],
    ["Calc", 25, 25, 50, 50],
    ["Final", 0, 0, 99, 0],
    ["Final", 0, 0, 0, 99],
  ];

  it.each(coordCombos)(
    "round-trip: %s [%d,%d]->[%d,%d]",
    (sheet, sr, sc, er, ec) => {
      const formatted = formatRefersTo(sheet, sr, sc, er, ec);
      const parsed = parseRefersTo(formatted);
      expect(parsed).not.toBeNull();
      expect(parsed!.sheetName).toBe(sheet);
      expect(parsed!.startRow).toBe(Math.min(sr, er));
      expect(parsed!.startCol).toBe(Math.min(sc, ec));
      expect(parsed!.endRow).toBe(Math.max(sr, er));
      expect(parsed!.endCol).toBe(Math.max(sc, ec));
    }
  );
});

// ============================================================================
// LAMBDA buildLambdaRefersTo / parseLambdaRefersTo round-trip - 30 combos
// ============================================================================

describe("LAMBDA build/parse round-trip", () => {
  const lambdaCombos: [string[], string][] = [
    [["x"], "x + 1"],
    [["x", "y"], "x + y"],
    [["a", "b", "c"], "a + b + c"],
    [["rate"], "rate * 100"],
    [["amount", "rate"], "amount * (1 + rate)"],
    [["n"], "IF(n <= 1, n, n * 2)"],
    [["val"], "ROUND(val, 2)"],
    [["x", "y", "z"], "x * y + z"],
    [["price", "qty"], "price * qty"],
    [["base", "exp"], "POWER(base, exp)"],
    [["a"], "ABS(a)"],
    [["s"], "LEN(s)"],
    [["a", "b"], "MAX(a, b)"],
    [["a", "b"], "MIN(a, b)"],
    [["pv", "rate", "nper"], "pv * POWER(1 + rate, nper)"],
    [["x"], "SIN(x)"],
    [["x"], "COS(x)"],
    [["r"], "PI() * r * r"],
    [["a", "b"], "SQRT(a * a + b * b)"],
    [["text"], "UPPER(text)"],
    [["n", "k"], "FACT(n) / (FACT(k) * FACT(n - k))"],
    [["x"], "x"],
    [["a", "b", "c", "d"], "a + b + c + d"],
    [["val", "lo", "hi"], "IF(val < lo, lo, IF(val > hi, hi, val))"],
    [["s", "n"], "LEFT(s, n)"],
    [["arr"], "SUM(arr)"],
    [["pmt", "rate", "nper"], "pmt * ((1 - POWER(1 + rate, -nper)) / rate)"],
    [["a", "b"], "IF(a > b, a, b)"],
    [["x", "y"], "IF(AND(x > 0, y > 0), x * y, 0)"],
    [["input"], "TRIM(input)"],
  ];

  it.each(lambdaCombos)(
    "round-trip: params=%j body=%s",
    (params, body) => {
      const built = buildLambdaRefersTo(params, body);
      expect(built).toMatch(/^=LAMBDA\(/);

      const parsed = parseLambdaRefersTo(built);
      expect(parsed).not.toBeNull();
      expect(parsed!.params).toEqual(params);
      expect(parsed!.body).toBe(body);
    }
  );
});
