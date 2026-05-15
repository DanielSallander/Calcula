//! FILENAME: app/src/core/lib/__tests__/formula-integration.test.ts
// PURPOSE: Integration tests combining formula parsing, reference toggling,
//          reference building, and fill lists.

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  buildCellReference,
  buildRangeReference,
  updateFormulaReference,
  findReferenceAtCell,
} from "../formulaRefParser";
import {
  toggleReferenceAtCursor,
  getReferenceAtCursor,
} from "../formulaRefToggle";
import { FillListRegistry } from "../fillLists";
import { columnToLetter, letterToColumn } from "../../types";

// ============================================================================
// Formula Parse + Toggle Round-Trips
// ============================================================================

describe("formula parse + toggle integration", () => {
  it("parses a formula, toggles the first ref to absolute, then re-parses", () => {
    const formula = "=A1+B2";
    // Toggle at cursor on A1 (position 1-3)
    const toggled = toggleReferenceAtCursor(formula, 2);
    expect(toggled.formula).toBe("=$A$1+B2");

    // Re-parse the toggled formula
    const refs = parseFormulaReferencesWithPositions(toggled.formula);
    expect(refs).toHaveLength(2);
    expect(refs[0].isStartColAbsolute).toBe(true);
    expect(refs[0].isStartRowAbsolute).toBe(true);
    expect(refs[0].originalText).toBe("$A$1");
    // B2 should still be relative
    expect(refs[1].isStartColAbsolute).toBe(false);
    expect(refs[1].isStartRowAbsolute).toBe(false);
  });

  it("cycles through all four toggle states and re-parses each time", () => {
    let formula = "=C5";
    const states: Array<{ colAbs: boolean; rowAbs: boolean }> = [];

    // Cycle: C5 -> $C$5 -> C$5 -> $C5 -> C5
    for (let i = 0; i < 4; i++) {
      const result = toggleReferenceAtCursor(formula, 2);
      formula = result.formula;
      const refs = parseFormulaReferencesWithPositions(formula);
      expect(refs).toHaveLength(1);
      states.push({
        colAbs: refs[0].isStartColAbsolute,
        rowAbs: refs[0].isStartRowAbsolute,
      });
    }

    expect(states).toEqual([
      { colAbs: true, rowAbs: true },   // $C$5
      { colAbs: false, rowAbs: true },   // C$5
      { colAbs: true, rowAbs: false },   // $C5
      { colAbs: false, rowAbs: false },  // C5
    ]);
  });

  it("toggles a ref inside SUM, re-parses, and verifies coordinates unchanged", () => {
    const formula = "=SUM(D10:F20)";
    const toggled = toggleReferenceAtCursor(formula, 6); // cursor on D10
    expect(toggled.formula).toBe("=SUM($D$10:F20)");

    const refs = parseFormulaReferences(toggled.formula);
    expect(refs).toHaveLength(1);
    // Range coordinates should be the same regardless of $ markers
    expect(refs[0]).toMatchObject({
      startRow: 9,
      startCol: 3,
      endRow: 19,
      endCol: 5,
    });
  });

  it("parses a cross-sheet formula and toggles the ref", () => {
    const formula = "=Sheet1!A1+B2";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(2);
    expect(refs[0].sheetName).toBe("Sheet1");
    expect(refs[0].originalText).toBe("Sheet1!A1");

    // Toggle the second ref (B2)
    const toggled = toggleReferenceAtCursor(formula, 12); // cursor on B2
    expect(toggled.formula).toBe("=Sheet1!A1+$B$2");
  });

  it("parse -> updateFormulaReference -> re-parse produces correct coordinates", () => {
    const formula = "=A1+B2*C3";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(3);

    // Move B2 (index 1) to D5
    const updated = updateFormulaReference(formula, refs[1], 4, 3);
    expect(updated).toContain("D5");

    // Re-parse and verify
    const newRefs = parseFormulaReferences(updated);
    expect(newRefs).toHaveLength(3);
    expect(newRefs[0]).toMatchObject({ startRow: 0, startCol: 0 }); // A1 unchanged
    expect(newRefs[1]).toMatchObject({ startRow: 4, startCol: 3 }); // D5
    expect(newRefs[2]).toMatchObject({ startRow: 2, startCol: 2 }); // C3 unchanged
  });

  it("updates a range reference preserving absolute markers then re-parses", () => {
    const formula = "=SUM($A$1:$B$5)";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].isStartColAbsolute).toBe(true);

    // Move the range to C3:D7
    const updated = updateFormulaReference(formula, refs[0], 2, 2, 6, 3);
    expect(updated).toBe("=SUM($C$3:$D$7)");

    const newRefs = parseFormulaReferencesWithPositions(updated);
    expect(newRefs[0].isStartColAbsolute).toBe(true);
    expect(newRefs[0].isEndColAbsolute).toBe(true);
  });

  it("findReferenceAtCell locates the right ref after a toggle", () => {
    let formula = "=A1+B2+C3";
    // Toggle B2 to $B$2
    const toggled = toggleReferenceAtCursor(formula, 5);
    formula = toggled.formula;

    const refs = parseFormulaReferencesWithPositions(formula);
    // Cell (1,1) is B2 — should be found at index 1
    const idx = findReferenceAtCell(refs, 1, 1);
    expect(idx).toBe(1);
    expect(refs[idx].isStartColAbsolute).toBe(true);
  });

  it("handles getReferenceAtCursor fallback after closing paren", () => {
    const formula = "=SUM(A1)";
    // Cursor after the ) at position 8
    const ref = getReferenceAtCursor(formula, 8);
    expect(ref).not.toBeNull();
    expect(ref!.ref).toBe("A1");
  });
});

