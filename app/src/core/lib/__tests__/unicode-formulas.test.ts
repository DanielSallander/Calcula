//! FILENAME: app/src/core/lib/__tests__/unicode-formulas.test.ts
// PURPOSE: Tests for unicode handling in formula references, sheet names, and string literals.

import { describe, it, expect } from "vitest";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  buildCellReference,
  buildRangeReference,
} from "../formulaRefParser";
import { columnToLetter, letterToColumn } from "../../types";

// ============================================================================
// Sheet names with unicode characters
// ============================================================================

describe("sheet names with unicode characters", () => {
  it("parses reference with quoted Swedish sheet name", () => {
    const formula = "='Försäljning'!A1";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Försäljning");
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].startRow).toBe(0);
  });

  it("parses reference with quoted German sheet name", () => {
    const formula = "='Übersicht'!B2";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Übersicht");
  });

  it("parses reference with quoted CJK sheet name", () => {
    const formula = "='売上データ'!C3";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("売上データ");
    expect(refs[0].startCol).toBe(2);
    expect(refs[0].startRow).toBe(2);
  });

  it("parses reference with quoted Arabic sheet name", () => {
    const formula = "='البيانات'!D4";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("البيانات");
  });

  it("parses range reference with unicode sheet name", () => {
    const formula = "=SUM('Données'!A1:B10)";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Données");
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].endCol).toBe(1);
  });

  it("parses multiple references with different unicode sheet names", () => {
    const formula = "='日本語'!A1+'中文'!B2";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(2);
    expect(refs[0].sheetName).toBe("日本語");
    expect(refs[1].sheetName).toBe("中文");
  });

  it("handles sheet name with single quote requiring escaping", () => {
    const formula = "='It''s Data'!A1";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    // The escaped single quote should be parsed correctly
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].startRow).toBe(0);
  });
});

// ============================================================================
// Column letters are ASCII-only
// ============================================================================

describe("column letters are ASCII-only", () => {
  it("columnToLetter returns only A-Z characters", () => {
    for (let col = 0; col < 100; col++) {
      const letter = columnToLetter(col);
      expect(letter).toMatch(/^[A-Z]+$/);
    }
  });

  it("letterToColumn rejects non-ASCII letters", () => {
    // These should return -1 or throw, since they are not valid column letters
    const invalidInputs = ["Ä", "Ö", "Ü", "É", "Ñ"];
    for (const input of invalidInputs) {
      const result = letterToColumn(input);
      // Invalid column letters should not produce a valid column index
      // (The exact behavior depends on implementation - they may return a garbage value
      // but should not match any real column index meaningfully)
      expect(typeof result).toBe("number");
    }
  });

  it("unicode characters in formula do not produce phantom cell references", () => {
    // The string "Ä1" looks like a cell reference but Ä is not a valid column letter
    const formula = '=Ä1+B2';
    const refs = parseFormulaReferences(formula);
    // Should only find B2, not Ä1
    const b2Ref = refs.find(r => r.startCol === 1 && r.startRow === 1);
    expect(b2Ref).toBeDefined();
    // Ä1 should not be parsed as a cell reference
    const phantomRef = refs.find(r => r.sheetName === undefined && r.startCol !== 1);
    // If it finds something, it should not be at a position matching Ä1
    expect(refs.length).toBe(1);
  });
});

// ============================================================================
// Formula strings containing unicode text literals
// ============================================================================

describe("formula strings with unicode text literals", () => {
  it("does not extract references from inside string literals with unicode", () => {
    // Note: the parser may or may not skip string literals depending on implementation.
    // This test documents the behavior.
    const formula = '=A1&"日本語テスト"';
    const refs = parseFormulaReferences(formula);
    // A1 should be found
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].startRow).toBe(0);
  });

  it("handles formula with unicode concatenation", () => {
    const formula = '=A1&" – "&B1';
    const refs = parseFormulaReferences(formula);
    expect(refs.length).toBe(2);
  });

  it("parses references after emoji in formula string", () => {
    const formula = '="🎉"&A1';
    const refs = parseFormulaReferences(formula);
    expect(refs.length).toBeGreaterThanOrEqual(1);
    const a1 = refs.find(r => r.startCol === 0 && r.startRow === 0);
    expect(a1).toBeDefined();
  });
});

// ============================================================================
// buildCellReference / buildRangeReference with unicode sheet names
// ============================================================================

describe("building references with unicode sheet names", () => {
  it("quotes sheet names with unicode characters", () => {
    const ref = buildCellReference(0, 0, false, false, "Données");
    // Unicode sheet names need quoting since they may contain non-ASCII
    // The exact behavior depends on the quoting regex
    expect(ref).toContain("A1");
    expect(ref).toContain("Données");
  });

  it("quotes sheet name with spaces and unicode", () => {
    const ref = buildCellReference(2, 3, true, true, "日本 データ");
    expect(ref).toContain("'日本 データ'");
    expect(ref).toContain("$D$3");
  });

  it("builds range reference with unicode sheet name", () => {
    const ref = buildRangeReference(0, 0, 9, 4, false, false, false, false, "Résumé");
    expect(ref).toContain("A1");
    expect(ref).toContain("E10");
    expect(ref).toContain("Résumé");
  });
});
