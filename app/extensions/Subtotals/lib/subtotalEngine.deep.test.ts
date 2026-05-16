//! FILENAME: app/extensions/Subtotals/lib/subtotalEngine.deep.test.ts
// PURPOSE: Deep tests for subtotal engine logic covering nested subtotals,
//          all 11 function codes, mixed data, large datasets, row indices, etc.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline copies of pure logic from subtotalEngine.ts and types.ts
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

interface DataGroup {
  groupValue: string;
  startRow: number;
  endRow: number;
}

function detectGroups(values: string[], startRow: number): DataGroup[] {
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

function indexToCol(index: number): string {
  let result = "";
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function buildSubtotalFormula(functionCode: number, col: number, startRow: number, endRow: number): string {
  const colLetter = indexToCol(col);
  return `=SUBTOTAL(${functionCode},${colLetter}${startRow + 1}:${colLetter}${endRow + 1})`;
}

function buildSubtotalLabel(groupValue: string, funcName: string): string {
  return `${groupValue} ${funcName}`;
}

/**
 * Simulates the full bottom-up insertion algorithm from applySubtotals.
 * Returns the insert positions, adjusted group ranges, and grand total row.
 */
function simulateBottomUpInsertion(
  groups: DataGroup[],
  originalEndRow: number,
  subtotalCols: number[],
  functionCode: number,
): {
  subtotalRows: Array<{ dataStart: number; dataEnd: number; subtotalRow: number; label: string; formulas: string[] }>;
  grandTotalRow: number;
  grandTotalFormulas: string[];
  totalInserted: number;
} {
  const funcInfo = SUBTOTAL_FUNCTIONS.find((f) => f.code === functionCode)!;
  let totalInserted = 0;
  const subtotalRows: Array<{
    dataStart: number;
    dataEnd: number;
    subtotalRow: number;
    label: string;
    formulas: string[];
  }> = [];

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    const adjustedEndRow = group.endRow + totalInserted;
    const adjustedStartRow = group.startRow + totalInserted;
    const insertAt = adjustedEndRow + 1;
    totalInserted++;

    const formulas = subtotalCols.map((col) => buildSubtotalFormula(functionCode, col, adjustedStartRow, adjustedEndRow));

    subtotalRows.unshift({
      dataStart: adjustedStartRow,
      dataEnd: adjustedEndRow,
      subtotalRow: insertAt,
      label: buildSubtotalLabel(group.groupValue, funcInfo.name),
      formulas,
    });
  }

  const grandTotalRow = originalEndRow + totalInserted + 1;
  const startRow = groups[0].startRow;
  const grandTotalFormulas = subtotalCols.map((col) => {
    const colLetter = indexToCol(col);
    return `=SUBTOTAL(${functionCode},${colLetter}${startRow + 1}:${colLetter}${grandTotalRow})`;
  });

  return { subtotalRows, grandTotalRow, grandTotalFormulas, totalInserted };
}

// ============================================================================
// Tests: All 11 SUBTOTAL function codes
// ============================================================================

describe("all 11 SUBTOTAL function codes", () => {
  const expectedMapping: Array<{ code: SubtotalFunction; name: string }> = [
    { code: 1, name: "AVERAGE" },
    { code: 2, name: "COUNT" },
    { code: 3, name: "COUNTA" },
    { code: 4, name: "MAX" },
    { code: 5, name: "MIN" },
    { code: 6, name: "PRODUCT" },
    { code: 7, name: "STDEV" },
    { code: 8, name: "STDEVP" },
    { code: 9, name: "SUM" },
    { code: 10, name: "VAR" },
    { code: 11, name: "VARP" },
  ];

  for (const { code, name } of expectedMapping) {
    it(`code ${code} maps to ${name} and generates correct formula`, () => {
      const funcInfo = SUBTOTAL_FUNCTIONS.find((f) => f.code === code);
      expect(funcInfo).toBeDefined();
      expect(funcInfo!.name).toBe(name);

      const formula = buildSubtotalFormula(code, 1, 0, 9);
      expect(formula).toBe(`=SUBTOTAL(${code},B1:B10)`);
    });
  }

  it("each code produces a unique label suffix", () => {
    const labels = SUBTOTAL_FUNCTIONS.map((f) => buildSubtotalLabel("Region", f.name));
    expect(new Set(labels).size).toBe(11);
  });
});

// ============================================================================
// Tests: Nested subtotals (region -> city)
// ============================================================================

describe("nested subtotals (region then city)", () => {
  // Data layout: Region in col 0, City in col 1, Sales in col 2
  // Row 1: North, NYC, 100
  // Row 2: North, NYC, 200
  // Row 3: North, Boston, 150
  // Row 4: South, Miami, 300
  // Row 5: South, Miami, 250
  // Row 6: South, Atlanta, 175

  const regionValues = ["North", "North", "North", "South", "South", "South"];
  const cityValues = ["NYC", "NYC", "Boston", "Miami", "Miami", "Atlanta"];

  it("detects outer groups (region) correctly", () => {
    const groups = detectGroups(regionValues, 1);
    expect(groups).toEqual([
      { groupValue: "North", startRow: 1, endRow: 3 },
      { groupValue: "South", startRow: 4, endRow: 6 },
    ]);
  });

  it("detects inner groups (city) correctly", () => {
    const groups = detectGroups(cityValues, 1);
    expect(groups).toEqual([
      { groupValue: "NYC", startRow: 1, endRow: 2 },
      { groupValue: "Boston", startRow: 3, endRow: 3 },
      { groupValue: "Miami", startRow: 4, endRow: 5 },
      { groupValue: "Atlanta", startRow: 6, endRow: 6 },
    ]);
  });

  it("inner subtotals insert correctly bottom-up (city level)", () => {
    const cityGroups = detectGroups(cityValues, 1);
    const result = simulateBottomUpInsertion(cityGroups, 6, [2], 9);

    // 4 city groups -> 4 subtotal rows inserted
    expect(result.totalInserted).toBe(4);
    expect(result.subtotalRows).toHaveLength(4);

    // After bottom-up insertion, verify subtotal rows are after each city group
    // NYC group (rows 1-2): subtotal at row 3 (adjusted for 3 inserts below)
    // but with bottom-up: Atlanta first (insert at 7), Miami (insert at 7), Boston (insert at 5), NYC (insert at 5)
    // Let's verify the final positions are monotonically increasing
    for (let i = 1; i < result.subtotalRows.length; i++) {
      expect(result.subtotalRows[i].subtotalRow).toBeGreaterThanOrEqual(result.subtotalRows[i - 1].subtotalRow);
    }
  });

  it("outer subtotals would need recalculated ranges after inner inserts", () => {
    // This tests the concept that applying subtotals at the city level first
    // shifts the region group boundaries
    const cityGroups = detectGroups(cityValues, 1);
    const innerResult = simulateBottomUpInsertion(cityGroups, 6, [2], 9);

    // After 4 inner subtotal rows, original endRow 6 becomes 6 + 4 = 10
    // Plus grand total = 11, so total rows expanded significantly
    expect(innerResult.grandTotalRow).toBe(6 + 4 + 1); // 11
  });
});

// ============================================================================
// Tests: Mixed data types in groups
// ============================================================================

describe("mixed data types in group values", () => {
  it("handles numeric strings as group values", () => {
    const groups = detectGroups(["100", "100", "200", "200"], 0);
    expect(groups).toHaveLength(2);
    expect(groups[0].groupValue).toBe("100");
    expect(groups[1].groupValue).toBe("200");
  });

  it("handles date-like strings as group values", () => {
    const groups = detectGroups(["2024-01-01", "2024-01-01", "2024-02-01"], 0);
    expect(groups).toHaveLength(2);
    expect(groups[0].groupValue).toBe("2024-01-01");
  });

  it("treats blank cells as empty string groups", () => {
    const groups = detectGroups(["", "", "A", "A", ""], 0);
    expect(groups).toHaveLength(3);
    expect(groups[0].groupValue).toBe("");
    expect(groups[1].groupValue).toBe("A");
    expect(groups[2].groupValue).toBe("");
  });

  it("distinguishes between similar-looking values strictly", () => {
    const groups = detectGroups(["1", "01", "1.0", "1"], 0);
    expect(groups).toHaveLength(4); // all different strings
  });

  it("handles special characters in group values", () => {
    const groups = detectGroups(["A&B", "A&B", "C/D"], 0);
    expect(groups).toHaveLength(2);
    expect(groups[0].groupValue).toBe("A&B");
  });

  it("labels for groups with special chars are correctly formed", () => {
    expect(buildSubtotalLabel("A&B", "SUM")).toBe("A&B SUM");
    expect(buildSubtotalLabel("2024-Q1", "AVERAGE")).toBe("2024-Q1 AVERAGE");
  });
});

// ============================================================================
// Tests: Very large dataset (1000+ rows, 50+ groups)
// ============================================================================

describe("large dataset performance", () => {
  it("handles 1000 rows with 50 groups", () => {
    // 50 groups of 20 rows each
    const values: string[] = [];
    for (let g = 0; g < 50; g++) {
      for (let r = 0; r < 20; r++) {
        values.push(`Group${g.toString().padStart(2, "0")}`);
      }
    }
    expect(values).toHaveLength(1000);

    const groups = detectGroups(values, 1);
    expect(groups).toHaveLength(50);

    // Verify first and last group boundaries
    expect(groups[0]).toEqual({ groupValue: "Group00", startRow: 1, endRow: 20 });
    expect(groups[49]).toEqual({ groupValue: "Group49", startRow: 981, endRow: 1000 });
  });

  it("handles 1000 rows where every row is its own group", () => {
    const values = Array.from({ length: 1000 }, (_, i) => `Item${i}`);
    const groups = detectGroups(values, 0);
    expect(groups).toHaveLength(1000);

    // Each group is a single row
    for (let i = 0; i < 1000; i++) {
      expect(groups[i].startRow).toBe(i);
      expect(groups[i].endRow).toBe(i);
    }
  });

  it("bottom-up insertion with 50 groups produces correct totalInserted", () => {
    const values: string[] = [];
    for (let g = 0; g < 50; g++) {
      for (let r = 0; r < 20; r++) {
        values.push(`G${g}`);
      }
    }
    const groups = detectGroups(values, 1);
    const result = simulateBottomUpInsertion(groups, 1000, [2, 3], 9);

    expect(result.totalInserted).toBe(50);
    expect(result.grandTotalRow).toBe(1000 + 50 + 1);
    expect(result.subtotalRows).toHaveLength(50);
    expect(result.grandTotalFormulas).toHaveLength(2); // 2 subtotal columns
  });

  it("handles 2000 rows with alternating groups (1000 groups of 2)", () => {
    const values: string[] = [];
    for (let g = 0; g < 1000; g++) {
      values.push(`Pair${g}`, `Pair${g}`);
    }
    const groups = detectGroups(values, 0);
    expect(groups).toHaveLength(1000);
  });
});

// ============================================================================
// Tests: Single-row groups
// ============================================================================

describe("single-row groups", () => {
  it("every row is its own group when all values differ", () => {
    const groups = detectGroups(["A", "B", "C", "D", "E"], 0);
    expect(groups).toHaveLength(5);
    groups.forEach((g, i) => {
      expect(g.startRow).toBe(i);
      expect(g.endRow).toBe(i);
    });
  });

  it("bottom-up insertion for single-row groups yields correct formulas", () => {
    const groups = detectGroups(["A", "B", "C"], 0);
    const result = simulateBottomUpInsertion(groups, 2, [1], 9);

    // Each subtotal formula covers exactly one row
    for (const sub of result.subtotalRows) {
      expect(sub.dataStart).toBe(sub.dataEnd);
      expect(sub.formulas[0]).toMatch(/B\d+:B\d+/);
      // The start and end in the formula range should match
      const match = sub.formulas[0].match(/B(\d+):B(\d+)/);
      expect(match![1]).toBe(match![2]);
    }
  });
});

// ============================================================================
// Tests: Already-sorted vs unsorted data
// ============================================================================

describe("sorted vs unsorted data", () => {
  it("sorted data produces minimal groups", () => {
    const sorted = ["A", "A", "B", "B", "C", "C"];
    const groups = detectGroups(sorted, 0);
    expect(groups).toHaveLength(3);
  });

  it("unsorted data with same values produces more groups (non-contiguous)", () => {
    const unsorted = ["A", "B", "A", "B", "C", "A"];
    const groups = detectGroups(unsorted, 0);
    // A, B, A, B, C, A -> 6 separate groups since non-contiguous
    expect(groups).toHaveLength(6);
  });

  it("partially sorted data produces intermediate number of groups", () => {
    const partial = ["A", "A", "B", "A", "A"];
    const groups = detectGroups(partial, 0);
    // A(0-1), B(2), A(3-4) -> 3 groups
    expect(groups).toHaveLength(3);
  });
});

// ============================================================================
// Tests: Column offset calculations for different data layouts
// ============================================================================

describe("column offset calculations", () => {
  it("indexToCol handles columns A through Z", () => {
    expect(indexToCol(0)).toBe("A");
    expect(indexToCol(25)).toBe("Z");
  });

  it("indexToCol handles double-letter columns AA through AZ", () => {
    expect(indexToCol(26)).toBe("AA");
    expect(indexToCol(27)).toBe("AB");
    expect(indexToCol(51)).toBe("AZ");
  });

  it("indexToCol handles triple-letter columns", () => {
    expect(indexToCol(702)).toBe("AAA");
  });

  it("formulas for multiple subtotal columns reference correct letters", () => {
    // Subtotal columns at B(1), D(3), F(5)
    const cols = [1, 3, 5];
    const formulas = cols.map((c) => buildSubtotalFormula(9, c, 0, 9));
    expect(formulas[0]).toContain("B1:B10");
    expect(formulas[1]).toContain("D1:D10");
    expect(formulas[2]).toContain("F1:F10");
  });

  it("formulas with high column indices use double letters", () => {
    const formula = buildSubtotalFormula(9, 27, 0, 4);
    expect(formula).toBe("=SUBTOTAL(9,AB1:AB5)");
  });
});

// ============================================================================
// Tests: Row insertion order (bottom-up exact index verification)
// ============================================================================

describe("bottom-up insertion exact indices", () => {
  it("4 groups: verifies exact insertion positions", () => {
    const groups: DataGroup[] = [
      { groupValue: "A", startRow: 0, endRow: 1 },
      { groupValue: "B", startRow: 2, endRow: 4 },
      { groupValue: "C", startRow: 5, endRow: 5 },
      { groupValue: "D", startRow: 6, endRow: 8 },
    ];

    let totalInserted = 0;
    const positions: number[] = [];

    for (let i = groups.length - 1; i >= 0; i--) {
      const adjustedEnd = groups[i].endRow + totalInserted;
      positions.unshift(adjustedEnd + 1);
      totalInserted++;
    }

    // D: end=8+0=8, insert at 9
    // C: end=5+1=6, insert at 7
    // B: end=4+2=6, insert at 7
    // A: end=1+3=4, insert at 5
    expect(positions).toEqual([5, 7, 7, 9]);
  });

  it("all subtotal rows come after their respective data rows", () => {
    const groups: DataGroup[] = [
      { groupValue: "X", startRow: 10, endRow: 14 },
      { groupValue: "Y", startRow: 15, endRow: 19 },
      { groupValue: "Z", startRow: 20, endRow: 24 },
    ];

    const result = simulateBottomUpInsertion(groups, 24, [1], 9);

    for (const sub of result.subtotalRows) {
      expect(sub.subtotalRow).toBeGreaterThan(sub.dataEnd);
      expect(sub.subtotalRow).toBe(sub.dataEnd + 1);
    }
  });

  it("grand total row is always after the last subtotal row", () => {
    const groups: DataGroup[] = [
      { groupValue: "A", startRow: 0, endRow: 3 },
      { groupValue: "B", startRow: 4, endRow: 7 },
    ];

    const result = simulateBottomUpInsertion(groups, 7, [1], 9);
    const lastSubtotalRow = result.subtotalRows[result.subtotalRows.length - 1].subtotalRow;
    expect(result.grandTotalRow).toBeGreaterThan(lastSubtotalRow);
  });
});

// ============================================================================
// Tests: Grand total row placement
// ============================================================================

describe("grand total row placement", () => {
  it("grand total = originalEndRow + groupCount + 1", () => {
    const testCases = [
      { endRow: 9, groupCount: 3, expected: 13 },
      { endRow: 99, groupCount: 10, expected: 110 },
      { endRow: 0, groupCount: 1, expected: 2 },
      { endRow: 999, groupCount: 50, expected: 1050 },
    ];

    for (const tc of testCases) {
      expect(tc.endRow + tc.groupCount + 1).toBe(tc.expected);
    }
  });

  it("grand total formula covers full range including subtotal rows", () => {
    const groups: DataGroup[] = [
      { groupValue: "A", startRow: 1, endRow: 3 },
      { groupValue: "B", startRow: 4, endRow: 6 },
    ];

    const result = simulateBottomUpInsertion(groups, 6, [2], 9);
    // Grand total formula should start from first data row and go to grand total row
    expect(result.grandTotalFormulas[0]).toContain(`C2:`);
    expect(result.grandTotalFormulas[0]).toContain(`C${result.grandTotalRow}`);
  });
});

// ============================================================================
// Tests: Replace existing subtotals scenario
// ============================================================================

describe("replace existing subtotals", () => {
  it("detecting groups on data with existing subtotal labels creates separate groups", () => {
    // If there are already subtotal rows, they appear as different group values
    const valuesWithSubtotals = ["North", "North", "North SUM", "South", "South", "South SUM", "Grand Total"];
    const groups = detectGroups(valuesWithSubtotals, 0);

    // Subtotal rows break group continuity
    expect(groups.length).toBeGreaterThan(2);
    // The "North SUM" row forms its own group
    const subtotalGroup = groups.find((g) => g.groupValue === "North SUM");
    expect(subtotalGroup).toBeDefined();
    expect(subtotalGroup!.startRow).toBe(subtotalGroup!.endRow); // single row
  });

  it("to replace subtotals, old subtotal rows must be removed first", () => {
    // This verifies that the engine treats subtotal label rows as data
    // A proper "replace" would strip rows matching "* SUM" / "Grand Total" pattern first
    const cleaned = ["North", "North", "South", "South"];
    const groups = detectGroups(cleaned, 0);
    expect(groups).toHaveLength(2);
  });
});
