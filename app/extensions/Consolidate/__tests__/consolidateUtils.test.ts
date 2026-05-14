//! FILENAME: app/extensions/Consolidate/__tests__/consolidateUtils.test.ts
// PURPOSE: Tests for Consolidate utility functions (range parsing, formatting).

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
// parseCellRef
// ============================================================================

describe("parseCellRef", () => {
  it("parses A1 -> (0, 0)", () => {
    expect(parseCellRef("A1")).toEqual({ row: 0, col: 0 });
  });

  it("parses $D$10 -> (9, 3)", () => {
    expect(parseCellRef("$D$10")).toEqual({ row: 9, col: 3 });
  });

  it("returns null for invalid ref", () => {
    expect(parseCellRef("")).toBeNull();
    expect(parseCellRef("A0")).toBeNull();
    expect(parseCellRef("123")).toBeNull();
  });
});

// ============================================================================
// formatRangeDisplay
// ============================================================================

describe("formatRangeDisplay", () => {
  it("formats simple sheet name", () => {
    const result = formatRangeDisplay("Sheet1", 0, 0, 9, 3);
    expect(result).toBe("Sheet1!$A$1:$D$10");
  });

  it("quotes sheet names with special characters", () => {
    const result = formatRangeDisplay("My Sheet", 0, 0, 0, 0);
    expect(result.startsWith("'My Sheet'!")).toBe(true);
  });

  it("does not quote simple sheet names", () => {
    const result = formatRangeDisplay("Data_2024", 0, 0, 0, 0);
    expect(result.startsWith("Data_2024!")).toBe(true);
  });
});

// ============================================================================
// parseRangeReference
// ============================================================================

describe("parseRangeReference", () => {
  const sheets = [
    { index: 0, name: "Sheet1" },
    { index: 1, name: "Sales Data" },
    { index: 2, name: "Summary" },
  ];

  it("parses a basic range reference", () => {
    const result = parseRangeReference("Sheet1!A1:D10", sheets);
    expect(result).not.toBeNull();
    expect(result!.sheetIndex).toBe(0);
    expect(result!.sheetName).toBe("Sheet1");
    expect(result!.startRow).toBe(0);
    expect(result!.startCol).toBe(0);
    expect(result!.endRow).toBe(9);
    expect(result!.endCol).toBe(3);
  });

  it("parses absolute references", () => {
    const result = parseRangeReference("Sheet1!$A$1:$D$10", sheets);
    expect(result).not.toBeNull();
    expect(result!.startRow).toBe(0);
    expect(result!.endRow).toBe(9);
  });

  it("handles quoted sheet names with spaces", () => {
    const result = parseRangeReference("'Sales Data'!A1:B5", sheets);
    expect(result).not.toBeNull();
    expect(result!.sheetName).toBe("Sales Data");
    expect(result!.sheetIndex).toBe(1);
  });

  it("is case-insensitive for sheet names", () => {
    const result = parseRangeReference("SHEET1!A1:B2", sheets);
    expect(result).not.toBeNull();
    expect(result!.sheetName).toBe("Sheet1");
  });

  it("returns null for empty input", () => {
    expect(parseRangeReference("", sheets)).toBeNull();
    expect(parseRangeReference("   ", sheets)).toBeNull();
  });

  it("returns null when missing '!'", () => {
    expect(parseRangeReference("A1:B2", sheets)).toBeNull();
  });

  it("returns null for unknown sheet", () => {
    expect(parseRangeReference("NoSuchSheet!A1:B2", sheets)).toBeNull();
  });

  it("returns null for single cell (not a range)", () => {
    expect(parseRangeReference("Sheet1!A1", sheets)).toBeNull();
  });

  it("normalizes reversed ranges", () => {
    const result = parseRangeReference("Sheet1!D10:A1", sheets);
    expect(result).not.toBeNull();
    expect(result!.startRow).toBe(0);
    expect(result!.startCol).toBe(0);
    expect(result!.endRow).toBe(9);
    expect(result!.endCol).toBe(3);
  });

  it("populates the display field", () => {
    const result = parseRangeReference("Sheet1!A1:D10", sheets);
    expect(result!.display).toBe("Sheet1!$A$1:$D$10");
  });
});

// ============================================================================
// CONSOLIDATION_FUNCTIONS
// ============================================================================

describe("CONSOLIDATION_FUNCTIONS", () => {
  it("has 11 functions", () => {
    expect(CONSOLIDATION_FUNCTIONS).toHaveLength(11);
  });

  it("includes sum, average, count", () => {
    const values = CONSOLIDATION_FUNCTIONS.map((f) => f.value);
    expect(values).toContain("sum");
    expect(values).toContain("average");
    expect(values).toContain("count");
  });

  it("each entry has value and label", () => {
    for (const fn of CONSOLIDATION_FUNCTIONS) {
      expect(fn.value).toBeTruthy();
      expect(fn.label).toBeTruthy();
    }
  });

  it("includes statistical functions", () => {
    const values = CONSOLIDATION_FUNCTIONS.map((f) => f.value);
    expect(values).toContain("stdDev");
    expect(values).toContain("stdDevP");
    expect(values).toContain("var");
    expect(values).toContain("varP");
  });
});
