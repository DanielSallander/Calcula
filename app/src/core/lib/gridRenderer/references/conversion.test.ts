//! FILENAME: app/src/core/lib/gridRenderer/references/conversion.test.ts
// PURPOSE: Tests for cell/range reference conversion functions

import { describe, it, expect } from "vitest";
import {
  formatSheetName,
  createSheetPrefix,
  cellToReference,
  rangeToReference,
  columnToReference,
  columnRangeToReference,
  rowToReference,
  rowRangeToReference,
} from "./conversion";

// ============================================================================
// formatSheetName
// ============================================================================

describe("formatSheetName", () => {
  it("returns plain name unchanged", () => {
    expect(formatSheetName("Sheet1")).toBe("Sheet1");
  });

  it("quotes name with spaces", () => {
    expect(formatSheetName("My Sheet")).toBe("'My Sheet'");
  });

  it("quotes name starting with digit", () => {
    expect(formatSheetName("2024Budget")).toBe("'2024Budget'");
  });

  it("quotes name with exclamation mark", () => {
    expect(formatSheetName("Data!")).toBe("'Data!'");
  });

  it("quotes name with square brackets", () => {
    expect(formatSheetName("Sheet[1]")).toBe("'Sheet[1]'");
  });

  it("escapes single quotes by doubling them", () => {
    expect(formatSheetName("Bob's")).toBe("'Bob''s'");
  });

  it("handles name with both spaces and quotes", () => {
    expect(formatSheetName("Bob's Sheet")).toBe("'Bob''s Sheet'");
  });
});

// ============================================================================
// createSheetPrefix
// ============================================================================

describe("createSheetPrefix", () => {
  it("returns empty string when no target sheet", () => {
    expect(createSheetPrefix(null, null)).toBe("");
  });

  it("returns empty string when target equals current", () => {
    expect(createSheetPrefix("Sheet1", "Sheet1")).toBe("");
  });

  it("returns prefix when target differs from current", () => {
    expect(createSheetPrefix("Sheet2", "Sheet1")).toBe("Sheet2!");
  });

  it("quotes prefix when sheet name has spaces", () => {
    expect(createSheetPrefix("My Sheet", "Sheet1")).toBe("'My Sheet'!");
  });
});

// ============================================================================
// cellToReference
// ============================================================================

describe("cellToReference", () => {
  it("converts (0, 0) to A1", () => {
    expect(cellToReference(0, 0)).toBe("A1");
  });

  it("converts (0, 25) to Z1", () => {
    expect(cellToReference(0, 25)).toBe("Z1");
  });

  it("converts (0, 26) to AA1", () => {
    expect(cellToReference(0, 26)).toBe("AA1");
  });

  it("converts (9, 2) to C10", () => {
    expect(cellToReference(9, 2)).toBe("C10");
  });

  it("includes sheet prefix for cross-sheet reference", () => {
    expect(cellToReference(0, 0, "Sheet2", "Sheet1")).toBe("Sheet2!A1");
  });

  it("omits prefix when target equals current sheet", () => {
    expect(cellToReference(0, 0, "Sheet1", "Sheet1")).toBe("A1");
  });
});

// ============================================================================
// rangeToReference
// ============================================================================

describe("rangeToReference", () => {
  it("converts single-cell range to single reference", () => {
    expect(rangeToReference(0, 0, 0, 0)).toBe("A1");
  });

  it("converts multi-cell range", () => {
    expect(rangeToReference(0, 0, 4, 2)).toBe("A1:C5");
  });

  it("normalizes reversed coordinates", () => {
    expect(rangeToReference(4, 2, 0, 0)).toBe("A1:C5");
  });

  it("includes sheet prefix for cross-sheet range", () => {
    expect(rangeToReference(0, 0, 1, 1, "Data", "Sheet1")).toBe("Data!A1:B2");
  });
});

// ============================================================================
// columnToReference / columnRangeToReference
// ============================================================================

describe("columnToReference", () => {
  it("converts column 0 to A:A", () => {
    expect(columnToReference(0)).toBe("A:A");
  });

  it("converts column 25 to Z:Z", () => {
    expect(columnToReference(25)).toBe("Z:Z");
  });

  it("includes sheet prefix", () => {
    expect(columnToReference(0, "Sheet2", "Sheet1")).toBe("Sheet2!A:A");
  });
});

describe("columnRangeToReference", () => {
  it("converts single column range", () => {
    expect(columnRangeToReference(2, 2)).toBe("C:C");
  });

  it("converts multi column range", () => {
    expect(columnRangeToReference(0, 2)).toBe("A:C");
  });

  it("normalizes reversed columns", () => {
    expect(columnRangeToReference(2, 0)).toBe("A:C");
  });
});

// ============================================================================
// rowToReference / rowRangeToReference
// ============================================================================

describe("rowToReference", () => {
  it("converts row 0 to 1:1", () => {
    expect(rowToReference(0)).toBe("1:1");
  });

  it("converts row 9 to 10:10", () => {
    expect(rowToReference(9)).toBe("10:10");
  });

  it("includes sheet prefix", () => {
    expect(rowToReference(0, "Sheet2", "Sheet1")).toBe("Sheet2!1:1");
  });
});

describe("rowRangeToReference", () => {
  it("converts single row range", () => {
    expect(rowRangeToReference(4, 4)).toBe("5:5");
  });

  it("converts multi row range", () => {
    expect(rowRangeToReference(0, 4)).toBe("1:5");
  });

  it("normalizes reversed rows", () => {
    expect(rowRangeToReference(4, 0)).toBe("1:5");
  });
});
