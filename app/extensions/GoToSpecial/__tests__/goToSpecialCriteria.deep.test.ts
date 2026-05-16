//! FILENAME: app/extensions/GoToSpecial/__tests__/goToSpecialCriteria.deep.test.ts
// PURPOSE: Deep tests for Go To Special bounding range, criteria matching, and edge cases.

import { describe, it, expect } from "vitest";

// ============================================================================
// Replicated logic from GoToSpecialDialog and goToSpecialCriteria.test.ts
// ============================================================================

interface CellPos {
  row: number;
  col: number;
}

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
    additionalRanges:
      cells.length <= 1000
        ? cells.map((c) => ({
            startRow: c.row,
            startCol: c.col,
            endRow: c.row,
            endCol: c.col,
          }))
        : undefined,
  };
}

function normalizeSearchRange(sel: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}) {
  if (sel.startRow === sel.endRow && sel.startCol === sel.endCol) {
    return undefined;
  }
  return {
    startRow: Math.min(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endRow: Math.max(sel.startRow, sel.endRow),
    endCol: Math.max(sel.startCol, sel.endCol),
  };
}

// ============================================================================
// Simulated cell type checker for criteria filtering tests
// ============================================================================

interface CellData {
  row: number;
  col: number;
  value: unknown;
  formula?: string;
  hasError?: boolean;
}

type CriteriaType =
  | "blanks"
  | "formulas"
  | "constants"
  | "errors"
  | "numbers"
  | "text"
  | "logicals";

function matchesCriteria(cell: CellData, criteria: CriteriaType): boolean {
  switch (criteria) {
    case "blanks":
      return cell.value === null || cell.value === undefined || cell.value === "";
    case "formulas":
      return !!cell.formula;
    case "constants":
      return !cell.formula && cell.value !== null && cell.value !== undefined && cell.value !== "";
    case "errors":
      return !!cell.hasError;
    case "numbers":
      return typeof cell.value === "number";
    case "text":
      return typeof cell.value === "string" && cell.value !== "";
    case "logicals":
      return typeof cell.value === "boolean";
  }
}

function filterByCriteria(
  cells: CellData[],
  ...criteria: CriteriaType[]
): CellPos[] {
  return cells
    .filter((c) => criteria.some((cr) => matchesCriteria(c, cr)))
    .map((c) => ({ row: c.row, col: c.col }));
}

// ============================================================================
// Bounding range - four corners of a large range
// ============================================================================

describe("bounding range - corner cells", () => {
  it("computes correct bounds from cells in all 4 corners", () => {
    const cells: CellPos[] = [
      { row: 0, col: 0 },       // top-left
      { row: 0, col: 999 },     // top-right
      { row: 9999, col: 0 },    // bottom-left
      { row: 9999, col: 999 },  // bottom-right
    ];
    const result = computeSelectionFromCells(cells)!;
    expect(result.startRow).toBe(0);
    expect(result.startCol).toBe(0);
    expect(result.endRow).toBe(9999);
    expect(result.endCol).toBe(999);
    expect(result.additionalRanges).toHaveLength(4);
  });

  it("handles cells only on the diagonal", () => {
    const cells: CellPos[] = [
      { row: 5, col: 5 },
      { row: 100, col: 100 },
    ];
    const result = computeSelectionFromCells(cells)!;
    expect(result.startRow).toBe(5);
    expect(result.startCol).toBe(5);
    expect(result.endRow).toBe(100);
    expect(result.endCol).toBe(100);
  });

  it("handles all cells in the same row", () => {
    const cells: CellPos[] = [
      { row: 7, col: 0 },
      { row: 7, col: 5 },
      { row: 7, col: 10 },
    ];
    const result = computeSelectionFromCells(cells)!;
    expect(result.startRow).toBe(7);
    expect(result.endRow).toBe(7);
    expect(result.startCol).toBe(0);
    expect(result.endCol).toBe(10);
  });

  it("handles all cells in the same column", () => {
    const cells: CellPos[] = [
      { row: 0, col: 3 },
      { row: 50, col: 3 },
      { row: 200, col: 3 },
    ];
    const result = computeSelectionFromCells(cells)!;
    expect(result.startCol).toBe(3);
    expect(result.endCol).toBe(3);
    expect(result.startRow).toBe(0);
    expect(result.endRow).toBe(200);
  });
});

// ============================================================================
// additionalRanges threshold behavior
// ============================================================================

describe("additionalRanges threshold", () => {
  it("includes additionalRanges at exactly 1000 cells", () => {
    const cells = Array.from({ length: 1000 }, (_, i) => ({
      row: i,
      col: 0,
    }));
    const result = computeSelectionFromCells(cells)!;
    expect(result.additionalRanges).toHaveLength(1000);
  });

  it("omits additionalRanges at 1001 cells", () => {
    const cells = Array.from({ length: 1001 }, (_, i) => ({
      row: i,
      col: 0,
    }));
    const result = computeSelectionFromCells(cells)!;
    expect(result.additionalRanges).toBeUndefined();
  });

  it("handles 10K+ cells without error", () => {
    const cells = Array.from({ length: 10000 }, (_, i) => ({
      row: Math.floor(i / 100),
      col: i % 100,
    }));
    const result = computeSelectionFromCells(cells)!;
    expect(result.additionalRanges).toBeUndefined();
    expect(result.startRow).toBe(0);
    expect(result.endRow).toBe(99);
    expect(result.startCol).toBe(0);
    expect(result.endCol).toBe(99);
  });
});

// ============================================================================
// Criteria filtering
// ============================================================================

describe("criteria filtering", () => {
  const testCells: CellData[] = [
    { row: 0, col: 0, value: 42 },
    { row: 0, col: 1, value: "hello" },
    { row: 0, col: 2, value: null },
    { row: 0, col: 3, value: "", formula: "=A1+B1" },
    { row: 1, col: 0, value: true },
    { row: 1, col: 1, value: 0, hasError: true },
    { row: 1, col: 2, value: "" },
    { row: 1, col: 3, value: 3.14, formula: "=PI()" },
  ];

  it("finds blanks (null, undefined, empty string)", () => {
    const result = filterByCriteria(testCells, "blanks");
    expect(result).toHaveLength(3); // null at (0,2), "" with formula at (0,3), "" at (1,2)
  });

  it("finds formulas", () => {
    const result = filterByCriteria(testCells, "formulas");
    expect(result).toHaveLength(2); // (0,3) and (1,3)
  });

  it("finds constants (non-formula, non-blank)", () => {
    const result = filterByCriteria(testCells, "constants");
    // 42, "hello", true, 0(error)
    expect(result).toHaveLength(4);
  });

  it("finds errors", () => {
    const result = filterByCriteria(testCells, "errors");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ row: 1, col: 1 });
  });

  it("finds numbers", () => {
    const result = filterByCriteria(testCells, "numbers");
    expect(result).toHaveLength(3); // 42, 0, 3.14
  });

  it("finds text", () => {
    const result = filterByCriteria(testCells, "text");
    expect(result).toHaveLength(1); // "hello"
  });

  it("finds logicals", () => {
    const result = filterByCriteria(testCells, "logicals");
    expect(result).toHaveLength(1); // true
  });

  it("combined criteria: numbers AND constants", () => {
    const result = filterByCriteria(testCells, "numbers", "constants");
    // numbers: 42, 0, 3.14; constants: 42, "hello", true, 0
    // union: 42, "hello", true, 0, 3.14 = 5
    expect(result).toHaveLength(5);
  });
});

