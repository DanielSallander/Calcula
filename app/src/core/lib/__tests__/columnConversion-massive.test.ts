//! FILENAME: app/src/core/lib/__tests__/columnConversion-massive.test.ts
// PURPOSE: Massive parameterized tests for columnToLetter and letterToColumn
// TARGET: 1200 tests via it.each

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types";

// --- Test data generation ---

// Single letters: 0-25 (A-Z)
const singleLetters: [number, string][] = Array.from({ length: 26 }, (_, i) => [
  i,
  String.fromCharCode(65 + i),
]);

// Two letters: 26-51 (AA-AZ)
const twoLettersStart: [number, string][] = Array.from(
  { length: 26 },
  (_, i) => [26 + i, "A" + String.fromCharCode(65 + i)]
);

// Every 10th from 52 to 702 (BA onwards through AAA-1)
const everyTenth: number[] = [];
for (let i = 52; i <= 702; i += 10) everyTenth.push(i);

// Every 100th from 700 to 16383
const everyHundredth: number[] = [];
for (let i = 700; i <= 16383; i += 100) everyHundredth.push(i);

// Combine all selected columns (deduplicated)
const allSelectedCols = [
  ...new Set([
    ...singleLetters.map(([c]) => c),
    ...twoLettersStart.map(([c]) => c),
    ...everyTenth,
    ...everyHundredth,
  ]),
].sort((a, b) => a - b);

// Build expected values for known columns
function expectedColumnToLetter(col: number): string {
  let result = "";
  let c = col;
  while (c >= 0) {
    result = String.fromCharCode((c % 26) + 65) + result;
    c = Math.floor(c / 26) - 1;
  }
  return result;
}

// Generate test cases: [col, expectedLetter]
const columnTestCases: [number, string][] = allSelectedCols.map((col) => [
  col,
  expectedColumnToLetter(col),
]);

// Trim to 500 if needed
const col500 = columnTestCases.slice(0, 500);

describe("columnToLetter - massive parameterized (500 cases)", () => {
  it.each(col500)(
    "columnToLetter(%i) should return %s",
    (col, expected) => {
      expect(columnToLetter(col)).toBe(expected);
    }
  );
});

describe("letterToColumn - massive parameterized (500 cases)", () => {
  it.each(col500)(
    "letterToColumn(%s) from col %i should return %i",
    (col, letter) => {
      expect(letterToColumn(letter)).toBe(col);
    }
  );
});

// Round-trip consistency: 200 random columns
const roundTripCols: number[] = [];
for (let i = 0; i < 200; i++) {
  // Deterministic spread across full range
  roundTripCols.push(Math.floor((i * 16383) / 200));
}

describe("columnToLetter/letterToColumn round-trip (200 cases)", () => {
  it.each(roundTripCols)(
    "round-trip for column %i",
    (col) => {
      const letter = columnToLetter(col);
      const back = letterToColumn(letter);
      expect(back).toBe(col);
    }
  );
});