// ============================================================================
// Column Conversion + Formula Reference Round-Trips
// ============================================================================

describe("column conversion + formula reference integration", () => {
  it("converts column index to letter, builds a reference, then parses it back", () => {
    for (const col of [0, 25, 26, 701, 702]) {
      const letter = columnToLetter(col);
      const ref = buildCellReference(0, col, false, false);
      const parsed = parseFormulaReferences(`=${ref}`);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].startCol).toBe(col);
    }
  });

  it("round-trips column letter -> index -> letter for multi-char columns", () => {
    const testCases = ["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"];
    for (const letter of testCases) {
      const idx = letterToColumn(letter);
      const back = columnToLetter(idx);
      expect(back).toBe(letter);
    }
  });

  it("builds a range reference with mixed absolute markers and parses back", () => {
    const rangeStr = buildRangeReference(2, 1, 10, 5, true, false, false, true);
    // Should be $B3:F$11
    const formula = `=SUM(${rangeStr})`;
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      startRow: 2,
      startCol: 1,
      endRow: 10,
      endCol: 5,
      isStartColAbsolute: true,
      isStartRowAbsolute: false,
      isEndColAbsolute: false,
      isEndRowAbsolute: true,
    });
  });

  it("builds a cross-sheet range and parses it", () => {
    const rangeStr = buildRangeReference(0, 0, 9, 2, false, false, false, false, "Data Sheet");
    const formula = `=${rangeStr}`;
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Data Sheet");
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 0,
      endRow: 9, endCol: 2,
    });
  });

  it("builds single-cell reference for equal start/end in buildRangeReference", () => {
    const ref = buildRangeReference(5, 3, 5, 3, false, false, false, false);
    expect(ref).toBe("D6"); // No colon for single cell
    expect(ref).not.toContain(":");
  });
});

// ============================================================================
// Fill Lists + Sequence Generation
// ============================================================================

describe("fill list sequence generation integration", () => {
  beforeEach(() => {
    FillListRegistry._reset();
  });

  it("matches weekdays and generates a full week sequence", () => {
    const match = FillListRegistry.matchValues(["Mon"]);
    expect(match).not.toBeNull();
    expect(match!.list.id).toBe("builtin.weekday.short");

    const week: string[] = [];
    // Mon is index 1, generate 7 values starting from offset 1
    for (let i = 1; i <= 7; i++) {
      week.push(FillListRegistry.generateValue(match!, 1, i));
    }
    expect(week).toEqual(["Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Mon"]);
  });

  it("matches months with step=2 and generates every-other-month sequence", () => {
    const match = FillListRegistry.matchValues(["Jan", "Mar"]);
    expect(match).not.toBeNull();
    expect(match!.step).toBe(2);

    // Generate next 3 values after Mar (index 2)
    const next = [1, 2, 3].map((offset) =>
      FillListRegistry.generateValue(match!, 2, offset)
    );
    expect(next).toEqual(["May", "Jul", "Sep"]);
  });

  it("wraps around when generating past the end of a list", () => {
    const match = FillListRegistry.matchValues(["Nov"]);
    expect(match).not.toBeNull();

    const next = [1, 2, 3].map((offset) =>
      FillListRegistry.generateValue(match!, 10, offset)
    );
    expect(next).toEqual(["Dec", "Jan", "Feb"]);
  });

  it("creates a custom list, matches against it, then generates values", () => {
    const list = FillListRegistry.addList("Sizes", [
      "XS", "S", "M", "L", "XL", "XXL",
    ]);

    const match = FillListRegistry.matchValues(["M"]);
    expect(match).not.toBeNull();
    expect(match!.list.id).toBe(list.id);
    expect(match!.startIndex).toBe(2);

    const next = FillListRegistry.generateValue(match!, 2, 1);
    expect(next).toBe("L");
  });

  it("user-defined lists take priority over built-in when overlapping", () => {
    // Create a custom list that starts with "Mon"
    FillListRegistry.addList("Custom Days", ["Mon", "Tue", "Wed"]);
    const match = FillListRegistry.matchValues(["Mon"]);
    expect(match).not.toBeNull();
    // User list should be checked first
    expect(match!.list.builtIn).toBe(false);
  });

  it("case-insensitive matching works for fill lists", () => {
    const match = FillListRegistry.matchValues(["JANUARY", "FEBRUARY"]);
    expect(match).not.toBeNull();
    expect(match!.list.id).toBe("builtin.month.full");
    expect(match!.step).toBe(1);
  });

  it("returns null for non-matching values", () => {
    const match = FillListRegistry.matchValues(["foo", "bar"]);
    expect(match).toBeNull();
  });

  it("handles remove and update of custom lists", () => {
    const list = FillListRegistry.addList("Test", ["A", "B", "C"]);
    expect(FillListRegistry.getUserLists()).toHaveLength(1);

    FillListRegistry.updateList(list.id, "Updated", ["X", "Y", "Z"]);
    const match = FillListRegistry.matchValues(["X"]);
    expect(match).not.toBeNull();

    FillListRegistry.removeList(list.id);
    expect(FillListRegistry.getUserLists()).toHaveLength(0);
    expect(FillListRegistry.matchValues(["X"])).toBeNull();
  });
});

