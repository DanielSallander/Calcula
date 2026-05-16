//! FILENAME: app/src/core/lib/__tests__/off-by-one.test.ts
// PURPOSE: Off-by-one boundary tests for column/letter conversion, cell ranges,
//          and formula reference parsing.

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types";
import { parseFormulaReferences, parseFormulaReferencesWithPositions } from "../formulaRefParser";

// ---------------------------------------------------------------------------
// columnToLetter at boundaries
// ---------------------------------------------------------------------------

describe("columnToLetter at letter-count transitions", () => {
  it("col 0 => A (first single letter)", () => {
    expect(columnToLetter(0)).toBe("A");
  });

  it("col 25 => Z (last single letter)", () => {
    expect(columnToLetter(25)).toBe("Z");
  });

  it("col 26 => AA (first two-letter)", () => {
    expect(columnToLetter(26)).toBe("AA");
  });

  it("col 51 => AZ (last of AA..AZ block)", () => {
    expect(columnToLetter(51)).toBe("AZ");
  });

  it("col 52 => BA (first of BA block)", () => {
    expect(columnToLetter(52)).toBe("BA");
  });

  it("col 701 => ZZ (last two-letter)", () => {
    expect(columnToLetter(701)).toBe("ZZ");
  });

  it("col 702 => AAA (first three-letter)", () => {
    expect(columnToLetter(702)).toBe("AAA");
  });
});

// ---------------------------------------------------------------------------
// letterToColumn at boundaries (inverse of columnToLetter)
// ---------------------------------------------------------------------------

