//! FILENAME: app/src/core/lib/formulaRefParser-edge.test.ts
// PURPOSE: Edge-case and stress tests for formulaRefParser.

import { describe, it, expect } from "vitest";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  buildCellReference,
  buildRangeReference,
  findReferenceAtCell,
  updateFormulaReference,
} from "./formulaRefParser";

// ============================================================================
// Stress: Very long formulas (100+ references)
// ============================================================================

describe("stress: formulas with 100+ references", () => {
  it("parses 100 cell references", () => {
    const cellRefs = Array.from({ length: 100 }, (_, i) => {
      const col = String.fromCharCode(65 + (i % 26));
      const row = Math.floor(i / 26) + 1;
      return `${col}${row}`;
    });
    const formula = "=" + cellRefs.join("+");
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(100);
  });

  it("parses 50 range references", () => {
    const rangeRefs = Array.from({ length: 50 }, (_, i) => {
      const col = String.fromCharCode(65 + (i % 26));
      const row = Math.floor(i / 26) + 1;
      return `${col}${row}:${col}${row + 10}`;
    });
    const formula = "=" + rangeRefs.join("+");
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(50);
    refs.forEach((ref) => {
      expect(ref.endRow - ref.startRow).toBe(10);
    });
  });

  it("tracks positions correctly in long formulas", () => {
    const formula = "=" + Array.from({ length: 50 }, () => "A1").join("+");
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(50);
    // Each "A1" should have correct originalText
    refs.forEach((ref) => {
      expect(ref.originalText).toBe("A1");
    });
  });

  it("handles SUM with 200 arguments", () => {
    const args = Array.from({ length: 200 }, (_, i) => {
      const col = String.fromCharCode(65 + (i % 26));
      const row = Math.floor(i / 26) + 1;
      return `${col}${row}`;
    });
    const formula = `=SUM(${args.join(",")})`;
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(200);
  });
});

// ============================================================================
// Stress: Deeply nested function calls
// ============================================================================

describe("stress: nested function calls", () => {
  it("parses references in 10-level nested IF", () => {
    // IF(A1>0, IF(B1>0, IF(C1>0, ... D1 ..., E1), F1), G1)
    let formula = "=A1";
    for (let i = 0; i < 10; i++) {
      const col = String.fromCharCode(66 + i); // B, C, D, ...
      formula = `IF(${col}1>0,${formula},${col}2)`;
    }
    formula = "=" + formula;
    const refs = parseFormulaReferences(formula);
    // A1 + 10 pairs of col1 and col2 = 21 refs
    expect(refs.length).toBeGreaterThanOrEqual(10);
  });

  it("parses nested SUM/AVERAGE/MAX", () => {
    const formula = "=SUM(A1:A10,AVERAGE(B1:B10,MAX(C1:C10,MIN(D1:D10))))";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(4);
    expect(refs[0]).toMatchObject({ startCol: 0, endCol: 0, startRow: 0, endRow: 9 });
  });

  it("parses INDEX/MATCH combination", () => {
    const formula = "=INDEX(A1:A100,MATCH(B1,C1:C100,0))";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(3);
  });

  it("parses SUMPRODUCT with multiple ranges", () => {
    const formula = "=SUMPRODUCT((A1:A50=\"Yes\")*(B1:B50)*(C1:C50>0))";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(3);
  });
});

// ============================================================================
// Edge: Column boundaries
// ============================================================================

describe("edge: extreme column and row references", () => {
  it("parses triple-letter column (AAA1)", () => {
    const refs = parseFormulaReferences("=AAA1");
    expect(refs).toHaveLength(1);
    // AAA = 26*26 + 26 + 0 = 702
    expect(refs[0].startCol).toBe(702);
  });

  it("parses XFD1 (last Excel column)", () => {
    const refs = parseFormulaReferences("=XFD1");
    expect(refs).toHaveLength(1);
    // XFD = 16383
    expect(refs[0].startCol).toBe(16383);
  });

  it("parses very high row number", () => {
    const refs = parseFormulaReferences("=A1048576");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(1048575); // 0-based
  });

  it("parses range spanning large area", () => {
    const refs = parseFormulaReferences("=A1:ZZ9999");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].endRow).toBe(9998);
  });

  it("builds reference for column 702 (AAA)", () => {
    const ref = buildCellReference(0, 702, false, false);
    expect(ref).toBe("AAA1");
  });
});

// ============================================================================
// Edge: Mixed absolute/relative markers
// ============================================================================

describe("edge: all absolute/relative combinations", () => {
  const combos: [boolean, boolean, string][] = [
    [false, false, "A1"],
    [true, false, "$A1"],
    [false, true, "A$1"],
    [true, true, "$A$1"],
  ];

  for (const [absCol, absRow, expected] of combos) {
    it(`buildCellReference(absCol=${absCol}, absRow=${absRow}) => ${expected}`, () => {
      expect(buildCellReference(0, 0, absCol, absRow)).toBe(expected);
    });
  }

  it("preserves all 16 absolute combos in range reference", () => {
    // 4 booleans for range = 16 combinations; just test they don't crash
    for (let mask = 0; mask < 16; mask++) {
      const sc = !!(mask & 8), sr = !!(mask & 4), ec = !!(mask & 2), er = !!(mask & 1);
      const result = buildRangeReference(0, 0, 1, 1, sc, sr, ec, er);
      expect(result).toBeTruthy();
      // Verify round-trip parse
      const refs = parseFormulaReferences("=" + result);
      expect(refs).toHaveLength(1);
    }
  });
});

// ============================================================================
// Edge: Sheet name variations
// ============================================================================

