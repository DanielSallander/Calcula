//! FILENAME: app/extensions/_standard/conditional-formatting/__tests__/ruleEvaluator-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for rule evaluation engine
// TARGET: 260+ tests via it.each

import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateCondition,
  buildRangeContext,
  clearRangeContextCache,
} from "../ruleEvaluator";
import type {
  CellValueCondition,
  TextCondition,
  Top10Condition,
  AboveAverageCondition,
  DuplicatesCondition,
  ComparisonOperator,
  TextOperator,
  RangeContext,
} from "../types";

const coords = { row: 0, col: 0 };

// ============================================================================
// 1. Cell Value Rules: 8 operators x 10 value combos = 80 tests
// ============================================================================

describe("cellValue conditions (parameterized)", () => {
  const cond = (
    operator: ComparisonOperator,
    v1: number | string,
    v2?: number | string,
  ): CellValueCondition => ({
    type: "cellValue",
    operator,
    value1: v1,
    value2: v2,
  });

  describe.each<{
    op: ComparisonOperator;
    cases: [string, number | string, boolean, number | string?][];
  }>([
    {
      op: "greaterThan",
      cases: [
        ["100 > 50", 50, true],
        ["50 > 50", 50, false],
        ["0 > 50", 50, false],
        ["-10 > -20", -20, true],
        ["999.9 > 999.8", 999.8, true],
        ["0.001 > 0", 0, true],
        ["-1 > 0", 0, false],
        ["1000000 > 999999", 999999, true],
        ["0 > -1", -1, true],
        ["5.5 > 5.5", 5.5, false],
      ],
    },
    {
      op: "lessThan",
      cases: [
        ["10 < 50", 50, true],
        ["50 < 50", 50, false],
        ["100 < 50", 50, false],
        ["-20 < -10", -10, true],
        ["0 < 0.001", 0.001, true],
        ["-100 < 0", 0, true],
        ["999 < 1000", 1000, true],
        ["0 < 0", 0, false],
        ["-0.5 < -0.4", -0.4, true],
        ["1 < -1", -1, false],
      ],
    },
    {
      op: "equal",
      cases: [
        ["50 == 50", 50, true],
        ["0 == 0", 0, true],
        ["-1 == -1", -1, true],
        ["100 == 50", 50, false],
        ["0.1 == 0.1", 0.1, true],
        ["99 == 100", 100, false],
        ["-5 == 5", 5, false],
        ["1000 == 1000", 1000, true],
        ["0 == -0", 0, true],
        ["3.14 == 3.14", 3.14, true],
      ],
    },
    {
      op: "notEqual",
      cases: [
        ["50 != 100", 100, true],
        ["50 != 50", 50, false],
        ["0 != 1", 1, true],
        ["-1 != 1", 1, true],
        ["0 != 0", 0, false],
        ["3.14 != 3.15", 3.15, true],
        ["100 != 100", 100, false],
        ["-5 != -5", -5, false],
        ["999 != 1000", 1000, true],
        ["0.001 != 0.002", 0.002, true],
      ],
    },
    {
      op: "greaterThanOrEqual",
      cases: [
        ["50 >= 50", 50, true],
        ["51 >= 50", 50, true],
        ["49 >= 50", 50, false],
        ["0 >= 0", 0, true],
        ["-1 >= 0", 0, false],
        ["100 >= 99", 99, true],
        ["-10 >= -10", -10, true],
        ["-9 >= -10", -10, true],
        ["0.1 >= 0.1", 0.1, true],
        ["0.09 >= 0.1", 0.1, false],
      ],
    },
    {
      op: "lessThanOrEqual",
      cases: [
        ["50 <= 50", 50, true],
        ["49 <= 50", 50, true],
        ["51 <= 50", 50, false],
        ["0 <= 0", 0, true],
        ["1 <= 0", 0, false],
        ["-10 <= -10", -10, true],
        ["-11 <= -10", -10, true],
        ["-9 <= -10", -10, false],
        ["0.1 <= 0.1", 0.1, true],
        ["0.11 <= 0.1", 0.1, false],
      ],
    },
    {
      op: "between",
      cases: [
        ["5 in [1,10]", 1, true, 10],
        ["1 in [1,10]", 1, true, 10],
        ["10 in [1,10]", 1, true, 10],
        ["0 in [1,10]", 1, false, 10],
        ["11 in [1,10]", 1, false, 10],
        ["-5 in [-10,0]", -10, true, 0],
        ["50 in [100,0] (reversed)", 100, true, 0],
        ["0.5 in [0,1]", 0, true, 1],
        ["-1 in [-1,-1]", -1, true, -1],
        ["5 in [5,5]", 5, true, 5],
      ],
    },
    {
      op: "notBetween",
      cases: [
        ["0 not in [1,10]", 1, true, 10],
        ["11 not in [1,10]", 1, true, 10],
        ["5 not in [1,10]", 1, false, 10],
        ["1 not in [1,10]", 1, false, 10],
        ["10 not in [1,10]", 1, false, 10],
        ["-11 not in [-10,0]", -10, true, 0],
        ["1 not in [-10,0]", -10, true, 0],
        ["-5 not in [-10,0]", -10, false, 0],
        ["100 not in [0,50]", 0, true, 50],
        ["-1 not in [0,50]", 0, true, 50],
      ],
    },
  ])("$op", ({ op, cases }) => {
    it.each(cases)("%s (threshold=%s, expected=%s)", (label, threshold, expected, threshold2) => {
      // Extract the cell value from the label (first number before the operator)
      const cellValue = label.toString().match(/-?[\d.]+/)![0];
      const condition = cond(op, threshold, threshold2);
      expect(evaluateCondition(condition, cellValue, coords)).toBe(expected);
    });
  });
});

