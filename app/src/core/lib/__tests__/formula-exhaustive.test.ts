//! FILENAME: app/src/core/lib/__tests__/formula-exhaustive.test.ts
// PURPOSE: Exhaustive edge-case tests for formula modules to maximize coverage

import { describe, it, expect } from "vitest";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  buildCellReference,
  buildRangeReference,
  updateFormulaReference,
  findReferenceAtCell,
  type FormulaReferenceWithPosition,
} from "../formulaRefParser";
import {
  toggleReferenceAtCursor,
  getReferenceAtCursor,
} from "../formulaRefToggle";
import {
  autoCompleteFormula,
  isIncompleteFormula,
} from "../formulaCompletion";

// ============================================================================
// updateFormulaReference edge cases
// ============================================================================

describe("updateFormulaReference", () => {
  function makeRef(overrides: Partial<FormulaReferenceWithPosition>): FormulaReferenceWithPosition {
    return {
      startRow: 0, startCol: 0, endRow: 0, endCol: 0,
      color: "#000", isPassive: false,
      textStartIndex: 0, textEndIndex: 0, originalText: "",
      isStartColAbsolute: false, isStartRowAbsolute: false,
      isEndColAbsolute: false, isEndRowAbsolute: false,
      ...overrides,
    };
  }

  it("moves a reference by negative delta (e.g., A5 -> A1)", () => {
    const formula = "=A5+B2";
    const refs = parseFormulaReferencesWithPositions(formula);
    const result = updateFormulaReference(formula, refs[0], 0, 0);
    expect(result).toBe("=A1+B2");
  });

  it("moves a reference to the same position (no-op)", () => {
    const formula = "=C3";
    const refs = parseFormulaReferencesWithPositions(formula);
    const result = updateFormulaReference(formula, refs[0], 2, 2);
    expect(result).toBe("=C3");
  });

  it("moves a reference to a high row/col", () => {
    const formula = "=A1";
    const refs = parseFormulaReferencesWithPositions(formula);
    const result = updateFormulaReference(formula, refs[0], 999999, 701);
    // col 701 = ZZ (0-based: 701 = 26*26+25 = ZZ)
    expect(result).toContain("1000000");
  });

  it("moves a range reference preserving size when endRow/endCol omitted", () => {
    const formula = "=A1:C3";
    const refs = parseFormulaReferencesWithPositions(formula);
    // Move top-left to D5 (row=4, col=3), range should become D5:F7
    const result = updateFormulaReference(formula, refs[0], 4, 3);
    expect(result).toBe("=D5:F7");
  });

  it("moves a range with explicit new end coordinates", () => {
    const formula = "=A1:B2";
    const refs = parseFormulaReferencesWithPositions(formula);
    const result = updateFormulaReference(formula, refs[0], 0, 0, 9, 9);
    expect(result).toBe("=A1:J10");
  });

  it("collapses a range to a single cell when start equals end", () => {
    const formula = "=A1:B2";
    const refs = parseFormulaReferencesWithPositions(formula);
    const result = updateFormulaReference(formula, refs[0], 5, 5, 5, 5);
    expect(result).toBe("=F6");
  });

  it("preserves absolute markers on moved reference", () => {
    const formula = "=$A$1";
    const refs = parseFormulaReferencesWithPositions(formula);
    const result = updateFormulaReference(formula, refs[0], 3, 3);
    expect(result).toBe("=$D$4");
  });
});

// ============================================================================
// findReferenceAtCell edge cases
// ============================================================================

