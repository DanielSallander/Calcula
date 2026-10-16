//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotCellNavigation.test.ts
// PURPOSE: One arrow step inside a canvas pivot box (D-CELLS, WP-A S5): a
//          vertical step skips HIDDEN rows (height 0: a collapsed group, a
//          filtered row), every step clamps at the view's edges.

import { describe, it, expect } from "vitest";
import { stepPivotCell } from "../pivotCellNavigation";

/** 8 rows x 4 columns; rows 2, 3 and 6 hidden. */
const g = { rowCount: 8, colCount: 4, rowHeights: [24, 24, 0, 0, 24, 24, 0, 24] };

describe("stepPivotCell", () => {
  it("down and up skip hidden rows", () => {
    expect(stepPivotCell(g, 1, 2, "down")).toEqual({ row: 4, col: 2 });
    expect(stepPivotCell(g, 4, 2, "up")).toEqual({ row: 1, col: 2 });
    expect(stepPivotCell(g, 5, 0, "down")).toEqual({ row: 7, col: 0 });
    expect(stepPivotCell(g, 7, 0, "up")).toEqual({ row: 5, col: 0 });
  });

  it("a plain step moves one row or column", () => {
    expect(stepPivotCell(g, 0, 0, "down")).toEqual({ row: 1, col: 0 });
    expect(stepPivotCell(g, 4, 1, "right")).toEqual({ row: 4, col: 2 });
    expect(stepPivotCell(g, 4, 1, "left")).toEqual({ row: 4, col: 0 });
  });

  it("edges clamp: no step past the first/last row or column", () => {
    expect(stepPivotCell(g, 0, 0, "up")).toEqual({ row: 0, col: 0 });
    expect(stepPivotCell(g, 7, 3, "down")).toEqual({ row: 7, col: 3 });
    expect(stepPivotCell(g, 2, 0, "left")).toEqual({ row: 2, col: 0 });
    expect(stepPivotCell(g, 2, 3, "right")).toEqual({ row: 2, col: 3 });
  });

  it("no visible row in that direction: it stays put", () => {
    const tail = { rowCount: 4, colCount: 2, rowHeights: [24, 24, 0, 0] };
    expect(stepPivotCell(tail, 1, 1, "down")).toEqual({ row: 1, col: 1 });
    const head = { rowCount: 4, colCount: 2, rowHeights: [0, 0, 24, 24] };
    expect(stepPivotCell(head, 2, 0, "up")).toEqual({ row: 2, col: 0 });
  });

  it("a start outside the view is clamped into it first; an empty view answers (0, 0)", () => {
    expect(stepPivotCell(g, 50, 9, "left")).toEqual({ row: 7, col: 2 });
    expect(stepPivotCell({ rowCount: 0, colCount: 0, rowHeights: [] }, 3, 3, "down")).toEqual({ row: 0, col: 0 });
  });
});