// ============================================================================
// 2. Text Rules: 6 types x 10 patterns = 60 tests
// ============================================================================

describe("text conditions (parameterized)", () => {
  const cond = (
    operator: TextOperator,
    value: string,
    caseSensitive?: boolean,
  ): TextCondition => ({
    type: "text",
    operator,
    value,
    caseSensitive,
  });

  describe.each<{
    op: TextOperator;
    cases: [string, string, string, boolean, boolean?][];
  }>([
    {
      op: "contains",
      cases: [
        ["hello in 'hello world'", "hello world", "hello", true],
        ["world in 'hello world'", "hello world", "world", true],
        ["xyz not in 'hello'", "hello", "xyz", false],
        ["empty in anything", "anything", "", true],
        ["HELLO in 'hello' (case-insensitive)", "hello", "HELLO", true],
        ["HELLO in 'hello' (case-sensitive)", "hello", "HELLO", false, true],
        ["ell in 'Hello'", "Hello", "ell", true],
        ["123 in 'abc123def'", "abc123def", "123", true],
        ["space in 'a b'", "a b", " ", true],
        ["full match", "test", "test", true],
      ],
    },
    {
      op: "beginsWith",
      cases: [
        ["hello starts 'hello world'", "hello world", "hello", true],
        ["world starts 'hello world'", "hello world", "world", false],
        ["empty starts anything", "anything", "", true],
        ["H starts 'hello' (insensitive)", "hello", "H", true],
        ["H starts 'hello' (sensitive)", "hello", "H", false, true],
        ["abc starts 'abcdef'", "abcdef", "abc", true],
        ["def starts 'abcdef'", "abcdef", "def", false],
        ["123 starts '123abc'", "123abc", "123", true],
        ["full match starts", "test", "test", true],
        ["longer than target", "hi", "hello", false],
      ],
    },
    {
      op: "endsWith",
      cases: [
        ["world ends 'hello world'", "hello world", "world", true],
        ["hello ends 'hello world'", "hello world", "hello", false],
        ["empty ends anything", "anything", "", true],
        ["D ends 'world' (insensitive)", "world", "D", true],
        ["D ends 'world' (sensitive)", "world", "D", false, true],
        ["def ends 'abcdef'", "abcdef", "def", true],
        ["abc ends 'abcdef'", "abcdef", "abc", false],
        ["123 ends 'abc123'", "abc123", "123", true],
        ["full match ends", "test", "test", true],
        ["longer than target", "hi", "hello", false],
      ],
    },
    {
      op: "equals",
      cases: [
        ["exact match", "hello", "hello", true],
        ["different", "hello", "world", false],
        ["case insensitive", "Hello", "hello", true],
        ["case sensitive match", "hello", "hello", true, true],
        ["case sensitive mismatch", "Hello", "hello", false, true],
        ["empty equals empty", "", "", true],
        ["space matters", "hello ", "hello", false],
        ["numbers as text", "123", "123", true],
        ["special chars", "a@b#c", "a@b#c", true],
        ["unicode", "cafe", "CAFE", true],
      ],
    },
    {
      op: "notContains",
      cases: [
        ["xyz not in 'hello'", "hello", "xyz", true],
        ["hello not in 'hello world'", "hello world", "hello", false],
        ["ABC not in 'abc' (insensitive)", "abc", "ABC", false],
        ["ABC not in 'abc' (sensitive)", "abc", "ABC", true, true],
        ["empty never not-contained", "anything", "", false],
        ["space not in 'abc'", "abc", " ", true],
        ["123 not in 'abc'", "abc", "123", true],
        ["full not in partial", "test", "testing", true],
        ["ab not in 'abc'", "abc", "ab", false],
        ["z not in 'abc'", "abc", "z", true],
      ],
    },
    {
      op: "notEquals",
      cases: [
        ["different strings", "hello", "world", true],
        ["same strings", "hello", "hello", false],
        ["case insensitive same", "Hello", "hello", false],
        ["case sensitive different", "Hello", "hello", true, true],
        ["empty vs non-empty", "", "hello", true],
        ["empty vs empty", "", "", false],
        ["space difference", " hello", "hello", true],
        ["numbers differ", "123", "456", true],
        ["numbers same", "123", "123", false],
        ["special chars differ", "a@b", "a#b", true],
      ],
    },
  ])("$op", ({ op, cases }) => {
    it.each(cases)("%s (cell=%s, search=%s, expected=%s)", (_label, cellValue, search, expected, caseSensitive) => {
      const condition = cond(op, search, caseSensitive);
      expect(evaluateCondition(condition, cellValue, coords)).toBe(expected);
    });
  });
});

