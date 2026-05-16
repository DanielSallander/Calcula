//! FILENAME: app/extensions/DefinedNames/lib/nameUtils-serialization.test.ts
// PURPOSE: Round-trip serialization tests for named range formatting/parsing and lambda utils.

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

vi.mock("@api/lib", () => ({
  // NamedRange type is only used for type checking, no runtime needed
}));

import {
  formatRefersTo,
  parseRefersTo,
  isValidName,
  formatScope,
  formatRangeDisplay,
} from "./nameUtils";
import {
  buildLambdaRefersTo,
  parseLambdaRefersTo,
} from "./lambdaUtils";

// ============================================================================
// formatRefersTo -> parseRefersTo Round-Trip
// ============================================================================

describe("formatRefersTo -> parseRefersTo round-trip", () => {
  it("single cell round-trips", () => {
    const formatted = formatRefersTo("Sheet1", 0, 0, 0, 0);
    const parsed = parseRefersTo(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.sheetName).toBe("Sheet1");
    expect(parsed!.startRow).toBe(0);
    expect(parsed!.startCol).toBe(0);
    expect(parsed!.endRow).toBe(0);
    expect(parsed!.endCol).toBe(0);
  });

  it("range round-trips", () => {
    const formatted = formatRefersTo("Data", 2, 1, 10, 5);
    const parsed = parseRefersTo(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.sheetName).toBe("Data");
    expect(parsed!.startRow).toBe(2);
    expect(parsed!.startCol).toBe(1);
    expect(parsed!.endRow).toBe(10);
    expect(parsed!.endCol).toBe(5);
  });

  it("reversed coordinates are normalized", () => {
    const formatted = formatRefersTo("Sheet1", 10, 5, 2, 1);
    const parsed = parseRefersTo(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.startRow).toBe(2);
    expect(parsed!.startCol).toBe(1);
    expect(parsed!.endRow).toBe(10);
    expect(parsed!.endCol).toBe(5);
  });

  it("large range round-trips", () => {
    const formatted = formatRefersTo("Sheet1", 0, 0, 999, 25);
    const parsed = parseRefersTo(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.startRow).toBe(0);
    expect(parsed!.endRow).toBe(999);
    expect(parsed!.endCol).toBe(25);
  });

  it("format -> display -> re-parse produces consistent output", () => {
    const formatted = formatRefersTo("Sales", 5, 2, 20, 8);
    const display = formatRangeDisplay(formatted);
    // display strips the "=", re-add it for parsing
    const reparsed = parseRefersTo("=" + display);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.sheetName).toBe("Sales");
    expect(reparsed!.startRow).toBe(5);
    expect(reparsed!.startCol).toBe(2);
    expect(reparsed!.endRow).toBe(20);
    expect(reparsed!.endCol).toBe(8);
  });
});

// ============================================================================
// LAMBDA Build -> Parse Round-Trip
// ============================================================================

