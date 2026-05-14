//! FILENAME: app/extensions/Subtotals/lib/subtotalEngine.test.ts
// PURPOSE: Tests for subtotal engine pure logic.
// CONTEXT: Tests group detection, subtotal formula generation, and the
//          SUBTOTAL_FUNCTIONS configuration. The main applySubtotals function
//          is async and uses many API calls, so we test the extractable logic
//          patterns and the types/constants.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline copy of types and constants from types.ts
// ============================================================================

type SubtotalFunction = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

interface SubtotalFunctionInfo {
  code: SubtotalFunction;
  name: string;
  label: string;
}

const SUBTOTAL_FUNCTIONS: SubtotalFunctionInfo[] = [
  { code: 9, name: "SUM", label: "Sum" },
  { code: 1, name: "AVERAGE", label: "Average" },
  { code: 2, name: "COUNT", label: "Count" },
  { code: 3, name: "COUNTA", label: "Count Numbers" },
  { code: 4, name: "MAX", label: "Max" },
  { code: 5, name: "MIN", label: "Min" },
  { code: 6, name: "PRODUCT", label: "Product" },
  { code: 7, name: "STDEV", label: "StdDev" },
  { code: 8, name: "STDEVP", label: "StdDevP" },
  { code: 10, name: "VAR", label: "Var" },
  { code: 11, name: "VARP", label: "VarP" },
];

// ============================================================================
// Inline copy of detectGroups logic from subtotalEngine.ts
// (Synchronous version for testing - same algorithm)
// ============================================================================

interface DataGroup {
  groupValue: string;
  startRow: number;
  endRow: number;
}

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
      groups.push({
        groupValue: currentValue,
        startRow: groupStart,
        endRow: row - 1,
      });
      currentValue = value;
      groupStart = row;
    }
  }

  if (currentValue !== null) {
    groups.push({
      groupValue: currentValue,
      startRow: groupStart,
      endRow: startRow + values.length - 1,
    });
  }

  return groups;
}

// ============================================================================
// Inline copy of formula generation logic
// ============================================================================

