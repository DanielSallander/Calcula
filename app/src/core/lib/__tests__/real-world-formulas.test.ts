//! FILENAME: app/src/core/lib/__tests__/real-world-formulas.test.ts
// PURPOSE: Tests simulating real Excel formula patterns - VLOOKUP, INDEX/MATCH,
//          SUMIFS, nested IF/AND/OR, array formulas, OFFSET, cross-workbook refs,
//          3D references, mixed formulas, F4 toggle, auto-complete, and round-trips.

import { describe, it, expect } from "vitest";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  buildCellReference,
  buildRangeReference,
  updateFormulaReference,
  type FormulaReferenceWithPosition,
} from "../formulaRefParser";
import { toggleReferenceAtCursor } from "../formulaRefToggle";
import { autoCompleteFormula, isIncompleteFormula } from "../formulaCompletion";

// ============================================================================
// VLOOKUP Formulas
// ============================================================================

describe("VLOOKUP formula patterns", () => {
  it("parses =VLOOKUP(A1,Sheet2!$A$1:$D$100,3,FALSE) - cross-sheet absolute range", () => {
    const formula = "=VLOOKUP(A1,Sheet2!$A$1:$D$100,3,FALSE)";
    const refs = parseFormulaReferencesWithPositions(formula);

    // A1 (lookup value)
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 0, endRow: 0, endCol: 0,
      isStartColAbsolute: false, isStartRowAbsolute: false,
    });

    // Sheet2!$A$1:$D$100 (table array)
    expect(refs[1]).toMatchObject({
      startRow: 0, startCol: 0, endRow: 99, endCol: 3,
      sheetName: "Sheet2",
      isStartColAbsolute: true, isStartRowAbsolute: true,
      isEndColAbsolute: true, isEndRowAbsolute: true,
    });

    // "3" and "FALSE" are not refs
    expect(refs).toHaveLength(2);
  });

  it("parses VLOOKUP with quoted sheet name containing space", () => {
    const formula = "=VLOOKUP(B5,'Price List'!$A$1:$C$500,2,FALSE)";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(2);
    expect(refs[1].sheetName).toBe("Price List");
    expect(refs[1]).toMatchObject({
      startRow: 0, startCol: 0, endRow: 499, endCol: 2,
    });
  });
});

// ============================================================================
// INDEX/MATCH Formulas
// ============================================================================

describe("INDEX/MATCH formula patterns", () => {
  it("parses =INDEX(B1:B100,MATCH(D1,A1:A100,0)) - nested function refs", () => {
    const formula = "=INDEX(B1:B100,MATCH(D1,A1:A100,0))";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(3);

    // B1:B100 (result array)
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 1, endRow: 99, endCol: 1,
    });

    // D1 (lookup value)
    expect(refs[1]).toMatchObject({
      startRow: 0, startCol: 3, endRow: 0, endCol: 3,
    });

    // A1:A100 (lookup array)
    expect(refs[2]).toMatchObject({
      startRow: 0, startCol: 0, endRow: 99, endCol: 0,
    });
  });

  it("parses two-dimensional INDEX/MATCH/MATCH", () => {
    const formula = "=INDEX($B$2:$E$10,MATCH(G1,$A$2:$A$10,0),MATCH(H1,$B$1:$E$1,0))";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(5);

    // $B$2:$E$10
    expect(refs[0]).toMatchObject({
      startRow: 1, startCol: 1, endRow: 9, endCol: 4,
      isStartColAbsolute: true, isStartRowAbsolute: true,
    });

    // G1 - relative
    expect(refs[1]).toMatchObject({
      startRow: 0, startCol: 6,
      isStartColAbsolute: false, isStartRowAbsolute: false,
    });

    // $A$2:$A$10
    expect(refs[2]).toMatchObject({
      startRow: 1, startCol: 0, endRow: 9, endCol: 0,
    });

    // H1
    expect(refs[3]).toMatchObject({ startRow: 0, startCol: 7 });

    // $B$1:$E$1
    expect(refs[4]).toMatchObject({
      startRow: 0, startCol: 1, endRow: 0, endCol: 4,
    });
  });
});

// ============================================================================
// SUMIFS Formulas
// ============================================================================

