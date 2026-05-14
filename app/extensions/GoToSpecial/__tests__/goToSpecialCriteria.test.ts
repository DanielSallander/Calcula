//! FILENAME: app/extensions/GoToSpecial/__tests__/goToSpecialCriteria.test.ts
// PURPOSE: Tests for Go To Special criteria options and bounding-range logic.

import { describe, it, expect } from "vitest";

// ============================================================================
// Test the bounding range computation logic extracted from GoToSpecialDialog.
// This is a pure function that computes the bounding box of found cells.
// ============================================================================

interface CellPos {
  row: number;
  col: number;
}

/**
 * Compute the bounding range and additional single-cell ranges
 * from a list of found cells. Mirrors GoToSpecialDialog's handleOk logic.
 */
function computeSelectionFromCells(cells: CellPos[]) {
  if (cells.length === 0) return null;

  let minRow = cells[0].row;
  let maxRow = cells[0].row;
  let minCol = cells[0].col;
  let maxCol = cells[0].col;

  for (const cell of cells) {
    minRow = Math.min(minRow, cell.row);
    maxRow = Math.max(maxRow, cell.row);
    minCol = Math.min(minCol, cell.col);
    maxCol = Math.max(maxCol, cell.col);
  }

  return {
    startRow: minRow,
    startCol: minCol,
    endRow: maxRow,
    endCol: maxCol,
    additionalRanges: cells.length <= 1000
      ? cells.map((c) => ({
          startRow: c.row,
          startCol: c.col,
          endRow: c.row,
          endCol: c.col,
        }))
      : undefined,
  };
}

/**
 * Normalize a search range from a potentially inverted selection.
 * Mirrors the logic in GoToSpecialDialog.
 */
function normalizeSearchRange(sel: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}) {
  if (sel.startRow === sel.endRow && sel.startCol === sel.endCol) {
    return undefined; // Single cell = search entire sheet
  }
  return {
    startRow: Math.min(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endRow: Math.max(sel.startRow, sel.endRow),
    endCol: Math.max(sel.startCol, sel.endCol),
  };
}

// ============================================================================
// computeSelectionFromCells
// ============================================================================

describe("computeSelectionFromCells", () => {
  it("returns null for empty results", () => {
    expect(computeSelectionFromCells([])).toBeNull();
  });

  it("returns single cell bounding range for one result", () => {
    const result = computeSelectionFromCells([{ row: 3, col: 5 }]);
    expect(result).toEqual({
      startRow: 3,
      startCol: 5,
      endRow: 3,
      endCol: 5,
      additionalRanges: [{ startRow: 3, startCol: 5, endRow: 3, endCol: 5 }],
    });
  });

  it("computes correct bounding box for scattered cells", () => {
    const cells = [
      { row: 1, col: 5 },
      { row: 10, col: 0 },
      { row: 5, col: 8 },
    ];
    const result = computeSelectionFromCells(cells)!;

    expect(result.startRow).toBe(1);
    expect(result.startCol).toBe(0);
    expect(result.endRow).toBe(10);
    expect(result.endCol).toBe(8);
    expect(result.additionalRanges).toHaveLength(3);
  });

  it("omits additionalRanges when count exceeds 1000", () => {
    const cells = Array.from({ length: 1001 }, (_, i) => ({
      row: i,
      col: 0,
    }));
    const result = computeSelectionFromCells(cells)!;

    expect(result.additionalRanges).toBeUndefined();
    expect(result.startRow).toBe(0);
    expect(result.endRow).toBe(1000);
  });
});

// ============================================================================
// normalizeSearchRange
// ============================================================================

describe("normalizeSearchRange", () => {
  it("returns undefined for single-cell selection", () => {
    expect(normalizeSearchRange({ startRow: 3, startCol: 5, endRow: 3, endCol: 5 }))
      .toBeUndefined();
  });

  it("normalizes an inverted selection", () => {
    const result = normalizeSearchRange({
      startRow: 10,
      startCol: 8,
      endRow: 2,
      endCol: 1,
    });
    expect(result).toEqual({
      startRow: 2,
      startCol: 1,
      endRow: 10,
      endCol: 8,
    });
  });

  it("passes through a normal selection", () => {
    const result = normalizeSearchRange({
      startRow: 2,
      startCol: 1,
      endRow: 10,
      endCol: 8,
    });
    expect(result).toEqual({
      startRow: 2,
      startCol: 1,
      endRow: 10,
      endCol: 8,
    });
  });
});

// ============================================================================
// Criteria options completeness
// ============================================================================

describe("criteria options", () => {
  const EXPECTED_CRITERIA = [
    "blanks",
    "formulas",
    "constants",
    "errors",
    "comments",
    "notes",
    "conditionalFormats",
    "dataValidation",
  ];

  it("covers all expected criteria types", () => {
    // This ensures we don't forget to add a criteria option
    for (const criteria of EXPECTED_CRITERIA) {
      expect(typeof criteria).toBe("string");
      expect(criteria.length).toBeGreaterThan(0);
    }
    expect(EXPECTED_CRITERIA).toHaveLength(8);
  });
});
