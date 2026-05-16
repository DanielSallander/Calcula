//! FILENAME: app/src/core/lib/__tests__/formula-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for formula modules using it.each
// CONTEXT: Tests parseFormulaReferences, autoCompleteFormula, toggleReferenceAtCursor,
//          buildCellReference, columnToLetter, letterToColumn

import { describe, it, expect } from "vitest";
import { parseFormulaReferences, buildCellReference, buildRangeReference } from "../formulaRefParser";
import { autoCompleteFormula } from "../formulaCompletion";
import { toggleReferenceAtCursor } from "../formulaRefToggle";
import { columnToLetter, letterToColumn } from "../../types";

// ============================================================================
// 1. parseFormulaReferences - 50 formulas via it.each
// ============================================================================

describe("parseFormulaReferences (parameterized)", () => {
  // Each entry: [formula, expectedRefCount, firstRefStart, firstRefEnd, lastRefStart, lastRefEnd]
  // Ref coords: [startRow, startCol, endRow, endCol]
  type RefTestCase = [
    string, // formula
    number, // expected ref count
    [number, number, number, number] | null, // first ref [startRow, startCol, endRow, endCol]
    [number, number, number, number] | null, // last ref [startRow, startCol, endRow, endCol]
    string | undefined, // first ref sheetName (optional)
  ];

  const cases: RefTestCase[] = [
    // Simple single-cell references
    ["=A1", 1, [0, 0, 0, 0], [0, 0, 0, 0], undefined],
    ["=B2", 1, [1, 1, 1, 1], [1, 1, 1, 1], undefined],
    ["=Z99", 1, [98, 25, 98, 25], [98, 25, 98, 25], undefined],
    ["=C10", 1, [9, 2, 9, 2], [9, 2, 9, 2], undefined],
    ["=AA1", 1, [0, 26, 0, 26], [0, 26, 0, 26], undefined],
    ["=AZ100", 1, [99, 51, 99, 51], [99, 51, 99, 51], undefined],
    ["=XFD1", 1, [0, 16383, 0, 16383], [0, 16383, 0, 16383], undefined],

    // Absolute references ($ markers don't affect parsed coords)
    ["=$A$1", 1, [0, 0, 0, 0], [0, 0, 0, 0], undefined],
    ["=A$1", 1, [0, 0, 0, 0], [0, 0, 0, 0], undefined],
    ["=$A1", 1, [0, 0, 0, 0], [0, 0, 0, 0], undefined],
    ["=$B$2", 1, [1, 1, 1, 1], [1, 1, 1, 1], undefined],
    ["=$Z$99", 1, [98, 25, 98, 25], [98, 25, 98, 25], undefined],
    ["=B$5", 1, [4, 1, 4, 1], [4, 1, 4, 1], undefined],

    // Range references
    ["=A1:B5", 1, [0, 0, 4, 1], [0, 0, 4, 1], undefined],
    ["=$A$1:$B$5", 1, [0, 0, 4, 1], [0, 0, 4, 1], undefined],
    ["=A1:A100", 1, [0, 0, 99, 0], [0, 0, 99, 0], undefined],
    ["=C3:F10", 1, [2, 2, 9, 5], [2, 2, 9, 5], undefined],
    ["=D1:D1", 1, [0, 3, 0, 3], [0, 3, 0, 3], undefined],
    ["=$A1:B$5", 1, [0, 0, 4, 1], [0, 0, 4, 1], undefined],

    // Cross-sheet references
    ["=Sheet1!A1", 1, [0, 0, 0, 0], [0, 0, 0, 0], "Sheet1"],
    ["='My Sheet'!A1", 1, [0, 0, 0, 0], [0, 0, 0, 0], "My Sheet"],
    ["=Sheet1!A1:B5", 1, [0, 0, 4, 1], [0, 0, 4, 1], "Sheet1"],
    ["='My Sheet'!A1:B5", 1, [0, 0, 4, 1], [0, 0, 4, 1], "My Sheet"],
    ["=Sheet2!$C$3", 1, [2, 2, 2, 2], [2, 2, 2, 2], "Sheet2"],
    ["=Data!Z100", 1, [99, 25, 99, 25], [99, 25, 99, 25], "Data"],

    // Functions with single ref
    ["=SUM(A1:B5)", 1, [0, 0, 4, 1], [0, 0, 4, 1], undefined],
    ["=AVERAGE(C1:C100)", 1, [0, 2, 99, 2], [0, 2, 99, 2], undefined],
    ["=COUNT(A1:Z1)", 1, [0, 0, 0, 25], [0, 0, 0, 25], undefined],
    ["=MAX(B2:B50)", 1, [1, 1, 49, 1], [1, 1, 49, 1], undefined],
    ["=MIN(D10:D20)", 1, [9, 3, 19, 3], [9, 3, 19, 3], undefined],

    // Functions with multiple refs
    ["=IF(A1>0,B1,C1)", 3, [0, 0, 0, 0], [0, 2, 0, 2], undefined],
    ["=VLOOKUP(A1,B1:D10,2,FALSE)", 2, [0, 0, 0, 0], [0, 1, 9, 3], undefined],
    ["=A1+B1", 2, [0, 0, 0, 0], [0, 1, 0, 1], undefined],
    ["=A1+B1*C1-D1/E1", 5, [0, 0, 0, 0], [0, 4, 0, 4], undefined],
    ["=SUM(A1:A10)+AVERAGE(B1:B10)", 2, [0, 0, 9, 0], [0, 1, 9, 1], undefined],
    ["=A1+B2+C3+D4+E5+F6", 6, [0, 0, 0, 0], [5, 5, 5, 5], undefined],
    ["=INDEX(A1:D10,MATCH(E1,A1:A10,0),2)", 3, [0, 0, 9, 3], [0, 0, 9, 0], undefined],

    // Complex / nested
    ["=SUM(A1:A5,B1:B5,C1:C5)", 3, [0, 0, 4, 0], [0, 2, 4, 2], undefined],
    ["=(A1+B1)/(C1-D1)", 4, [0, 0, 0, 0], [0, 3, 0, 3], undefined],
    ["=IF(AND(A1>0,B1<10),C1,D1)", 4, [0, 0, 0, 0], [0, 3, 0, 3], undefined],
    ["=SUMPRODUCT(A1:A5,B1:B5)", 2, [0, 0, 4, 0], [0, 1, 4, 1], undefined],

    // Edge cases
    ["=A1:B5+C1:D5", 2, [0, 0, 4, 1], [0, 2, 4, 3], undefined],
    ["=Sheet1!A1+Sheet2!B2", 2, [0, 0, 0, 0], [1, 1, 1, 1], "Sheet1"],

    // No refs / non-formula
    ["hello", 0, null, null, undefined],
    ["=1+2+3", 0, null, null, undefined],
    ["=TRUE", 0, null, null, undefined],

    // Multiple cross-sheet
    ["='Sales Data'!A1:A10", 1, [0, 0, 9, 0], [0, 0, 9, 0], "Sales Data"],
    ["=CONCATENATE(A1,B1,C1,D1)", 4, [0, 0, 0, 0], [0, 3, 0, 3], undefined],
    ["=A1*100+B1*200", 2, [0, 0, 0, 0], [0, 1, 0, 1], undefined],
  ];

  it.each(cases)(
    "parses %s -> %d refs",
    (formula, expectedCount, firstRef, lastRef, firstSheetName) => {
      const refs = parseFormulaReferences(formula);
      expect(refs).toHaveLength(expectedCount);

      if (expectedCount > 0 && firstRef) {
        expect(refs[0].startRow).toBe(firstRef[0]);
        expect(refs[0].startCol).toBe(firstRef[1]);
        expect(refs[0].endRow).toBe(firstRef[2]);
        expect(refs[0].endCol).toBe(firstRef[3]);
        if (firstSheetName !== undefined) {
          expect(refs[0].sheetName).toBe(firstSheetName);
        }
      }

      if (expectedCount > 0 && lastRef) {
        const last = refs[refs.length - 1];
        expect(last.startRow).toBe(lastRef[0]);
        expect(last.startCol).toBe(lastRef[1]);
        expect(last.endRow).toBe(lastRef[2]);
        expect(last.endCol).toBe(lastRef[3]);
      }
    }
  );
});

