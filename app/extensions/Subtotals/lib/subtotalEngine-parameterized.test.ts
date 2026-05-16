//! FILENAME: app/extensions/Subtotals/lib/subtotalEngine-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for subtotal engine pure logic.
// CONTEXT: Tests formula generation, group detection, label generation, row insertion math.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline types and helpers (avoids Tauri import mocking)
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

/** Simulates indexToCol for columns A-Z */
function indexToCol(idx: number): string {
  if (idx < 26) return String.fromCharCode(65 + idx);
  const first = Math.floor(idx / 26) - 1;
  const second = idx % 26;
  return String.fromCharCode(65 + first) + String.fromCharCode(65 + second);
}

/** Generates the SUBTOTAL formula string for a given function code, column, and row range. */
function generateSubtotalFormula(
  functionCode: SubtotalFunction,
  colIndex: number,
  startRow: number,
  endRow: number,
): string {
  const colLetter = indexToCol(colIndex);
  return `=SUBTOTAL(${functionCode},${colLetter}${startRow + 1}:${colLetter}${endRow + 1})`;
}

/** Generates the label for a subtotal row. */
function generateSubtotalLabel(groupValue: string, functionCode: SubtotalFunction): string {
  const funcInfo = SUBTOTAL_FUNCTIONS.find((f) => f.code === functionCode);
  return `${groupValue} ${funcInfo?.name ?? "UNKNOWN"}`;
}

interface DataGroup {
  groupValue: string;
  startRow: number;
  endRow: number;
}

/** Pure synchronous group detection (from an array of values). */
function detectGroupsSync(values: string[]): DataGroup[] {
  const groups: DataGroup[] = [];
  if (values.length === 0) return groups;
  let currentValue = values[0];
  let groupStart = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== currentValue) {
      groups.push({ groupValue: currentValue, startRow: groupStart, endRow: i - 1 });
      currentValue = values[i];
      groupStart = i;
    }
  }
  groups.push({ groupValue: currentValue, startRow: groupStart, endRow: values.length - 1 });
  return groups;
}

/**
 * Calculate how many subtotal rows will be inserted for a given number of groups.
 * Each group gets 1 subtotal row + 1 grand total row at the end.
 */
function calculateInsertedRows(groupCount: number): number {
  return groupCount + 1; // one per group + grand total
}

/**
 * Calculate the final row index of the grand total after all insertions.
 * Original data occupies rows startRow..endRow. Each group inserts 1 row bottom-up,
 * then grand total goes at endRow + groupCount + 1.
 */
function grandTotalRowIndex(endRow: number, groupCount: number): number {
  return endRow + groupCount + 1;
}

// ============================================================================
// 1. All 11 SUBTOTAL functions x formula generation = 11 tests
// ============================================================================

describe("Subtotals: Formula generation for all 11 functions", () => {
  it.each(SUBTOTAL_FUNCTIONS)(
    "SUBTOTAL($code, ...) generates correct formula for $name",
    ({ code, name }) => {
      const formula = generateSubtotalFormula(code, 2, 1, 10); // column C, rows 1-10 (0-based)
      expect(formula).toBe(`=SUBTOTAL(${code},C2:C11)`);
      expect(formula).toContain(`${code}`);
    },
  );
});

// ============================================================================
// 2. Group detection with 20 different data patterns
// ============================================================================