describe("buildLambdaRefersTo -> parseLambdaRefersTo round-trip", () => {
  it("simple lambda round-trips", () => {
    const formula = buildLambdaRefersTo(["x", "y"], "x + y");
    const parsed = parseLambdaRefersTo(formula);
    expect(parsed).not.toBeNull();
    expect(parsed!.params).toEqual(["x", "y"]);
    expect(parsed!.body).toBe("x + y");
  });

  it("single parameter lambda round-trips", () => {
    const formula = buildLambdaRefersTo(["n"], "n * 2");
    const parsed = parseLambdaRefersTo(formula);
    expect(parsed).not.toBeNull();
    expect(parsed!.params).toEqual(["n"]);
    expect(parsed!.body).toBe("n * 2");
  });

  it("lambda with nested function calls in body round-trips", () => {
    const formula = buildLambdaRefersTo(["x"], "IF(x > 0, SUM(1, 2, 3), 0)");
    const parsed = parseLambdaRefersTo(formula);
    expect(parsed).not.toBeNull();
    expect(parsed!.params).toEqual(["x"]);
    expect(parsed!.body).toBe("IF(x > 0, SUM(1, 2, 3), 0)");
  });

  it("lambda with many parameters round-trips", () => {
    const params = ["a", "b", "c", "d", "e"];
    const body = "a + b + c + d + e";
    const formula = buildLambdaRefersTo(params, body);
    const parsed = parseLambdaRefersTo(formula);
    expect(parsed).not.toBeNull();
    expect(parsed!.params).toEqual(params);
    expect(parsed!.body).toBe(body);
  });

  it("lambda with underscore params round-trips", () => {
    const formula = buildLambdaRefersTo(["rate_annual", "num_periods"], "rate_annual / 12 * num_periods");
    const parsed = parseLambdaRefersTo(formula);
    expect(parsed).not.toBeNull();
    expect(parsed!.params).toEqual(["rate_annual", "num_periods"]);
  });

  it("lambda with string literal in body round-trips", () => {
    const formula = buildLambdaRefersTo(["x"], 'IF(x > 0, "positive", "negative")');
    const parsed = parseLambdaRefersTo(formula);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe('IF(x > 0, "positive", "negative")');
  });
});

// ============================================================================
// All Scope Types
// ============================================================================

describe("scope types", () => {
  it("workbook scope (null) formats correctly", () => {
    expect(formatScope(null, ["Sheet1", "Sheet2"])).toBe("Workbook");
  });

  it("sheet scope formats with sheet name", () => {
    expect(formatScope(0, ["Sheet1", "Sheet2"])).toBe("Sheet1");
    expect(formatScope(1, ["Sheet1", "Data"])).toBe("Data");
  });

  it("out-of-range sheet index falls back to SheetN", () => {
    expect(formatScope(5, ["Sheet1"])).toBe("Sheet6");
  });
});

// ============================================================================
// Special Characters in Names
// ============================================================================

describe("special characters in name validation", () => {
  it("underscore-prefixed name is valid", () => {
    expect(isValidName("_MyRange")).toBe(true);
  });

  it("backslash-prefixed name is valid", () => {
    expect(isValidName("\\Special")).toBe(true);
  });

  it("name with dots is valid", () => {
    expect(isValidName("My.Range.Name")).toBe(true);
  });

  it("name with underscore and digits is valid", () => {
    expect(isValidName("Data_2024")).toBe(true);
  });

  it("reserved words are rejected", () => {
    expect(isValidName("TRUE")).toBe(false);
    expect(isValidName("FALSE")).toBe(false);
    expect(isValidName("NULL")).toBe(false);
    expect(isValidName("true")).toBe(false);
  });

  it("cell reference lookalikes are rejected", () => {
    expect(isValidName("A1")).toBe(false);
    expect(isValidName("ZZ999")).toBe(false);
  });

  it("names starting with digit are rejected", () => {
    expect(isValidName("1stRange")).toBe(false);
  });

  it("names with spaces are rejected", () => {
    expect(isValidName("My Range")).toBe(false);
  });

  it("empty name is rejected", () => {
    expect(isValidName("")).toBe(false);
  });

  it("very long valid name is accepted", () => {
    expect(isValidName("A" + "b".repeat(200))).toBe(true);
  });
});

// ============================================================================
// parseRefersTo Edge Cases
// ============================================================================

describe("parseRefersTo edge cases", () => {
  it("returns null for non-range formulas", () => {
    expect(parseRefersTo("=SUM(A1:B10)")).toBeNull();
    expect(parseRefersTo("=IF(A1>0,1,0)")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRefersTo("")).toBeNull();
  });

  it("parses reference without sheet name", () => {
    const parsed = parseRefersTo("=$A$1:$C$5");
    expect(parsed).not.toBeNull();
    expect(parsed!.sheetName).toBeUndefined();
    expect(parsed!.startCol).toBe(0);
    expect(parsed!.endCol).toBe(2);
  });
});