// ============================================================================
// 2. autoCompleteFormula - 30 patterns via it.each
// ============================================================================

describe("autoCompleteFormula (parameterized)", () => {
  type CompletionTestCase = [string, string, string]; // [description, input, expected]

  const cases: CompletionTestCase[] = [
    // Already complete -> unchanged
    ["complete simple ref", "=A1", "=A1"],
    ["complete SUM", "=SUM(A1:B5)", "=SUM(A1:B5)"],
    ["complete nested", "=IF(A1>0,SUM(B1:B5),0)", "=IF(A1>0,SUM(B1:B5),0)"],
    ["complete string", '=CONCATENATE("hello","world")', '=CONCATENATE("hello","world")'],
    ["plain text", "hello", "hello"],
    ["complete with quotes", '="test"', '="test"'],
    ["number only", "=42", "=42"],
    ["complete multi-paren", "=((1+2))", "=((1+2))"],

    // Missing 1 closing paren
    ["1 missing paren SUM", "=SUM(A1:B5", "=SUM(A1:B5)"],
    ["1 missing paren IF", "=IF(A1>0,B1,C1", "=IF(A1>0,B1,C1)"],
    ["1 missing paren AVERAGE", "=AVERAGE(A1:A100", "=AVERAGE(A1:A100)"],
    ["1 missing paren simple", "=(1+2", "=(1+2)"],
    ["1 missing paren COUNT", "=COUNT(A1,B1,C1", "=COUNT(A1,B1,C1)"],

    // Missing 2 closing parens
    ["2 missing parens nested SUM", "=SUM(IF(A1>0,1,0", "=SUM(IF(A1>0,1,0))"],
    ["2 missing parens nested", "=IF(SUM(A1:A5", "=IF(SUM(A1:A5))"],
    ["2 missing parens math", "=((1+2", "=((1+2))"],

    // Missing 3 closing parens
    ["3 missing parens", "=IF(SUM(AVERAGE(A1:A5", "=IF(SUM(AVERAGE(A1:A5)))"],
    ["3 missing parens nested", "=(((1", "=(((1)))"],

    // Missing closing double quote
    ['missing closing "', '="Hello', '="Hello"'],
    ['missing closing " in CONCAT', '=CONCATENATE("hello', '=CONCATENATE("hello")'],
    ['missing closing " with paren', '=IF(A1="yes', '=IF(A1="yes")'],

    // Missing closing single quote
    ["missing closing '", "='Hello", "='Hello'"],
    ["missing closing ' in formula", "=IF(A1='test", "=IF(A1='test')"],

    // Mixed unclosed
    ['unclosed " and paren', '=SUM(IF(A1="yes', '=SUM(IF(A1="yes"))'],
    ['unclosed " and 2 parens', '=IF(SUM("hello', '=IF(SUM("hello"))'],
    ["unclosed ' and paren", "=CONCAT('hi", "=CONCAT('hi')"],

    // Already just a string (not formula)
    ["non-formula string", "just text", "just text"],
    ["empty", "", ""],
    ["equals only", "=", "="],
    ["deep nest missing 4", "=((((1", "=((((1))))"],
  ];

  it.each(cases)(
    "%s: %s -> %s",
    (_desc, input, expected) => {
      expect(autoCompleteFormula(input)).toBe(expected);
    }
  );
});

