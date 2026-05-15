//! FILENAME: app/src/api/__tests__/range-integration.test.ts
// PURPOSE: Integration tests for range/address/column conversion functions
//          working together across modules.

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../core/types";
import {
  cellToReference,
  rangeToReference,
  columnToReference,
  columnRangeToReference,
  rowToReference,
  rowRangeToReference,
  formatSheetName,
  createSheetPrefix,
} from "../../core/lib/gridRenderer/references/conversion";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  buildCellReference,
  buildRangeReference,
} from "../../core/lib/formulaRefParser";

// ============================================================================
// Column Conversion Exhaustive Round-Trips
// ============================================================================

describe("column conversion round-trips", () => {
  it("round-trips 0 through 702 (A through AAA)", () => {
    for (let col = 0; col <= 702; col++) {
      const letter = columnToLetter(col);
      const back = letterToColumn(letter);
      expect(back).toBe(col);
    }
  });

  it("handles extreme column indices", () => {
    // Column 16383 is XFD (Excel max)
    const letter = columnToLetter(16383);
    expect(letter).toBe("XFD");
    expect(letterToColumn("XFD")).toBe(16383);
  });

  it("produces correct letters for boundary values", () => {
    expect(columnToLetter(0)).toBe("A");
    expect(columnToLetter(25)).toBe("Z");
    expect(columnToLetter(26)).toBe("AA");
    expect(columnToLetter(51)).toBe("AZ");
    expect(columnToLetter(52)).toBe("BA");
    expect(columnToLetter(701)).toBe("ZZ");
    expect(columnToLetter(702)).toBe("AAA");
  });
});

// ============================================================================
// cellToReference + parseFormulaReferences Integration
// ============================================================================