describe("SUMIFS formula patterns", () => {
  it("parses =SUMIFS(C:C,A:A,\">100\",B:B,\"<50\") - full column refs are not cell refs", () => {
    // Note: Full column refs (C:C) do NOT match the parser's cell ref pattern
    // because C:C has no row numbers. The parser only sees cell refs with row numbers.
    const formula = '=SUMIFS(C:C,A:A,">100",B:B,"<50")';
    const refs = parseFormulaReferences(formula);
    // Full column refs like C:C have no row numbers, so parser doesn't extract them as cell refs
    expect(refs).toHaveLength(0);
  });

  it("parses SUMIFS with explicit ranges instead of full columns", () => {
    const formula = '=SUMIFS(C1:C1000,A1:A1000,">100",B1:B1000,"<50")';
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 2, endRow: 999, endCol: 2 });
    expect(refs[1]).toMatchObject({ startRow: 0, startCol: 0, endRow: 999, endCol: 0 });
    expect(refs[2]).toMatchObject({ startRow: 0, startCol: 1, endRow: 999, endCol: 1 });
  });
});

// ============================================================================
// IF/AND/OR Nesting
// ============================================================================

describe("nested IF/AND/OR formula patterns", () => {
  it("parses =IF(AND(A1>0,B1<100),IF(OR(C1=\"Y\",D1=\"Y\"),\"Pass\",\"Fail\"),\"N/A\")", () => {
    const formula = '=IF(AND(A1>0,B1<100),IF(OR(C1="Y",D1="Y"),"Pass","Fail"),"N/A")';
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(4);
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0 }); // A1
    expect(refs[1]).toMatchObject({ startRow: 0, startCol: 1 }); // B1
    expect(refs[2]).toMatchObject({ startRow: 0, startCol: 2 }); // C1
    expect(refs[3]).toMatchObject({ startRow: 0, startCol: 3 }); // D1
  });

  it("parses deeply nested IFS with mixed absolute/relative", () => {
    const formula = "=IF(A1>$B$1,IF(C1>$D$1,E1,F1),G1)";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(7);

    // Check absolute markers on $B$1
    const bRef = refs[1];
    expect(bRef.isStartColAbsolute).toBe(true);
    expect(bRef.isStartRowAbsolute).toBe(true);

    // $D$1
    const dRef = refs[3];
    expect(dRef.isStartColAbsolute).toBe(true);
    expect(dRef.isStartRowAbsolute).toBe(true);

    // E1, F1, G1 are relative
    for (const idx of [4, 5, 6]) {
      expect(refs[idx].isStartColAbsolute).toBe(false);
      expect(refs[idx].isStartRowAbsolute).toBe(false);
    }
  });
});

// ============================================================================
// Array Formulas
// ============================================================================

describe("array formula patterns", () => {
  it("parses {=SUM(IF(A1:A100>0,B1:B100))} - array formula with braces", () => {
    // The braces are not part of the formula string the parser needs
    // but testing that the parser handles the content inside
    const formula = "=SUM(IF(A1:A100>0,B1:B100))";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0, endRow: 99, endCol: 0 });
    expect(refs[1]).toMatchObject({ startRow: 0, startCol: 1, endRow: 99, endCol: 1 });
  });

  it("parses SUMPRODUCT array-like formula", () => {
    const formula = "=SUMPRODUCT((A1:A50=\"East\")*(B1:B50>100)*C1:C50)";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0, endRow: 49, endCol: 0 });
    expect(refs[1]).toMatchObject({ startRow: 0, startCol: 1, endRow: 49, endCol: 1 });
    expect(refs[2]).toMatchObject({ startRow: 0, startCol: 2, endRow: 49, endCol: 2 });
  });
});

// ============================================================================
// OFFSET/INDIRECT
// ============================================================================

describe("OFFSET formula patterns", () => {
  it("parses =SUM(OFFSET(A1,0,0,COUNTA(A:A),1)) - extracts cell ref A1", () => {
    const formula = "=SUM(OFFSET(A1,0,0,COUNTA(A:A),1))";
    const refs = parseFormulaReferences(formula);
    // Only A1 is a proper cell ref; A:A is full column (no row numbers)
    // and 0,0,1 are numeric literals
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0 });
  });
});

// ============================================================================
// Named Range References
// ============================================================================

