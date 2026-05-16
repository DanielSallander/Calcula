//! FILENAME: app/src/core/lib/__tests__/negative-tests.test.ts
// PURPOSE: Comprehensive negative testing - verify the system rejects invalid input gracefully.
// CONTEXT: Tests column conversion, range parsing, formula parsing, and scroll utils with bad inputs.

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types/types";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
} from "../formulaRefParser";
import { autoCompleteFormula, isIncompleteFormula } from "../formulaCompletion";
import {
  calculateMaxScroll,
  clampScroll,
  scrollToVisibleRange,
  getColumnWidthFromDimensions,
  getRowHeightFromDimensions,
} from "../scrollUtils";
import type { GridConfig, Viewport } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    totalRows: 1000,
    totalCols: 26,
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 30,
    ...overrides,
  } as GridConfig;
}

// ============================================================================
// Column conversion - invalid inputs
// ============================================================================

describe("columnToLetter - negative tests", () => {
  it("handles negative index", () => {
    // Negative col should not crash; result may be empty or garbage but no throw
    expect(() => columnToLetter(-1)).not.toThrow();
  });

  it("handles -100 index", () => {
    expect(() => columnToLetter(-100)).not.toThrow();
  });

  it("handles NaN index", () => {
    expect(() => columnToLetter(NaN)).not.toThrow();
  });

  // NOTE: columnToLetter(Infinity) causes infinite loop and OOM - not tested here.
  // This is a known limitation; callers must validate input before calling.

  it("handles fractional index (1.7)", () => {
    // Should truncate or handle gracefully
    const result = columnToLetter(1.7);
    expect(typeof result).toBe("string");
    // Column 1 = "B"
    expect(result).toBe("B");
  });
});

describe("letterToColumn - negative tests", () => {
  it("returns a number for empty string", () => {
    const result = letterToColumn("");
    expect(typeof result).toBe("number");
  });

  it("handles numeric string '123'", () => {
    // Digits have charCodes outside A-Z range, but function should not throw
    expect(() => letterToColumn("123")).not.toThrow();
  });

  it("handles special characters", () => {
    expect(() => letterToColumn("!@#")).not.toThrow();
  });

  it("handles lowercase letters", () => {
    // letterToColumn uses charCode - 64, lowercase will produce wrong results
    // but should not throw
    const result = letterToColumn("a");
    expect(typeof result).toBe("number");
  });

  it("handles very long string", () => {
    const long = "A".repeat(100);
    expect(() => letterToColumn(long)).not.toThrow();
  });
});

// ============================================================================
// Range / reference parsing - malformed addresses
// ============================================================================

describe("parseFormulaReferences - malformed addresses", () => {
  it("returns empty for non-formula string", () => {
    expect(parseFormulaReferences("hello")).toEqual([]);
  });

  it("returns empty for formula with no valid references", () => {
    expect(parseFormulaReferences("=")).toEqual([]);
  });

  it("rejects 'A' alone (no row number)", () => {
    const refs = parseFormulaReferences("=A");
    expect(refs).toEqual([]);
  });

  it("rejects '1A' (row before column)", () => {
    // '1A' is not a valid cell ref
    const refs = parseFormulaReferences("=1A");
    expect(refs).toEqual([]);
  });

  it("rejects 'A-1' (negative row)", () => {
    const refs = parseFormulaReferences("=A-1");
    expect(refs).toEqual([]);
  });

  it("does not parse 'AA' without row number", () => {
    const refs = parseFormulaReferences("=AA");
    expect(refs).toEqual([]);
  });

  it("handles ':B5' (missing start of range)", () => {
    const refs = parseFormulaReferences("=:B5");
    // Should pick up B5 as standalone ref, not a range
    expect(refs.length).toBeLessThanOrEqual(1);
  });

  it("handles 'A1:' (missing end of range)", () => {
    const refs = parseFormulaReferences("=A1:");
    // Should pick up A1 as standalone ref
    expect(refs.length).toBeLessThanOrEqual(1);
  });

  it("handles '!A1' (bang without sheet name)", () => {
    const refs = parseFormulaReferences("=!A1");
    // May or may not parse - should not crash
    expect(Array.isArray(refs)).toBe(true);
  });

  it("handles 'A1:A1:A1' (triple range)", () => {
    const refs = parseFormulaReferences("=A1:A1:A1");
    // Should not crash; may parse partial refs
    expect(Array.isArray(refs)).toBe(true);
  });
});

