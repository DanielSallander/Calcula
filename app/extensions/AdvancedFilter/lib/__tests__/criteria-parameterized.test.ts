//! FILENAME: app/extensions/AdvancedFilter/lib/__tests__/criteria-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for parseCriterion and matchesCriterion.

import { describe, it, expect, vi } from "vitest";

vi.mock("@api", () => ({
  getViewportCells: vi.fn(),
  updateCellsBatch: vi.fn(),
  setHiddenRows: vi.fn(),
  dispatchGridAction: vi.fn(),
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  indexToCol: vi.fn(),
  colToIndex: vi.fn(),
  setAdvancedFilterHiddenRows: vi.fn(),
  clearAdvancedFilterHiddenRows: vi.fn(),
}));

import { parseCriterion, matchesCriterion } from "../advancedFilterEngine";
import type { ParsedCriterion } from "../../types";

// ============================================================================
// parseCriterion - 80 parameterized cases
// ============================================================================

describe("parseCriterion", () => {
  // --- 6 operators x 5 value types = 30 ---
  describe("all operators x value types", () => {
    const operators = ["=", "<>", ">", "<", ">=", "<="] as const;
    const valueTypes: Array<{ label: string; input: string; expectedValue: string }> = [
      { label: "integer", input: "42", expectedValue: "42" },
      { label: "decimal", input: "3.14", expectedValue: "3.14" },
      { label: "negative number", input: "-100", expectedValue: "-100" },
      { label: "plain string", input: "Hello", expectedValue: "Hello" },
      { label: "date-like string", input: "2024-01-15", expectedValue: "2024-01-15" },
    ];

    const cases: Array<[string, string, typeof operators[number], string, boolean]> = [];
    for (const op of operators) {
      for (const vt of valueTypes) {
        const input = `${op}${vt.input}`;
        const hasWild = (op === "=" || op === "<>") && /[*?]/.test(vt.input);
        cases.push([`${op} + ${vt.label}`, input, op, vt.expectedValue, hasWild]);
      }
    }

    it.each(cases)(
      "%s: parseCriterion(%j) => op=%s val=%s wildcard=%s",
      (_label, input, expectedOp, expectedVal, expectedWild) => {
        const result = parseCriterion(input);
        expect(result.operator).toBe(expectedOp);
        expect(result.value).toBe(expectedVal);
        expect(result.hasWildcard).toBe(expectedWild);
      },
    );
  });

  // --- Wildcard patterns: 20 ---
  describe("wildcard patterns", () => {
    const wildcardCases: Array<[string, string, string, boolean]> = [
      ["star prefix", "*abc", "=", true],
      ["star suffix", "abc*", "=", true],
      ["star both", "*abc*", "=", true],
      ["question mark single", "a?c", "=", true],
      ["multiple questions", "a??c", "=", true],
      ["star and question", "a*b?c", "=", true],
      ["only star", "*", "=", true],
      ["only question", "?", "=", true],
      ["double star", "**", "=", true],
      ["star in middle", "ab*cd", "=", true],
      ["equals star prefix", "=*abc", "=", true],
      ["equals star suffix", "=abc*", "=", true],
      ["not-equal star", "<>*abc*", "<>", true],
      ["not-equal question", "<>a?b", "<>", true],
      ["greater with star (no wildcard)", ">a*b", ">", false],
      ["less with question (no wildcard)", "<a?b", "<", false],
      ["gte with star (no wildcard)", ">=x*", ">=", false],
      ["lte with question (no wildcard)", "<=y?", "<=", false],
      ["question at end", "test?", "=", true],
      ["complex pattern", "*test?value*", "=", true],
    ];

    it.each(wildcardCases)(
      "%s: parseCriterion(%j) => op=%s wildcard=%s",
      (_label, input, expectedOp, expectedWild) => {
        const result = parseCriterion(input);
        expect(result.operator).toBe(expectedOp);
        expect(result.hasWildcard).toBe(expectedWild);
      },
    );
  });

  // --- Edge cases: 30 ---
  describe("edge cases", () => {
    const edgeCases: Array<[string, string, string, string, boolean]> = [
      ["empty string", "", "=", "", false],
      ["single space", " ", "=", "", false],
      ["multiple spaces", "   ", "=", "", false],
      ["tab character", "\t", "=", "", false],
      ["equals only", "=", "=", "", false],
      ["not-equal only", "<>", "<>", "", false],
      ["greater-than only", ">", ">", "", false],
      ["less-than only", "<", "<", "", false],
      ["gte only", ">=", ">=", "", false],
      ["lte only", "<=", "<=", "", false],
      ["equals with spaces", "= hello ", "=", "hello", false],
      ["gt with spaces", "> 100 ", ">", "100", false],
      ["very long string", "=".concat("a".repeat(1000)), "=", "a".repeat(1000), false],
      ["special chars no wildcard", "=hello@world.com", "=", "hello@world.com", false],
      ["numeric-like with text", "=12abc", "=", "12abc", false],
      ["negative zero", "=-0", "=", "-0", false],
      ["infinity", "=Infinity", "=", "Infinity", false],
      ["NaN string", "=NaN", "=", "NaN", false],
      ["leading zeros", "=007", "=", "007", false],
      ["scientific notation", "=1e5", "=", "1e5", false],
      ["no operator plain text", "hello", "=", "hello", false],
      ["no operator number", "42", "=", "42", false],
      ["no operator negative", "-5", "=", "-5", false],
      ["unicode text", "=\u00e4\u00f6\u00fc", "=", "\u00e4\u00f6\u00fc", false],
      ["equals equals", "==", "=", "=", false],
      ["double less than", "<<", "<", "<", false],
      ["double greater than", ">>", ">", ">", false],
      ["gt then equals (not >=)", ">==", ">=", "=", false],
      ["boolean-like true", "=TRUE", "=", "TRUE", false],
      ["boolean-like false", "=FALSE", "=", "FALSE", false],
    ];

    it.each(edgeCases)(
      "%s: parseCriterion(%j) => op=%s val=%s wildcard=%s",
      (_label, input, expectedOp, expectedVal, expectedWild) => {
        const result = parseCriterion(input);
        expect(result.operator).toBe(expectedOp);
        expect(result.value).toBe(expectedVal);
        expect(result.hasWildcard).toBe(expectedWild);
      },
    );
  });
});