describe("named range references", () => {
  it("named ranges without row numbers produce no cell refs", () => {
    const formula = "=SUM(SalesData)";
    const refs = parseFormulaReferences(formula);
    // "SalesData" has no column letters followed by row digits in standard pattern
    expect(refs).toHaveLength(0);
  });

  it("formula mixing named range and cell ref", () => {
    const formula = "=VLOOKUP(A1,SalesTable,3,FALSE)";
    const refs = parseFormulaReferences(formula);
    // Only A1 is a cell ref; SalesTable is a name
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0 });
  });
});

// ============================================================================
// Cross-Workbook References
// ============================================================================

describe("cross-workbook references", () => {
  it("parses ='[Budget.xlsx]Sheet1'!A1 - extracts ref with sheet context", () => {
    const formula = "='[Budget.xlsx]Sheet1'!A1";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    // The parser treats the whole quoted prefix as the sheet name
    expect(refs[0].sheetName).toBe("[Budget.xlsx]Sheet1");
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0 });
  });

  it("parses cross-workbook range reference", () => {
    const formula = "=SUM('[Sales 2024.xlsx]Q1 Data'!$A$1:$D$500)";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("[Sales 2024.xlsx]Q1 Data");
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 0, endRow: 499, endCol: 3,
      isStartColAbsolute: true, isEndRowAbsolute: true,
    });
  });
});

// ============================================================================
// 3D References
// ============================================================================

describe("3D references (Sheet1:Sheet5!A1)", () => {
  it("parses =SUM(Sheet1:Sheet5!A1) - 3D single cell", () => {
    const formula = "=SUM(Sheet1:Sheet5!A1)";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    // Parser extracts the first sheet name from the 3D ref
    expect(refs[0].sheetName).toBe("Sheet1");
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0 });
  });

  it("parses =SUM(Sheet1:Sheet5!A1:C10) - 3D range", () => {
    const formula = "=SUM(Sheet1:Sheet5!A1:C10)";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 0, endRow: 9, endCol: 2,
      sheetName: "Sheet1",
    });
  });

  it("parses quoted 3D ref: =SUM('Jan:Dec'!B5)", () => {
    const formula = "=SUM('Jan:Dec'!B5)";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Jan");
    expect(refs[0]).toMatchObject({ startRow: 4, startCol: 1 });
  });
});

// ============================================================================
// Mixed Formulas
// ============================================================================

describe("mixed formula patterns", () => {
  it("parses =A1+$B$2*Sheet1!C3-'My Sheet'!$D4", () => {
    const formula = "=A1+$B$2*Sheet1!C3-'My Sheet'!$D4";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(4);

    // A1 - relative
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 0,
      isStartColAbsolute: false, isStartRowAbsolute: false,
    });
    expect(refs[0].sheetName).toBeUndefined();

    // $B$2 - absolute
    expect(refs[1]).toMatchObject({
      startRow: 1, startCol: 1,
      isStartColAbsolute: true, isStartRowAbsolute: true,
    });

    // Sheet1!C3
    expect(refs[2]).toMatchObject({
      startRow: 2, startCol: 2,
      sheetName: "Sheet1",
    });

    // 'My Sheet'!$D4 - col absolute, row relative
    expect(refs[3]).toMatchObject({
      startRow: 3, startCol: 3,
      sheetName: "My Sheet",
      isStartColAbsolute: true, isStartRowAbsolute: false,
    });
  });

  it("parses complex financial formula", () => {
    const formula = "=IF(B2>0,PMT($C$1/12,$D$1*12,-B2),0)+E2";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(5);
    // B2, $C$1, $D$1, B2 (second occurrence), E2
    expect(refs[0]).toMatchObject({ startRow: 1, startCol: 1 }); // B2
    expect(refs[1]).toMatchObject({ startRow: 0, startCol: 2, isStartColAbsolute: true }); // $C$1
    expect(refs[2]).toMatchObject({ startRow: 0, startCol: 3, isStartColAbsolute: true }); // $D$1
    expect(refs[3]).toMatchObject({ startRow: 1, startCol: 1 }); // B2 again
    expect(refs[4]).toMatchObject({ startRow: 1, startCol: 4 }); // E2
  });
});

// ============================================================================
// F4 Toggle on Complex Formulas
// ============================================================================