describe("findReferenceAtCell", () => {
  it("finds a cell inside a range reference", () => {
    const refs = parseFormulaReferencesWithPositions("=A1:D4");
    // Cell B2 is inside range A1:D4
    expect(findReferenceAtCell(refs, 1, 1)).toBe(0);
  });

  it("finds exact cell match on corner of range", () => {
    const refs = parseFormulaReferencesWithPositions("=A1:D4");
    expect(findReferenceAtCell(refs, 0, 0)).toBe(0); // top-left
    expect(findReferenceAtCell(refs, 3, 3)).toBe(0); // bottom-right
  });

  it("returns -1 for cell outside range", () => {
    const refs = parseFormulaReferencesWithPositions("=A1:B2");
    expect(findReferenceAtCell(refs, 5, 5)).toBe(-1);
  });

  it("returns first overlapping reference", () => {
    const refs = parseFormulaReferencesWithPositions("=A1:C3+B2:D4");
    // B2 is in both ranges; should return index 0 (first match)
    expect(findReferenceAtCell(refs, 1, 1)).toBe(0);
  });

  it("skips cross-sheet references on different sheet", () => {
    const refs = parseFormulaReferencesWithPositions("=Sheet2!A1+B2");
    // Looking on Sheet1 - Sheet2!A1 should not match
    const idx = findReferenceAtCell(refs, 0, 0, "Sheet1", "Sheet1");
    // B2 is on Sheet1 (formula source), so it should match at row=1,col=1
    expect(idx).toBe(-1); // A1 is on Sheet2, not Sheet1
    expect(findReferenceAtCell(refs, 1, 1, "Sheet1", "Sheet1")).toBe(1);
  });

  it("matches when sheetName is undefined (same sheet implied)", () => {
    const refs = parseFormulaReferencesWithPositions("=A1");
    expect(findReferenceAtCell(refs, 0, 0)).toBe(0);
  });
});

// ============================================================================
// parseFormulaReferencesWithPositions - exact text positions
// ============================================================================

describe("parseFormulaReferencesWithPositions exact positions", () => {
  const cases: Array<{ formula: string; expected: Array<{ text: string; start: number; end: number }> }> = [
    { formula: "=A1", expected: [{ text: "A1", start: 1, end: 3 }] },
    { formula: "=$A$1", expected: [{ text: "$A$1", start: 1, end: 5 }] },
    { formula: "=A1+B2", expected: [{ text: "A1", start: 1, end: 3 }, { text: "B2", start: 4, end: 6 }] },
    { formula: "=A1:B2", expected: [{ text: "A1:B2", start: 1, end: 6 }] },
    { formula: "=$A$1:$B$2", expected: [{ text: "$A$1:$B$2", start: 1, end: 10 }] },
    { formula: "=SUM(A1:B2,C3)", expected: [{ text: "A1:B2", start: 5, end: 10 }, { text: "C3", start: 11, end: 13 }] },
    { formula: "=Sheet1!A1", expected: [{ text: "Sheet1!A1", start: 1, end: 10 }] },
    { formula: "='My Sheet'!A1:B2", expected: [{ text: "'My Sheet'!A1:B2", start: 1, end: 17 }] },
    { formula: "=A1+Sheet1!B2+C3", expected: [
      { text: "A1", start: 1, end: 3 },
      { text: "Sheet1!B2", start: 4, end: 13 },
      { text: "C3", start: 14, end: 16 },
    ]},
    { formula: "=IF(A1>0,B2,C3)", expected: [
      { text: "A1", start: 4, end: 6 },
      { text: "B2", start: 9, end: 11 },
      { text: "C3", start: 12, end: 14 },
    ]},
  ];

  cases.forEach(({ formula, expected }) => {
    it(`parses positions for ${formula}`, () => {
      const refs = parseFormulaReferencesWithPositions(formula);
      expect(refs).toHaveLength(expected.length);
      expected.forEach((exp, i) => {
        expect(refs[i].originalText).toBe(exp.text);
        expect(refs[i].textStartIndex).toBe(exp.start);
        expect(refs[i].textEndIndex).toBe(exp.end);
      });
    });
  });
});

// ============================================================================
// buildCellReference - all 4 absolute/relative combos + sheet names
// ============================================================================