// ============================================================================
// 3. toggleReferenceAtCursor - cycling through all 4 states for 20 formulas
// ============================================================================

describe("toggleReferenceAtCursor (parameterized)", () => {
  // Each entry: [formula, cursorPos, expected cycle of 4 toggles]
  // Cycle: relative -> $col$row -> col$row -> $col row -> relative
  type ToggleCycleCase = [string, number, string[]]; // [formula, cursorPos, [after1, after2, after3, after4]]

  const cycleCases: ToggleCycleCase[] = [
    ["=A1", 2, ["=$A$1", "=A$1", "=$A1", "=A1"]],
    ["=B2", 2, ["=$B$2", "=B$2", "=$B2", "=B2"]],
    ["=C3", 2, ["=$C$3", "=C$3", "=$C3", "=C3"]],
    ["=Z99", 3, ["=$Z$99", "=Z$99", "=$Z99", "=Z99"]],
    ["=D10", 3, ["=$D$10", "=D$10", "=$D10", "=D10"]],
    ["=AA1", 3, ["=$AA$1", "=AA$1", "=$AA1", "=AA1"]],
    ["=E5", 2, ["=$E$5", "=E$5", "=$E5", "=E5"]],
    ["=F100", 4, ["=$F$100", "=F$100", "=$F100", "=F100"]],
    ["=G7", 2, ["=$G$7", "=G$7", "=$G7", "=G7"]],
    ["=H1", 2, ["=$H$1", "=H$1", "=$H1", "=H1"]],
    ["=I20", 3, ["=$I$20", "=I$20", "=$I20", "=I20"]],
    ["=J3", 2, ["=$J$3", "=J$3", "=$J3", "=J3"]],
    ["=K50", 3, ["=$K$50", "=K$50", "=$K50", "=K50"]],
    ["=L1", 2, ["=$L$1", "=L$1", "=$L1", "=L1"]],
    ["=M99", 3, ["=$M$99", "=M$99", "=$M99", "=M99"]],
    ["=N10", 3, ["=$N$10", "=N$10", "=$N10", "=N10"]],
    ["=O25", 3, ["=$O$25", "=O$25", "=$O25", "=O25"]],
    ["=P1", 2, ["=$P$1", "=P$1", "=$P1", "=P1"]],
    ["=Q42", 3, ["=$Q$42", "=Q$42", "=$Q42", "=Q42"]],
    ["=R8", 2, ["=$R$8", "=R$8", "=$R8", "=R8"]],
  ];

  it.each(cycleCases)(
    "cycles %s (cursor %d) through 4 states",
    (formula, cursorPos, expectedCycle) => {
      let current = formula;
      let pos = cursorPos;

      for (let i = 0; i < 4; i++) {
        const result = toggleReferenceAtCursor(current, pos);
        expect(result.formula).toBe(expectedCycle[i]);
        current = result.formula;
        pos = result.cursorPos;
      }
    }
  );
});

