//! FILENAME: app/src/core/lib/__tests__/type-guards-exhaustive.test.ts
// PURPOSE: Exhaustive tests for all type guard / type-checking functions in core.

import { describe, it, expect } from "vitest";
import { isValidColor, isDefaultTextColor, isDefaultBackgroundColor } from "../gridRenderer/styles/styleUtils";
import { isNumericValue, isErrorValue } from "../gridRenderer/styles/cellFormatting";
import { isIncompleteFormula } from "../formulaCompletion";
import { isFormula, isFormulaExpectingReference } from "../../types/types";
import { isLineInsideMerge } from "../gridRenderer/rendering/grid";

// ============================================================================
// isValidColor
// ============================================================================

describe("isValidColor", () => {
  it("accepts 6-digit hex with #", () => {
    expect(isValidColor("#ff0000")).toBe(true);
    expect(isValidColor("#ABCDEF")).toBe(true);
    expect(isValidColor("#000000")).toBe(true);
  });

  it("accepts 3-digit hex with #", () => {
    expect(isValidColor("#fff")).toBe(true);
    expect(isValidColor("#ABC")).toBe(true);
  });

  it("accepts 4-digit and 8-digit hex (with alpha)", () => {
    expect(isValidColor("#ffff")).toBe(true);
    expect(isValidColor("#ff000080")).toBe(true);
  });

  it("accepts 6/8 digit hex without # (backend format)", () => {
    expect(isValidColor("ff0000")).toBe(true);
    expect(isValidColor("FF000080")).toBe(true);
  });

  it("rejects 3-digit hex without # (ambiguous)", () => {
    expect(isValidColor("fff")).toBe(false);
  });

  it("accepts rgb/rgba", () => {
    expect(isValidColor("rgb(255, 0, 0)")).toBe(true);
    expect(isValidColor("rgba(0, 0, 0, 0.5)")).toBe(true);
    expect(isValidColor("rgb(0,0,0)")).toBe(true);
  });

  it("accepts named colors", () => {
    expect(isValidColor("red")).toBe(true);
    expect(isValidColor("transparent")).toBe(true);
    expect(isValidColor("BLACK")).toBe(true);
  });

  it("rejects null, undefined, empty", () => {
    expect(isValidColor(null)).toBe(false);
    expect(isValidColor(undefined)).toBe(false);
    expect(isValidColor("")).toBe(false);
    expect(isValidColor("   ")).toBe(false);
  });

  it("rejects invalid strings", () => {
    expect(isValidColor("notacolor")).toBe(false);
    expect(isValidColor("#xyz")).toBe(false);
    expect(isValidColor("#12345")).toBe(false);
    expect(isValidColor("rgb(999)")).toBe(false);
  });
});

// ============================================================================
// isDefaultTextColor
// ============================================================================

describe("isDefaultTextColor", () => {
  it("returns true for null/undefined (defaults)", () => {
    expect(isDefaultTextColor(null)).toBe(true);
    expect(isDefaultTextColor(undefined)).toBe(true);
  });

  it("returns true for various black representations", () => {
    expect(isDefaultTextColor("#000000")).toBe(true);
    expect(isDefaultTextColor("#000")).toBe(true);
    expect(isDefaultTextColor("000000")).toBe(true);
    expect(isDefaultTextColor("black")).toBe(true);
    expect(isDefaultTextColor("BLACK")).toBe(true);
    expect(isDefaultTextColor("rgb(0, 0, 0)")).toBe(true);
    expect(isDefaultTextColor("rgb(0,0,0)")).toBe(true);
    expect(isDefaultTextColor("rgba(0, 0, 0, 1)")).toBe(true);
    expect(isDefaultTextColor("rgba(0,0,0,1)")).toBe(true);
  });

  it("returns false for non-black colors", () => {
    expect(isDefaultTextColor("#ff0000")).toBe(false);
    expect(isDefaultTextColor("red")).toBe(false);
    expect(isDefaultTextColor("#000001")).toBe(false);
    expect(isDefaultTextColor("rgb(0, 0, 1)")).toBe(false);
    expect(isDefaultTextColor("rgba(0, 0, 0, 0.5)")).toBe(false);
  });

  it("handles whitespace", () => {
    expect(isDefaultTextColor("  #000000  ")).toBe(true);
    expect(isDefaultTextColor("  BLACK  ")).toBe(true);
  });
});

// ============================================================================
// isDefaultBackgroundColor
// ============================================================================