// ============================================================================
// Edge cases: all match, none match, single cell
// ============================================================================

describe("edge cases", () => {
  it("all cells match criteria", () => {
    const cells: CellData[] = [
      { row: 0, col: 0, value: null },
      { row: 0, col: 1, value: "" },
      { row: 1, col: 0, value: undefined },
    ];
    const result = filterByCriteria(cells, "blanks");
    expect(result).toHaveLength(3);
  });

  it("no cells match criteria", () => {
    const cells: CellData[] = [
      { row: 0, col: 0, value: 1 },
      { row: 0, col: 1, value: 2 },
    ];
    const result = filterByCriteria(cells, "blanks");
    expect(result).toHaveLength(0);
  });

  it("single cell input", () => {
    const result = computeSelectionFromCells([{ row: 42, col: 7 }])!;
    expect(result.startRow).toBe(42);
    expect(result.endRow).toBe(42);
    expect(result.startCol).toBe(7);
    expect(result.endCol).toBe(7);
    expect(result.additionalRanges).toHaveLength(1);
  });

  it("empty input returns null", () => {
    expect(computeSelectionFromCells([])).toBeNull();
  });

  it("no matching criteria yields empty array for selection", () => {
    const found = filterByCriteria(
      [{ row: 0, col: 0, value: 42 }],
      "blanks",
    );
    const selection = computeSelectionFromCells(found);
    expect(selection).toBeNull();
  });
});

// ============================================================================
// normalizeSearchRange - additional cases
// ============================================================================

describe("normalizeSearchRange - additional cases", () => {
  it("returns undefined for 0,0 to 0,0", () => {
    expect(
      normalizeSearchRange({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }),
    ).toBeUndefined();
  });

  it("normalizes when only rows are inverted", () => {
    const result = normalizeSearchRange({
      startRow: 50,
      startCol: 0,
      endRow: 10,
      endCol: 5,
    })!;
    expect(result.startRow).toBe(10);
    expect(result.endRow).toBe(50);
    expect(result.startCol).toBe(0);
    expect(result.endCol).toBe(5);
  });

  it("normalizes when only columns are inverted", () => {
    const result = normalizeSearchRange({
      startRow: 0,
      startCol: 10,
      endRow: 5,
      endCol: 2,
    })!;
    expect(result.startCol).toBe(2);
    expect(result.endCol).toBe(10);
  });

  it("handles very large range coordinates", () => {
    const result = normalizeSearchRange({
      startRow: 1048575,
      startCol: 16383,
      endRow: 0,
      endCol: 0,
    })!;
    expect(result.startRow).toBe(0);
    expect(result.endRow).toBe(1048575);
    expect(result.startCol).toBe(0);
    expect(result.endCol).toBe(16383);
  });
});