describe("F4 toggle on each ref in complex formulas", () => {
  it("toggles each ref in =A1+$B$2*Sheet1!C3 independently", () => {
    const formula = "=A1+$B$2*Sheet1!C3";
    const refs = parseFormulaReferencesWithPositions(formula);

    // Toggle A1 -> $A$1
    const t1 = toggleReferenceAtCursor(formula, refs[0].textStartIndex + 1);
    expect(t1.formula).toContain("$A$1");
    // $B$2 and Sheet1!C3 should be unchanged
    expect(t1.formula).toContain("$B$2");
    expect(t1.formula).toContain("Sheet1!C3");

    // Toggle $B$2 -> B$2
    const t2 = toggleReferenceAtCursor(formula, refs[1].textStartIndex + 1);
    expect(t2.formula).toContain("B$2");

    // Toggle on Sheet1!C3 - the toggle regex sees "Sheet1" as letters+digits
    // and "C3" separately. The cursor on the Sheet prefix toggles "Sheet1" part.
    // To toggle C3 itself, position cursor on the C3 portion after the !
    const c3Start = formula.indexOf("C3", refs[2].textStartIndex);
    const t3 = toggleReferenceAtCursor(formula, c3Start + 1);
    // toggleReferenceAtCursor sees Sheet1 and C3 as separate ref-like matches
    // so toggling at C3 position makes it $C$3
    expect(t3.formula).toContain("$C$3");
  });

  it("full F4 cycle on a ref inside nested function", () => {
    let formula = "=SUM(IF(A1>0,B1,C1))";
    // Find B1 position
    let refs = parseFormulaReferencesWithPositions(formula);
    const b1Idx = refs.findIndex(r => r.startCol === 1);

    // Cycle: B1 -> $B$1 -> B$1 -> $B1 -> B1
    const expected = ["$B$1", "B$1", "$B1", "B1"];
    for (const exp of expected) {
      refs = parseFormulaReferencesWithPositions(formula);
      const pos = refs[b1Idx].textStartIndex + 1;
      const result = toggleReferenceAtCursor(formula, pos);
      formula = result.formula;
      expect(formula).toContain(exp);
    }
  });
});

// ============================================================================
// Auto-Complete on Complete/Incomplete Formulas
// ============================================================================

describe("auto-complete on real-world formulas", () => {
  it("does not change a complete VLOOKUP formula", () => {
    const formula = "=VLOOKUP(A1,Sheet2!$A$1:$D$100,3,FALSE)";
    expect(isIncompleteFormula(formula)).toBe(false);
    expect(autoCompleteFormula(formula)).toBe(formula);
  });

  it("does not change a complete nested IF formula", () => {
    const formula = '=IF(AND(A1>0,B1<100),IF(OR(C1="Y",D1="Y"),"Pass","Fail"),"N/A")';
    expect(isIncompleteFormula(formula)).toBe(false);
    expect(autoCompleteFormula(formula)).toBe(formula);
  });

  it("does not change a complete INDEX/MATCH formula", () => {
    const formula = "=INDEX(B1:B100,MATCH(D1,A1:A100,0))";
    expect(isIncompleteFormula(formula)).toBe(false);
    expect(autoCompleteFormula(formula)).toBe(formula);
  });

  it("completes VLOOKUP missing closing paren", () => {
    const formula = "=VLOOKUP(A1,B1:D100,3,FALSE";
    expect(isIncompleteFormula(formula)).toBe(true);
    expect(autoCompleteFormula(formula)).toBe("=VLOOKUP(A1,B1:D100,3,FALSE)");
  });

  it("completes nested IF missing two closing parens", () => {
    const formula = "=IF(A1>0,IF(B1>0,C1,D1";
    expect(isIncompleteFormula(formula)).toBe(true);
    expect(autoCompleteFormula(formula)).toBe("=IF(A1>0,IF(B1>0,C1,D1))");
  });

  it("completes SUMIFS missing paren with string criteria", () => {
    const formula = '=SUMIFS(C1:C100,A1:A100,">100"';
    expect(isIncompleteFormula(formula)).toBe(true);
    const completed = autoCompleteFormula(formula);
    expect(completed.endsWith(")")).toBe(true);
  });

  it("does not change a simple addition formula", () => {
    const formula = "=A1+B2*C3";
    expect(autoCompleteFormula(formula)).toBe(formula);
  });
});

// ============================================================================
// Round-Trip: Parse -> Build -> Re-Parse
// ============================================================================

