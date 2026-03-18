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
// parseFormulaReferences
// ============================================================================

describe("parseFormulaReferences", () => {
  it("returns empty for non-formula strings", () => {
    expect(parseFormulaReferences("hello")).toEqual([]);
    expect(parseFormulaReferences("A1")).toEqual([]);
    expect(parseFormulaReferences("")).toEqual([]);
  });

  it("parses a single cell reference", () => {
    const refs = parseFormulaReferences("=A1");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
  });

  it("parses multiple cell references", () => {
    const refs = parseFormulaReferences("=A1+B2");
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0 });
    expect(refs[1]).toMatchObject({ startRow: 1, startCol: 1 });
  });

  it("parses a range reference", () => {
    const refs = parseFormulaReferences("=A1:B2");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 0,
      endRow: 1, endCol: 1,
    });
  });

  it("handles absolute references with $", () => {
    const refs = parseFormulaReferences("=$A$1:$B$2");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 0,
      endRow: 1, endCol: 1,
    });
  });

  it("extracts sheet name from cross-sheet reference", () => {
    const refs = parseFormulaReferences("=Sheet1!A1");
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Sheet1");
    expect(refs[0]).toMatchObject({ startRow: 0, startCol: 0 });
  });

  it("extracts quoted sheet name", () => {
    const refs = parseFormulaReferences("='Sheet Name'!A1:B2");
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Sheet Name");
  });

  it("assigns different colors to different references", () => {
    const refs = parseFormulaReferences("=A1+B2+C3");
    expect(refs).toHaveLength(3);
    expect(refs[0].color).not.toBe(refs[1].color);
    expect(refs[1].color).not.toBe(refs[2].color);
  });

  it("marks references as passive when flag is set", () => {
    const refs = parseFormulaReferences("=A1+B2", true);
    expect(refs.every((r) => r.isPassive)).toBe(true);
  });

  it("normalizes range order (min/max)", () => {
    // B2:A1 should still produce startRow=0, startCol=0
    const refs = parseFormulaReferences("=B2:A1");
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 0,
      endRow: 1, endCol: 1,
    });
  });

  it("parses multi-letter column references", () => {
    const refs = parseFormulaReferences("=AA1");
    expect(refs).toHaveLength(1);
    expect(refs[0].startCol).toBe(26); // AA = column 26
  });
});

// ============================================================================
// parseFormulaReferencesWithPositions
// ============================================================================

describe("parseFormulaReferencesWithPositions", () => {
  it("returns empty for non-formula strings", () => {
    expect(parseFormulaReferencesWithPositions("hello")).toEqual([]);
  });

  it("includes text position info", () => {
    const refs = parseFormulaReferencesWithPositions("=A1+B2");
    expect(refs).toHaveLength(2);
    expect(refs[0].textStartIndex).toBe(1);
    expect(refs[0].textEndIndex).toBe(3);
    expect(refs[0].originalText).toBe("A1");
    expect(refs[1].originalText).toBe("B2");
  });

  it("detects absolute markers", () => {
    const refs = parseFormulaReferencesWithPositions("=$A$1");
    expect(refs[0].isStartColAbsolute).toBe(true);
    expect(refs[0].isStartRowAbsolute).toBe(true);
  });

  it("detects mixed absolute markers in ranges", () => {
    const refs = parseFormulaReferencesWithPositions("=$A1:B$2");
    expect(refs[0].isStartColAbsolute).toBe(true);
    expect(refs[0].isStartRowAbsolute).toBe(false);
    expect(refs[0].isEndColAbsolute).toBe(false);
    expect(refs[0].isEndRowAbsolute).toBe(true);
  });

  it("handles sheet prefix in position tracking", () => {
    const refs = parseFormulaReferencesWithPositions("=Sheet1!A1");
    expect(refs[0].sheetName).toBe("Sheet1");
    expect(refs[0].originalText).toBe("Sheet1!A1");
  });
});

// ============================================================================
// buildCellReference
// ============================================================================