// ============================================================================
// Complex Multi-Module Scenarios
// ============================================================================

describe("complex multi-module scenarios", () => {
  it("builds a SUM formula from column indices, parses, toggles all refs, and verifies", () => {
    // Build a SUM formula referencing columns 0-4, row 0
    const refs = Array.from({ length: 5 }, (_, i) =>
      buildCellReference(0, i, false, false)
    );
    let formula = `=SUM(${refs.join(",")})`;
    expect(formula).toBe("=SUM(A1,B1,C1,D1,E1)");

    // Toggle each ref to absolute
    for (let i = 0; i < 5; i++) {
      const parsed = parseFormulaReferencesWithPositions(formula);
      const ref = getReferenceAtCursor(formula, parsed[i].textStartIndex + 1);
      expect(ref).not.toBeNull();
      const toggled = toggleReferenceAtCursor(formula, parsed[i].textStartIndex + 1);
      formula = toggled.formula;
    }

    // All should now be absolute
    const finalRefs = parseFormulaReferencesWithPositions(formula);
    for (const ref of finalRefs) {
      expect(ref.isStartColAbsolute).toBe(true);
      expect(ref.isStartRowAbsolute).toBe(true);
    }
  });

  it("simulates drag-to-fill with weekday values mapped to cell references", () => {
    // Start with "Wed" in cell C1
    const startValues = ["Wed"];
    const match = FillListRegistry.matchValues(startValues);
    expect(match).not.toBeNull();

    // Generate 5 values to fill downward (C2 through C6)
    const filled: Array<{ value: string; ref: string }> = [];
    for (let offset = 1; offset <= 5; offset++) {
      const value = FillListRegistry.generateValue(match!, 3, offset); // Wed=index 3
      const ref = buildCellReference(offset, 2, false, false); // Column C, rows 1-5
      filled.push({ value, ref });
    }

    expect(filled.map((f) => f.value)).toEqual(["Thu", "Fri", "Sat", "Sun", "Mon"]);
    expect(filled.map((f) => f.ref)).toEqual(["C2", "C3", "C4", "C5", "C6"]);

    // Verify each ref parses to correct coordinates
    for (let i = 0; i < filled.length; i++) {
      const parsed = parseFormulaReferences(`=${filled[i].ref}`);
      expect(parsed[0].startRow).toBe(i + 1);
      expect(parsed[0].startCol).toBe(2);
    }
  });

  it("multi-reference formula: update one ref then toggle another", () => {
    const formula = "=A1*B2+C3/D4";
    let refs = parseFormulaReferencesWithPositions(formula);

    // Move C3 to E10
    let updated = updateFormulaReference(formula, refs[2], 9, 4);
    expect(updated).toContain("E10");

    // Toggle D4 to $D$4
    refs = parseFormulaReferencesWithPositions(updated);
    const d4Ref = refs.find((r) => r.startCol === 3 && r.startRow === 3);
    expect(d4Ref).toBeDefined();
    const toggled = toggleReferenceAtCursor(updated, d4Ref!.textStartIndex + 1);

    // Re-parse final formula
    const finalRefs = parseFormulaReferences(toggled.formula);
    expect(finalRefs).toHaveLength(4);
    expect(finalRefs[0]).toMatchObject({ startRow: 0, startCol: 0 }); // A1
    expect(finalRefs[1]).toMatchObject({ startRow: 1, startCol: 1 }); // B2
    expect(finalRefs[2]).toMatchObject({ startRow: 9, startCol: 4 }); // E10
    expect(finalRefs[3]).toMatchObject({ startRow: 3, startCol: 3 }); // $D$4
  });

  it("3D sheet reference is parsed correctly", () => {
    const formula = "=Sheet1:Sheet3!A1:B5";
    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Sheet1");
    expect(refs[0]).toMatchObject({
      startRow: 0, startCol: 0,
      endRow: 4, endCol: 1,
    });
  });
});