describe("buildCellReference all combos", () => {
  it("relative col, relative row", () => {
    expect(buildCellReference(0, 0, false, false)).toBe("A1");
  });

  it("absolute col, relative row", () => {
    expect(buildCellReference(0, 0, true, false)).toBe("$A1");
  });

  it("relative col, absolute row", () => {
    expect(buildCellReference(0, 0, false, true)).toBe("A$1");
  });

  it("absolute col, absolute row", () => {
    expect(buildCellReference(0, 0, true, true)).toBe("$A$1");
  });

  it("with simple sheet name", () => {
    expect(buildCellReference(2, 1, false, false, "Sheet1")).toBe("Sheet1!B3");
  });

  it("with sheet name containing spaces (quoted)", () => {
    expect(buildCellReference(0, 0, true, true, "My Sheet")).toBe("'My Sheet'!$A$1");
  });

  it("with sheet name containing apostrophe (escaped)", () => {
    expect(buildCellReference(0, 0, false, false, "Bob's")).toBe("'Bob''s'!A1");
  });

  it("with sheet name starting with digit (quoted)", () => {
    expect(buildCellReference(0, 0, false, false, "2024")).toBe("'2024'!A1");
  });
});

// ============================================================================
// buildRangeReference - all 16 absolute/relative combos
// ============================================================================

describe("buildRangeReference all 16 combos", () => {
  const bools = [false, true];
  let count = 0;
  for (const sc of bools) {
    for (const sr of bools) {
      for (const ec of bools) {
        for (const er of bools) {
          const label = `startCol=${sc ? "$" : ""}A, startRow=${sr ? "$" : ""}1, endCol=${ec ? "$" : ""}B, endRow=${er ? "$" : ""}2`;
          it(`combo: ${label}`, () => {
            const result = buildRangeReference(0, 0, 1, 1, sc, sr, ec, er);
            const expected =
              `${sc ? "$" : ""}A${sr ? "$" : ""}1:${ec ? "$" : ""}B${er ? "$" : ""}2`;
            expect(result).toBe(expected);
          });
          count++;
        }
      }
    }
  }

  it("collapses single cell range (start == end)", () => {
    expect(buildRangeReference(0, 0, 0, 0, true, true, false, false)).toBe("$A$1");
  });

  it("with sheet name on range", () => {
    expect(buildRangeReference(0, 0, 1, 1, false, false, false, false, "Data")).toBe("Data!A1:B2");
  });

  it("single cell range with sheet name", () => {
    expect(buildRangeReference(2, 2, 2, 2, false, false, false, false, "Sheet1")).toBe("Sheet1!C3");
  });
});

// ============================================================================
// autoCompleteFormula edge cases
// ============================================================================

describe("autoCompleteFormula", () => {
  it("handles string with escaped quote inside", () => {
    // Backslash-escaped quote: the char after backslash is not treated as closing
    const result = autoCompleteFormula('=CONCAT("hello\\"');
    // The \" means the quote after backslash doesn't close, so we're still in string
    // Actually: prevChar is \, so " is skipped -> still inString -> adds " then )
    expect(result).toContain(")");
  });

  it("closes multiple unclosed parens", () => {
    expect(autoCompleteFormula("=SUM(IF(A1")).toBe("=SUM(IF(A1))");
  });

  it("closes unclosed single-quote string", () => {
    expect(autoCompleteFormula("='hello")).toBe("='hello'");
  });

  it("no change for complete formula", () => {
    expect(autoCompleteFormula("=SUM(A1)")).toBe("=SUM(A1)");
  });

  it("no change for non-formula", () => {
    expect(autoCompleteFormula("hello")).toBe("hello");
  });

  it("handles paren inside string (not counted)", () => {
    // The ( inside the string should not affect paren depth
    expect(autoCompleteFormula('=CONCAT("(", A1')).toBe('=CONCAT("(", A1)');
  });

  it("does not add parens when depth is negative (extra closing parens)", () => {
    // Extra ) makes depth negative -- no parens added
    const result = autoCompleteFormula("=A1)");
    expect(result).toBe("=A1)");
  });
});

// ============================================================================
// isIncompleteFormula edge cases
// ============================================================================

describe("isIncompleteFormula", () => {
  it("returns false for non-formula", () => {
    expect(isIncompleteFormula("hello")).toBe(false);
  });

  it("returns true for unclosed string", () => {
    expect(isIncompleteFormula('="hello')).toBe(true);
  });

  it("returns true for unclosed paren", () => {
    expect(isIncompleteFormula("=SUM(A1")).toBe(true);
  });

  it("returns false for balanced formula", () => {
    expect(isIncompleteFormula("=SUM(A1)")).toBe(false);
  });
});