describe("letterToColumn at letter-count transitions", () => {
  it("A => 0", () => {
    expect(letterToColumn("A")).toBe(0);
  });

  it("Z => 25", () => {
    expect(letterToColumn("Z")).toBe(25);
  });

  it("AA => 26", () => {
    expect(letterToColumn("AA")).toBe(26);
  });

  it("AZ => 51", () => {
    expect(letterToColumn("AZ")).toBe(51);
  });

  it("BA => 52", () => {
    expect(letterToColumn("BA")).toBe(52);
  });

  it("ZZ => 701", () => {
    expect(letterToColumn("ZZ")).toBe(701);
  });

  it("AAA => 702", () => {
    expect(letterToColumn("AAA")).toBe(702);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: columnToLetter(letterToColumn(x)) === x
// ---------------------------------------------------------------------------

describe("columnToLetter <-> letterToColumn round-trip", () => {
  const cases = [0, 1, 25, 26, 51, 52, 100, 255, 701, 702, 703, 16383];
  for (const col of cases) {
    it(`round-trips col ${col}`, () => {
      expect(letterToColumn(columnToLetter(col))).toBe(col);
    });
  }
});

// ---------------------------------------------------------------------------
// CellRange iteration: exact cell count = rowCount * colCount
// ---------------------------------------------------------------------------

describe("cell range iteration count", () => {
  // Simulate range iteration the same way the grid does
  function countCells(startRow: number, startCol: number, endRow: number, endCol: number): number {
    let count = 0;
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        count++;
      }
    }
    return count;
  }

  it("single cell range has exactly 1 cell", () => {
    expect(countCells(0, 0, 0, 0)).toBe(1);
  });

  it("1x5 range has exactly 5 cells", () => {
    expect(countCells(0, 0, 0, 4)).toBe(5);
  });

  it("5x1 range has exactly 5 cells", () => {
    expect(countCells(0, 0, 4, 0)).toBe(5);
  });

  it("3x4 range has exactly 12 cells", () => {
    expect(countCells(2, 3, 4, 6)).toBe(12);
  });

  it("count equals (endRow-startRow+1) * (endCol-startCol+1)", () => {
    const sr = 5, sc = 10, er = 15, ec = 20;
    const expected = (er - sr + 1) * (ec - sc + 1);
    expect(countCells(sr, sc, er, ec)).toBe(expected);
    expect(expected).toBe(11 * 11); // 121
  });
});

// ---------------------------------------------------------------------------
// parseFormulaReferences: verify 0-based startRow/startCol
// ---------------------------------------------------------------------------

describe("parseFormulaReferences 0-based coordinates", () => {
  it("A1 parses to startRow=0, startCol=0", () => {
    const refs = parseFormulaReferences("=A1");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].startCol).toBe(0);
  });

  it("B2 parses to startRow=1, startCol=1", () => {
    const refs = parseFormulaReferences("=B2");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(1);
    expect(refs[0].startCol).toBe(1);
  });

  it("Z1 parses to startCol=25", () => {
    const refs = parseFormulaReferences("=Z1");
    expect(refs).toHaveLength(1);
    expect(refs[0].startCol).toBe(25);
  });

  it("AA1 parses to startCol=26", () => {
    const refs = parseFormulaReferences("=AA1");
    expect(refs).toHaveLength(1);
    expect(refs[0].startCol).toBe(26);
  });

  it("A1:C3 parses to exact range boundaries", () => {
    const refs = parseFormulaReferences("=SUM(A1:C3)");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].endRow).toBe(2);
    expect(refs[0].endCol).toBe(2);
  });

  it("range with reversed order is normalized (min/max)", () => {
    // C3:A1 should still produce startRow=0,startCol=0,endRow=2,endCol=2
    const refs = parseFormulaReferences("=SUM(C3:A1)");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].endRow).toBe(2);
    expect(refs[0].endCol).toBe(2);
  });

  it("multiple references get separate colors", () => {
    const refs = parseFormulaReferences("=A1+B2+C3");
    expect(refs).toHaveLength(3);
    // Each should have a different color
    const colors = new Set(refs.map((r) => r.color));
    expect(colors.size).toBe(3);
  });

  it("non-formula string returns empty array", () => {
    expect(parseFormulaReferences("hello")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Formula ref positions: verify character positions are exact
// ---------------------------------------------------------------------------

describe("parseFormulaReferencesWithPositions text indices", () => {
  it("single ref: textStartIndex and textEndIndex match formula substring", () => {
    const formula = "=A1+100";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].textStartIndex).toBe(1); // after "="
    expect(refs[0].textEndIndex).toBe(3);   // "A1" is 2 chars
    expect(formula.substring(refs[0].textStartIndex, refs[0].textEndIndex)).toBe("A1");
  });

  it("range ref covers the full A1:B2 text", () => {
    const formula = "=SUM(A1:B2)";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    const text = formula.substring(refs[0].textStartIndex, refs[0].textEndIndex);
    expect(text).toBe("A1:B2");
  });

  it("absolute ref includes dollar signs in span", () => {
    const formula = "=$A$1";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    const text = formula.substring(refs[0].textStartIndex, refs[0].textEndIndex);
    expect(text).toBe("$A$1");
    expect(refs[0].isStartColAbsolute).toBe(true);
    expect(refs[0].isStartRowAbsolute).toBe(true);
  });

  it("mixed absolute ref: $A1 has col absolute but not row", () => {
    const formula = "=$A1";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].isStartColAbsolute).toBe(true);
    expect(refs[0].isStartRowAbsolute).toBe(false);
  });

  it("multiple refs have non-overlapping positions", () => {
    const formula = "=A1+B2*C3";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(3);
    for (let i = 1; i < refs.length; i++) {
      expect(refs[i].textStartIndex).toBeGreaterThanOrEqual(refs[i - 1].textEndIndex);
    }
  });

  it("sheet-qualified ref includes sheet prefix in span", () => {
    const formula = "=Sheet1!A1";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    const text = formula.substring(refs[0].textStartIndex, refs[0].textEndIndex);
    expect(text).toBe("Sheet1!A1");
    expect(refs[0].sheetName).toBe("Sheet1");
  });

  it("originalText matches the formula substring", () => {
    const formula = "=SUM($A$1:$B$2)+C3";
    const refs = parseFormulaReferencesWithPositions(formula);
    for (const ref of refs) {
      expect(ref.originalText).toBe(
        formula.substring(ref.textStartIndex, ref.textEndIndex)
      );
    }
  });
});
