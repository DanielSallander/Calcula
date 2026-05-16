//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/__tests__/bookmark-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for bookmark CRUD, colors, and cell ref formatting.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @api to avoid pulling in heavy dependencies.
vi.mock("@api", () => ({
  columnToLetter(col: number): string {
    let result = "";
    let c = col;
    while (c >= 0) {
      result = String.fromCharCode((c % 26) + 65) + result;
      c = Math.floor(c / 26) - 1;
    }
    return result;
  },
}));

import {
  addBookmark,
  removeAllBookmarks,
  getBookmarkAt,
  setCurrentSheet,
} from "../bookmarkStore";
import type { BookmarkColor } from "../bookmarkTypes";
import { BOOKMARK_COLORS } from "../bookmarkTypes";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  removeAllBookmarks();
  setCurrentSheet(0);
});

// ============================================================================
// addBookmark - 50 cell positions
// ============================================================================

describe("addBookmark at various positions", () => {
  const positions: [number, number, number, string][] = [
    [0, 0, 0, "Sheet1"],
    [0, 1, 0, "Sheet1"],
    [0, 25, 0, "Sheet1"],
    [0, 26, 0, "Sheet1"],
    [1, 0, 0, "Sheet1"],
    [5, 5, 0, "Sheet1"],
    [10, 0, 0, "Sheet1"],
    [10, 10, 0, "Sheet1"],
    [99, 0, 0, "Sheet1"],
    [99, 99, 0, "Sheet1"],
    [100, 0, 0, "Sheet1"],
    [255, 0, 0, "Sheet1"],
    [255, 255, 0, "Sheet1"],
    [999, 0, 0, "Sheet1"],
    [999, 999, 0, "Sheet1"],
    [0, 0, 1, "Sheet2"],
    [0, 0, 2, "Sheet3"],
    [5, 3, 1, "Sheet2"],
    [10, 10, 2, "Sheet3"],
    [50, 50, 0, "Sheet1"],
    [1000, 0, 0, "Sheet1"],
    [0, 100, 0, "Sheet1"],
    [0, 200, 0, "Sheet1"],
    [0, 255, 0, "Sheet1"],
    [0, 256, 0, "Sheet1"],
    [500, 100, 0, "Sheet1"],
    [1, 1, 1, "Data"],
    [2, 2, 2, "Summary"],
    [3, 3, 0, "Sheet1"],
    [4, 4, 0, "Sheet1"],
    [7, 7, 0, "Sheet1"],
    [8, 8, 0, "Sheet1"],
    [9, 9, 0, "Sheet1"],
    [15, 0, 0, "Sheet1"],
    [20, 5, 0, "Sheet1"],
    [25, 10, 0, "Sheet1"],
    [30, 15, 0, "Sheet1"],
    [35, 20, 0, "Sheet1"],
    [40, 25, 0, "Sheet1"],
    [45, 0, 0, "Sheet1"],
    [50, 0, 0, "Sheet1"],
    [55, 0, 0, "Sheet1"],
    [60, 0, 0, "Sheet1"],
    [65, 0, 0, "Sheet1"],
    [70, 0, 0, "Sheet1"],
    [75, 5, 0, "Sheet1"],
    [80, 10, 0, "Sheet1"],
    [85, 15, 0, "Sheet1"],
    [90, 20, 0, "Sheet1"],
    [95, 25, 0, "Sheet1"],
  ];

  it.each(positions)(
    "adds bookmark at row=%d col=%d sheet=%d (%s)",
    (row, col, sheetIndex, sheetName) => {
      const bm = addBookmark(row, col, sheetIndex, sheetName);
      expect(bm.row).toBe(row);
      expect(bm.col).toBe(col);
      expect(bm.sheetIndex).toBe(sheetIndex);
      expect(bm.sheetName).toBe(sheetName);
      expect(bm.id).toBeTruthy();

      const found = getBookmarkAt(row, col, sheetIndex);
      expect(found).toBeDefined();
      expect(found!.id).toBe(bm.id);
    }
  );
});

// ============================================================================
// Colors x positions - 60 tests (6 colors x 10 positions)
// ============================================================================

describe("addBookmark with colors", () => {
  const colorPositions: [BookmarkColor, number, number][] = [];
  const samplePositions: [number, number][] = [
    [0, 0], [1, 1], [2, 2], [5, 5], [10, 10],
    [0, 25], [25, 0], [50, 50], [99, 99], [100, 100],
  ];

  for (const color of BOOKMARK_COLORS) {
    for (const [row, col] of samplePositions) {
      colorPositions.push([color, row, col]);
    }
  }

  it.each(colorPositions)(
    "color=%s at row=%d col=%d",
    (color, row, col) => {
      const bm = addBookmark(row, col, 0, "Sheet1", { color });
      expect(bm.color).toBe(color);
      expect(bm.row).toBe(row);
      expect(bm.col).toBe(col);
    }
  );
});

// ============================================================================
// formatCellRef via bookmark label - 40 row/col combos
// ============================================================================

describe("bookmark default label (formatCellRef)", () => {
  const refCombos: [number, number, string][] = [
    [0, 0, "A1"],
    [0, 1, "B1"],
    [0, 2, "C1"],
    [0, 25, "Z1"],
    [0, 26, "AA1"],
    [0, 27, "AB1"],
    [0, 51, "AZ1"],
    [0, 52, "BA1"],
    [0, 255, "IV1"],
    [0, 256, "IW1"],
    [1, 0, "A2"],
    [2, 0, "A3"],
    [9, 0, "A10"],
    [99, 0, "A100"],
    [999, 0, "A1000"],
    [0, 701, "ZZ1"],
    [0, 702, "AAA1"],
    [1, 1, "B2"],
    [2, 2, "C3"],
    [3, 3, "D4"],
    [4, 4, "E5"],
    [5, 5, "F6"],
    [6, 6, "G7"],
    [7, 7, "H8"],
    [8, 8, "I9"],
    [9, 9, "J10"],
    [10, 0, "A11"],
    [10, 1, "B11"],
    [10, 2, "C11"],
    [10, 3, "D11"],
    [10, 25, "Z11"],
    [10, 26, "AA11"],
    [49, 0, "A50"],
    [49, 49, "AX50"],
    [99, 25, "Z100"],
    [99, 26, "AA100"],
    [199, 0, "A200"],
    [199, 51, "AZ200"],
    [499, 0, "A500"],
    [999, 25, "Z1000"],
  ];

  it.each(refCombos)(
    "row=%d col=%d -> label=%s",
    (row, col, expectedLabel) => {
      setCurrentSheet(0);
      const bm = addBookmark(row, col, 0, "Sheet1");
      expect(bm.label).toBe(expectedLabel);
    }
  );
});