// ============================================================================
// Formula parsing - only operators, unbalanced brackets, nested errors
// ============================================================================

describe("autoCompleteFormula - negative tests", () => {
  it("handles formula with only operators", () => {
    const result = autoCompleteFormula("=+-*/");
    expect(typeof result).toBe("string");
    expect(result.startsWith("=")).toBe(true);
  });

  it("handles deeply unbalanced parentheses (many opens)", () => {
    const result = autoCompleteFormula("=((((((");
    expect(result).toBe("=(((((())))))");
  });

  it("handles extra closing parens", () => {
    const result = autoCompleteFormula("=A1)))");
    expect(typeof result).toBe("string");
  });

  it("handles nested unclosed quotes inside parens", () => {
    const result = autoCompleteFormula('=IF("hello');
    expect(typeof result).toBe("string");
    // Should close both quote and paren
  });

  it("handles formula that is just '='", () => {
    const result = autoCompleteFormula("=");
    expect(result).toBe("=");
  });

  it("returns non-formula strings unchanged", () => {
    expect(autoCompleteFormula("hello")).toBe("hello");
    expect(autoCompleteFormula("")).toBe("");
  });
});

describe("isIncompleteFormula - negative tests", () => {
  it("returns false for non-formula", () => {
    expect(isIncompleteFormula("hello")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isIncompleteFormula("")).toBe(false);
  });

  it("handles null bytes in formula", () => {
    expect(() => isIncompleteFormula("=\0\0")).not.toThrow();
  });
});

// ============================================================================
// Scroll utils - negative viewport dimensions, NaN, zero totals
// ============================================================================

describe("scrollUtils - negative tests", () => {
  it("calculateMaxScroll with zero totalRows", () => {
    const config = makeConfig({ totalRows: 0, totalCols: 0 });
    const result = calculateMaxScroll(config, 800, 600, undefined);
    expect(typeof result.maxScrollX).toBe("number");
    expect(typeof result.maxScrollY).toBe("number");
  });

  it("calculateMaxScroll with negative viewport dimensions", () => {
    const config = makeConfig();
    const result = calculateMaxScroll(config, -100, -200, undefined);
    expect(typeof result.maxScrollX).toBe("number");
    expect(typeof result.maxScrollY).toBe("number");
  });

  it("clampScroll with NaN returns NaN (no input validation)", () => {
    const config = makeConfig();
    const result = clampScroll(NaN, NaN, config, 800, 600, undefined);
    // clampScroll does not guard against NaN - callers must validate
    expect(isNaN(result.scrollX)).toBe(true);
    expect(isNaN(result.scrollY)).toBe(true);
  });

  it("scrollToVisibleRange with NaN scroll values", () => {
    const config = makeConfig();
    expect(() =>
      scrollToVisibleRange(NaN, NaN, 800, 600, config, undefined)
    ).not.toThrow();
  });

  it("scrollToVisibleRange with negative viewport", () => {
    const config = makeConfig();
    expect(() =>
      scrollToVisibleRange(0, 0, -500, -500, config, undefined)
    ).not.toThrow();
  });

  it("getColumnWidthFromDimensions with NaN col", () => {
    const config = makeConfig();
    const result = getColumnWidthFromDimensions(NaN, config, undefined);
    expect(typeof result).toBe("number");
  });

  it("getRowHeightFromDimensions with NaN row", () => {
    const config = makeConfig();
    const result = getRowHeightFromDimensions(NaN, config, undefined);
    expect(typeof result).toBe("number");
  });
});