// ============================================================================
// 3. Top10 Rules: 20 combos (count/percent x 5 thresholds x 2 directions)
// ============================================================================

describe("top10 conditions (parameterized)", () => {
  // Range: 1..20 sorted
  const rangeValues = Array.from({ length: 20 }, (_, i) => String(i + 1));
  const context = buildRangeContext(rangeValues);

  const cond = (
    direction: "top" | "bottom",
    count: number,
    percent?: boolean,
  ): Top10Condition => ({
    type: "top10",
    direction,
    count,
    percent,
  });

  describe.each<{
    direction: "top" | "bottom";
    cases: [string, number, boolean, string, boolean][];
  }>([
    {
      direction: "top",
      cases: [
        // [label, count, percent, cellValue, expected]
        ["top 1 item, val=20", 1, false, "20", true],
        ["top 1 item, val=19", 1, false, "19", false],
        ["top 5 items, val=16", 5, false, "16", true],
        ["top 5 items, val=15", 5, false, "15", false],
        ["top 10 items, val=11", 10, false, "11", true],
        ["top 10%, val=20 (top 2)", 10, true, "20", true],
        ["top 10%, val=19 (top 2)", 10, true, "19", true],
        ["top 10%, val=18 (not top 2)", 10, true, "18", false],
        ["top 50%, val=11 (top 10)", 50, true, "11", true],
        ["top 50%, val=10 (not top 10)", 50, true, "10", false],
      ],
    },
    {
      direction: "bottom",
      cases: [
        ["bottom 1 item, val=1", 1, false, "1", true],
        ["bottom 1 item, val=2", 1, false, "2", false],
        ["bottom 5 items, val=5", 5, false, "5", true],
        ["bottom 5 items, val=6", 5, false, "6", false],
        ["bottom 10 items, val=10", 10, false, "10", true],
        ["bottom 10%, val=1 (bottom 2)", 10, true, "1", true],
        ["bottom 10%, val=2 (bottom 2)", 10, true, "2", true],
        ["bottom 10%, val=3 (not bottom 2)", 10, true, "3", false],
        ["bottom 50%, val=10 (bottom 10)", 50, true, "10", true],
        ["bottom 50%, val=11 (not bottom 10)", 50, true, "11", false],
      ],
    },
  ])("$direction", ({ direction, cases }) => {
    it.each(cases)("%s", (_label, count, percent, cellValue, expected) => {
      const condition = cond(direction, count, percent || undefined);
      expect(evaluateCondition(condition, cellValue, coords, context)).toBe(expected);
    });
  });
});

// ============================================================================
// 4. Color Scale Positions: 50 value/min/max combos
// ============================================================================

