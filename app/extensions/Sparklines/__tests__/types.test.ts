//! FILENAME: app/extensions/Sparklines/__tests__/types.test.ts
// PURPOSE: Tests for sparkline type validation logic.

import { describe, it, expect } from "vitest";
import { validateSparklineRanges } from "../types";
import type { CellRange } from "../types";

// ============================================================================
// Helpers
// ============================================================================

function range(startRow: number, startCol: number, endRow: number, endCol: number): CellRange {
  return { startRow, startCol, endRow, endCol };
}

// ============================================================================
// Tests
// ============================================================================

describe("validateSparklineRanges", () => {
  describe("single-cell location", () => {
    it("accepts a single-cell location with 1D row data", () => {
      const result = validateSparklineRanges(range(0, 5, 0, 5), range(0, 0, 0, 4));
      expect(result.valid).toBe(true);
      expect(result.count).toBe(1);
      expect(result.orientation).toBe("byRow");
    });

    it("accepts a single-cell location with 1D column data", () => {
      const result = validateSparklineRanges(range(0, 5, 0, 5), range(0, 0, 4, 0));
      expect(result.valid).toBe(true);
      expect(result.count).toBe(1);
      expect(result.orientation).toBe("byCol");
    });

    it("rejects a single-cell location with 2D data", () => {
      const result = validateSparklineRanges(range(0, 5, 0, 5), range(0, 0, 4, 4));
      expect(result.valid).toBe(false);
      expect(result.error).toContain("2D data range");
    });
  });

  describe("multi-cell column location (Nx1)", () => {
    it("accepts matching row count in data", () => {
      const result = validateSparklineRanges(range(0, 5, 4, 5), range(0, 0, 4, 3));
      expect(result.valid).toBe(true);
      expect(result.count).toBe(5);
      expect(result.orientation).toBe("byRow");
    });

    it("rejects mismatched row count", () => {
      const result = validateSparklineRanges(range(0, 5, 4, 5), range(0, 0, 2, 3));
      expect(result.valid).toBe(false);
      expect(result.error).toContain("rows");
    });
  });

  describe("multi-cell row location (1xN)", () => {
    it("accepts matching column count in data", () => {
      const result = validateSparklineRanges(range(5, 0, 5, 4), range(0, 0, 3, 4));
      expect(result.valid).toBe(true);
      expect(result.count).toBe(5);
      expect(result.orientation).toBe("byCol");
    });

    it("rejects mismatched column count", () => {
      const result = validateSparklineRanges(range(5, 0, 5, 4), range(0, 0, 3, 2));
      expect(result.valid).toBe(false);
      expect(result.error).toContain("columns");
    });
  });

  describe("2D location (invalid)", () => {
    it("rejects a 2D location range", () => {
      const result = validateSparklineRanges(range(0, 0, 2, 2), range(0, 0, 0, 4));
      expect(result.valid).toBe(false);
      expect(result.error).toContain("single cell");
    });
  });

  describe("edge cases", () => {
    it("handles single-cell data with single-cell location", () => {
      const result = validateSparklineRanges(range(0, 0, 0, 0), range(0, 1, 0, 1));
      expect(result.valid).toBe(true);
      expect(result.count).toBe(1);
    });

    it("handles multi-cell location with 1D data matching length", () => {
      // Column location with 1D column data of same length
      const result = validateSparklineRanges(range(0, 5, 2, 5), range(0, 0, 2, 0));
      expect(result.valid).toBe(true);
      expect(result.count).toBe(3);
    });

    it("rejects multi-cell location with 1D data of different length", () => {
      const result = validateSparklineRanges(range(0, 5, 2, 5), range(0, 0, 4, 0));
      expect(result.valid).toBe(false);
    });
  });
});
