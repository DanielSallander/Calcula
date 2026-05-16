/**
 * FILENAME: app/src/core/lib/__tests__/scroll-titan.test.ts
 * PURPOSE: Titan-scale parameterized tests for scroll and column utilities.
 * TARGET: 12000+ tests via programmatic it.each arrays.
 */

import { describe, it, expect } from "vitest";
import { getColumnXPosition, getRowYPosition } from "../scrollUtils";
import { columnToLetter, letterToColumn } from "../../types";
import type { GridConfig } from "../../types";

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------
const defaultConfig: GridConfig = {
  defaultCellWidth: 100,
  defaultCellHeight: 25,
  rowHeaderWidth: 50,
  colHeaderHeight: 30,
  totalRows: 1_048_576,
  totalCols: 16_384,
  minColumnWidth: 20,
  minRowHeight: 10,
  outlineBarWidth: 0,
};

// ===========================================================================
// 1. getColumnXPosition for columns 0-3999 (4000 tests)
// ===========================================================================
const colXCases: [number, number][] = Array.from({ length: 4000 }, (_, i) => [
  i,
  i * 100,
]);

describe("getColumnXPosition 0-3999", () => {
  it.each(colXCases)("col %i -> %i px", (col, expected) => {
    expect(getColumnXPosition(col, defaultConfig)).toBe(expected);
  });
});

// ===========================================================================
// 2. getRowYPosition for rows 0-3999 (4000 tests)
// ===========================================================================
const rowYCases: [number, number][] = Array.from({ length: 4000 }, (_, i) => [
  i,
  i * 25,
]);

describe("getRowYPosition 0-3999", () => {
  it.each(rowYCases)("row %i -> %i px", (row, expected) => {
    expect(getRowYPosition(row, defaultConfig)).toBe(expected);
  });
});

// ===========================================================================
// 3. columnToLetter round-trip for columns 2000-5999 (4000 tests)
// ===========================================================================
const colLetterCases: number[] = Array.from({ length: 4000 }, (_, i) => 2000 + i);

describe("columnToLetter round-trip 2000-5999", () => {
  it.each(colLetterCases)("col %i round-trips through letter conversion", (col) => {
    const letter = columnToLetter(col);
    expect(typeof letter).toBe("string");
    expect(letter.length).toBeGreaterThan(0);
    expect(letterToColumn(letter)).toBe(col);
  });
});
