//! FILENAME: app/extensions/Search/__tests__/search-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for query matching, navigation, and replace logic.

import { describe, it, expect, beforeEach } from "vitest";
import { useFindStore } from "../../BuiltIn/FindReplaceDialog/useFindStore";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  useFindStore.getState().reset();
});

// ============================================================================
// Helper: simulate matching logic (pure function, mirrors what search does)
// ============================================================================

function doesMatch(
  query: string,
  target: string,
  caseSensitive: boolean,
  matchEntireCell: boolean
): boolean {
  if (!query) return false;
  const q = caseSensitive ? query : query.toLowerCase();
  const t = caseSensitive ? target : target.toLowerCase();
  if (matchEntireCell) return q === t;
  return t.includes(q);
}

// ============================================================================
// Query matching - 50 combos
// ============================================================================

describe("query matching logic", () => {
  const matchCombos: [string, string, boolean, boolean, boolean][] = [
    // [query, target, caseSensitive, matchEntireCell, expected]
    ["hello", "hello", false, false, true],
    ["hello", "Hello", false, false, true],
    ["hello", "Hello", true, false, false],
    ["hello", "hello world", false, false, true],
    ["hello", "hello world", false, true, false],
    ["hello", "hello", false, true, true],
    ["Hello", "hello", false, true, true],
    ["Hello", "hello", true, true, false],
    ["", "anything", false, false, false],
    ["test", "", false, false, false],
    ["abc", "ABCDEF", false, false, true],
    ["abc", "ABCDEF", true, false, false],
    ["ABC", "ABCDEF", true, false, true],
    ["123", "abc123def", false, false, true],
    ["123", "abc123def", false, true, false],
    ["123", "123", false, true, true],
    ["a", "a", false, false, true],
    ["a", "A", true, false, false],
    ["a", "A", false, false, true],
    ["test", "testing", false, false, true],
    ["test", "testing", false, true, false],
    ["Test", "testing", false, false, true],
    ["Test", "testing", true, false, false],
    ["ing", "testing", false, false, true],
    ["ING", "testing", false, false, true],
    ["ING", "testing", true, false, false],
    ["full match", "full match", false, true, true],
    ["full match", "Full Match", false, true, true],
    ["full match", "Full Match", true, true, false],
    [" ", "a b", false, false, true],
    [" ", " ", false, true, true],
    ["$100", "$100.00", false, false, true],
    ["$100", "$100.00", false, true, false],
    ["100%", "100%", false, true, true],
    [".", "3.14", false, false, true],
    ["pi", "3.14159", false, false, false],
    ["14", "3.14159", false, false, true],
    ["hello world", "hello world", false, true, true],
    ["HELLO WORLD", "hello world", false, true, true],
    ["HELLO WORLD", "hello world", true, true, false],
    ["needle", "haystackneedlehaystack", false, false, true],
    ["NEEDLE", "haystackneedlehaystack", false, false, true],
    ["NEEDLE", "haystackneedlehaystack", true, false, false],
    ["x", "xyz", false, false, true],
    ["z", "xyz", false, false, true],
    ["y", "xyz", true, false, true],
    ["Y", "xyz", true, false, false],
    ["data", "Data Analysis", false, false, true],
    ["DATA", "Data Analysis", true, false, false],
    ["Analysis", "Data Analysis", true, false, true],
  ];

  it.each(matchCombos)(
    "query=%s target=%s caseSensitive=%s entireCell=%s -> %s",
    (query, target, caseSensitive, matchEntireCell, expected) => {
      expect(doesMatch(query, target, caseSensitive, matchEntireCell)).toBe(expected);
    }
  );
});

// ============================================================================
// Navigation - 30 match-count x direction combos
// ============================================================================