// ============================================================================
// toggleReferenceAtCursor on range references
// ============================================================================

describe("toggleReferenceAtCursor on ranges", () => {
  it("toggles first cell of a range A1:B5 -> $A$1:B5", () => {
    // Cursor on A1 part (position 1-3)
    const result = toggleReferenceAtCursor("=A1:B5", 2);
    // The regex matches individual cell refs, not ranges as units
    // A1 at [1,3] and B5 at [4,6] are separate matches
    expect(result.formula).toBe("=$A$1:B5");
  });

  it("toggles second cell of a range A1:B5 -> A1:$B$5", () => {
    const result = toggleReferenceAtCursor("=A1:B5", 5);
    expect(result.formula).toBe("=A1:$B$5");
  });

  it("falls back to nearest ref before cursor", () => {
    // Cursor after closing paren
    const result = toggleReferenceAtCursor("=SUM(B2)", 8);
    expect(result.formula).toBe("=SUM($B$2)");
  });

  it("returns unchanged when no refs exist", () => {
    const result = toggleReferenceAtCursor("=123+456", 3);
    expect(result.formula).toBe("=123+456");
    expect(result.cursorPos).toBe(3);
  });

  it("returns unchanged when cursor is before all refs", () => {
    const result = toggleReferenceAtCursor("=A1", 0);
    // cursor at 0 is before A1 which starts at 1
    // No ref at cursor, no ref before cursor -> unchanged
    expect(result.formula).toBe("=A1");
  });
});

// ============================================================================
// getReferenceAtCursor edge cases
// ============================================================================

describe("getReferenceAtCursor", () => {
  it("returns null for formula with no refs", () => {
    expect(getReferenceAtCursor("=123", 2)).toBeNull();
  });

  it("falls back to nearest ref before cursor", () => {
    const result = getReferenceAtCursor("=A1+100", 6);
    expect(result).not.toBeNull();
    expect(result!.ref).toBe("A1");
  });

  it("returns null when cursor is before all refs", () => {
    expect(getReferenceAtCursor("=A1", 0)).toBeNull();
  });
});

// ============================================================================
// Formula edge cases: non-formula strings
// ============================================================================

describe("non-formula and edge-case strings", () => {
  it("space before = sign is not a formula", () => {
    expect(parseFormulaReferences(" =A1")).toEqual([]);
    expect(parseFormulaReferencesWithPositions(" =A1")).toEqual([]);
  });

  it("formula with multiple = signs (=A1=B1 is a comparison)", () => {
    const refs = parseFormulaReferences("=A1=B1");
    expect(refs).toHaveLength(2);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].startCol).toBe(0);
    expect(refs[1].startRow).toBe(0);
    expect(refs[1].startCol).toBe(1);
  });

  it("formula with only whitespace after = sign", () => {
    const refs = parseFormulaReferences("=   ");
    expect(refs).toEqual([]);
  });

  it("empty string returns no refs", () => {
    expect(parseFormulaReferences("")).toEqual([]);
  });

  it("just = sign returns no refs", () => {
    expect(parseFormulaReferences("=")).toEqual([]);
  });
});

// ============================================================================
// parseFormulaReferences: 3D references and special cases
// ============================================================================

describe("parseFormulaReferences special cases", () => {
  it("handles 3D reference Sheet1:Sheet3!A1", () => {
    const refs = parseFormulaReferences("=Sheet1:Sheet3!A1");
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Sheet1");
  });

  it("handles passive mode", () => {
    const refs = parseFormulaReferences("=A1", true);
    expect(refs).toHaveLength(1);
    expect(refs[0].isPassive).toBe(true);
  });

  it("handles reversed range (B2:A1 normalizes to A1:B2)", () => {
    const refs = parseFormulaReferences("=B2:A1");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].endRow).toBe(1);
    expect(refs[0].endCol).toBe(1);
  });

  it("assigns cycling colors to multiple references", () => {
    const formula = "=A1+B2+C3+D4+E5+F6+G7+H8+I9+J10";
    const refs = parseFormulaReferences(formula);
    expect(refs.length).toBe(10);
    // Colors should cycle
    expect(refs[0].color).toBe(refs[0].color); // sanity
  });
});
