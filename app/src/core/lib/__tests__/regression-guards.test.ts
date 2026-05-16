//! FILENAME: app/src/core/lib/__tests__/regression-guards.test.ts
// PURPOSE: Regression guards for specific bugs and edge cases found during testing.
// CONTEXT: Each test documents a known bug or fragile edge case to prevent regressions.

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types";
import { parseFormulaReferences } from "../formulaRefParser";
import { scrollToVisibleRange, isCellVisible } from "../scrollUtils";
import { autoCompleteFormula } from "../formulaCompletion";
import type { GridConfig, Viewport } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 30,
    totalRows: 1_000_000,
    totalCols: 16_384,
    minColumnWidth: 20,
    minRowHeight: 10,
    outlineBarWidth: 0,
    ...overrides,
  } as GridConfig;
}

// ============================================================================
// Guard: columnToLetter(0) must be "A" not ""
// ============================================================================

describe("REGRESSION: columnToLetter off-by-one", () => {
  it("columnToLetter(0) returns 'A', not empty string", () => {
    expect(columnToLetter(0)).toBe("A");
  });

  it("columnToLetter does not return undefined or empty for any valid index", () => {
    for (let i = 0; i < 26; i++) {
      const result = columnToLetter(i);
      expect(result).toBeTruthy();
      expect(result.length).toBe(1);
    }
  });
});

// ============================================================================
// Guard: letterToColumn("A") must be 0 not 1 (0-based)
// ============================================================================

describe("REGRESSION: letterToColumn 1-based vs 0-based", () => {
  it("letterToColumn('A') returns 0, not 1", () => {
    expect(letterToColumn("A")).toBe(0);
  });

  it("letterToColumn('Z') returns 25, not 26", () => {
    expect(letterToColumn("Z")).toBe(25);
  });

  it("round-trip: letterToColumn(columnToLetter(n)) === n", () => {
    for (const n of [0, 1, 25, 26, 701, 702]) {
      expect(letterToColumn(columnToLetter(n))).toBe(n);
    }
  });
});

// ============================================================================
// Guard: parseFormulaReferences must handle $A$1 without doubling
// ============================================================================

describe("REGRESSION: parseFormulaReferences with absolute references", () => {
  it("$A$1 produces exactly one reference, not two", () => {
    const refs = parseFormulaReferences("=$A$1+1");
    const a1Refs = refs.filter(
      (r) => r.startRow === 0 && r.startCol === 0 && r.endRow === 0 && r.endCol === 0,
    );
    expect(a1Refs.length).toBe(1);
  });

  it("$A$1:$B$2 produces exactly one range reference", () => {
    const refs = parseFormulaReferences("=SUM($A$1:$B$2)");
    expect(refs.length).toBe(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].endRow).toBe(1);
    expect(refs[0].endCol).toBe(1);
  });

  it("mixed absolute/relative like $A1 does not duplicate", () => {
    const refs = parseFormulaReferences("=$A1");
    expect(refs.length).toBe(1);
  });
});

// ============================================================================
// Guard: scrollToVisibleRange with scroll=0 starts at row 0, col 0
// ============================================================================

describe("REGRESSION: scrollToVisibleRange at origin", () => {
  it("scroll (0,0) starts at row 0, col 0", () => {
    const config = makeConfig();
    const range = scrollToVisibleRange(0, 0, config, 800, 600);
    expect(range.startRow).toBe(0);
    expect(range.startCol).toBe(0);
  });

  it("scroll (0,0) has zero pixel offset", () => {
    const config = makeConfig();
    const range = scrollToVisibleRange(0, 0, config, 800, 600);
    expect(range.offsetX).toBe(-0); // -(0 % width) produces -0 in JS
    expect(range.offsetY).toBe(-0);
  });

  it("endRow and endCol are positive", () => {
    const config = makeConfig();
    const range = scrollToVisibleRange(0, 0, config, 800, 600);
    expect(range.endRow).toBeGreaterThan(0);
    expect(range.endCol).toBeGreaterThan(0);
  });
});

// ============================================================================
// Guard: autoCompleteFormula must not add extra parens to complete formulas
// ============================================================================

describe("REGRESSION: autoCompleteFormula does not over-complete", () => {
  it("already-balanced formula is returned unchanged", () => {
    expect(autoCompleteFormula("=SUM(A1:B2)")).toBe("=SUM(A1:B2)");
  });

  it("nested balanced parens are returned unchanged", () => {
    expect(autoCompleteFormula("=IF(A1>0,SUM(B1:B5),0)")).toBe(
      "=IF(A1>0,SUM(B1:B5),0)",
    );
  });

  it("adds exactly one paren when one is missing", () => {
    expect(autoCompleteFormula("=SUM(A1:B2")).toBe("=SUM(A1:B2)");
  });

  it("adds exactly two parens when two are missing", () => {
    expect(autoCompleteFormula("=IF(A1,SUM(B1")).toBe("=IF(A1,SUM(B1))");
  });

  it("non-formula text is never modified", () => {
    expect(autoCompleteFormula("hello(")).toBe("hello(");
  });
});

// ============================================================================
// Guard: isCellVisible edge - cell at exact viewport boundary
// ============================================================================

describe("REGRESSION: isCellVisible at viewport boundary", () => {
  it("cell at (0,0) is visible when viewport starts at origin", () => {
    const config = makeConfig();
    const viewport: Viewport = {
      startRow: 0,
      startCol: 0,
      rowCount: 20,
      colCount: 10,
      scrollX: 0,
      scrollY: 0,
    };
    expect(isCellVisible(0, 0, viewport, config, 800, 600)).toBe(true);
  });

  it("cell at endRow boundary is still visible", () => {
    const config = makeConfig();
    const viewport: Viewport = {
      startRow: 0,
      startCol: 0,
      rowCount: 20,
      colCount: 10,
      scrollX: 0,
      scrollY: 0,
    };
    // Get the range to find the actual endRow
    const range = scrollToVisibleRange(0, 0, config, 800, 600);
    expect(isCellVisible(range.endRow, 0, viewport, config, 800, 600)).toBe(true);
  });

  it("cell one past endRow is not visible", () => {
    const config = makeConfig();
    const viewport: Viewport = {
      startRow: 0,
      startCol: 0,
      rowCount: 20,
      colCount: 10,
      scrollX: 0,
      scrollY: 0,
    };
    const range = scrollToVisibleRange(0, 0, config, 800, 600);
    expect(isCellVisible(range.endRow + 1, 0, viewport, config, 800, 600)).toBe(false);
  });
});