// ============================================================================
// matchesCriterion - 100 parameterized cases
// ============================================================================

function crit(operator: ParsedCriterion["operator"], value: string, hasWildcard = false): ParsedCriterion {
  return { operator, value, hasWildcard };
}

describe("matchesCriterion", () => {
  // --- Numeric comparisons: 40 ---
  describe("numeric comparisons", () => {
    const numericCases: Array<[string, string, ParsedCriterion, boolean]> = [
      // = operator
      ["10 = 10", "10", crit("=", "10"), true],
      ["10 = 20", "10", crit("=", "20"), false],
      ["0 = 0", "0", crit("=", "0"), true],
      ["-5 = -5", "-5", crit("=", "-5"), true],
      ["-5 = 5", "-5", crit("=", "5"), false],
      ["3.14 = 3.14", "3.14", crit("=", "3.14"), true],
      ["3.14 = 3.15", "3.14", crit("=", "3.15"), false],
      // <> operator
      ["10 <> 20", "10", crit("<>", "20"), true],
      ["10 <> 10", "10", crit("<>", "10"), false],
      ["0 <> 1", "0", crit("<>", "1"), true],
      ["-1 <> 1", "-1", crit("<>", "1"), true],
      // > operator
      ["20 > 10", "20", crit(">", "10"), true],
      ["10 > 20", "10", crit(">", "20"), false],
      ["10 > 10", "10", crit(">", "10"), false],
      ["-1 > -2", "-1", crit(">", "-2"), true],
      ["0.5 > 0.4", "0.5", crit(">", "0.4"), true],
      // < operator
      ["5 < 10", "5", crit("<", "10"), true],
      ["10 < 5", "10", crit("<", "5"), false],
      ["10 < 10", "10", crit("<", "10"), false],
      ["-3 < -1", "-3", crit("<", "-1"), true],
      ["0.1 < 0.2", "0.1", crit("<", "0.2"), true],
      // >= operator
      ["10 >= 10", "10", crit(">=", "10"), true],
      ["11 >= 10", "11", crit(">=", "10"), true],
      ["9 >= 10", "9", crit(">=", "10"), false],
      ["0 >= 0", "0", crit(">=", "0"), true],
      ["-1 >= -1", "-1", crit(">=", "-1"), true],
      // <= operator
      ["10 <= 10", "10", crit("<=", "10"), true],
      ["9 <= 10", "9", crit("<=", "10"), true],
      ["11 <= 10", "11", crit("<=", "10"), false],
      ["0 <= 0", "0", crit("<=", "0"), true],
      // Floating point edge cases
      ["100 > 99.99", "100", crit(">", "99.99"), true],
      ["99.99 < 100", "99.99", crit("<", "100"), true],
      ["1000000 = 1000000", "1000000", crit("=", "1000000"), true],
      ["-999 < 0", "-999", crit("<", "0"), true],
      ["0.001 > 0", "0.001", crit(">", "0"), true],
      // Boundary
      ["0 > -1", "0", crit(">", "-1"), true],
      ["0 < 1", "0", crit("<", "1"), true],
      ["-0.5 >= -0.5", "-0.5", crit(">=", "-0.5"), true],
      ["999 <= 999", "999", crit("<=", "999"), true],
      ["1.5 <> 1.6", "1.5", crit("<>", "1.6"), true],
    ];

    it.each(numericCases)(
      "%s: matchesCriterion(%j, criterion) => %s",
      (_label, cellValue, criterion, expected) => {
        expect(matchesCriterion(cellValue, criterion)).toBe(expected);
      },
    );
  });

  // --- String comparisons: 30 ---
  describe("string comparisons", () => {
    const stringCases: Array<[string, string, ParsedCriterion, boolean]> = [
      ["exact match", "hello", crit("=", "hello"), true],
      ["case insensitive match", "Hello", crit("=", "hello"), true],
      ["case insensitive match 2", "HELLO", crit("=", "hello"), true],
      ["no match", "hello", crit("=", "world"), false],
      ["not equal match", "hello", crit("<>", "world"), true],
      ["not equal same", "hello", crit("<>", "hello"), false],
      ["not equal case insensitive", "Hello", crit("<>", "hello"), false],
      ["string > comparison", "banana", crit(">", "apple"), true],
      ["string > no match", "apple", crit(">", "banana"), false],
      ["string < comparison", "apple", crit("<", "banana"), true],
      ["string < no match", "banana", crit("<", "apple"), false],
      ["string >= equal", "apple", crit(">=", "apple"), true],
      ["string >= greater", "banana", crit(">=", "apple"), true],
      ["string >= less", "apple", crit(">=", "banana"), false],
      ["string <= equal", "apple", crit("<=", "apple"), true],
      ["string <= less", "apple", crit("<=", "banana"), true],
      ["string <= greater", "banana", crit("<=", "apple"), false],
      ["empty cell = empty crit matches all", "", crit("=", ""), true],
      ["non-empty cell = empty crit matches all", "hello", crit("=", ""), true],
      ["empty cell = non-empty crit", "", crit("=", "hello"), false],
      ["empty cell <> non-empty", "", crit("<>", "hello"), true],
      ["whitespace handling", "  hello  ", crit("=", "hello"), true],
      ["mixed case sort", "Alpha", crit("<", "beta"), true],
      ["string with numbers", "abc123", crit("=", "abc123"), true],
      ["string with numbers not equal", "abc123", crit("<>", "abc456"), true],
      ["leading space trimmed", " test", crit("=", "test"), true],
      ["trailing space trimmed", "test ", crit("=", "test"), true],
      ["special characters", "@#$", crit("=", "@#$"), true],
      ["unicode strings", "\u00e4\u00f6\u00fc", crit("=", "\u00e4\u00f6\u00fc"), true],
      ["number-as-string vs number", "10", crit("=", "10"), true],
    ];

    it.each(stringCases)(
      "%s: matchesCriterion(%j, criterion) => %s",
      (_label, cellValue, criterion, expected) => {
        expect(matchesCriterion(cellValue, criterion)).toBe(expected);
      },
    );
  });

  // --- Wildcard matching: 30 ---
  describe("wildcard matching", () => {
    const wildcardCases: Array<[string, string, ParsedCriterion, boolean]> = [
      // Star wildcards
      ["star prefix match", "abcdef", crit("=", "*def", true), true],
      ["star prefix no match", "abcdef", crit("=", "*xyz", true), false],
      ["star suffix match", "abcdef", crit("=", "abc*", true), true],
      ["star suffix no match", "abcdef", crit("=", "xyz*", true), false],
      ["star both ends match", "abcdef", crit("=", "*cde*", true), true],
      ["star both ends no match", "abcdef", crit("=", "*xyz*", true), false],
      ["star matches everything", "anything", crit("=", "*", true), true],
      ["star matches empty", "", crit("=", "*", true), true],
      ["star in middle", "abcdef", crit("=", "ab*ef", true), true],
      ["star in middle no match", "abcdef", crit("=", "ab*xy", true), false],
      // Question mark wildcards
      ["question single char", "abc", crit("=", "a?c", true), true],
      ["question no match (too long)", "abbc", crit("=", "a?c", true), false],
      ["question no match (wrong char)", "axc", crit("=", "a?d", true), false],
      ["question at start", "xbc", crit("=", "?bc", true), true],
      ["question at end", "abx", crit("=", "ab?", true), true],
      ["multiple questions", "abcd", crit("=", "a??d", true), true],
      ["question matches single only", "ad", crit("=", "a?d", true), false],
      // Combined star and question
      ["star and question combo", "testing", crit("=", "t?st*", true), true],
      ["star and question no match", "failing", crit("=", "t?st*", true), false],
      ["question then star", "abcdef", crit("=", "?bc*", true), true],
      // Not-equal with wildcards
      ["<> star match (negated)", "abcdef", crit("<>", "*def", true), false],
      ["<> star no match (negated)", "abcdef", crit("<>", "*xyz", true), true],
      ["<> question match (negated)", "abc", crit("<>", "a?c", true), false],
      ["<> question no match (negated)", "axd", crit("<>", "a?c", true), true],
      // Case insensitivity
      ["wildcard case insensitive", "ABCDEF", crit("=", "*def*", true), true],
      ["wildcard case insensitive 2", "Hello", crit("=", "h?llo", true), true],
      // Edge patterns
      ["double star", "anything", crit("=", "**", true), true],
      ["only question no match empty", "", crit("=", "?", true), false],
      ["only question matches single", "x", crit("=", "?", true), true],
      ["complex pattern", "test_value_123", crit("=", "test*value*1?3", true), true],
    ];

    it.each(wildcardCases)(
      "%s: matchesCriterion(%j, criterion) => %s",
      (_label, cellValue, criterion, expected) => {
        expect(matchesCriterion(cellValue, criterion)).toBe(expected);
      },
    );
  });
});