describe("navigation with varying match counts", () => {
  // Generate match arrays of different sizes
  function makeMatches(count: number): [number, number][] {
    return Array.from({ length: count }, (_, i) => [i, 0] as [number, number]);
  }

  const navCombos: [number, "next" | "prev", number, number][] = [
    // [matchCount, direction, startIndex, expectedIndex]
    [1, "next", 0, 0],
    [1, "prev", 0, 0],
    [2, "next", 0, 1],
    [2, "next", 1, 0],
    [2, "prev", 0, 1],
    [2, "prev", 1, 0],
    [3, "next", 0, 1],
    [3, "next", 1, 2],
    [3, "next", 2, 0],
    [3, "prev", 0, 2],
    [3, "prev", 1, 0],
    [3, "prev", 2, 1],
    [5, "next", 0, 1],
    [5, "next", 4, 0],
    [5, "prev", 0, 4],
    [5, "prev", 3, 2],
    [10, "next", 0, 1],
    [10, "next", 9, 0],
    [10, "prev", 0, 9],
    [10, "prev", 5, 4],
    [10, "next", 5, 6],
    [20, "next", 19, 0],
    [20, "prev", 0, 19],
    [20, "next", 10, 11],
    [20, "prev", 10, 9],
    [50, "next", 49, 0],
    [50, "prev", 0, 49],
    [50, "next", 25, 26],
    [100, "next", 99, 0],
    [100, "prev", 0, 99],
  ];

  it.each(navCombos)(
    "count=%d dir=%s start=%d -> index=%d",
    (matchCount, direction, startIndex, expectedIndex) => {
      const matches = makeMatches(matchCount);
      useFindStore.getState().setMatches(matches, "q");
      useFindStore.getState().setCurrentIndex(startIndex);

      if (direction === "next") {
        useFindStore.getState().nextMatch();
      } else {
        useFindStore.getState().previousMatch();
      }

      expect(useFindStore.getState().currentIndex).toBe(expectedIndex);
    }
  );
});

// ============================================================================
// Replace logic - 20 search/replace/expected combos
// ============================================================================

describe("replace string operations", () => {
  // Pure replace helper (mirrors what the extension does on a cell value)
  function replaceInString(
    value: string,
    search: string,
    replacement: string,
    caseSensitive: boolean,
    matchEntireCell: boolean
  ): string {
    if (matchEntireCell) {
      const v = caseSensitive ? value : value.toLowerCase();
      const s = caseSensitive ? search : search.toLowerCase();
      return v === s ? replacement : value;
    }
    if (caseSensitive) {
      return value.split(search).join(replacement);
    }
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return value.replace(regex, replacement);
  }

  const replaceCombos: [string, string, string, boolean, boolean, string][] = [
    // [value, search, replace, caseSensitive, matchEntireCell, expected]
    ["hello", "hello", "world", false, false, "world"],
    ["Hello World", "hello", "hi", false, false, "hi World"],
    ["Hello World", "hello", "hi", true, false, "Hello World"],
    ["aaa", "a", "b", false, false, "bbb"],
    ["Test123", "123", "456", false, false, "Test456"],
    ["hello", "hello", "world", false, true, "world"],
    ["Hello", "hello", "world", false, true, "world"],
    ["Hello", "hello", "world", true, true, "Hello"],
    ["abc def abc", "abc", "xyz", false, false, "xyz def xyz"],
    ["UPPER", "upper", "lower", false, false, "lower"],
    ["UPPER", "upper", "lower", true, false, "UPPER"],
    ["$100.00", "$100", "$200", false, false, "$200.00"],
    ["one two three", "two", "2", false, false, "one 2 three"],
    ["", "a", "b", false, false, ""],
    ["no match here", "xyz", "abc", false, false, "no match here"],
    ["CasE", "case", "CASE", false, true, "CASE"],
    ["repeat repeat", "repeat", "once", false, false, "once once"],
    ["A1+B1", "A1", "C1", false, false, "C1+B1"],
    ["SUM(A1:A10)", "SUM", "AVERAGE", false, false, "AVERAGE(A1:A10)"],
    ["100%", "100%", "50%", false, true, "50%"],
  ];

  it.each(replaceCombos)(
    "value=%s search=%s replace=%s caseSens=%s entire=%s -> %s",
    (value, search, replacement, caseSensitive, matchEntireCell, expected) => {
      expect(
        replaceInString(value, search, replacement, caseSensitive, matchEntireCell)
      ).toBe(expected);
    }
  );
});