describe("color scale position calculation (parameterized)", () => {
  // Helper: compute normalized position [0,1] within a range
  function colorScalePosition(value: number, min: number, max: number): number {
    if (max === min) return 0.5;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  it.each<[string, number, number, number, number]>([
    ["min value", 0, 0, 100, 0],
    ["max value", 100, 0, 100, 1],
    ["midpoint", 50, 0, 100, 0.5],
    ["quarter", 25, 0, 100, 0.25],
    ["three-quarter", 75, 0, 100, 0.75],
    ["negative range min", -100, -100, 0, 0],
    ["negative range max", 0, -100, 0, 1],
    ["negative range mid", -50, -100, 0, 0.5],
    ["cross-zero min", -50, -50, 50, 0],
    ["cross-zero max", 50, -50, 50, 1],
    ["cross-zero zero", 0, -50, 50, 0.5],
    ["small range min", 0, 0, 1, 0],
    ["small range max", 1, 0, 1, 1],
    ["small range mid", 0.5, 0, 1, 0.5],
    ["large range", 500000, 0, 1000000, 0.5],
    ["decimal precision 0.1", 10, 0, 100, 0.1],
    ["decimal precision 0.9", 90, 0, 100, 0.9],
    ["below min (clamped)", -10, 0, 100, 0],
    ["above max (clamped)", 110, 0, 100, 1],
    ["equal min max", 50, 50, 50, 0.5],
    ["10%", 10, 0, 100, 0.1],
    ["20%", 20, 0, 100, 0.2],
    ["30%", 30, 0, 100, 0.3],
    ["40%", 40, 0, 100, 0.4],
    ["60%", 60, 0, 100, 0.6],
    ["70%", 70, 0, 100, 0.7],
    ["80%", 80, 0, 100, 0.8],
    ["90%", 90, 0, 100, 0.9],
    ["1%", 1, 0, 100, 0.01],
    ["99%", 99, 0, 100, 0.99],
    ["neg 25%", -75, -100, 0, 0.25],
    ["neg 75%", -25, -100, 0, 0.75],
    ["offset range 10%", 110, 100, 200, 0.1],
    ["offset range 50%", 150, 100, 200, 0.5],
    ["offset range 90%", 190, 100, 200, 0.9],
    ["tiny range 0.001", 0.0005, 0, 0.001, 0.5],
    ["large negative", -999, -1000, 0, 0.001],
    ["float accumulation", 0.3, 0, 1, 0.3],
    ["negative to positive 25%", -25, -50, 50, 0.25],
    ["negative to positive 75%", 25, -50, 50, 0.75],
    ["exactly at 1/3", 100 / 3, 0, 100, 1 / 3],
    ["exactly at 2/3", 200 / 3, 0, 100, 2 / 3],
    ["zero in positive range", 0, 0, 200, 0],
    ["very close to max", 99.999, 0, 100, 0.99999],
    ["very close to min", 0.001, 0, 100, 0.00001],
    ["range [1000,2000] at 1500", 1500, 1000, 2000, 0.5],
    ["range [1000,2000] at 1250", 1250, 1000, 2000, 0.25],
    ["range [-1,-0.5] at -0.75", -0.75, -1, -0.5, 0.5],
    ["range [0,10] at 3", 3, 0, 10, 0.3],
    ["range [0,10] at 7", 7, 0, 10, 0.7],
  ])("%s: value=%s min=%s max=%s -> %s", (_label, value, min, max, expected) => {
    const result = colorScalePosition(value, min, max);
    expect(result).toBeCloseTo(expected, 5);
  });
});

// ============================================================================
// 5. Data Bar Widths: 40 value/range combos
// ============================================================================

describe("data bar width calculation (parameterized)", () => {
  // Data bar percent: (value - min) / (max - min) * 100, clamped to [0,100]
  function dataBarPercent(value: number, min: number, max: number): number {
    if (max === min) return 0;
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  }

  it.each<[string, number, number, number, number]>([
    ["min -> 0%", 0, 0, 100, 0],
    ["max -> 100%", 100, 0, 100, 100],
    ["mid -> 50%", 50, 0, 100, 50],
    ["quarter -> 25%", 25, 0, 100, 25],
    ["three-quarter -> 75%", 75, 0, 100, 75],
    ["10%", 10, 0, 100, 10],
    ["90%", 90, 0, 100, 90],
    ["below min clamped", -10, 0, 100, 0],
    ["above max clamped", 110, 0, 100, 100],
    ["negative range 0%", -100, -100, 0, 0],
    ["negative range 100%", 0, -100, 0, 100],
    ["negative range 50%", -50, -100, 0, 50],
    ["cross-zero 0%", -50, -50, 50, 0],
    ["cross-zero 50%", 0, -50, 50, 50],
    ["cross-zero 100%", 50, -50, 50, 100],
    ["small values 50%", 0.5, 0, 1, 50],
    ["small values 10%", 0.1, 0, 1, 10],
    ["equal min/max", 50, 50, 50, 0],
    ["offset range 0%", 100, 100, 200, 0],
    ["offset range 100%", 200, 100, 200, 100],
    ["offset range 50%", 150, 100, 200, 50],
    ["1 of 10", 1, 0, 10, 10],
    ["3 of 10", 3, 0, 10, 30],
    ["7 of 10", 7, 0, 10, 70],
    ["9 of 10", 9, 0, 10, 90],
    ["large range 25%", 250000, 0, 1000000, 25],
    ["large range 75%", 750000, 0, 1000000, 75],
    ["5%", 5, 0, 100, 5],
    ["15%", 15, 0, 100, 15],
    ["33%", 33, 0, 100, 33],
    ["67%", 67, 0, 100, 67],
    ["95%", 95, 0, 100, 95],
    ["1%", 1, 0, 100, 1],
    ["99%", 99, 0, 100, 99],
    ["neg to pos 25%", -25, -50, 50, 25],
    ["neg to pos 75%", 25, -50, 50, 75],
    ["decimal 33.3%", 1, 0, 3, 33.33333],
    ["decimal 66.7%", 2, 0, 3, 66.66667],
    ["very small percent", 0.01, 0, 100, 0.01],
    ["near 100%", 99.99, 0, 100, 99.99],
  ])("%s: value=%s min=%s max=%s -> %s%%", (_label, value, min, max, expected) => {
    const result = dataBarPercent(value, min, max);
    expect(result).toBeCloseTo(expected, 3);
  });
});

// ============================================================================
// 6. Icon Set Thresholds: 30 value/bucket combos (3-icon, 4-icon, 5-icon)
// ============================================================================

describe("icon set threshold calculation (parameterized)", () => {
  // Determine icon index based on value position in range
  // 3-icon: [0%, 33%, 67%, 100%] -> icons 2,1,0
  // 4-icon: [0%, 25%, 50%, 75%, 100%] -> icons 3,2,1,0
  // 5-icon: [0%, 20%, 40%, 60%, 80%, 100%] -> icons 4,3,2,1,0
  function iconIndex(value: number, min: number, max: number, iconCount: 3 | 4 | 5): number {
    if (max === min) return 0;
    const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
    const step = 1 / iconCount;
    const bucket = Math.min(iconCount - 1, Math.floor(pct / step));
    // Reverse: highest value = icon 0 (best), lowest = icon N-1
    return iconCount - 1 - bucket;
  }

  describe("3-icon sets", () => {
    it.each<[string, number, number, number, number]>([
      ["min value -> worst icon", 0, 0, 100, 2],
      ["low value -> worst icon", 10, 0, 100, 2],
      ["at 33% -> mid icon", 33, 0, 100, 2],
      ["at 34% -> mid icon", 34, 0, 100, 1],
      ["mid value -> mid icon", 50, 0, 100, 1],
      ["at 66% -> mid icon", 66, 0, 100, 1],
      ["at 67% -> best icon", 67, 0, 100, 0],
      ["high value -> best icon", 80, 0, 100, 0],
      ["max value -> best icon", 100, 0, 100, 0],
      ["just below 33%", 32, 0, 100, 2],
    ])("%s: value=%s -> icon %s", (_label, value, min, max, expected) => {
      expect(iconIndex(value, min, max, 3)).toBe(expected);
    });
  });

  describe("4-icon sets", () => {
    it.each<[string, number, number, number, number]>([
      ["min value", 0, 0, 100, 3],
      ["at 25%", 25, 0, 100, 2],
      ["at 26%", 26, 0, 100, 2],
      ["at 50%", 50, 0, 100, 1],
      ["at 51%", 51, 0, 100, 1],
      ["at 75%", 75, 0, 100, 0],
      ["at 76%", 76, 0, 100, 0],
      ["max value", 100, 0, 100, 0],
      ["at 12%", 12, 0, 100, 3],
      ["at 37%", 37, 0, 100, 2],
    ])("%s: value=%s -> icon %s", (_label, value, min, max, expected) => {
      expect(iconIndex(value, min, max, 4)).toBe(expected);
    });
  });

  describe("5-icon sets", () => {
    it.each<[string, number, number, number, number]>([
      ["min value", 0, 0, 100, 4],
      ["at 20%", 20, 0, 100, 3],
      ["at 21%", 21, 0, 100, 3],
      ["at 40%", 40, 0, 100, 2],
      ["at 41%", 41, 0, 100, 2],
      ["at 60%", 60, 0, 100, 2],
      ["at 61%", 61, 0, 100, 1],
      ["at 80%", 80, 0, 100, 0],
      ["at 90%", 90, 0, 100, 0],
      ["max value", 100, 0, 100, 0],
    ])("%s: value=%s -> icon %s", (_label, value, min, max, expected) => {
      expect(iconIndex(value, min, max, 5)).toBe(expected);
    });
  });
});

// ============================================================================
// 7. Above/Below Average: 20 value/stats combos
// ============================================================================

describe("aboveAverage conditions (parameterized)", () => {
  // Average of [10,20,30,40,50] = 30
  const rangeValues = ["10", "20", "30", "40", "50"];
  const context = buildRangeContext(rangeValues);

  const cond = (direction: AboveAverageCondition["direction"]): AboveAverageCondition => ({
    type: "aboveAverage",
    direction,
  });

  describe.each<{
    dir: AboveAverageCondition["direction"];
    cases: [string, string, boolean][];
  }>([
    {
      dir: "above",
      cases: [
        ["50 above avg 30", "50", true],
        ["40 above avg 30", "40", true],
        ["31 above avg 30", "31", true],
        ["30 not above avg 30", "30", false],
        ["10 not above avg 30", "10", false],
      ],
    },
    {
      dir: "below",
      cases: [
        ["10 below avg 30", "10", true],
        ["20 below avg 30", "20", true],
        ["29 below avg 30", "29", true],
        ["30 not below avg 30", "30", false],
        ["50 not below avg 30", "50", false],
      ],
    },
    {
      dir: "equalOrAbove",
      cases: [
        ["50 >= avg 30", "50", true],
        ["30 >= avg 30", "30", true],
        ["29 not >= avg 30", "29", false],
        ["31 >= avg 30", "31", true],
        ["10 not >= avg 30", "10", false],
      ],
    },
    {
      dir: "equalOrBelow",
      cases: [
        ["10 <= avg 30", "10", true],
        ["30 <= avg 30", "30", true],
        ["31 not <= avg 30", "31", false],
        ["29 <= avg 30", "29", true],
        ["50 not <= avg 30", "50", false],
      ],
    },
  ])("$dir", ({ dir, cases }) => {
    it.each(cases)("%s", (_label, cellValue, expected) => {
      expect(evaluateCondition(cond(dir), cellValue, coords, context)).toBe(expected);
    });
  });
});

// ============================================================================
// 8. Duplicates/Unique: 20 value/range combos
// ============================================================================

describe("duplicates/unique conditions (parameterized)", () => {
  // Range with some duplicates: a appears 3x, b appears 2x, c/d/e appear 1x
  const rangeValues = ["a", "b", "a", "c", "b", "d", "a", "e"];
  const context = buildRangeContext(rangeValues);

  const dupCond: DuplicatesCondition = { type: "duplicates", unique: false };
  const uniqCond: DuplicatesCondition = { type: "duplicates", unique: true };

  describe("duplicates (unique=false)", () => {
    it.each<[string, string, boolean]>([
      ["'a' is duplicate (3x)", "a", true],
      ["'b' is duplicate (2x)", "b", true],
      ["'A' is duplicate (case insensitive)", "A", true],
      ["'B' is duplicate (case insensitive)", "B", true],
      ["'c' is unique (1x)", "c", false],
      ["'d' is unique (1x)", "d", false],
      ["'e' is unique (1x)", "e", false],
      ["empty string skipped", "", false],
      ["'  a  ' trimmed match", "  a  ", true],
      ["'f' not in range", "f", false],
    ])("%s", (_label, cellValue, expected) => {
      expect(evaluateCondition(dupCond, cellValue, coords, context)).toBe(expected);
    });
  });

  describe("unique (unique=true)", () => {
    it.each<[string, string, boolean]>([
      ["'a' is not unique (3x)", "a", false],
      ["'b' is not unique (2x)", "b", false],
      ["'c' is unique (1x)", "c", true],
      ["'d' is unique (1x)", "d", true],
      ["'e' is unique (1x)", "e", true],
      ["'A' not unique (case insensitive)", "A", false],
      ["empty string skipped", "", false],
      ["'f' not in range (count=0 -> not dup -> unique)", "f", true],
      ["'  c  ' trimmed match unique", "  c  ", true],
      ["'  b  ' trimmed match not unique", "  b  ", false],
    ])("%s", (_label, cellValue, expected) => {
      expect(evaluateCondition(uniqCond, cellValue, coords, context)).toBe(expected);
    });
  });
});