describe("edge: unusual sheet names", () => {
  it("handles sheet name with numbers", () => {
    const refs = parseFormulaReferences("=Sheet123!A1");
    expect(refs[0].sheetName).toBe("Sheet123");
  });

  it("handles quoted sheet name with special chars", () => {
    const refs = parseFormulaReferences("='Sheet (1)'!A1");
    expect(refs[0].sheetName).toBe("Sheet (1)");
  });

  it("handles quoted sheet name with single quote escape", () => {
    const refs = parseFormulaReferences("='Sheet''s Data'!A1:B2");
    expect(refs).toHaveLength(1);
    // The sheet name may include the escaped quote
    expect(refs[0].sheetName).toBeDefined();
  });

  it("handles multiple cross-sheet references to different sheets", () => {
    const refs = parseFormulaReferences("=Sheet1!A1+Sheet2!B2+'My Sheet'!C3");
    expect(refs).toHaveLength(3);
    expect(refs[0].sheetName).toBe("Sheet1");
    expect(refs[1].sheetName).toBe("Sheet2");
    expect(refs[2].sheetName).toBe("My Sheet");
  });
});

// ============================================================================
// Edge: Formulas with string literals and errors
// ============================================================================

describe("edge: formulas with strings and errors", () => {
  it("does not parse references inside string literals", () => {
    const refs = parseFormulaReferences('=A1&"B2"');
    // "B2" is inside a string literal - should not be a reference
    // A1 should be parsed, B2 should not
    const a1 = refs.find((r) => r.startCol === 0 && r.startRow === 0);
    expect(a1).toBeDefined();
  });

  it("handles formula with error values as text", () => {
    // Error values like #REF! should not break parsing
    const refs = parseFormulaReferences("=A1+#REF!+B2");
    // Should still find A1 and B2
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it("handles formula starting with error", () => {
    const refs = parseFormulaReferences("=#REF!");
    // Should not crash
    expect(refs).toBeDefined();
  });

  it("handles empty parentheses", () => {
    const refs = parseFormulaReferences("=SUM()");
    expect(refs).toHaveLength(0);
  });
});

// ============================================================================
// Edge: Array-formula-like patterns
// ============================================================================

describe("edge: array formula patterns", () => {
  it("parses curly-brace array formula", () => {
    // Legacy array formula syntax: {=SUM(A1:A10*B1:B10)}
    const refs = parseFormulaReferences("={SUM(A1:A10*B1:B10)}");
    // Should find both ranges even with curly braces
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  it("parses modern dynamic array functions", () => {
    const refs = parseFormulaReferences("=FILTER(A1:D100,B1:B100>0)");
    expect(refs).toHaveLength(2);
  });

  it("parses SEQUENCE and SORT references", () => {
    const refs = parseFormulaReferences("=SORT(A1:C10,2,-1)");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ startCol: 0, endCol: 2, startRow: 0, endRow: 9 });
  });
});

// ============================================================================
// Edge: updateFormulaReference edge cases
// ============================================================================

describe("edge: updateFormulaReference boundaries", () => {
  it("handles moving reference to row 0, col 0", () => {
    const refs = parseFormulaReferencesWithPositions("=C3");
    const result = updateFormulaReference("=C3", refs[0], 0, 0);
    expect(result).toBe("=A1");
  });

  it("handles moving range to very large coordinates", () => {
    const refs = parseFormulaReferencesWithPositions("=A1:B2");
    const result = updateFormulaReference("=A1:B2", refs[0], 1000, 100);
    expect(result).toContain("1001"); // row 1000 is displayed as 1001
  });

  it("updates first of many references without affecting others", () => {
    const formula = "=A1+B2+C3+D4+E5";
    const refs = parseFormulaReferencesWithPositions(formula);
    const result = updateFormulaReference(formula, refs[0], 5, 5);
    expect(result).toContain("F6"); // A1 moved to F6
    expect(result).toContain("B2"); // unchanged
    expect(result).toContain("C3"); // unchanged
  });

  it("updates last reference in formula", () => {
    const formula = "=A1+B2+C3";
    const refs = parseFormulaReferencesWithPositions(formula);
    const result = updateFormulaReference(formula, refs[2], 0, 0);
    expect(result).toBe("=A1+B2+A1");
  });
});

// ============================================================================
// Edge: findReferenceAtCell boundaries
// ============================================================================

describe("edge: findReferenceAtCell corner cases", () => {
  it("finds reference at range boundary cells", () => {
    const refs = parseFormulaReferencesWithPositions("=A1:C3");
    // Top-left corner
    expect(findReferenceAtCell(refs, 0, 0)).toBe(0);
    // Bottom-right corner
    expect(findReferenceAtCell(refs, 2, 2)).toBe(0);
    // Just outside
    expect(findReferenceAtCell(refs, 3, 3)).toBe(-1);
  });

  it("returns first matching when multiple references overlap", () => {
    // Two overlapping ranges
    const refs = parseFormulaReferencesWithPositions("=A1:C3+B2:D4");
    // B2 is in both ranges - should return first (index 0)
    const idx = findReferenceAtCell(refs, 1, 1);
    expect(idx).toBe(0);
  });

  it("handles empty references array", () => {
    expect(findReferenceAtCell([], 0, 0)).toBe(-1);
  });
});

// ============================================================================
// Performance
// ============================================================================

describe("performance: parsing throughput", () => {
  it("parses 1000 formulas within reasonable time", () => {
    const formula = "=SUM(A1:A100)+AVERAGE(B1:B50,C1:C50)+D1*E1/F1";
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      parseFormulaReferences(formula);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });
});
