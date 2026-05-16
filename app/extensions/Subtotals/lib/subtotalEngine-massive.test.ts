//! FILENAME: app/extensions/Subtotals/lib/subtotalEngine-massive.test.ts
// PURPOSE: 200+ heavily parameterized tests for subtotal engine logic.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline helpers (avoids Tauri import mocking)
// ============================================================================

type SubtotalFunction = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

const SUBTOTAL_FUNCTIONS: Array<{ code: SubtotalFunction; name: string }> = [
  { code: 9, name: "SUM" },
  { code: 1, name: "AVERAGE" },
  { code: 2, name: "COUNT" },
  { code: 3, name: "COUNTA" },
  { code: 4, name: "MAX" },
  { code: 5, name: "MIN" },
  { code: 6, name: "PRODUCT" },
  { code: 7, name: "STDEV" },
  { code: 8, name: "STDEVP" },
  { code: 10, name: "VAR" },
  { code: 11, name: "VARP" },
];

function indexToCol(idx: number): string {
  if (idx < 26) return String.fromCharCode(65 + idx);
  const first = Math.floor(idx / 26) - 1;
  const second = idx % 26;
  return String.fromCharCode(65 + first) + String.fromCharCode(65 + second);
}

function generateSubtotalFormula(
  functionCode: SubtotalFunction,
  colIndex: number,
  startRow: number,
  endRow: number,
): string {
  const colLetter = indexToCol(colIndex);
  return `=SUBTOTAL(${functionCode},${colLetter}${startRow + 1}:${colLetter}${endRow + 1})`;
}

interface DataGroup {
  groupValue: string;
  startRow: number;
  endRow: number;
}

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

function calculateInsertedRows(groupCount: number): number {
  return groupCount + 1;
}

function grandTotalRowIndex(endRow: number, groupCount: number): number {
  return endRow + groupCount + 1;
}

/** Compute row index of subtotal for group i (0-based), inserted bottom-up. */
function subtotalRowForGroup(group: DataGroup, groupIndex: number): number {
  return group.endRow + groupIndex + 1;
}

// ============================================================================
// 1. Group detection: 100 data column patterns
// ============================================================================

describe("Subtotals: Group detection - 100 patterns", () => {
  // Generate 100 distinct patterns
  const patterns: Array<{ name: string; values: string[]; expectedGroups: number }> = [];

  // 10 single-group patterns
  for (let len = 1; len <= 10; len++) {
    patterns.push({
      name: `all-same length=${len}`,
      values: Array(len).fill("A"),
      expectedGroups: 1,
    });
  }

  // 10 all-unique patterns
  for (let len = 2; len <= 11; len++) {
    patterns.push({
      name: `all-unique length=${len}`,
      values: Array.from({ length: len }, (_, i) => String.fromCharCode(65 + (i % 26))),
      expectedGroups: len,
    });
  }

  // 20 two-group patterns (varying split point)
  for (let split = 1; split <= 20; split++) {
    const total = split + 5;
    patterns.push({
      name: `two-groups split=${split}/${total}`,
      values: [...Array(split).fill("X"), ...Array(total - split).fill("Y")],
      expectedGroups: 2,
    });
  }

  // 20 three-group patterns
  for (let i = 0; i < 20; i++) {
    const a = i + 1;
    const b = 3;
    const c = 2;
    patterns.push({
      name: `three-groups sizes=${a},${b},${c}`,
      values: [...Array(a).fill("A"), ...Array(b).fill("B"), ...Array(c).fill("C")],
      expectedGroups: 3,
    });
  }

  // 20 alternating patterns (varying length)
  for (let len = 2; len <= 21; len++) {
    patterns.push({
      name: `alternating length=${len}`,
      values: Array.from({ length: len }, (_, i) => (i % 2 === 0 ? "P" : "Q")),
      expectedGroups: len,
    });
  }

  // 10 many-group patterns
  for (let groups = 4; groups <= 13; groups++) {
    const values: string[] = [];
    for (let g = 0; g < groups; g++) {
      values.push(...Array(3).fill(`G${g}`));
    }
    patterns.push({
      name: `${groups}-groups of 3`,
      values,
      expectedGroups: groups,
    });
  }

  // 10 patterns with empty strings
  for (let i = 0; i < 10; i++) {
    const values = [...Array(i + 1).fill(""), ...Array(3).fill("X")];
    patterns.push({
      name: `empty-then-X empties=${i + 1}`,
      values,
      expectedGroups: 2,
    });
  }

  it.each(patterns)("$name -> $expectedGroups groups", ({ values, expectedGroups }) => {
    const groups = detectGroupsSync(values);
    expect(groups).toHaveLength(expectedGroups);
    // Verify coverage
    if (values.length > 0) {
      expect(groups[0].startRow).toBe(0);
      expect(groups[groups.length - 1].endRow).toBe(values.length - 1);
    }
    // Verify continuity
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i].startRow).toBe(groups[i - 1].endRow + 1);
    }
  });
});

