import { describe, it, expect, vi } from "vitest";

// Mock Tauri backend and grid dependencies to isolate pure logic tests
vi.mock("./lib", () => ({
  getCell: vi.fn(),
  updateCellsBatch: vi.fn(),
  applyFormatting: vi.fn(),
  applyBorderPreset: vi.fn(),
}));
vi.mock("./grid", () => ({
  navigateToCell: vi.fn(),
  navigateToRange: vi.fn(),
  borderAround: vi.fn(),
}));

// CellRange is exported, but parseAddress and parseSingleCellRef are not.
// We test them indirectly via CellRange.fromAddress and the address property.
import { CellRange } from "./range";

// ---------------------------------------------------------------------------
// parseAddress (tested via CellRange.fromAddress)
// ---------------------------------------------------------------------------
describe("parseAddress (via CellRange.fromAddress)", () => {
  it('parses "A1" as single cell (0,0)', () => {
    const r = CellRange.fromAddress("A1");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.endRow).toBe(0);
    expect(r.endCol).toBe(0);
  });

  it('parses "B5" as single cell (4,1)', () => {
    const r = CellRange.fromAddress("B5");
    expect(r.startRow).toBe(4);
    expect(r.startCol).toBe(1);
    expect(r.isSingleCell).toBe(true);
  });

  it('parses "Z1" as column 25', () => {
    const r = CellRange.fromAddress("Z1");
    expect(r.startCol).toBe(25);
  });

  it('parses "AA1" as column 26', () => {
    const r = CellRange.fromAddress("AA1");
    expect(r.startCol).toBe(26);
  });

  it('parses "A1:B5" as a multi-cell range', () => {
    const r = CellRange.fromAddress("A1:B5");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.endRow).toBe(4);
    expect(r.endCol).toBe(1);
  });

  it('parses "B2:D10" correctly', () => {
    const r = CellRange.fromAddress("B2:D10");
    expect(r.startRow).toBe(1);
    expect(r.startCol).toBe(1);
    expect(r.endRow).toBe(9);
    expect(r.endCol).toBe(3);
  });

  it('parses "Sheet1!A1" with sheet prefix', () => {
    // Sheet is parsed but not stored on the range
    const r = CellRange.fromAddress("Sheet1!A1");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.isSingleCell).toBe(true);
  });

  it('parses "Sheet1!A1:B5" with sheet prefix', () => {
    const r = CellRange.fromAddress("Sheet1!A1:B5");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.endRow).toBe(4);
    expect(r.endCol).toBe(1);
  });

  it('parses quoted sheet name "\'My Sheet\'!C3"', () => {
    const r = CellRange.fromAddress("'My Sheet'!C3");
    expect(r.startRow).toBe(2);
    expect(r.startCol).toBe(2);
  });

  it('parses "$A$1" (absolute reference) as (0,0)', () => {
    const r = CellRange.fromAddress("$A$1");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
  });

  it('parses "$A$1:$B$5" (absolute range)', () => {
    const r = CellRange.fromAddress("$A$1:$B$5");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.endRow).toBe(4);
    expect(r.endCol).toBe(1);
  });

  it('parses mixed absolute/relative "$A1:B$5"', () => {
    const r = CellRange.fromAddress("$A1:B$5");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.endRow).toBe(4);
    expect(r.endCol).toBe(1);
  });

  it("normalizes reversed ranges (end < start)", () => {
    // "B5:A1" should be normalized so start <= end
    const r = CellRange.fromAddress("B5:A1");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.endRow).toBe(4);
    expect(r.endCol).toBe(1);
  });

  it("handles leading/trailing whitespace", () => {
    const r = CellRange.fromAddress("  A1:B2  ");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.endRow).toBe(1);
    expect(r.endCol).toBe(1);
  });

  it("throws on invalid address", () => {
    expect(() => CellRange.fromAddress("123")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => CellRange.fromAddress("")).toThrow();
  });

  it("handles lowercase letters", () => {
    const r = CellRange.fromAddress("a1:b5");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.endRow).toBe(4);
    expect(r.endCol).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CellRange Class
// ---------------------------------------------------------------------------
describe("CellRange", () => {
  describe("construction", () => {
    it("stores coordinates correctly", () => {
      const r = new CellRange(2, 3, 5, 7);
      expect(r.startRow).toBe(2);
      expect(r.startCol).toBe(3);
      expect(r.endRow).toBe(5);
      expect(r.endCol).toBe(7);
    });

    it("fromCell creates a single-cell range", () => {
      const r = CellRange.fromCell(3, 4);
      expect(r.startRow).toBe(3);
      expect(r.startCol).toBe(4);
      expect(r.endRow).toBe(3);
      expect(r.endCol).toBe(4);
      expect(r.isSingleCell).toBe(true);
    });
  });

  describe("properties", () => {
    it("rowCount returns correct number of rows", () => {
      const r = new CellRange(0, 0, 4, 0);
      expect(r.rowCount).toBe(5);
    });

    it("colCount returns correct number of columns", () => {
      const r = new CellRange(0, 0, 0, 3);
      expect(r.colCount).toBe(4);
    });

    it("cellCount returns rows * cols", () => {
      const r = new CellRange(0, 0, 2, 3);
      expect(r.cellCount).toBe(12); // 3 rows x 4 cols
    });

    it("isSingleCell is true for single-cell range", () => {
      expect(new CellRange(5, 5, 5, 5).isSingleCell).toBe(true);
    });

    it("isSingleCell is false for multi-cell range", () => {
      expect(new CellRange(0, 0, 0, 1).isSingleCell).toBe(false);
    });

    it("address returns A1 for single cell at (0,0)", () => {
      const r = CellRange.fromCell(0, 0);
      expect(r.address).toBe("A1");
    });

    it("address returns correct string for multi-cell range", () => {
      const r = new CellRange(0, 0, 4, 1);
      expect(r.address).toBe("A1:B5");
    });

    it("address returns correct string for single cell not at origin", () => {
      const r = CellRange.fromCell(9, 2); // C10
      expect(r.address).toBe("C10");
    });
  });

  describe("contains", () => {
    const r = new CellRange(2, 3, 5, 7);

    it("returns true for top-left corner", () => {
      expect(r.contains(2, 3)).toBe(true);
    });

    it("returns true for bottom-right corner", () => {
      expect(r.contains(5, 7)).toBe(true);
    });

    it("returns true for cell in the middle", () => {
      expect(r.contains(3, 5)).toBe(true);
    });

    it("returns false for cell above the range", () => {
      expect(r.contains(1, 5)).toBe(false);
    });

    it("returns false for cell below the range", () => {
      expect(r.contains(6, 5)).toBe(false);
    });

    it("returns false for cell left of the range", () => {
      expect(r.contains(3, 2)).toBe(false);
    });

    it("returns false for cell right of the range", () => {
      expect(r.contains(3, 8)).toBe(false);
    });
  });

  describe("cells() iterator", () => {
    it("yields all cells row by row for a 2x2 range", () => {
      const r = new CellRange(0, 0, 1, 1);
      const cells = [...r.cells()];
      expect(cells).toEqual([
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 0 },
        { row: 1, col: 1 },
      ]);
    });

    it("yields a single cell for single-cell range", () => {
      const r = CellRange.fromCell(3, 4);
      const cells = [...r.cells()];
      expect(cells).toEqual([{ row: 3, col: 4 }]);
    });

    it("yields correct count for a 3x4 range", () => {
      const r = new CellRange(0, 0, 2, 3);
      const cells = [...r.cells()];
      expect(cells.length).toBe(12);
    });
  });

  describe("forEachCell", () => {
    it("calls the callback for every cell", () => {
      const r = new CellRange(0, 0, 1, 1);
      const visited: Array<[number, number]> = [];
      r.forEachCell((row, col) => visited.push([row, col]));
      expect(visited).toEqual([
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ]);
    });
  });

  describe("intersects", () => {
    it("returns true for overlapping ranges", () => {
      const a = new CellRange(0, 0, 5, 5);
      const b = new CellRange(3, 3, 8, 8);
      expect(a.intersects(b)).toBe(true);
      expect(b.intersects(a)).toBe(true);
    });

    it("returns true for adjacent ranges sharing an edge", () => {
      const a = new CellRange(0, 0, 2, 2);
      const b = new CellRange(2, 2, 4, 4);
      expect(a.intersects(b)).toBe(true);
    });

    it("returns false for non-overlapping ranges", () => {
      const a = new CellRange(0, 0, 2, 2);
      const b = new CellRange(3, 3, 5, 5);
      expect(a.intersects(b)).toBe(false);
    });

    it("returns true when one range contains the other", () => {
      const outer = new CellRange(0, 0, 10, 10);
      const inner = new CellRange(2, 2, 5, 5);
      expect(outer.intersects(inner)).toBe(true);
      expect(inner.intersects(outer)).toBe(true);
    });
  });

  describe("intersection", () => {
    it("returns the overlapping region", () => {
      const a = new CellRange(0, 0, 5, 5);
      const b = new CellRange(3, 3, 8, 8);
      const result = a.intersection(b);
      expect(result).not.toBeNull();
      expect(result!.startRow).toBe(3);
      expect(result!.startCol).toBe(3);
      expect(result!.endRow).toBe(5);
      expect(result!.endCol).toBe(5);
    });

    it("returns null for non-overlapping ranges", () => {
      const a = new CellRange(0, 0, 2, 2);
      const b = new CellRange(5, 5, 8, 8);
      expect(a.intersection(b)).toBeNull();
    });

    it("returns single cell when ranges touch at a corner", () => {
      const a = new CellRange(0, 0, 3, 3);
      const b = new CellRange(3, 3, 6, 6);
      const result = a.intersection(b);
      expect(result).not.toBeNull();
      expect(result!.isSingleCell).toBe(true);
      expect(result!.startRow).toBe(3);
      expect(result!.startCol).toBe(3);
    });
  });

  describe("union", () => {
    it("returns bounding box of both ranges", () => {
      const a = new CellRange(2, 3, 5, 7);
      const b = new CellRange(0, 1, 4, 10);
      const u = a.union(b);
      expect(u.startRow).toBe(0);
      expect(u.startCol).toBe(1);
      expect(u.endRow).toBe(5);
      expect(u.endCol).toBe(10);
    });
  });

  describe("offset", () => {
    it("shifts the range by the given offsets", () => {
      const r = new CellRange(2, 3, 5, 7);
      const shifted = r.offset(1, 2);
      expect(shifted.startRow).toBe(3);
      expect(shifted.startCol).toBe(5);
      expect(shifted.endRow).toBe(6);
      expect(shifted.endCol).toBe(9);
    });

    it("preserves the size of the range", () => {
      const r = new CellRange(0, 0, 4, 4);
      const shifted = r.offset(10, 10);
      expect(shifted.rowCount).toBe(r.rowCount);
      expect(shifted.colCount).toBe(r.colCount);
    });

    it("supports negative offsets", () => {
      const r = new CellRange(5, 5, 8, 8);
      const shifted = r.offset(-3, -2);
      expect(shifted.startRow).toBe(2);
      expect(shifted.startCol).toBe(3);
    });
  });

  describe("resize", () => {
    it("creates a new range with the given dimensions", () => {
      const r = new CellRange(2, 3, 5, 7);
      const resized = r.resize(2, 3);
      expect(resized.startRow).toBe(2);
      expect(resized.startCol).toBe(3);
      expect(resized.endRow).toBe(3);
      expect(resized.endCol).toBe(5);
      expect(resized.rowCount).toBe(2);
      expect(resized.colCount).toBe(3);
    });
  });

  describe("getCell", () => {
    it("returns a single-cell range at the given offset", () => {
      const r = new CellRange(2, 3, 5, 7);
      const cell = r.getCell(1, 2);
      expect(cell.startRow).toBe(3);
      expect(cell.startCol).toBe(5);
      expect(cell.isSingleCell).toBe(true);
    });

    it("throws when offset is out of range", () => {
      const r = new CellRange(0, 0, 2, 2);
      expect(() => r.getCell(5, 0)).toThrow();
      expect(() => r.getCell(0, 5)).toThrow();
    });
  });

  describe("getRow", () => {
    it("returns a row range within the parent range", () => {
      const r = new CellRange(2, 3, 5, 7);
      const row = r.getRow(1);
      expect(row.startRow).toBe(3);
      expect(row.endRow).toBe(3);
      expect(row.startCol).toBe(3);
      expect(row.endCol).toBe(7);
    });

    it("throws when row offset is out of range", () => {
      const r = new CellRange(0, 0, 2, 2);
      expect(() => r.getRow(5)).toThrow();
    });
  });

  describe("getColumn", () => {
    it("returns a column range within the parent range", () => {
      const r = new CellRange(2, 3, 5, 7);
      const col = r.getColumn(2);
      expect(col.startCol).toBe(5);
      expect(col.endCol).toBe(5);
      expect(col.startRow).toBe(2);
      expect(col.endRow).toBe(5);
    });

    it("throws when col offset is out of range", () => {
      const r = new CellRange(0, 0, 2, 2);
      expect(() => r.getColumn(5)).toThrow();
    });
  });

  describe("equals", () => {
    it("returns true for structurally identical ranges", () => {
      const a = new CellRange(1, 2, 3, 4);
      const b = new CellRange(1, 2, 3, 4);
      expect(a.equals(b)).toBe(true);
    });

    it("returns false when ranges differ", () => {
      const a = new CellRange(1, 2, 3, 4);
      const b = new CellRange(1, 2, 3, 5);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("toString", () => {
    it("returns a debug string with address", () => {
      const r = new CellRange(0, 0, 4, 1);
      expect(r.toString()).toBe("CellRange(A1:B5)");
    });

    it("returns debug string for single cell", () => {
      const r = CellRange.fromCell(0, 0);
      expect(r.toString()).toBe("CellRange(A1)");
    });
  });
});
