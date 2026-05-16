//! FILENAME: app/src/core/lib/gridRenderer/rendering/grid-merge.test.ts
// PURPOSE: Deep tests for isLineInsideMerge - complex patterns, adjacency, boundaries.

import { describe, it, expect } from "vitest";
import { isLineInsideMerge } from "./grid";

type CellMap = Map<string, { rowSpan?: number; colSpan?: number }>;

function makeCells(
  entries: Array<[row: number, col: number, rowSpan: number, colSpan: number]>,
): CellMap {
  const map: CellMap = new Map();
  for (const [r, c, rs, cs] of entries) {
    map.set(`${r},${c}`, { rowSpan: rs, colSpan: cs });
  }
  return map;
}

// ============================================================================
// Single-cell "merge" (1x1)
// ============================================================================

describe("1x1 merge (no actual spanning)", () => {
  const cells = makeCells([[5, 5, 1, 1]]);

  it("vertical line not suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 5, 5, 5)).toBe(false);
    expect(isLineInsideMerge(cells, "vertical", 6, 5, 5)).toBe(false);
  });

  it("horizontal line not suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 5, 5, 5)).toBe(false);
    expect(isLineInsideMerge(cells, "horizontal", 6, 5, 5)).toBe(false);
  });
});

// ============================================================================
// Merge at row 0 / col 0
// ============================================================================

describe("merge at origin (0,0)", () => {
  const cells = makeCells([[0, 0, 3, 4]]); // rows 0-2, cols 0-3

  it("vertical lines inside are suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 1, 0, 2)).toBe(true);
    expect(isLineInsideMerge(cells, "vertical", 2, 0, 2)).toBe(true);
    expect(isLineInsideMerge(cells, "vertical", 3, 0, 2)).toBe(true);
  });

  it("vertical line at col 0 (left edge) is NOT suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 0, 0, 2)).toBe(false);
  });

  it("vertical line at col 4 (right boundary) is NOT suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 4, 0, 2)).toBe(false);
  });

  it("horizontal lines inside are suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 1, 0, 3)).toBe(true);
    expect(isLineInsideMerge(cells, "horizontal", 2, 0, 3)).toBe(true);
  });

  it("horizontal line at row 0 (top edge) is NOT suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 0, 0, 3)).toBe(false);
  });

  it("horizontal line at row 3 (bottom boundary) is NOT suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 3, 0, 3)).toBe(false);
  });
});

// ============================================================================
// Merge at large row/col (boundary test)
// ============================================================================

describe("merge at large indices", () => {
  const cells = makeCells([[99998, 16383, 2, 2]]); // rows 99998-99999, cols 16383-16384

  it("vertical line inside large-index merge is suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 16384, 99998, 99999)).toBe(true);
  });

  it("vertical line outside is not suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 16383, 99998, 99999)).toBe(false);
    expect(isLineInsideMerge(cells, "vertical", 16385, 99998, 99999)).toBe(false);
  });

  it("horizontal line inside large-index merge is suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 99999, 16383, 16384)).toBe(true);
  });

  it("horizontal line outside is not suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 99998, 16383, 16384)).toBe(false);
    expect(isLineInsideMerge(cells, "horizontal", 100000, 16383, 16384)).toBe(false);
  });
});

// ============================================================================
// 100x100 merge
// ============================================================================

describe("large merge: 100 rows x 100 columns", () => {
  const cells = makeCells([[10, 10, 100, 100]]); // rows 10-109, cols 10-109

  it("vertical line at col 11 (just inside left) is suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 11, 10, 109)).toBe(true);
  });

  it("vertical line at col 109 (last inside) is suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 109, 10, 109)).toBe(true);
  });

  it("vertical line at col 55 (middle) is suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 55, 50, 60)).toBe(true);
  });

  it("vertical line at col 10 (left edge) is NOT suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 10, 10, 109)).toBe(false);
  });

  it("vertical line at col 110 (right boundary) is NOT suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 110, 10, 109)).toBe(false);
  });

  it("horizontal line at row 11 (just inside top) is suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 11, 10, 109)).toBe(true);
  });

  it("horizontal line at row 109 (last inside) is suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 109, 10, 109)).toBe(true);
  });

  it("horizontal line at row 10 (top edge) is NOT suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 10, 10, 109)).toBe(false);
  });

  it("horizontal line at row 110 (bottom boundary) is NOT suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 110, 10, 109)).toBe(false);
  });

  it("vertical line inside but perp range outside merge rows returns false", () => {
    expect(isLineInsideMerge(cells, "vertical", 55, 0, 9)).toBe(false);
    expect(isLineInsideMerge(cells, "vertical", 55, 110, 200)).toBe(false);
  });
});

// ============================================================================
// Multiple adjacent merges
// ============================================================================