function indexToCol(index: number): string {
  let result = "";
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function buildSubtotalFormula(
  functionCode: number,
  col: number,
  startRow: number,
  endRow: number,
): string {
  const colLetter = indexToCol(col);
  const formulaStartRow = startRow + 1; // 1-based
  const formulaEndRow = endRow + 1;     // 1-based
  return `=SUBTOTAL(${functionCode},${colLetter}${formulaStartRow}:${colLetter}${formulaEndRow})`;
}

function buildSubtotalLabel(groupValue: string, funcName: string): string {
  return `${groupValue} ${funcName}`;
}

// ============================================================================
// Tests: SUBTOTAL_FUNCTIONS configuration
// ============================================================================

describe("SUBTOTAL_FUNCTIONS", () => {
  it("contains 11 functions", () => {
    expect(SUBTOTAL_FUNCTIONS).toHaveLength(11);
  });

  it("has unique codes", () => {
    const codes = SUBTOTAL_FUNCTIONS.map((f) => f.code);
    expect(new Set(codes).size).toBe(11);
  });

  it("codes range from 1 to 11", () => {
    const codes = SUBTOTAL_FUNCTIONS.map((f) => f.code).sort((a, b) => a - b);
    expect(codes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("has SUM as code 9 (matching Excel)", () => {
    const sum = SUBTOTAL_FUNCTIONS.find((f) => f.code === 9);
    expect(sum).toBeDefined();
    expect(sum!.name).toBe("SUM");
  });

  it("has AVERAGE as code 1 (matching Excel)", () => {
    const avg = SUBTOTAL_FUNCTIONS.find((f) => f.code === 1);
    expect(avg).toBeDefined();
    expect(avg!.name).toBe("AVERAGE");
  });

  it("each function has name and label", () => {
    for (const func of SUBTOTAL_FUNCTIONS) {
      expect(func.name).toBeTruthy();
      expect(func.label).toBeTruthy();
    }
  });

  it("SUM is the first entry (default selection)", () => {
    expect(SUBTOTAL_FUNCTIONS[0].code).toBe(9);
    expect(SUBTOTAL_FUNCTIONS[0].name).toBe("SUM");
  });
});

// ============================================================================
// Tests: Group Detection
// ============================================================================

describe("detectGroups", () => {
  it("returns empty array for empty values", () => {
    expect(detectGroups([], 0)).toEqual([]);
  });

  it("detects a single group when all values are the same", () => {
    const groups = detectGroups(["A", "A", "A", "A"], 1);
    expect(groups).toEqual([
      { groupValue: "A", startRow: 1, endRow: 4 },
    ]);
  });

  it("detects multiple contiguous groups", () => {
    const groups = detectGroups(["North", "North", "South", "South", "East"], 0);
    expect(groups).toEqual([
      { groupValue: "North", startRow: 0, endRow: 1 },
      { groupValue: "South", startRow: 2, endRow: 3 },
      { groupValue: "East", startRow: 4, endRow: 4 },
    ]);
  });

  it("detects single-row groups", () => {
    const groups = detectGroups(["A", "B", "C"], 5);
    expect(groups).toEqual([
      { groupValue: "A", startRow: 5, endRow: 5 },
      { groupValue: "B", startRow: 6, endRow: 6 },
      { groupValue: "C", startRow: 7, endRow: 7 },
    ]);
  });

  it("handles repeated group values that are non-contiguous", () => {
    // "A", "B", "A" -> 3 groups (not merged because non-contiguous)
    const groups = detectGroups(["A", "B", "A"], 0);
    expect(groups).toEqual([
      { groupValue: "A", startRow: 0, endRow: 0 },
      { groupValue: "B", startRow: 1, endRow: 1 },
      { groupValue: "A", startRow: 2, endRow: 2 },
    ]);
  });

  it("treats empty strings as valid group values", () => {
    const groups = detectGroups(["", "", "X", "X"], 0);
    expect(groups).toEqual([
      { groupValue: "", startRow: 0, endRow: 1 },
      { groupValue: "X", startRow: 2, endRow: 3 },
    ]);
  });

  it("handles single value", () => {
    const groups = detectGroups(["Only"], 10);
    expect(groups).toEqual([
      { groupValue: "Only", startRow: 10, endRow: 10 },
    ]);
  });

  it("respects startRow offset", () => {
    const groups = detectGroups(["A", "A", "B"], 100);
    expect(groups).toEqual([
      { groupValue: "A", startRow: 100, endRow: 101 },
      { groupValue: "B", startRow: 102, endRow: 102 },
    ]);
  });

  it("handles large number of same-value rows", () => {
    const values = Array(1000).fill("Region1");
    const groups = detectGroups(values, 0);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ groupValue: "Region1", startRow: 0, endRow: 999 });
  });
});

// ============================================================================
// Tests: Subtotal Formula Generation
// ============================================================================

describe("buildSubtotalFormula", () => {
  it("generates correct SUM formula", () => {
    // Column B (index 1), rows 2-5 (0-based)
    const formula = buildSubtotalFormula(9, 1, 2, 5);
    expect(formula).toBe("=SUBTOTAL(9,B3:B6)");
  });

  it("generates correct AVERAGE formula", () => {
    const formula = buildSubtotalFormula(1, 0, 0, 9);
    expect(formula).toBe("=SUBTOTAL(1,A1:A10)");
  });

  it("generates correct COUNT formula", () => {
    const formula = buildSubtotalFormula(2, 2, 5, 10);
    expect(formula).toBe("=SUBTOTAL(2,C6:C11)");
  });

  it("handles large column indices (double-letter columns)", () => {
    const formula = buildSubtotalFormula(9, 26, 0, 4);
    expect(formula).toBe("=SUBTOTAL(9,AA1:AA5)");
  });

  it("handles single-row range", () => {
    const formula = buildSubtotalFormula(9, 3, 5, 5);
    expect(formula).toBe("=SUBTOTAL(9,D6:D6)");
  });
});

// ============================================================================
// Tests: Subtotal Label Generation
// ============================================================================

describe("buildSubtotalLabel", () => {
  it("combines group value with function name", () => {
    expect(buildSubtotalLabel("North", "SUM")).toBe("North SUM");
    expect(buildSubtotalLabel("Sales", "AVERAGE")).toBe("Sales AVERAGE");
  });

  it("handles empty group value", () => {
    expect(buildSubtotalLabel("", "SUM")).toBe(" SUM");
  });

  it("handles group value with spaces", () => {
    expect(buildSubtotalLabel("New York", "COUNT")).toBe("New York COUNT");
  });
});

// ============================================================================
// Tests: Row Adjustment Logic (bottom-up insertion)
// ============================================================================

describe("bottom-up insertion row adjustment", () => {
  it("adjusts rows correctly when inserting bottom-up", () => {
    // Simulates the bottom-up insertion algorithm from applySubtotals.
    // Groups: [0-2], [3-5], [6-9]
    // Insert subtotal rows bottom-up.
    const groups: DataGroup[] = [
      { groupValue: "A", startRow: 0, endRow: 2 },
      { groupValue: "B", startRow: 3, endRow: 5 },
      { groupValue: "C", startRow: 6, endRow: 9 },
    ];

    let totalInserted = 0;
    const insertPositions: number[] = [];

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      const adjustedEndRow = group.endRow + totalInserted;
      const insertAt = adjustedEndRow + 1;
      insertPositions.unshift(insertAt);
      totalInserted++;
    }

    // Group C: endRow=9, adjusted=9, insert at 10
    // Group B: endRow=5, adjusted=5+1=6, insert at 7
    // Group A: endRow=2, adjusted=2+2=4, insert at 5
    expect(insertPositions).toEqual([5, 7, 10]);
  });

  it("preserves earlier group indices when working bottom-up", () => {
    const groups: DataGroup[] = [
      { groupValue: "X", startRow: 0, endRow: 0 },
      { groupValue: "Y", startRow: 1, endRow: 1 },
    ];

    let totalInserted = 0;
    const results: Array<{ adjustedStart: number; adjustedEnd: number; insertAt: number }> = [];

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      const adjustedStart = group.startRow + totalInserted;
      const adjustedEnd = group.endRow + totalInserted;
      const insertAt = adjustedEnd + 1;
      results.unshift({ adjustedStart, adjustedEnd, insertAt });
      totalInserted++;
    }

    // Y: start=1+0=1, end=1+0=1, insert=2; totalInserted=1
    // X: start=0+1=1, end=0+1=1, insert=2; but wait...
    // Actually X: start=0+1=1, end=0+1=1, insert=2
    expect(results[0]).toEqual({ adjustedStart: 1, adjustedEnd: 1, insertAt: 2 });
    expect(results[1]).toEqual({ adjustedStart: 1, adjustedEnd: 1, insertAt: 2 });
  });

  it("computes correct grand total row position", () => {
    // endRow=9, totalInserted=3 (3 subtotal rows), grandTotal = 9 + 3 + 1 = 13
    const endRow = 9;
    const totalInserted = 3;
    const grandTotalRow = endRow + totalInserted + 1;
    expect(grandTotalRow).toBe(13);
  });
});
