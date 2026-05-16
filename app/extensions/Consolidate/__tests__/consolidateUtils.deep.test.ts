//! FILENAME: app/extensions/Consolidate/__tests__/consolidateUtils.deep.test.ts
// PURPOSE: Deep tests for Consolidate utilities - all functions, edge cases, cross-sheet.

import { describe, it, expect, vi } from "vitest";

vi.mock("@api", () => ({
  columnToLetter: (col: number) => {
    let result = "";
    let c = col;
    while (c >= 0) {
      result = String.fromCharCode(65 + (c % 26)) + result;
      c = Math.floor(c / 26) - 1;
    }
    return result;
  },
}));

import {
  parseCellRef,
  formatRangeDisplay,
  parseRangeReference,
} from "../lib/consolidateUtils";
import { CONSOLIDATION_FUNCTIONS } from "../types";

// ============================================================================
// parseCellRef - deeper coverage
// ============================================================================

describe("parseCellRef deep", () => {
  it("parses multi-letter columns: AA1 -> (0, 26)", () => {
    expect(parseCellRef("AA1")).toEqual({ row: 0, col: 26 });
  });

  it("parses AZ1 -> (0, 51)", () => {
    expect(parseCellRef("AZ1")).toEqual({ row: 0, col: 51 });
  });

  it("parses BA1 -> (0, 52)", () => {
    expect(parseCellRef("BA1")).toEqual({ row: 0, col: 52 });
  });

  it("parses ZZ1 -> (0, 701)", () => {
    // ZZ = 26*26 + 26 - 1 = 701
    expect(parseCellRef("ZZ1")).toEqual({ row: 0, col: 701 });
  });

  it("parses triple-letter AAA1 -> (0, 702)", () => {
    expect(parseCellRef("AAA1")).toEqual({ row: 0, col: 702 });
  });

  it("handles mixed case with dollars: $aB$99", () => {
    expect(parseCellRef("$aB$99")).toEqual({ row: 98, col: 27 });
  });

  it("handles large row numbers: A99999", () => {
    expect(parseCellRef("A99999")).toEqual({ row: 99998, col: 0 });
  });

  it("returns null for just letters", () => {
    expect(parseCellRef("ABC")).toBeNull();
  });

  it("returns null for just numbers", () => {
    expect(parseCellRef("999")).toBeNull();
  });

  it("returns null for special chars", () => {
    expect(parseCellRef("A1!")).toBeNull();
  });

  it("returns null for row 0 (1-based boundary)", () => {
    expect(parseCellRef("A0")).toBeNull();
  });
});

// ============================================================================
// formatRangeDisplay - deeper coverage
// ============================================================================

describe("formatRangeDisplay deep", () => {
  it("formats large column indices correctly", () => {
    const result = formatRangeDisplay("Sheet1", 0, 26, 0, 26);
    expect(result).toBe("Sheet1!$AA$1:$AA$1");
  });

  it("quotes sheet names with dots", () => {
    const result = formatRangeDisplay("Q1.2024", 0, 0, 0, 0);
    expect(result.startsWith("'Q1.2024'!")).toBe(true);
  });

  it("quotes sheet names with hyphens", () => {
    const result = formatRangeDisplay("Jan-Mar", 0, 0, 0, 0);
    expect(result.startsWith("'Jan-Mar'!")).toBe(true);
  });

  it("does not quote underscored names", () => {
    const result = formatRangeDisplay("Sales_Q1", 0, 0, 0, 0);
    expect(result.startsWith("Sales_Q1!")).toBe(true);
  });

  it("does not quote purely alphanumeric names", () => {
    const result = formatRangeDisplay("Sheet99", 0, 0, 0, 0);
    expect(result.startsWith("Sheet99!")).toBe(true);
  });

  it("formats large ranges with correct row/col", () => {
    const result = formatRangeDisplay("Data", 999, 51, 1999, 103);
    expect(result).toBe("Data!$AZ$1000:$CZ$2000");
  });
});

// ============================================================================
// parseRangeReference - deeper coverage
// ============================================================================

