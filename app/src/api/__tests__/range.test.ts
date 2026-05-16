import { describe, it, expect } from "vitest";
import { CellRange } from "../range";

// These tests cover the pure/synchronous parts of CellRange that don't need Tauri.
// The async data methods (getValue, getValues, setValue, etc.) require backend mocking
// and are covered in range-integration.test.ts.

describe("CellRange - pure logic", () => {
  // ==========================================================================
  // Factory Methods & Address Parsing
  // ==========================================================================

  describe("fromCell", () => {
    it("creates a single-cell range", () => {
      const r = CellRange.fromCell(3, 5);
      expect(r.startRow).toBe(3);
      expect(r.startCol).toBe(5);
      expect(r.endRow).toBe(3);
      expect(r.endCol).toBe(5);
      expect(r.isSingleCell).toBe(true);
    });
  });

  describe("fromAddress", () => {
    it("parses single cell A1", () => {
      const r = CellRange.fromAddress("A1");
      expect(r.startRow).toBe(0);
      expect(r.startCol).toBe(0);
      expect(r.isSingleCell).toBe(true);
    });

    it("parses range B2:D5", () => {
      const r = CellRange.fromAddress("B2:D5");
      expect(r.startRow).toBe(1);
      expect(r.startCol).toBe(1);
      expect(r.endRow).toBe(4);
      expect(r.endCol).toBe(3);
    });

    it("parses absolute references $A$1:$B$5", () => {
      const r = CellRange.fromAddress("$A$1:$B$5");
      expect(r.startRow).toBe(0);
      expect(r.startCol).toBe(0);
      expect(r.endRow).toBe(4);
      expect(r.endCol).toBe(1);
    });

    it("parses with sheet prefix (ignores sheet)", () => {
      const r = CellRange.fromAddress("Sheet1!C3:E7");
      expect(r.startRow).toBe(2);
      expect(r.startCol).toBe(2);
      expect(r.endRow).toBe(6);
      expect(r.endCol).toBe(4);
    });

    it("normalizes reversed ranges", () => {
      // D5:B2 should normalize to B2:D5
      const r = CellRange.fromAddress("D5:B2");
      expect(r.startRow).toBe(1);
      expect(r.startCol).toBe(1);
      expect(r.endRow).toBe(4);
      expect(r.endCol).toBe(3);
    });

    it("throws on invalid reference", () => {
      expect(() => CellRange.fromAddress("invalid")).toThrow("Invalid cell reference");
    });
  });

  // ==========================================================================
  // Properties
  // ==========================================================================

  describe("properties", () => {
    it("rowCount and colCount", () => {
      const r = new CellRange(1, 2, 5, 4);
      expect(r.rowCount).toBe(5);
      expect(r.colCount).toBe(3);
    });

    it("cellCount", () => {
      const r = new CellRange(0, 0, 2, 3);
      expect(r.cellCount).toBe(12); // 3 rows x 4 cols
    });

    it("isSingleCell", () => {
      expect(new CellRange(1, 1, 1, 1).isSingleCell).toBe(true);
      expect(new CellRange(1, 1, 2, 1).isSingleCell).toBe(false);
    });

    it("address for single cell", () => {
      expect(CellRange.fromCell(0, 0).address).toBe("A1");
      expect(CellRange.fromCell(0, 25).address).toBe("Z1");
    });

    it("address for range", () => {
      const r = new CellRange(0, 0, 4, 3);
      expect(r.address).toBe("A1:D5");
    });
  });

  // ==========================================================================
  // Navigation
  // ==========================================================================

  describe("offset", () => {
    it("shifts range preserving shape", () => {
      const r = new CellRange(1, 1, 3, 3);
      const shifted = r.offset(5, 2);
      expect(shifted.startRow).toBe(6);
      expect(shifted.startCol).toBe(3);
      expect(shifted.endRow).toBe(8);
      expect(shifted.endCol).toBe(5);
    });

    it("negative offset", () => {
      const r = new CellRange(5, 5, 7, 7);
      const shifted = r.offset(-3, -2);
      expect(shifted.startRow).toBe(2);
      expect(shifted.startCol).toBe(3);
    });
  });

  describe("resize", () => {
    it("resizes from top-left corner", () => {
      const r = new CellRange(1, 1, 3, 3);
      const resized = r.resize(2, 5);
      expect(resized.startRow).toBe(1);
      expect(resized.startCol).toBe(1);
      expect(resized.endRow).toBe(2);
      expect(resized.endCol).toBe(5);
    });
  });

  describe("getCell", () => {
    it("returns single-cell range at offset", () => {
      const r = new CellRange(2, 3, 5, 6);
      const cell = r.getCell(1, 2);
      expect(cell.startRow).toBe(3);
      expect(cell.startCol).toBe(5);
      expect(cell.isSingleCell).toBe(true);
    });

    it("throws for out-of-bounds offset", () => {
      const r = new CellRange(0, 0, 2, 2);
      expect(() => r.getCell(5, 0)).toThrow("outside range");
    });
  });

  describe("getRow", () => {
    it("returns full row within range", () => {
      const r = new CellRange(0, 0, 5, 3);
      const row = r.getRow(2);
      expect(row.startRow).toBe(2);
      expect(row.endRow).toBe(2);
      expect(row.startCol).toBe(0);
      expect(row.endCol).toBe(3);
    });

    it("throws for out-of-bounds row offset", () => {
      const r = new CellRange(0, 0, 2, 2);
      expect(() => r.getRow(5)).toThrow("outside range");
    });
  });

  describe("getColumn", () => {
    it("returns full column within range", () => {
      const r = new CellRange(0, 0, 5, 3);
      const col = r.getColumn(1);
      expect(col.startCol).toBe(1);
      expect(col.endCol).toBe(1);
      expect(col.startRow).toBe(0);
      expect(col.endRow).toBe(5);
    });

    it("throws for out-of-bounds column offset", () => {
      const r = new CellRange(0, 0, 2, 2);
      expect(() => r.getColumn(5)).toThrow("outside range");
    });
  });

  // ==========================================================================
  // Set Operations
  // ==========================================================================

  describe("contains", () => {
    const r = new CellRange(1, 1, 5, 5);

    it("returns true for cell inside range", () => {
      expect(r.contains(3, 3)).toBe(true);
    });

    it("returns true for corner cells", () => {
      expect(r.contains(1, 1)).toBe(true);
      expect(r.contains(5, 5)).toBe(true);
    });

    it("returns false for cell outside range", () => {
      expect(r.contains(0, 0)).toBe(false);
      expect(r.contains(6, 3)).toBe(false);
    });
  });

  describe("intersects", () => {
    it("returns true for overlapping ranges", () => {
      const a = new CellRange(0, 0, 3, 3);
      const b = new CellRange(2, 2, 5, 5);
      expect(a.intersects(b)).toBe(true);
    });

    it("returns false for non-overlapping ranges", () => {
      const a = new CellRange(0, 0, 1, 1);
      const b = new CellRange(3, 3, 5, 5);
      expect(a.intersects(b)).toBe(false);
    });

    it("returns true for adjacent touching ranges (they share an edge cell)", () => {
      const a = new CellRange(0, 0, 2, 2);
      const b = new CellRange(2, 2, 4, 4);
      expect(a.intersects(b)).toBe(true);
    });
  });

  describe("intersection", () => {
    it("returns overlap region", () => {
      const a = new CellRange(0, 0, 3, 3);
      const b = new CellRange(2, 2, 5, 5);
      const result = a.intersection(b);
      expect(result).not.toBeNull();
      expect(result!.startRow).toBe(2);
      expect(result!.startCol).toBe(2);
      expect(result!.endRow).toBe(3);
      expect(result!.endCol).toBe(3);
    });

    it("returns null for non-overlapping", () => {
      const a = new CellRange(0, 0, 1, 1);
      const b = new CellRange(5, 5, 8, 8);
      expect(a.intersection(b)).toBeNull();
    });
  });

  describe("union", () => {
    it("returns bounding box", () => {
      const a = new CellRange(2, 3, 4, 5);
      const b = new CellRange(0, 0, 3, 3);
      const result = a.union(b);
      expect(result.startRow).toBe(0);
      expect(result.startCol).toBe(0);
      expect(result.endRow).toBe(4);
      expect(result.endCol).toBe(5);
    });
  });

  // ==========================================================================
  // Iteration
  // ==========================================================================

  describe("cells generator", () => {
    it("yields all cells row by row", () => {
      const r = new CellRange(0, 0, 1, 1);
      const cells = [...r.cells()];
      expect(cells).toEqual([
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 0 },
        { row: 1, col: 1 },
      ]);
    });
  });

  describe("forEachCell", () => {
    it("calls callback for every cell", () => {
      const r = new CellRange(0, 0, 1, 2);
      const visited: string[] = [];
      r.forEachCell((row, col) => visited.push(`${row},${col}`));
      expect(visited).toEqual(["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"]);
    });
  });

  // ==========================================================================
  // Equality & Serialization
  // ==========================================================================

  describe("equals", () => {
    it("returns true for identical ranges", () => {
      const a = new CellRange(1, 2, 3, 4);
      const b = new CellRange(1, 2, 3, 4);
      expect(a.equals(b)).toBe(true);
    });

    it("returns false for different ranges", () => {
      const a = new CellRange(1, 2, 3, 4);
      const b = new CellRange(1, 2, 3, 5);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("toString", () => {
    it("returns debug string", () => {
      const r = CellRange.fromAddress("A1:C3");
      expect(r.toString()).toBe("CellRange(A1:C3)");
    });

    it("single cell toString", () => {
      expect(CellRange.fromCell(0, 0).toString()).toBe("CellRange(A1)");
    });
  });
});