describe("isDefaultBackgroundColor", () => {
  it("returns true for null/undefined", () => {
    expect(isDefaultBackgroundColor(null)).toBe(true);
    expect(isDefaultBackgroundColor(undefined)).toBe(true);
  });

  it("returns true for white representations", () => {
    expect(isDefaultBackgroundColor("#ffffff")).toBe(true);
    expect(isDefaultBackgroundColor("#fff")).toBe(true);
    expect(isDefaultBackgroundColor("ffffff")).toBe(true);
    expect(isDefaultBackgroundColor("white")).toBe(true);
    expect(isDefaultBackgroundColor("rgb(255, 255, 255)")).toBe(true);
    expect(isDefaultBackgroundColor("rgb(255,255,255)")).toBe(true);
    expect(isDefaultBackgroundColor("rgba(255, 255, 255, 1)")).toBe(true);
  });

  it("returns true for transparent", () => {
    expect(isDefaultBackgroundColor("transparent")).toBe(true);
    expect(isDefaultBackgroundColor("rgba(0, 0, 0, 0)")).toBe(true);
    expect(isDefaultBackgroundColor("rgba(0,0,0,0)")).toBe(true);
  });

  it("returns false for non-default backgrounds", () => {
    expect(isDefaultBackgroundColor("#f0f0f0")).toBe(false);
    expect(isDefaultBackgroundColor("red")).toBe(false);
    expect(isDefaultBackgroundColor("rgb(255, 255, 254)")).toBe(false);
  });
});

// ============================================================================
// isNumericValue
// ============================================================================

describe("isNumericValue", () => {
  it("recognizes plain numbers", () => {
    expect(isNumericValue("42")).toBe(true);
    expect(isNumericValue("-3.14")).toBe(true);
    expect(isNumericValue("0")).toBe(true);
    expect(isNumericValue("1e10")).toBe(true);
  });

  it("recognizes formatted numbers", () => {
    expect(isNumericValue("$1,000")).toBe(true);
    expect(isNumericValue("50%")).toBe(true);
    expect(isNumericValue("(100)")).toBe(true); // accounting negative
    expect(isNumericValue("$1,234.56")).toBe(true);
  });

  it("rejects non-numeric strings", () => {
    expect(isNumericValue("")).toBe(false);
    expect(isNumericValue("hello")).toBe(false);
    expect(isNumericValue("12abc")).toBe(false);
    expect(isNumericValue("NaN")).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isNumericValue("Infinity")).toBe(false);
    expect(isNumericValue("-Infinity")).toBe(false);
  });
});

// ============================================================================
// isErrorValue
// ============================================================================

describe("isErrorValue", () => {
  it("recognizes all standard error types", () => {
    expect(isErrorValue("#VALUE!")).toBe(true);
    expect(isErrorValue("#REF!")).toBe(true);
    expect(isErrorValue("#NAME?")).toBe(true);
    expect(isErrorValue("#DIV/0!")).toBe(true);
    expect(isErrorValue("#NULL!")).toBe(true);
    expect(isErrorValue("#N/A")).toBe(true);
    expect(isErrorValue("#NUM!")).toBe(true);
    expect(isErrorValue("#ERROR")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isErrorValue("#value!")).toBe(true);
    expect(isErrorValue("#ref!")).toBe(true);
    expect(isErrorValue("#n/a")).toBe(true);
  });

  it("rejects non-error strings", () => {
    expect(isErrorValue("")).toBe(false);
    expect(isErrorValue("#")).toBe(false);
    expect(isErrorValue("ERROR")).toBe(false);
    expect(isErrorValue("hello")).toBe(false);
    expect(isErrorValue("#WRONG")).toBe(false);
  });
});

// ============================================================================
// isFormula
// ============================================================================

describe("isFormula", () => {
  it("returns true for strings starting with =", () => {
    expect(isFormula("=SUM(A1:B2)")).toBe(true);
    expect(isFormula("=")).toBe(true);
    expect(isFormula("  =A1")).toBe(true); // trimmed
  });

  it("returns false for non-formulas", () => {
    expect(isFormula("hello")).toBe(false);
    expect(isFormula("42")).toBe(false);
    expect(isFormula("")).toBe(false);
    expect(isFormula("A1=B1")).toBe(false);
  });
});

// ============================================================================
// isFormulaExpectingReference
// ============================================================================