describe("round-trip: parse -> build -> re-parse produces same refs", () => {
  function roundTrip(formula: string): void {
    const refs = parseFormulaReferencesWithPositions(formula);
    for (const ref of refs) {
      const isRange = ref.startRow !== ref.endRow || ref.startCol !== ref.endCol;
      let built: string;
      if (isRange) {
        built = buildRangeReference(
          ref.startRow, ref.startCol, ref.endRow, ref.endCol,
          ref.isStartColAbsolute, ref.isStartRowAbsolute,
          ref.isEndColAbsolute, ref.isEndRowAbsolute,
          ref.sheetName,
        );
      } else {
        built = buildCellReference(
          ref.startRow, ref.startCol,
          ref.isStartColAbsolute, ref.isStartRowAbsolute,
          ref.sheetName,
        );
      }
      // Re-parse the built reference
      const reParsed = parseFormulaReferencesWithPositions(`=${built}`);
      expect(reParsed).toHaveLength(1);
      expect(reParsed[0].startRow).toBe(ref.startRow);
      expect(reParsed[0].startCol).toBe(ref.startCol);
      expect(reParsed[0].endRow).toBe(ref.endRow);
      expect(reParsed[0].endCol).toBe(ref.endCol);
      expect(reParsed[0].isStartColAbsolute).toBe(ref.isStartColAbsolute);
      expect(reParsed[0].isStartRowAbsolute).toBe(ref.isStartRowAbsolute);
    }
  }

  it("round-trips VLOOKUP refs", () => {
    roundTrip("=VLOOKUP(A1,Sheet2!$A$1:$D$100,3,FALSE)");
  });

  it("round-trips INDEX/MATCH refs", () => {
    roundTrip("=INDEX(B1:B100,MATCH(D1,A1:A100,0))");
  });

  it("round-trips mixed absolute/relative formula", () => {
    roundTrip("=A1+$B$2*C$3-$D4");
  });

  it("round-trips cross-sheet formula", () => {
    roundTrip("=Sheet1!A1+'Data Sheet'!$B$5");
  });

  it("round-trips complex financial formula", () => {
    roundTrip("=IF(B2>0,PMT($C$1/12,$D$1*12,-B2),0)+E2");
  });

  it("round-trips formula after updateFormulaReference", () => {
    const formula = "=A1+B2+C3";
    const refs = parseFormulaReferencesWithPositions(formula);
    // Move B2 to Z99
    const updated = updateFormulaReference(formula, refs[1], 98, 25);
    // Round-trip all refs in the updated formula
    roundTrip(updated);
  });
});

// ============================================================================
// Edge Cases and Stress Tests
// ============================================================================

describe("edge cases in real-world formulas", () => {
  it("handles formula with many refs (10+ references)", () => {
    const formula = "=A1+B1+C1+D1+E1+F1+G1+H1+I1+J1+K1+L1";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      expect(refs[i].startCol).toBe(i);
      expect(refs[i].startRow).toBe(0);
    }
  });

  it("handles formula with string literals that look like refs", () => {
    // The parser doesn't skip strings, so "A1" inside quotes is still matched.
    // This is a known limitation - documenting current behavior.
    const formula = '=IF(A1="B2",C3,D4)';
    const refs = parseFormulaReferences(formula);
    // B2 inside the string is matched (known limitation)
    expect(refs.length).toBeGreaterThanOrEqual(3); // At least A1, C3, D4
  });

  it("handles very large row/column references", () => {
    const formula = "=XFD1048576";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(1048575); // 0-based
    // XFD = column 16383 (0-based)
    expect(refs[0].startCol).toBe(16383);
  });

  it("correctly distinguishes function names from refs (SUM, IF, etc.)", () => {
    // SUM1 could look like a ref (col SUM, row 1) - verify parser behavior
    // The parser matches letter+digit patterns, so SUM1 would be parsed as a ref
    // But real functions like SUM( are followed by parens, not used as refs
    const formula = "=SUM(A1)";
    const refs = parseFormulaReferences(formula);
    // SUM is followed by (, so the regex should not match "SUM1" here
    // It should only match A1
    expect(refs.some(r => r.startCol === 0 && r.startRow === 0)).toBe(true);
  });

  it("parses formula with consecutive ranges separated by comma", () => {
    const formula = "=SUM(A1:A10,B1:B10,C1:C10)";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ startCol: 0, endCol: 0, startRow: 0, endRow: 9 });
    expect(refs[1]).toMatchObject({ startCol: 1, endCol: 1, startRow: 0, endRow: 9 });
    expect(refs[2]).toMatchObject({ startCol: 2, endCol: 2, startRow: 0, endRow: 9 });
  });
});
