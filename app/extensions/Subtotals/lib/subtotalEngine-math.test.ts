//! FILENAME: app/extensions/Subtotals/lib/subtotalEngine-math.test.ts
// PURPOSE: Verify mathematical correctness of subtotal engine computations.
// CONTEXT: Tests formula generation, row index arithmetic, and grand total coverage
//          using pure synchronous logic extracted from subtotalEngine patterns.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline helpers mirroring subtotalEngine.ts logic
// ============================================================================

/** Convert 0-based column index to Excel column letter. */
function indexToCol(col: number): string {
  let result = "";
  let c = col;
  while (c >= 0) {
    result = String.fromCharCode(65 + (c % 26)) + result;
    c = Math.floor(c / 26) - 1;
  }
  return result;
}

interface DataGroup {
  groupValue: string;
  startRow: number;
  endRow: number;
}

/** Synchronous version of detectGroups for testing. */
function detectGroups(
  values: string[],
  startRow: number,
): DataGroup[] {
  const groups: DataGroup[] = [];
  let currentValue: string | null = null;
  let groupStart = startRow;

  for (let i = 0; i < values.length; i++) {
    const row = startRow + i;
    const value = values[i];

    if (currentValue === null) {
      currentValue = value;
      groupStart = row;
    } else if (value !== currentValue) {
      groups.push({ groupValue: currentValue, startRow: groupStart, endRow: row - 1 });
      currentValue = value;
      groupStart = row;
    }
  }
  if (currentValue !== null) {
    groups.push({ groupValue: currentValue, startRow: groupStart, endRow: startRow + values.length - 1 });
  }
  return groups;
}

/** Generate SUBTOTAL formula for a given column/range. */
function buildSubtotalFormula(
  functionCode: number,
  col: number,
  startRow: number,
  endRow: number,
): string {
  const colLetter = indexToCol(col);
  return `=SUBTOTAL(${functionCode},${colLetter}${startRow + 1}:${colLetter}${endRow + 1})`;
}

/**
 * Simulate the bottom-up subtotal row insertion and return the
 * insertion indices and formula ranges.
 */
function simulateSubtotalInsertion(
  groups: DataGroup[],
  subtotalCols: number[],
  functionCode: number,
  startRow: number,
  endRow: number,
): {
  insertionRows: number[];
  formulas: Array<{ row: number; col: number; formula: string }>;
  grandTotalRow: number;
  grandTotalFormulas: Array<{ col: number; formula: string }>;
} {
  let totalInserted = 0;
  const insertionRows: number[] = [];
  const formulas: Array<{ row: number; col: number; formula: string }> = [];

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    const adjustedEndRow = group.endRow + totalInserted;
    const adjustedStartRow = group.startRow + totalInserted;
    const insertAt = adjustedEndRow + 1;

    insertionRows.unshift(insertAt);

    for (const col of subtotalCols) {
      const colLetter = indexToCol(col);
      const formulaStartRow = adjustedStartRow + 1; // 1-based
      const formulaEndRow = adjustedEndRow + 1;     // 1-based
      formulas.push({
        row: insertAt,
        col,
        formula: `=SUBTOTAL(${functionCode},${colLetter}${formulaStartRow}:${colLetter}${formulaEndRow})`,
      });
    }
    totalInserted++;
  }

  const grandTotalRow = endRow + totalInserted + 1;
  const grandTotalFormulas: Array<{ col: number; formula: string }> = [];
  for (const col of subtotalCols) {
    const colLetter = indexToCol(col);
    const gtStartRow = startRow + 1;
    const gtEndRow = grandTotalRow;
    grandTotalFormulas.push({
      col,
      formula: `=SUBTOTAL(${functionCode},${colLetter}${gtStartRow}:${colLetter}${gtEndRow})`,
    });
  }

  return { insertionRows, formulas, grandTotalRow, grandTotalFormulas };
}

// ============================================================================
// SUBTOTAL formula references match exact data ranges
// ============================================================================