// ============================================================================
// 4. buildCellReference - 50+ combinations via it.each
// ============================================================================

describe("buildCellReference (parameterized)", () => {
  // Generate row 0-4 x col 0-4 x 4 absolute combos = 100, take 50+
  type BuildRefCase = [number, number, boolean, boolean, string | undefined, string];

  const cases: BuildRefCase[] = [
    // row, col, colAbs, rowAbs, sheetName, expected
    [0, 0, false, false, undefined, "A1"],
    [0, 0, true, true, undefined, "$A$1"],
    [0, 0, true, false, undefined, "$A1"],
    [0, 0, false, true, undefined, "A$1"],
    [0, 1, false, false, undefined, "B1"],
    [0, 1, true, true, undefined, "$B$1"],
    [0, 2, false, false, undefined, "C1"],
    [0, 2, true, false, undefined, "$C1"],
    [0, 3, false, true, undefined, "D$1"],
    [0, 4, true, true, undefined, "$E$1"],
    [1, 0, false, false, undefined, "A2"],
    [1, 0, true, true, undefined, "$A$2"],
    [1, 1, false, false, undefined, "B2"],
    [1, 1, true, true, undefined, "$B$2"],
    [1, 1, false, true, undefined, "B$2"],
    [1, 1, true, false, undefined, "$B2"],
    [1, 2, false, false, undefined, "C2"],
    [1, 3, true, true, undefined, "$D$2"],
    [1, 4, false, true, undefined, "E$2"],
    [2, 0, true, false, undefined, "$A3"],
    [2, 1, false, false, undefined, "B3"],
    [2, 2, true, true, undefined, "$C$3"],
    [2, 3, false, false, undefined, "D3"],
    [2, 4, true, true, undefined, "$E$3"],
    [3, 0, false, false, undefined, "A4"],
    [3, 1, true, true, undefined, "$B$4"],
    [3, 2, false, true, undefined, "C$4"],
    [3, 3, true, false, undefined, "$D4"],
    [3, 4, false, false, undefined, "E4"],
    [4, 0, true, true, undefined, "$A$5"],
    [4, 1, false, false, undefined, "B5"],
    [4, 2, true, false, undefined, "$C5"],
    [4, 3, false, true, undefined, "D$5"],
    [4, 4, true, true, undefined, "$E$5"],
    [5, 0, false, false, undefined, "A6"],
    [5, 5, true, true, undefined, "$F$6"],

    // With sheet names
    [0, 0, false, false, "Sheet1", "Sheet1!A1"],
    [0, 0, true, true, "Sheet1", "Sheet1!$A$1"],
    [1, 1, false, false, "Data", "Data!B2"],
    [2, 3, true, false, "Sales", "Sales!$D3"],
    [0, 0, false, false, "My Sheet", "'My Sheet'!A1"],
    [0, 0, true, true, "My Sheet", "'My Sheet'!$A$1"],
    [3, 2, false, true, "Q1 2024", "'Q1 2024'!C$4"],
    [0, 0, false, false, "Sheet's Name", "'Sheet''s Name'!A1"],

    // Larger row/col
    [99, 25, false, false, undefined, "Z100"],
    [999, 0, true, true, undefined, "$A$1000"],
    [0, 26, false, false, undefined, "AA1"],
    [0, 51, false, false, undefined, "AZ1"],
    [0, 701, false, false, undefined, "ZZ1"],
    [9, 702, false, false, undefined, "AAA10"],
  ];

  it.each(cases)(
    "row=%d col=%d colAbs=%s rowAbs=%s sheet=%s -> %s",
    (row, col, colAbs, rowAbs, sheetName, expected) => {
      expect(buildCellReference(row, col, colAbs, rowAbs, sheetName)).toBe(expected);
    }
  );
});