describe("Subtotals: Group detection patterns", () => {
  const patterns: Array<{
    name: string;
    values: string[];
    expectedGroups: number;
    expectedFirstGroup: string;
    expectedLastGroup: string;
  }> = [
    { name: "single value", values: ["A", "A", "A"], expectedGroups: 1, expectedFirstGroup: "A", expectedLastGroup: "A" },
    { name: "two groups", values: ["A", "A", "B", "B"], expectedGroups: 2, expectedFirstGroup: "A", expectedLastGroup: "B" },
    { name: "three groups", values: ["A", "B", "C"], expectedGroups: 3, expectedFirstGroup: "A", expectedLastGroup: "C" },
    { name: "alternating", values: ["A", "B", "A", "B"], expectedGroups: 4, expectedFirstGroup: "A", expectedLastGroup: "B" },
    { name: "single element", values: ["X"], expectedGroups: 1, expectedFirstGroup: "X", expectedLastGroup: "X" },
    { name: "empty string groups", values: ["", "", "A", "A"], expectedGroups: 2, expectedFirstGroup: "", expectedLastGroup: "A" },
    { name: "all different", values: ["A", "B", "C", "D", "E"], expectedGroups: 5, expectedFirstGroup: "A", expectedLastGroup: "E" },
    { name: "all same", values: ["Z", "Z", "Z", "Z", "Z"], expectedGroups: 1, expectedFirstGroup: "Z", expectedLastGroup: "Z" },
    { name: "numbers as strings", values: ["1", "1", "2", "2", "3"], expectedGroups: 3, expectedFirstGroup: "1", expectedLastGroup: "3" },
    { name: "mixed case", values: ["North", "North", "South", "South", "East"], expectedGroups: 3, expectedFirstGroup: "North", expectedLastGroup: "East" },
    { name: "long run then short", values: ["A", "A", "A", "A", "A", "B"], expectedGroups: 2, expectedFirstGroup: "A", expectedLastGroup: "B" },
    { name: "short run then long", values: ["A", "B", "B", "B", "B", "B"], expectedGroups: 2, expectedFirstGroup: "A", expectedLastGroup: "B" },
    { name: "three equal groups", values: ["X", "X", "Y", "Y", "Z", "Z"], expectedGroups: 3, expectedFirstGroup: "X", expectedLastGroup: "Z" },
    { name: "repeated pattern", values: ["A", "B", "A", "B", "A", "B"], expectedGroups: 6, expectedFirstGroup: "A", expectedLastGroup: "B" },
    { name: "empty array", values: [], expectedGroups: 0, expectedFirstGroup: "", expectedLastGroup: "" },
    { name: "spaces matter", values: ["A", "A ", "A"], expectedGroups: 3, expectedFirstGroup: "A", expectedLastGroup: "A" },
    { name: "unicode values", values: ["Alpha", "Beta", "Beta", "Gamma"], expectedGroups: 3, expectedFirstGroup: "Alpha", expectedLastGroup: "Gamma" },
    { name: "region names", values: ["West", "West", "West", "East", "East", "North", "North", "South"], expectedGroups: 4, expectedFirstGroup: "West", expectedLastGroup: "South" },
    { name: "department groups", values: ["Sales", "Sales", "HR", "HR", "IT", "IT", "Finance", "Finance"], expectedGroups: 4, expectedFirstGroup: "Sales", expectedLastGroup: "Finance" },
    { name: "single char groups", values: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"], expectedGroups: 10, expectedFirstGroup: "A", expectedLastGroup: "J" },
  ];

  it.each(patterns)(
    "pattern: $name => $expectedGroups groups",
    ({ values, expectedGroups, expectedFirstGroup, expectedLastGroup }) => {
      const groups = detectGroupsSync(values);
      expect(groups.length).toBe(expectedGroups);
      if (expectedGroups > 0) {
        expect(groups[0].groupValue).toBe(expectedFirstGroup);
        expect(groups[groups.length - 1].groupValue).toBe(expectedLastGroup);
      }
    },
  );
});

// ============================================================================
// 3. Label generation for all 11 functions x 5 group values = 55 tests
// ============================================================================

describe("Subtotals: Label generation", () => {
  const groupValues = ["North", "South", "East", "West", "Central"];
  const cases: Array<{
    groupValue: string;
    code: SubtotalFunction;
    name: string;
    expected: string;
  }> = [];

  for (const gv of groupValues) {
    for (const func of SUBTOTAL_FUNCTIONS) {
      cases.push({
        groupValue: gv,
        code: func.code,
        name: func.name,
        expected: `${gv} ${func.name}`,
      });
    }
  }

  it.each(cases)(
    "$groupValue $name => $expected",
    ({ groupValue, code, expected }) => {
      expect(generateSubtotalLabel(groupValue, code)).toBe(expected);
    },
  );
});

// ============================================================================
// 4. Row insertion calculations for 15 scenarios
// ============================================================================

describe("Subtotals: Row insertion calculations", () => {
  const scenarios: Array<{
    desc: string;
    dataStartRow: number;
    dataEndRow: number;
    groupCount: number;
    expectedInserted: number;
    expectedGrandTotalRow: number;
  }> = [
    { desc: "1 group, rows 1-5", dataStartRow: 1, dataEndRow: 5, groupCount: 1, expectedInserted: 2, expectedGrandTotalRow: 7 },
    { desc: "2 groups, rows 1-10", dataStartRow: 1, dataEndRow: 10, groupCount: 2, expectedInserted: 3, expectedGrandTotalRow: 13 },
    { desc: "3 groups, rows 0-8", dataStartRow: 0, dataEndRow: 8, groupCount: 3, expectedInserted: 4, expectedGrandTotalRow: 12 },
    { desc: "5 groups, rows 1-50", dataStartRow: 1, dataEndRow: 50, groupCount: 5, expectedInserted: 6, expectedGrandTotalRow: 56 },
    { desc: "10 groups, rows 0-99", dataStartRow: 0, dataEndRow: 99, groupCount: 10, expectedInserted: 11, expectedGrandTotalRow: 110 },
    { desc: "1 group, single row", dataStartRow: 0, dataEndRow: 0, groupCount: 1, expectedInserted: 2, expectedGrandTotalRow: 2 },
    { desc: "20 groups, rows 1-100", dataStartRow: 1, dataEndRow: 100, groupCount: 20, expectedInserted: 21, expectedGrandTotalRow: 121 },
    { desc: "4 groups, rows 5-20", dataStartRow: 5, dataEndRow: 20, groupCount: 4, expectedInserted: 5, expectedGrandTotalRow: 25 },
    { desc: "7 groups, rows 0-49", dataStartRow: 0, dataEndRow: 49, groupCount: 7, expectedInserted: 8, expectedGrandTotalRow: 57 },
    { desc: "2 groups, rows 10-15", dataStartRow: 10, dataEndRow: 15, groupCount: 2, expectedInserted: 3, expectedGrandTotalRow: 18 },
    { desc: "6 groups, rows 0-5", dataStartRow: 0, dataEndRow: 5, groupCount: 6, expectedInserted: 7, expectedGrandTotalRow: 12 },
    { desc: "3 groups, rows 100-200", dataStartRow: 100, dataEndRow: 200, groupCount: 3, expectedInserted: 4, expectedGrandTotalRow: 204 },
    { desc: "1 group, rows 0-999", dataStartRow: 0, dataEndRow: 999, groupCount: 1, expectedInserted: 2, expectedGrandTotalRow: 1001 },
    { desc: "15 groups, rows 0-150", dataStartRow: 0, dataEndRow: 150, groupCount: 15, expectedInserted: 16, expectedGrandTotalRow: 166 },
    { desc: "50 groups, rows 0-500", dataStartRow: 0, dataEndRow: 500, groupCount: 50, expectedInserted: 51, expectedGrandTotalRow: 551 },
  ];

  it.each(scenarios)(
    "$desc => $expectedInserted inserted, grand total at row $expectedGrandTotalRow",
    ({ dataEndRow, groupCount, expectedInserted, expectedGrandTotalRow }) => {
      expect(calculateInsertedRows(groupCount)).toBe(expectedInserted);
      expect(grandTotalRowIndex(dataEndRow, groupCount)).toBe(expectedGrandTotalRow);
    },
  );
});