describe("adjacent merges side by side", () => {
  // Two horizontal merges next to each other: [0,0 span 3 cols] [0,3 span 3 cols]
  const cells = makeCells([
    [0, 0, 1, 3], // cols 0-2
    [0, 3, 1, 3], // cols 3-5
  ]);

  it("vertical line at col 1 (inside first merge) is suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 1, 0, 0)).toBe(true);
  });

  it("vertical line at col 4 (inside second merge) is suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 4, 0, 0)).toBe(true);
  });

  it("vertical line at col 3 (boundary between merges) - inside second, not first", () => {
    // col 3 is the left edge of second merge (not inside), and right boundary of first (not inside)
    // For first merge: lineIndex=3 > masterCol=0 AND lineIndex=3 < masterCol+colSpan=3? NO (3 < 3 is false)
    // For second merge: lineIndex=3 > masterCol=3? NO (3 > 3 is false)
    expect(isLineInsideMerge(cells, "vertical", 3, 0, 0)).toBe(false);
  });

  it("vertical line at col 6 (right boundary of second) is NOT suppressed", () => {
    expect(isLineInsideMerge(cells, "vertical", 6, 0, 0)).toBe(false);
  });
});

describe("adjacent merges stacked vertically", () => {
  const cells = makeCells([
    [0, 0, 3, 1], // rows 0-2
    [3, 0, 3, 1], // rows 3-5
  ]);

  it("horizontal line at row 1 (inside first) is suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 1, 0, 0)).toBe(true);
  });

  it("horizontal line at row 4 (inside second) is suppressed", () => {
    expect(isLineInsideMerge(cells, "horizontal", 4, 0, 0)).toBe(true);
  });

  it("horizontal line at row 3 (boundary) is NOT suppressed", () => {
    // row 3 is top of second merge (not > masterRow=3) and bottom boundary of first (not < 0+3=3)
    expect(isLineInsideMerge(cells, "horizontal", 3, 0, 0)).toBe(false);
  });
});

// ============================================================================
// Complex pattern: checkerboard of merges
// ============================================================================

describe("complex pattern: diagonal merges", () => {
  // 2x2 merges along the diagonal
  const cells = makeCells([
    [0, 0, 2, 2],
    [2, 2, 2, 2],
    [4, 4, 2, 2],
  ]);

  it("vertical line col 1 suppressed only at row 0-1", () => {
    expect(isLineInsideMerge(cells, "vertical", 1, 0, 1)).toBe(true);
    expect(isLineInsideMerge(cells, "vertical", 1, 2, 5)).toBe(false);
  });

  it("vertical line col 3 suppressed only at row 2-3", () => {
    expect(isLineInsideMerge(cells, "vertical", 3, 2, 3)).toBe(true);
    expect(isLineInsideMerge(cells, "vertical", 3, 0, 1)).toBe(false);
  });

  it("vertical line col 5 suppressed only at row 4-5", () => {
    expect(isLineInsideMerge(cells, "vertical", 5, 4, 5)).toBe(true);
    expect(isLineInsideMerge(cells, "vertical", 5, 0, 3)).toBe(false);
  });

  it("horizontal line row 1 suppressed only at col 0-1", () => {
    expect(isLineInsideMerge(cells, "horizontal", 1, 0, 1)).toBe(true);
    expect(isLineInsideMerge(cells, "horizontal", 1, 2, 5)).toBe(false);
  });
});

// ============================================================================
// Merge with undefined spans (defaults to 1)
// ============================================================================

describe("cells with undefined rowSpan/colSpan", () => {
  it("treats undefined as 1 (no suppression)", () => {
    const cells: CellMap = new Map();
    cells.set("3,3", {}); // no rowSpan, no colSpan
    expect(isLineInsideMerge(cells, "vertical", 4, 3, 3)).toBe(false);
    expect(isLineInsideMerge(cells, "horizontal", 4, 3, 3)).toBe(false);
  });

  it("treats undefined colSpan as 1 even with rowSpan > 1", () => {
    const cells: CellMap = new Map();
    cells.set("0,0", { rowSpan: 5 }); // colSpan undefined -> 1
    // Vertical lines should never be suppressed (colSpan=1)
    expect(isLineInsideMerge(cells, "vertical", 1, 0, 4)).toBe(false);
    // But horizontal lines inside should be suppressed
    expect(isLineInsideMerge(cells, "horizontal", 2, 0, 0)).toBe(true);
  });
});

// ============================================================================
// Perpendicular range edge cases
// ============================================================================

describe("perpendicular range edge overlap", () => {
  const cells = makeCells([[5, 5, 3, 3]]); // rows 5-7, cols 5-7

  it("perp range touching merge start exactly overlaps", () => {
    // Vertical line inside cols, perp range ends at merge start row
    expect(isLineInsideMerge(cells, "vertical", 6, 5, 5)).toBe(true);
    expect(isLineInsideMerge(cells, "vertical", 6, 7, 7)).toBe(true);
  });

  it("perp range just before merge does not overlap", () => {
    expect(isLineInsideMerge(cells, "vertical", 6, 0, 4)).toBe(false);
  });

  it("perp range just after merge does not overlap", () => {
    expect(isLineInsideMerge(cells, "vertical", 6, 8, 10)).toBe(false);
  });

  it("single-point perp range at merge boundary overlaps", () => {
    expect(isLineInsideMerge(cells, "vertical", 6, 7, 7)).toBe(true);
  });
});