describe("cellToReference -> parse round-trip", () => {
  it("converts cell coordinates to reference and parses back", () => {
    const testCases = [
      { row: 0, col: 0 },      // A1
      { row: 99, col: 25 },    // Z100
      { row: 0, col: 26 },     // AA1
      { row: 999, col: 701 },  // ZZ1000
    ];

    for (const { row, col } of testCases) {
      const ref = cellToReference(row, col);
      const parsed = parseFormulaReferences(`=${ref}`);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].startRow).toBe(row);
      expect(parsed[0].startCol).toBe(col);
      expect(parsed[0].endRow).toBe(row);
      expect(parsed[0].endCol).toBe(col);
    }
  });

  it("handles cross-sheet references in cellToReference", () => {
    const ref = cellToReference(5, 3, "Sheet2", "Sheet1");
    expect(ref).toBe("Sheet2!D6");

    const parsed = parseFormulaReferences(`=${ref}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sheetName).toBe("Sheet2");
    expect(parsed[0].startRow).toBe(5);
    expect(parsed[0].startCol).toBe(3);
  });

  it("omits sheet prefix when target equals current sheet", () => {
    const ref = cellToReference(0, 0, "Sheet1", "Sheet1");
    expect(ref).toBe("A1");
    expect(ref).not.toContain("!");
  });
});

// ============================================================================
// rangeToReference -> parseFormulaReferences Integration
// ============================================================================

describe("rangeToReference -> parse round-trip", () => {
  it("converts range coordinates to reference and parses back", () => {
    const testCases = [
      { sr: 0, sc: 0, er: 9, ec: 2 },     // A1:C10
      { sr: 5, sc: 1, er: 20, ec: 5 },     // B6:F21
      { sr: 0, sc: 0, er: 0, ec: 0 },      // Single cell A1
      { sr: 99, sc: 25, er: 199, ec: 51 },  // Z100:AZ200
    ];

    for (const { sr, sc, er, ec } of testCases) {
      const ref = rangeToReference(sr, sc, er, ec);
      const parsed = parseFormulaReferences(`=${ref}`);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].startRow).toBe(sr);
      expect(parsed[0].startCol).toBe(sc);
      expect(parsed[0].endRow).toBe(er);
      expect(parsed[0].endCol).toBe(ec);
    }
  });

  it("normalizes reversed ranges", () => {
    // Pass end before start -- rangeToReference should normalize
    const ref = rangeToReference(10, 5, 0, 0);
    const parsed = parseFormulaReferences(`=${ref}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].startRow).toBe(0);
    expect(parsed[0].startCol).toBe(0);
    expect(parsed[0].endRow).toBe(10);
    expect(parsed[0].endCol).toBe(5);
  });

  it("cross-sheet range reference round-trips", () => {
    const ref = rangeToReference(0, 0, 9, 3, "My Sheet", null);
    expect(ref).toContain("'My Sheet'!");

    const parsed = parseFormulaReferences(`=${ref}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sheetName).toBe("My Sheet");
  });
});

// ============================================================================
// Sheet Name Formatting
// ============================================================================

describe("sheet name formatting integration", () => {
  it("quotes sheet names with spaces", () => {
    const formatted = formatSheetName("Data Sheet");
    expect(formatted).toBe("'Data Sheet'");
  });

  it("does not quote simple sheet names", () => {
    const formatted = formatSheetName("Sheet1");
    expect(formatted).toBe("Sheet1");
  });

  it("escapes single quotes in sheet names", () => {
    const formatted = formatSheetName("John's Data");
    expect(formatted).toBe("'John''s Data'");
  });

  it("quotes sheet names starting with digits", () => {
    const formatted = formatSheetName("2024Budget");
    expect(formatted).toBe("'2024Budget'");
  });

  it("createSheetPrefix returns empty for same sheet", () => {
    expect(createSheetPrefix("Sheet1", "Sheet1")).toBe("");
  });

  it("createSheetPrefix returns prefix for different sheet", () => {
    expect(createSheetPrefix("Sheet2", "Sheet1")).toBe("Sheet2!");
  });

  it("createSheetPrefix returns empty for null target", () => {
    expect(createSheetPrefix(null, "Sheet1")).toBe("");
  });
});

// ============================================================================
// Column/Row Reference Functions
// ============================================================================

describe("column and row references", () => {
  it("columnToReference produces correct format", () => {
    expect(columnToReference(0)).toBe("A:A");
    expect(columnToReference(25)).toBe("Z:Z");
    expect(columnToReference(26)).toBe("AA:AA");
  });

  it("columnRangeToReference works for multi-column ranges", () => {
    expect(columnRangeToReference(0, 2)).toBe("A:C");
    expect(columnRangeToReference(25, 27)).toBe("Z:AB");
  });

  it("columnRangeToReference normalizes reversed ranges", () => {
    expect(columnRangeToReference(5, 2)).toBe("C:F");
  });

  it("rowToReference produces correct format", () => {
    expect(rowToReference(0)).toBe("1:1");
    expect(rowToReference(99)).toBe("100:100");
  });

  it("rowRangeToReference works for multi-row ranges", () => {
    expect(rowRangeToReference(0, 9)).toBe("1:10");
    expect(rowRangeToReference(99, 199)).toBe("100:200");
  });

  it("cross-sheet column reference", () => {
    const ref = columnToReference(0, "Sales", null);
    expect(ref).toBe("Sales!A:A");
  });

  it("cross-sheet row range reference", () => {
    const ref = rowRangeToReference(0, 4, "Data Sheet", null);
    expect(ref).toBe("'Data Sheet'!1:5");
  });
});

// ============================================================================
// buildCellReference + buildRangeReference -> Parse Round-Trips
// ============================================================================

describe("buildCellReference/buildRangeReference -> parse integration", () => {
  it("builds absolute cell references and parses them", () => {
    const ref = buildCellReference(4, 2, true, true);
    expect(ref).toBe("$C$5");

    const parsed = parseFormulaReferencesWithPositions(`=${ref}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].isStartColAbsolute).toBe(true);
    expect(parsed[0].isStartRowAbsolute).toBe(true);
    expect(parsed[0].startRow).toBe(4);
    expect(parsed[0].startCol).toBe(2);
  });

  it("builds mixed absolute range and parses it", () => {
    // $A1:B$10
    const ref = buildRangeReference(0, 0, 9, 1, true, false, false, true);
    expect(ref).toBe("$A1:B$10");

    const parsed = parseFormulaReferencesWithPositions(`=${ref}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].isStartColAbsolute).toBe(true);
    expect(parsed[0].isStartRowAbsolute).toBe(false);
    expect(parsed[0].isEndColAbsolute).toBe(false);
    expect(parsed[0].isEndRowAbsolute).toBe(true);
  });

  it("builds cross-sheet absolute reference", () => {
    const ref = buildCellReference(0, 0, true, true, "Summary");
    expect(ref).toBe("Summary!$A$1");

    const parsed = parseFormulaReferences(`=${ref}`);
    expect(parsed[0].sheetName).toBe("Summary");
  });

  it("builds a multi-reference formula from coordinates and validates all parse back", () => {
    const cells = [
      { row: 0, col: 0 },
      { row: 5, col: 3 },
      { row: 99, col: 25 },
    ];
    const refStrings = cells.map((c) =>
      buildCellReference(c.row, c.col, false, false)
    );
    const formula = `=${refStrings.join("+")}`;

    const parsed = parseFormulaReferences(formula);
    expect(parsed).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(parsed[i].startRow).toBe(cells[i].row);
      expect(parsed[i].startCol).toBe(cells[i].col);
    }
  });
});
