//! FILENAME: app/extensions/DefinedNames/lib/nameUtils.test.ts
// PURPOSE: Tests for named range utility functions (formatting, parsing, validation).

import { describe, it, expect, vi } from "vitest";

// Mock @api to avoid pulling in monaco-editor and other heavy dependencies.
// We provide real implementations of columnToLetter and letterToColumn.
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

import {
  formatRefersTo,
  parseRefersTo,
  isValidName,
  formatScope,
  formatRangeDisplay,
} from "./nameUtils";

// ============================================================================
// formatRefersTo
// ============================================================================

describe("formatRefersTo", () => {
  it("should format a single cell reference", () => {
    // col 0 = A, row 0 => $A$1
    expect(formatRefersTo("Sheet1", 0, 0, 0, 0)).toBe("=Sheet1!$A$1");
  });

  it("should format a range reference", () => {
    // A1:B10 => cols 0-1, rows 0-9
    expect(formatRefersTo("Sheet1", 0, 0, 9, 1)).toBe("=Sheet1!$A$1:$B$10");
  });

  it("should normalise reversed coordinates", () => {
    // endRow < startRow, endCol < startCol => still produces min:max order
    expect(formatRefersTo("Sheet1", 9, 1, 0, 0)).toBe("=Sheet1!$A$1:$B$10");
  });

  it("should handle multi-letter columns", () => {
    // col 26 = AA
    expect(formatRefersTo("Sheet1", 0, 26, 0, 26)).toBe("=Sheet1!$AA$1");
  });

  it("should handle a large range", () => {
    expect(formatRefersTo("Data", 0, 0, 999, 25)).toBe("=Data!$A$1:$Z$1000");
  });

  it("should preserve sheet name with spaces", () => {
    expect(formatRefersTo("My Sheet", 0, 0, 0, 0)).toBe("=My Sheet!$A$1");
  });

  it("should handle single-row multi-column range", () => {
    expect(formatRefersTo("Sheet1", 0, 0, 0, 3)).toBe("=Sheet1!$A$1:$D$1");
  });

  it("should handle single-column multi-row range", () => {
    expect(formatRefersTo("Sheet1", 0, 0, 4, 0)).toBe("=Sheet1!$A$1:$A$5");
  });
});

// ============================================================================
// parseRefersTo
// ============================================================================