describe("isFormulaExpectingReference", () => {
  it("returns true for bare =", () => {
    expect(isFormulaExpectingReference("=")).toBe(true);
  });

  it("returns true when ending with operator", () => {
    expect(isFormulaExpectingReference("=A1+")).toBe(true);
    expect(isFormulaExpectingReference("=A1*")).toBe(true);
    expect(isFormulaExpectingReference("=A1/")).toBe(true);
    expect(isFormulaExpectingReference("=A1-")).toBe(true);
  });

  it("returns true when ending with delimiter", () => {
    expect(isFormulaExpectingReference("=SUM(")).toBe(true);
    expect(isFormulaExpectingReference("=IF(A1>0,")).toBe(true);
    expect(isFormulaExpectingReference("=A1:")).toBe(true);
  });

  it("returns false for complete formulas", () => {
    expect(isFormulaExpectingReference("=A1")).toBe(false);
    expect(isFormulaExpectingReference("=SUM(A1:B2)")).toBe(false);
  });

  it("returns false for non-formulas", () => {
    expect(isFormulaExpectingReference("hello")).toBe(false);
    expect(isFormulaExpectingReference("")).toBe(false);
  });

  it("respects cursorPosition parameter", () => {
    // cursor after comma, before closing paren
    expect(isFormulaExpectingReference("=IF(A1,)", 7)).toBe(true);
    // cursor at end (same as no position)
    expect(isFormulaExpectingReference("=A1", 3)).toBe(false);
  });
});

// ============================================================================
// isIncompleteFormula
// ============================================================================

describe("isIncompleteFormula", () => {
  it("returns true for unclosed parentheses", () => {
    expect(isIncompleteFormula("=SUM(A1")).toBe(true);
    expect(isIncompleteFormula("=IF(A1>0,SUM(A1")).toBe(true);
  });

  it("returns true for unclosed strings", () => {
    expect(isIncompleteFormula('="Hello')).toBe(true);
    expect(isIncompleteFormula("='test")).toBe(true);
  });

  it("returns false for complete formulas", () => {
    expect(isIncompleteFormula("=SUM(A1)")).toBe(false);
    expect(isIncompleteFormula('="Hello"')).toBe(false);
    expect(isIncompleteFormula("=A1+B1")).toBe(false);
  });

  it("returns false for non-formulas", () => {
    expect(isIncompleteFormula("hello")).toBe(false);
    expect(isIncompleteFormula("42")).toBe(false);
    expect(isIncompleteFormula("")).toBe(false);
  });

  it("handles nested parentheses correctly", () => {
    expect(isIncompleteFormula("=IF(SUM(A1:B2)>0,1,0)")).toBe(false);
    expect(isIncompleteFormula("=IF(SUM(A1:B2)>0,1,0")).toBe(true);
  });
});

// ============================================================================
// isLineInsideMerge
// ============================================================================

describe("isLineInsideMerge", () => {
  const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();

  it("returns false for empty cells map", () => {
    expect(isLineInsideMerge(new Map(), "vertical", 1, 0, 5)).toBe(false);
    expect(isLineInsideMerge(new Map(), "horizontal", 1, 0, 5)).toBe(false);
  });

  it("returns false for non-merged cells", () => {
    const single = new Map([["0,0", { rowSpan: 1, colSpan: 1 }]]);
    expect(isLineInsideMerge(single, "vertical", 1, 0, 0)).toBe(false);
  });

  it("detects vertical line inside horizontal merge", () => {
    // Cell at 0,0 spans 3 columns
    const merged = new Map([["0,0", { rowSpan: 1, colSpan: 3 }]]);
    expect(isLineInsideMerge(merged, "vertical", 1, 0, 0)).toBe(true);
    expect(isLineInsideMerge(merged, "vertical", 2, 0, 0)).toBe(true);
    // Line at boundary (col 3) is not inside
    expect(isLineInsideMerge(merged, "vertical", 3, 0, 0)).toBe(false);
    // Line at col 0 is start, not inside
    expect(isLineInsideMerge(merged, "vertical", 0, 0, 0)).toBe(false);
  });

  it("detects horizontal line inside vertical merge", () => {
    // Cell at 0,0 spans 3 rows
    const merged = new Map([["0,0", { rowSpan: 3, colSpan: 1 }]]);
    expect(isLineInsideMerge(merged, "horizontal", 1, 0, 0)).toBe(true);
    expect(isLineInsideMerge(merged, "horizontal", 2, 0, 0)).toBe(true);
    expect(isLineInsideMerge(merged, "horizontal", 3, 0, 0)).toBe(false);
    expect(isLineInsideMerge(merged, "horizontal", 0, 0, 0)).toBe(false);
  });

  it("checks perpendicular overlap", () => {
    // Merge at row 2, col 3, spanning 2 rows x 3 cols
    const merged = new Map([["2,3", { rowSpan: 2, colSpan: 3 }]]);
    // Vertical line at col 4, but rows 0-1 (no overlap with merge rows 2-3)
    expect(isLineInsideMerge(merged, "vertical", 4, 0, 1)).toBe(false);
    // Same line, rows overlapping
    expect(isLineInsideMerge(merged, "vertical", 4, 2, 3)).toBe(true);
  });
});
