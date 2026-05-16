/**
 * FILENAME: app/src/core/lib/__tests__/scroll-ultra.test.ts
 * PURPOSE: Ultra-massive parameterized tests for scroll utilities and column conversion.
 * TARGET: 2500+ tests via programmatic it.each arrays.
 */

import { describe, it, expect } from "vitest";
import { getColumnXPosition, getRowYPosition, SCROLLBAR_WIDTH, SCROLLBAR_HEIGHT, scrollToVisibleRange } from "../scrollUtils";
import { columnToLetter, letterToColumn } from "../../types/types";
import type { GridConfig } from "../../types";

// ---------------------------------------------------------------------------
// Shared config: default 100px width, 25px height
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
// 1. getColumnXPosition for columns 0-499 (500 tests)
// ===========================================================================
const colXCases: [number, number][] = Array.from({ length: 500 }, (_, i) => [i, i * 100]);

describe("getColumnXPosition: columns 0-499 default width", () => {
  it.each(colXCases)("col %i => x = %i", (col, expectedX) => {
    expect(getColumnXPosition(col, defaultConfig)).toBe(expectedX);
  });
});

// ===========================================================================
// 2. getRowYPosition for rows 0-499 (500 tests)
// ===========================================================================
const rowYCases: [number, number][] = Array.from({ length: 500 }, (_, i) => [i, i * 25]);

describe("getRowYPosition: rows 0-499 default height", () => {
  it.each(rowYCases)("row %i => y = %i", (row, expectedY) => {
    expect(getRowYPosition(row, defaultConfig)).toBe(expectedY);
  });
});

// ===========================================================================
// 3. columnToLetter for columns 0-499 (500 tests)
//    Verify length and format: 0-25 => 1 char, 26-701 => 2 chars
// ===========================================================================
function expectedColumnLetter(col: number): string {
  let result = "";
  let c = col;
  while (c >= 0) {
    result = String.fromCharCode((c % 26) + 65) + result;
    c = Math.floor(c / 26) - 1;
  }
  return result;
}

const colLetterCases: [number, string][] = Array.from({ length: 500 }, (_, i) => [i, expectedColumnLetter(i)]);

describe("columnToLetter: columns 0-499", () => {
  it.each(colLetterCases)("col %i => '%s'", (col, expected) => {
    const result = columnToLetter(col);
    expect(result).toBe(expected);
    // Verify length: 1 char for 0-25, 2 chars for 26-701
    if (col <= 25) {
      expect(result.length).toBe(1);
    } else {
      expect(result.length).toBe(2);
    }
    // Verify all uppercase
    expect(result).toMatch(/^[A-Z]+$/);
  });
});

// ===========================================================================
// 4. letterToColumn round-trip for columns 0-499 (500 tests)
// ===========================================================================
const roundTripCases: [number][] = Array.from({ length: 500 }, (_, i) => [i]);

describe("letterToColumn round-trip: columns 0-499", () => {
  it.each(roundTripCases)("col %i => letter => col %i", (col) => {
    const letter = columnToLetter(col);
    const back = letterToColumn(letter);
    expect(back).toBe(col);
  });
});

// ===========================================================================
// 5. scrollToVisibleRange: 500 different scroll/viewport combos (500 tests)
// ===========================================================================
interface ScrollTestCase {
  scrollX: number;
  scrollY: number;
  vpWidth: number;
  vpHeight: number;
  expectedStartCol: number;
  expectedStartRow: number;
  expectedOffsetX: number;
  expectedOffsetY: number;
}

const scrollCases: ScrollTestCase[] = Array.from({ length: 500 }, (_, i) => {
  const scrollX = i * 50; // 0, 50, 100, ...
  const scrollY = i * 10; // 0, 10, 20, ...
  const vpWidth = 800;
  const vpHeight = 600;

  const expectedStartCol = Math.floor(scrollX / 100);
  const expectedStartRow = Math.floor(scrollY / 25);
  const expectedOffsetX = -(scrollX % 100);
  const expectedOffsetY = -(scrollY % 25);

  return {
    scrollX,
    scrollY,
    vpWidth,
    vpHeight,
    expectedStartCol,
    expectedStartRow,
    expectedOffsetX,
    expectedOffsetY,
  };
});

describe("scrollToVisibleRange: 500 scroll/viewport combos", () => {
  it.each(scrollCases)(
    "scroll($scrollX, $scrollY) vp($vpWidth x $vpHeight)",
    ({ scrollX, scrollY, vpWidth, vpHeight, expectedStartCol, expectedStartRow, expectedOffsetX, expectedOffsetY }) => {
      const result = scrollToVisibleRange(scrollX, scrollY, defaultConfig, vpWidth, vpHeight);
      expect(result.startCol).toBe(expectedStartCol);
      expect(result.startRow).toBe(expectedStartRow);
      expect(result.offsetX).toBe(expectedOffsetX);
      expect(result.offsetY).toBe(expectedOffsetY);

      // endCol and endRow must be >= start
      expect(result.endCol).toBeGreaterThanOrEqual(result.startCol);
      expect(result.endRow).toBeGreaterThanOrEqual(result.startRow);

      // Verify endCol calculation
      const availableWidth = vpWidth - defaultConfig.rowHeaderWidth - SCROLLBAR_WIDTH;
      const visibleCols = Math.ceil(availableWidth / 100) + 1;
      expect(result.endCol).toBe(Math.min(expectedStartCol + visibleCols, defaultConfig.totalCols - 1));

      // Verify endRow calculation
      const availableHeight = vpHeight - defaultConfig.colHeaderHeight - SCROLLBAR_HEIGHT;
      const visibleRows = Math.ceil(availableHeight / 25) + 1;
      expect(result.endRow).toBe(Math.min(expectedStartRow + visibleRows, defaultConfig.totalRows - 1));
    }
  );
});