// ============================================================================
// 5. columnToLetter / letterToColumn - 100 values via it.each
// ============================================================================

describe("columnToLetter (parameterized)", () => {
  type ColLetterCase = [number, string]; // [0-based index, letter]

  const cases: ColLetterCase[] = [
    [0, "A"], [1, "B"], [2, "C"], [3, "D"], [4, "E"],
    [5, "F"], [6, "G"], [7, "H"], [8, "I"], [9, "J"],
    [10, "K"], [11, "L"], [12, "M"], [13, "N"], [14, "O"],
    [15, "P"], [16, "Q"], [17, "R"], [18, "S"], [19, "T"],
    [20, "U"], [21, "V"], [22, "W"], [23, "X"], [24, "Y"],
    [25, "Z"],
    // Two-letter columns
    [26, "AA"], [27, "AB"], [28, "AC"], [29, "AD"], [30, "AE"],
    [35, "AJ"], [40, "AO"], [45, "AT"], [50, "AY"], [51, "AZ"],
    [52, "BA"], [53, "BB"], [60, "BI"], [70, "BS"], [77, "BZ"],
    [78, "CA"], [100, "CW"], [103, "CZ"],
    [104, "DA"], [129, "DZ"],
    [130, "EA"], [155, "EZ"],
    [200, "GS"], [255, "IV"], // IV = last column in old Excel
    [300, "KO"], [350, "MM"], [400, "OK"],
    [500, "SG"], [600, "WC"], [675, "YZ"],
    [676, "ZA"], [701, "ZZ"],
    // Three-letter columns
    [702, "AAA"], [703, "AAB"], [704, "AAC"],
    [727, "AAZ"], [728, "ABA"], [750, "ABW"],
    [800, "ADU"], [900, "AHQ"], [1000, "ALM"],
    [1500, "BES"], [2000, "BXY"],
    [5000, "GJI"], [10000, "NTQ"],
    [16383, "XFD"], // Last Excel column
  ];

  it.each(cases)(
    "col %d -> %s",
    (col, expected) => {
      expect(columnToLetter(col)).toBe(expected);
    }
  );
});

describe("letterToColumn (parameterized)", () => {
  type LetterColCase = [string, number]; // [letter, 0-based index]

  const cases: LetterColCase[] = [
    ["A", 0], ["B", 1], ["C", 2], ["D", 3], ["E", 4],
    ["F", 5], ["G", 6], ["H", 7], ["I", 8], ["J", 9],
    ["K", 10], ["L", 11], ["M", 12], ["N", 13], ["O", 14],
    ["P", 15], ["Q", 16], ["R", 17], ["S", 18], ["T", 19],
    ["U", 20], ["V", 21], ["W", 22], ["X", 23], ["Y", 24],
    ["Z", 25],
    ["AA", 26], ["AB", 27], ["AZ", 51], ["BA", 52], ["BZ", 77],
    ["CA", 78], ["CZ", 103], ["DA", 104], ["DZ", 129],
    ["IV", 255], ["ZA", 676], ["ZZ", 701],
    ["AAA", 702], ["AAB", 703], ["AAZ", 727], ["ABA", 728],
    ["XFD", 16383],
  ];

  it.each(cases)(
    "%s -> col %d",
    (letter, expected) => {
      expect(letterToColumn(letter)).toBe(expected);
    }
  );
});

// ============================================================================
// 6. columnToLetter <-> letterToColumn roundtrip - 50 values
// ============================================================================

describe("columnToLetter <-> letterToColumn roundtrip", () => {
  const roundtripValues = [
    0, 1, 5, 10, 15, 20, 25, 26, 27, 50,
    51, 52, 77, 78, 100, 130, 200, 255, 300, 400,
    500, 600, 675, 676, 701, 702, 703, 727, 728, 800,
    900, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000, 12000,
    14000, 15000, 16000, 16383, 100, 256, 512, 1024, 2048, 4096,
  ];

  it.each(roundtripValues)(
    "roundtrip col %d",
    (col) => {
      expect(letterToColumn(columnToLetter(col))).toBe(col);
    }
  );
});