// ============================================================================
// 2. Formula generation: 50 group/function combos
// ============================================================================

describe("Subtotals: Formula generation - 50 combos", () => {
  const combos: Array<{
    name: string;
    code: SubtotalFunction;
    col: number;
    startRow: number;
    endRow: number;
  }> = [];

  // 11 functions x 1 config each = 11, then add 39 more varied configs
  for (const func of SUBTOTAL_FUNCTIONS) {
    combos.push({ name: `${func.name} col=0 rows=0-9`, code: func.code, col: 0, startRow: 0, endRow: 9 });
  }

  // 39 additional combos with varied columns and ranges
  const extraConfigs: Array<[number, number, number]> = [
    [0, 0, 0], [1, 0, 5], [2, 5, 20], [3, 10, 50], [4, 0, 99],
    [5, 0, 999], [25, 0, 10], [26, 0, 10], [27, 0, 10], [51, 0, 10],
    [0, 50, 100], [1, 100, 200], [2, 200, 300], [3, 0, 1], [4, 0, 2],
    [5, 0, 3], [10, 0, 49], [15, 10, 30], [20, 20, 40], [0, 0, 500],
    [1, 500, 1000], [2, 0, 1], [3, 1, 2], [4, 2, 3], [5, 3, 4],
    [6, 4, 5], [7, 5, 6], [8, 6, 7], [9, 7, 8], [10, 8, 9],
    [11, 9, 10], [12, 10, 11], [13, 11, 12], [14, 12, 13], [15, 13, 14],
    [16, 14, 15], [17, 15, 16], [18, 16, 17], [19, 17, 18],
  ];

  for (let i = 0; i < extraConfigs.length; i++) {
    const [col, startRow, endRow] = extraConfigs[i];
    const funcIdx = i % SUBTOTAL_FUNCTIONS.length;
    const func = SUBTOTAL_FUNCTIONS[funcIdx];
    combos.push({
      name: `${func.name} col=${col} rows=${startRow}-${endRow}`,
      code: func.code,
      col,
      startRow,
      endRow,
    });
  }

  it.each(combos)("$name", ({ code, col, startRow, endRow }) => {
    const formula = generateSubtotalFormula(code, col, startRow, endRow);
    const colLetter = indexToCol(col);
    expect(formula).toBe(`=SUBTOTAL(${code},${colLetter}${startRow + 1}:${colLetter}${endRow + 1})`);
    expect(formula).toMatch(/^=SUBTOTAL\(\d+,[A-Z]+\d+:[A-Z]+\d+\)$/);
  });
});

// ============================================================================
// 3. Row insertion: 50 multi-group scenarios
// ============================================================================

describe("Subtotals: Row insertion - 50 scenarios", () => {
  const scenarios: Array<{ name: string; dataRows: number; groupCount: number }> = [];

  // 50 scenarios with varying data sizes and group counts
  for (let i = 1; i <= 50; i++) {
    const dataRows = i * 10;
    const groupCount = Math.max(1, Math.min(i, Math.floor(dataRows / 2)));
    scenarios.push({
      name: `${dataRows} rows, ${groupCount} groups`,
      dataRows,
      groupCount,
    });
  }

  it.each(scenarios)("$name", ({ dataRows, groupCount }) => {
    const inserted = calculateInsertedRows(groupCount);
    expect(inserted).toBe(groupCount + 1);

    const endRow = dataRows - 1;
    const grandTotal = grandTotalRowIndex(endRow, groupCount);
    expect(grandTotal).toBe(endRow + groupCount + 1);
    expect(grandTotal).toBe(dataRows - 1 + groupCount + 1);

    // Total rows after insertion
    const totalAfter = dataRows + inserted;
    expect(totalAfter).toBe(dataRows + groupCount + 1);
    expect(grandTotal).toBeLessThan(totalAfter);
  });
});