describe("parseRefersTo", () => {
  it("should parse a single cell reference with sheet", () => {
    const result = parseRefersTo("=Sheet1!$A$1");
    expect(result).toEqual({
      sheetName: "Sheet1",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    });
  });

  it("should parse a range reference with sheet", () => {
    const result = parseRefersTo("=Sheet1!$A$1:$B$10");
    expect(result).toEqual({
      sheetName: "Sheet1",
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 1,
    });
  });

  it("should parse a reference without sheet name", () => {
    const result = parseRefersTo("=$C$5");
    expect(result).toEqual({
      sheetName: undefined,
      startRow: 4,
      startCol: 2,
      endRow: 4,
      endCol: 2,
    });
  });

  it("should parse reference without dollar signs", () => {
    const result = parseRefersTo("=Sheet1!A1:B10");
    expect(result).toEqual({
      sheetName: "Sheet1",
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 1,
    });
  });

  it("should parse multi-letter columns", () => {
    const result = parseRefersTo("=Sheet1!$AA$1");
    expect(result).not.toBeNull();
    expect(result!.startCol).toBe(26); // AA = 26
  });

  it("should return null for a non-range formula", () => {
    expect(parseRefersTo("=SUM(A1:A10)")).toBeNull();
  });

  it("should return null for a plain constant", () => {
    expect(parseRefersTo("=100")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(parseRefersTo("")).toBeNull();
  });

  it("should return null for string without leading equals", () => {
    expect(parseRefersTo("Sheet1!$A$1")).toBeNull();
  });

  describe("round-trip with formatRefersTo", () => {
    it("should round-trip a single cell", () => {
      const formatted = formatRefersTo("Sheet1", 5, 3, 5, 3);
      const parsed = parseRefersTo(formatted);
      expect(parsed).toEqual({
        sheetName: "Sheet1",
        startRow: 5,
        startCol: 3,
        endRow: 5,
        endCol: 3,
      });
    });

    it("should round-trip a range", () => {
      const formatted = formatRefersTo("Data", 0, 0, 99, 9);
      const parsed = parseRefersTo(formatted);
      expect(parsed).toEqual({
        sheetName: "Data",
        startRow: 0,
        startCol: 0,
        endRow: 99,
        endCol: 9,
      });
    });
  });
});

// ============================================================================
// isValidName
// ============================================================================

describe("isValidName", () => {
  describe("valid names", () => {
    it("should accept simple alphabetic name", () => {
      expect(isValidName("SalesData")).toBe(true);
    });

    it("should accept name starting with underscore", () => {
      expect(isValidName("_myName")).toBe(true);
    });

    it("should accept name starting with backslash", () => {
      expect(isValidName("\\myName")).toBe(true);
    });

    it("should accept name with digits after first char", () => {
      expect(isValidName("Data2024")).toBe(true);
    });

    it("should accept name with dots", () => {
      expect(isValidName("sales.q1")).toBe(true);
    });

    it("should accept single letter name", () => {
      expect(isValidName("x")).toBe(true);
    });

    it("should accept single underscore", () => {
      expect(isValidName("_")).toBe(true);
    });

    it("should accept long valid name", () => {
      expect(isValidName("a".repeat(200))).toBe(true);
    });

    it("should accept name that looks like cell ref but column is too large", () => {
      // XFE1 => col XFE = 16385 (> 16384), so valid as a name
      expect(isValidName("XFE1")).toBe(true);
    });
  });

  describe("invalid names", () => {
    it("should reject empty string", () => {
      expect(isValidName("")).toBe(false);
    });

    it("should reject name starting with digit", () => {
      expect(isValidName("1stQuarter")).toBe(false);
    });

    it("should reject name containing spaces", () => {
      expect(isValidName("my name")).toBe(false);
    });

    it("should reject name containing hyphen", () => {
      expect(isValidName("my-name")).toBe(false);
    });

    it("should reject name containing exclamation mark", () => {
      expect(isValidName("Sheet1!A1")).toBe(false);
    });

    it("should reject reserved word TRUE (case-insensitive)", () => {
      expect(isValidName("TRUE")).toBe(false);
      expect(isValidName("true")).toBe(false);
      expect(isValidName("True")).toBe(false);
    });

    it("should reject reserved word FALSE (case-insensitive)", () => {
      expect(isValidName("FALSE")).toBe(false);
      expect(isValidName("false")).toBe(false);
    });

    it("should reject reserved word NULL (case-insensitive)", () => {
      expect(isValidName("NULL")).toBe(false);
      expect(isValidName("null")).toBe(false);
    });

    it("should reject valid cell references", () => {
      expect(isValidName("A1")).toBe(false);
      expect(isValidName("B2")).toBe(false);
      expect(isValidName("Z100")).toBe(false);
      expect(isValidName("AA1")).toBe(false);
      expect(isValidName("XFD1048576")).toBe(false); // max valid cell
    });

    it("should reject name starting with special chars", () => {
      expect(isValidName("@name")).toBe(false);
      expect(isValidName("#name")).toBe(false);
      expect(isValidName("$name")).toBe(false);
    });
  });
});

// ============================================================================
// formatScope
// ============================================================================

describe("formatScope", () => {
  const sheetNames = ["Sheet1", "Sheet2", "Data"];

  it("should return 'Workbook' for null scope", () => {
    expect(formatScope(null, sheetNames)).toBe("Workbook");
  });

  it("should return sheet name for valid index", () => {
    expect(formatScope(0, sheetNames)).toBe("Sheet1");
    expect(formatScope(2, sheetNames)).toBe("Data");
  });

  it("should return fallback name for out-of-range index", () => {
    expect(formatScope(5, sheetNames)).toBe("Sheet6");
  });
});

// ============================================================================
// formatRangeDisplay
// ============================================================================

describe("formatRangeDisplay", () => {
  it("should strip leading equals sign", () => {
    expect(formatRangeDisplay("=Sheet1!$A$1:$B$10")).toBe(
      "Sheet1!$A$1:$B$10"
    );
  });

  it("should return value as-is if no leading equals", () => {
    expect(formatRangeDisplay("Sheet1!$A$1")).toBe("Sheet1!$A$1");
  });

  it("should handle formula with equals", () => {
    expect(formatRangeDisplay("=100")).toBe("100");
  });

  it("should handle empty string", () => {
    expect(formatRangeDisplay("")).toBe("");
  });
});