describe("buildCellReference", () => {
  it("builds simple relative reference", () => {
    expect(buildCellReference(0, 0, false, false)).toBe("A1");
  });

  it("builds absolute reference", () => {
    expect(buildCellReference(0, 0, true, true)).toBe("$A$1");
  });

  it("builds mixed reference", () => {
    expect(buildCellReference(4, 2, true, false)).toBe("$C5");
    expect(buildCellReference(4, 2, false, true)).toBe("C$5");
  });

  it("includes sheet name", () => {
    expect(buildCellReference(0, 0, false, false, "Sheet1")).toBe("Sheet1!A1");
  });

  it("quotes sheet names with spaces", () => {
    expect(buildCellReference(0, 0, false, false, "My Sheet")).toBe("'My Sheet'!A1");
  });
});

// ============================================================================
// buildRangeReference
// ============================================================================

describe("buildRangeReference", () => {
  it("builds simple range", () => {
    expect(buildRangeReference(0, 0, 1, 1, false, false, false, false)).toBe("A1:B2");
  });

  it("builds fully absolute range", () => {
    expect(buildRangeReference(0, 0, 1, 1, true, true, true, true)).toBe("$A$1:$B$2");
  });

  it("collapses single-cell range to cell reference", () => {
    expect(buildRangeReference(0, 0, 0, 0, false, false, false, false)).toBe("A1");
  });

  it("includes sheet name on ranges", () => {
    expect(buildRangeReference(0, 0, 1, 1, false, false, false, false, "Data")).toBe("Data!A1:B2");
  });
});

// ============================================================================
// findReferenceAtCell
// ============================================================================

describe("findReferenceAtCell", () => {
  it("finds reference containing the cell", () => {
    const refs = parseFormulaReferencesWithPositions("=A1:C3+D5");
    const idx = findReferenceAtCell(refs, 1, 1); // B2 is within A1:C3
    expect(idx).toBe(0);
  });

  it("returns -1 when cell is not in any reference", () => {
    const refs = parseFormulaReferencesWithPositions("=A1:C3");
    const idx = findReferenceAtCell(refs, 10, 10);
    expect(idx).toBe(-1);
  });

  it("matches exact single-cell reference", () => {
    const refs = parseFormulaReferencesWithPositions("=A1+D5");
    expect(findReferenceAtCell(refs, 4, 3)).toBe(1); // D5 is row 4, col 3
  });

  it("respects sheet name filtering", () => {
    const refs = parseFormulaReferencesWithPositions("=Sheet1!A1");
    // Current sheet is Sheet2 - should not match
    expect(findReferenceAtCell(refs, 0, 0, "Sheet2", "Sheet2")).toBe(-1);
    // Current sheet is Sheet1 - should match
    expect(findReferenceAtCell(refs, 0, 0, "Sheet1", "Sheet1")).toBe(0);
  });
});

// ============================================================================
// updateFormulaReference
// ============================================================================

describe("updateFormulaReference", () => {
  it("moves a single cell reference", () => {
    const refs = parseFormulaReferencesWithPositions("=A1+B2");
    const result = updateFormulaReference("=A1+B2", refs[0], 2, 2); // Move A1 to C3
    expect(result).toBe("=C3+B2");
  });

  it("moves a range reference", () => {
    const refs = parseFormulaReferencesWithPositions("=A1:B2+C3");
    const result = updateFormulaReference("=A1:B2+C3", refs[0], 5, 5); // Move range
    expect(result).toBe("=F6:G7+C3");
  });

  it("preserves absolute markers when moving", () => {
    const refs = parseFormulaReferencesWithPositions("=$A$1");
    const result = updateFormulaReference("=$A$1", refs[0], 3, 3);
    expect(result).toBe("=$D$4");
  });

  it("preserves sheet name when moving", () => {
    const refs = parseFormulaReferencesWithPositions("=Sheet1!A1");
    const result = updateFormulaReference("=Sheet1!A1", refs[0], 2, 2);
    expect(result).toBe("=Sheet1!C3");
  });
});