describe("parseRangeReference deep", () => {
  const sheets = [
    { index: 0, name: "Sheet1" },
    { index: 1, name: "Sales Data" },
    { index: 2, name: "Summary" },
    { index: 3, name: "Q1.2024" },
    { index: 4, name: "Jan-Mar" },
  ];

  it("parses quoted sheet name with dot", () => {
    const result = parseRangeReference("'Q1.2024'!A1:B5", sheets);
    expect(result).not.toBeNull();
    expect(result!.sheetName).toBe("Q1.2024");
    expect(result!.sheetIndex).toBe(3);
  });

  it("parses quoted sheet name with hyphen", () => {
    const result = parseRangeReference("'Jan-Mar'!C1:D10", sheets);
    expect(result).not.toBeNull();
    expect(result!.sheetName).toBe("Jan-Mar");
    expect(result!.sheetIndex).toBe(4);
  });

  it("handles case-insensitive match for quoted names", () => {
    const result = parseRangeReference("'sales data'!A1:B2", sheets);
    expect(result).not.toBeNull();
    expect(result!.sheetName).toBe("Sales Data");
  });

  it("returns null for invalid cell ref in range", () => {
    expect(parseRangeReference("Sheet1!ABC:D10", sheets)).toBeNull();
  });

  it("returns null for three-part range", () => {
    expect(parseRangeReference("Sheet1!A1:B2:C3", sheets)).toBeNull();
  });

  it("handles large column references in range", () => {
    const result = parseRangeReference("Sheet1!AA1:AZ100", sheets);
    expect(result).not.toBeNull();
    expect(result!.startCol).toBe(26);
    expect(result!.endCol).toBe(51);
    expect(result!.endRow).toBe(99);
  });

  it("handles whitespace around the reference", () => {
    const result = parseRangeReference("  Sheet1!A1:B2  ", sheets);
    expect(result).not.toBeNull();
    expect(result!.sheetName).toBe("Sheet1");
  });

  it("returns null when bang is present but no sheet name matches", () => {
    expect(parseRangeReference("Missing!A1:B2", sheets)).toBeNull();
  });

  it("cross-sheet: can parse multiple different sheets", () => {
    const r1 = parseRangeReference("Sheet1!A1:B5", sheets);
    const r2 = parseRangeReference("Summary!C3:D8", sheets);
    expect(r1!.sheetIndex).toBe(0);
    expect(r2!.sheetIndex).toBe(2);
    expect(r1!.sheetName).not.toBe(r2!.sheetName);
  });

  it("normalizes reversed large range", () => {
    const result = parseRangeReference("Sheet1!Z100:A1", sheets);
    expect(result).not.toBeNull();
    expect(result!.startRow).toBe(0);
    expect(result!.startCol).toBe(0);
    expect(result!.endRow).toBe(99);
    expect(result!.endCol).toBe(25);
  });

  it("display field uses absolute references with correct quoting", () => {
    const result = parseRangeReference("'Sales Data'!B2:D4", sheets);
    expect(result!.display).toBe("'Sales Data'!$B$2:$D$4");
  });
});

// ============================================================================
// CONSOLIDATION_FUNCTIONS - all functions present
// ============================================================================

describe("CONSOLIDATION_FUNCTIONS deep", () => {
  const allExpected = [
    "sum", "count", "average", "max", "min",
    "product", "countNums", "stdDev", "stdDevP", "var", "varP",
  ];

  it.each(allExpected)("includes %s function", (fn) => {
    const values = CONSOLIDATION_FUNCTIONS.map((f) => f.value);
    expect(values).toContain(fn);
  });

  it("has unique values (no duplicates)", () => {
    const values = CONSOLIDATION_FUNCTIONS.map((f) => f.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("has non-empty labels for all entries", () => {
    for (const fn of CONSOLIDATION_FUNCTIONS) {
      expect(fn.label.length).toBeGreaterThan(0);
    }
  });

  it("labels start with uppercase", () => {
    for (const fn of CONSOLIDATION_FUNCTIONS) {
      expect(fn.label[0]).toBe(fn.label[0].toUpperCase());
    }
  });
});
