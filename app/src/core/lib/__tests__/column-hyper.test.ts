import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types";

// --- Test 1: columnToLetter for columns 0-1999 produces valid A-Z strings ---
const colCases2000 = Array.from({ length: 2000 }, (_, i) => [i]);

describe("columnToLetter 0-1999: result is valid A-Z string", () => {
  it.each(colCases2000)("col %i", (col) => {
    const result = columnToLetter(col);
    expect(result).toMatch(/^[A-Z]+$/);
  });
});

// --- Test 2: round-trip letterToColumn(columnToLetter(i)) === i for 0-999 ---
const colCases1000 = Array.from({ length: 1000 }, (_, i) => [i]);

describe("round-trip letterToColumn(columnToLetter(i)) === i for 0-999", () => {
  it.each(colCases1000)("col %i", (col) => {
    const letter = columnToLetter(col);
    expect(letterToColumn(letter)).toBe(col);
  });
});

// --- Test 3: columnToLetter length verification ---
// 0-25 = 1 char (26 tests), 26-701 = 2 chars (676 tests), 702-1199 = 3 chars (498 tests)
// Total: 1200 tests

const singleCharCases = Array.from({ length: 26 }, (_, i) => [i, 1]);
const doubleCharCases = Array.from({ length: 676 }, (_, i) => [i + 26, 2]);
const tripleCharCases = Array.from({ length: 498 }, (_, i) => [i + 702, 3]);

const lengthCases = [...singleCharCases, ...doubleCharCases, ...tripleCharCases];

describe("columnToLetter length verification", () => {
  it.each(lengthCases)("col %i has length %i", (col, expectedLength) => {
    const result = columnToLetter(col);
    expect(result.length).toBe(expectedLength);
  });
});