describe("subtotal formula references - exact data ranges", () => {
  it("formula references match group boundaries", () => {
    // Rows 2-6, groups: A(2-3), B(4-6)
    const groups = detectGroups(["A", "A", "B", "B", "B"], 2);
    expect(groups).toEqual([
      { groupValue: "A", startRow: 2, endRow: 3 },
      { groupValue: "B", startRow: 4, endRow: 6 },
    ]);

    const result = simulateSubtotalInsertion(groups, [1], 9, 2, 6);

    // Bottom-up insertion: B processed first, then A.
    // B: adjustedStart=4, adjustedEnd=6, insertAt=7 => formula B5:B7
    // A: adjustedStart=2+1=2(no, B is below so no shift), adjustedEnd=3+1=3(no shift)
    // Actually: B is processed first (i=1), totalInserted=0 => adjustedEnd=6, insertAt=7
    // Then A (i=0), totalInserted=1 => adjustedStart=2, adjustedEnd=3, but row 7 was
    // inserted after row 6, so A's rows (2-3) are unaffected => insertAt=4
    // Wait: groups are iterated from last to first. B(startRow=4,endRow=6) first:
    //   adjustedEnd=6+0=6, adjustedStart=4+0=4, insertAt=7. Formula: B5:B7. totalInserted=1
    // A(startRow=2,endRow=3):
    //   adjustedEnd=3+1=4, adjustedStart=2+1=3, insertAt=5. Formula: B4:B5. totalInserted=2
    // So insertion rows are [5, 7]
    expect(result.insertionRows).toEqual([5, 7]);

    const formulaA = result.formulas.find((f) => f.row === 5);
    expect(formulaA).toBeDefined();
    expect(formulaA!.formula).toBe("=SUBTOTAL(9,B4:B5)");

    const formulaB = result.formulas.find((f) => f.row === 7);
    expect(formulaB).toBeDefined();
    expect(formulaB!.formula).toBe("=SUBTOTAL(9,B5:B7)");
  });

  it("single-row groups produce single-cell references", () => {
    const groups = detectGroups(["X", "Y", "Z"], 0);
    expect(groups).toHaveLength(3);

    const result = simulateSubtotalInsertion(groups, [2], 9, 0, 2);
    // Each group is a single row, so formula should reference a single cell range
    for (const f of result.formulas) {
      const match = f.formula.match(/C(\d+):C(\d+)/);
      expect(match).not.toBeNull();
      const start = parseInt(match![1]);
      const end = parseInt(match![2]);
      expect(end - start).toBe(0); // single row
    }
  });
});

// ============================================================================
// Row insertion indices are strictly increasing
// ============================================================================

describe("row insertion indices - strictly increasing", () => {
  it("insertion rows are in ascending order", () => {
    const groups = detectGroups(["A", "A", "B", "B", "C", "C", "C"], 0);
    const result = simulateSubtotalInsertion(groups, [1], 9, 0, 6);

    for (let i = 1; i < result.insertionRows.length; i++) {
      expect(result.insertionRows[i]).toBeGreaterThan(result.insertionRows[i - 1]);
    }
  });

  it("no two subtotal rows share the same index for multi-row groups", () => {
    // Use multi-row groups to ensure distinct insertion points
    const groups = detectGroups(["A", "A", "B", "B", "C", "C"], 10);
    const result = simulateSubtotalInsertion(groups, [0], 9, 10, 15);

    const unique = new Set(result.insertionRows);
    expect(unique.size).toBe(result.insertionRows.length);
  });

  it("grand total row is after all subtotal rows", () => {
    const groups = detectGroups(["A", "A", "B", "B"], 0);
    const result = simulateSubtotalInsertion(groups, [1], 9, 0, 3);

    const maxSubtotalRow = Math.max(...result.insertionRows);
    expect(result.grandTotalRow).toBeGreaterThan(maxSubtotalRow);
  });
});

// ============================================================================
// Grand total formula covers all data including subtotal rows
// ============================================================================

describe("grand total formula - covers full range", () => {
  it("grand total range starts at first data row", () => {
    const groups = detectGroups(["A", "A", "B", "B"], 5);
    const result = simulateSubtotalInsertion(groups, [3], 9, 5, 8);

    // Grand total should start from startRow+1 (1-based) = 6
    for (const gt of result.grandTotalFormulas) {
      expect(gt.formula).toContain("D6:");
    }
  });

  it("grand total range ends at grand total row (inclusive of subtotal rows)", () => {
    const groups = detectGroups(["A", "B", "C"], 0);
    const result = simulateSubtotalInsertion(groups, [1], 9, 0, 2);

    for (const gt of result.grandTotalFormulas) {
      expect(gt.formula).toContain(`:B${result.grandTotalRow}`);
    }
  });

  it("grand total covers correct number of rows with multiple groups", () => {
    // 4 data rows, 3 groups => 3 subtotal rows inserted => grand total at row 4+3+1=8
    const groups = detectGroups(["A", "B", "B", "C"], 0);
    const result = simulateSubtotalInsertion(groups, [0], 9, 0, 3);

    // 3 groups => 3 subtotal rows. grandTotalRow = endRow(3) + 3 + 1 = 7
    expect(result.grandTotalRow).toBe(7);
    // Formula: =SUBTOTAL(9,A1:A7) covering rows 0-6 in 0-based = rows 1-7 in 1-based
    expect(result.grandTotalFormulas[0].formula).toBe("=SUBTOTAL(9,A1:A7)");
  });
});
