//! FILENAME: app/src/core/lib/gridRenderer/rendering/grid.deeptest.ts
// PURPOSE: Deep tests for grid rendering utilities - merged cell line suppression

import { describe, it, expect } from "vitest";
import { isLineInsideMerge } from "./grid";

// ============================================================================
// isLineInsideMerge
// ============================================================================

describe("isLineInsideMerge", () => {
  describe("no merged cells", () => {
    it("returns false for empty cells map", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      expect(isLineInsideMerge(cells, "vertical", 5, 0, 10)).toBe(false);
      expect(isLineInsideMerge(cells, "horizontal", 5, 0, 10)).toBe(false);
    });

    it("returns false when cells have no spans", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", {});
      cells.set("5,5", { rowSpan: 1, colSpan: 1 });
      expect(isLineInsideMerge(cells, "vertical", 1, 0, 10)).toBe(false);
    });
  });

  describe("vertical lines with horizontal merge (colSpan)", () => {
    it("returns true for line inside a horizontal merge", () => {
      // Merge at (0,0) spanning 3 columns: cols 0,1,2
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", { colSpan: 3, rowSpan: 1 });

      // Vertical line at col 1 (inside the merge), row range overlaps
      expect(isLineInsideMerge(cells, "vertical", 1, 0, 0)).toBe(true);
      expect(isLineInsideMerge(cells, "vertical", 2, 0, 0)).toBe(true);
    });

    it("returns false for line at merge boundary (left edge)", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", { colSpan: 3 });

      // Line at col 0 = the left edge of the merge, not inside
      expect(isLineInsideMerge(cells, "vertical", 0, 0, 0)).toBe(false);
    });

    it("returns false for line at merge boundary (right edge)", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", { colSpan: 3 });

      // Line at col 3 = one past the merge, not inside
      expect(isLineInsideMerge(cells, "vertical", 3, 0, 0)).toBe(false);
    });

    it("returns false when perp range does not overlap merge rows", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("5,0", { colSpan: 3, rowSpan: 2 }); // rows 5-6, cols 0-2

      // Line at col 1 (inside cols) but rows 0-4 (not overlapping)
      expect(isLineInsideMerge(cells, "vertical", 1, 0, 4)).toBe(false);
      // rows 7-10 (not overlapping)
      expect(isLineInsideMerge(cells, "vertical", 1, 7, 10)).toBe(false);
    });

    it("returns true when perp range partially overlaps merge rows", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("5,0", { colSpan: 3, rowSpan: 2 }); // rows 5-6

      expect(isLineInsideMerge(cells, "vertical", 1, 4, 5)).toBe(true);
      expect(isLineInsideMerge(cells, "vertical", 1, 6, 8)).toBe(true);
    });
  });

  describe("horizontal lines with vertical merge (rowSpan)", () => {
    it("returns true for line inside a vertical merge", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", { rowSpan: 4, colSpan: 1 }); // rows 0-3

      expect(isLineInsideMerge(cells, "horizontal", 1, 0, 0)).toBe(true);
      expect(isLineInsideMerge(cells, "horizontal", 2, 0, 0)).toBe(true);
      expect(isLineInsideMerge(cells, "horizontal", 3, 0, 0)).toBe(true);
    });

    it("returns false for line at merge boundary (top edge)", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", { rowSpan: 3 });

      expect(isLineInsideMerge(cells, "horizontal", 0, 0, 0)).toBe(false);
    });

    it("returns false for line at merge boundary (bottom edge)", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", { rowSpan: 3 });

      expect(isLineInsideMerge(cells, "horizontal", 3, 0, 0)).toBe(false);
    });

    it("returns false when perp range does not overlap merge cols", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,5", { rowSpan: 3, colSpan: 2 }); // cols 5-6

      expect(isLineInsideMerge(cells, "horizontal", 1, 0, 4)).toBe(false);
      expect(isLineInsideMerge(cells, "horizontal", 1, 7, 10)).toBe(false);
    });
  });

  describe("large multi-cell merge", () => {
    it("correctly handles a 5x5 merge", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("2,3", { rowSpan: 5, colSpan: 5 }); // rows 2-6, cols 3-7

      // Vertical lines inside: cols 4,5,6,7 (but not 3 or 8)
      expect(isLineInsideMerge(cells, "vertical", 3, 2, 6)).toBe(false); // left edge
      expect(isLineInsideMerge(cells, "vertical", 4, 2, 6)).toBe(true);
      expect(isLineInsideMerge(cells, "vertical", 7, 2, 6)).toBe(true);
      expect(isLineInsideMerge(cells, "vertical", 8, 2, 6)).toBe(false); // right edge + 1

      // Horizontal lines inside: rows 3,4,5,6 (but not 2 or 7)
      expect(isLineInsideMerge(cells, "horizontal", 2, 3, 7)).toBe(false); // top edge
      expect(isLineInsideMerge(cells, "horizontal", 3, 3, 7)).toBe(true);
      expect(isLineInsideMerge(cells, "horizontal", 6, 3, 7)).toBe(true);
      expect(isLineInsideMerge(cells, "horizontal", 7, 3, 7)).toBe(false); // bottom edge + 1
    });
  });

  describe("multiple merges", () => {
    it("detects lines inside any of multiple merges", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", { colSpan: 3 }); // cols 0-2, row 0
      cells.set("5,5", { colSpan: 4 }); // cols 5-8, row 5

      expect(isLineInsideMerge(cells, "vertical", 1, 0, 0)).toBe(true);
      expect(isLineInsideMerge(cells, "vertical", 6, 5, 5)).toBe(true);
      // Between merges
      expect(isLineInsideMerge(cells, "vertical", 4, 0, 10)).toBe(false);
    });
  });

  describe("edge case: merge with only rowSpan (no colSpan)", () => {
    it("vertical line is not affected by row-only merge", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", { rowSpan: 3 }); // Only rowSpan, colSpan defaults to 1

      // Vertical lines should not be suppressed (colSpan = 1)
      expect(isLineInsideMerge(cells, "vertical", 1, 0, 2)).toBe(false);
    });
  });

  describe("edge case: merge with only colSpan (no rowSpan)", () => {
    it("horizontal line is not affected by col-only merge", () => {
      const cells = new Map<string, { rowSpan?: number; colSpan?: number }>();
      cells.set("0,0", { colSpan: 3 }); // Only colSpan, rowSpan defaults to 1

      // Horizontal lines should not be suppressed (rowSpan = 1)
      expect(isLineInsideMerge(cells, "horizontal", 1, 0, 2)).toBe(false);
    });
  });
});
