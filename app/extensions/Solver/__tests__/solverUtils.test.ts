//! FILENAME: app/extensions/Solver/__tests__/solverUtils.test.ts
// PURPOSE: Tests for Solver utility functions (cell parsing, constraint formatting).

import { describe, it, expect, vi } from "vitest";

vi.mock("@api", () => ({
  columnToLetter: (col: number) => {
    let result = "";
    let c = col;
    while (c >= 0) {
      result = String.fromCharCode(65 + (c % 26)) + result;
      c = Math.floor(c / 26) - 1;
    }
    return result;
  },
}));

import {
  parseCellRef,
  formatCellRef,
  parseCellList,
  formatConstraint,
} from "../lib/solverUtils";

// ============================================================================
// parseCellRef
// ============================================================================

describe("parseCellRef", () => {
  it("parses simple reference A1 -> (0, 0)", () => {
    expect(parseCellRef("A1")).toEqual({ row: 0, col: 0 });
  });

  it("parses B3 -> (2, 1)", () => {
    expect(parseCellRef("B3")).toEqual({ row: 2, col: 1 });
  });

  it("handles absolute references $C$5", () => {
    expect(parseCellRef("$C$5")).toEqual({ row: 4, col: 2 });
  });

  it("handles lowercase", () => {
    expect(parseCellRef("d10")).toEqual({ row: 9, col: 3 });
  });

  it("handles multi-letter columns AA1", () => {
    expect(parseCellRef("AA1")).toEqual({ row: 0, col: 26 });
  });

  it("handles AZ1", () => {
    expect(parseCellRef("AZ1")).toEqual({ row: 0, col: 51 });
  });

  it("returns null for empty string", () => {
    expect(parseCellRef("")).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(parseCellRef("123")).toBeNull();
    expect(parseCellRef("!@#")).toBeNull();
    expect(parseCellRef("A0")).toBeNull(); // row 0 is invalid (1-based)
    expect(parseCellRef("A-1")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(parseCellRef("  A1  ")).toEqual({ row: 0, col: 0 });
  });
});

// ============================================================================
// formatCellRef
// ============================================================================

describe("formatCellRef", () => {
  it("formats (0,0) as $A$1", () => {
    expect(formatCellRef(0, 0)).toBe("$A$1");
  });

  it("formats (4,2) as $C$5", () => {
    expect(formatCellRef(4, 2)).toBe("$C$5");
  });
});

// ============================================================================
// parseCellList
// ============================================================================

describe("parseCellList", () => {
  it("parses single cell", () => {
    expect(parseCellList("A1")).toEqual([{ row: 0, col: 0 }]);
  });

  it("parses comma-separated cells", () => {
    const result = parseCellList("A1, B2, C3");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ row: 0, col: 0 });
    expect(result[1]).toEqual({ row: 1, col: 1 });
    expect(result[2]).toEqual({ row: 2, col: 2 });
  });

  it("expands a range A1:B2 into 4 cells", () => {
    const result = parseCellList("A1:B2");
    expect(result).toHaveLength(4);
    expect(result).toContainEqual({ row: 0, col: 0 });
    expect(result).toContainEqual({ row: 0, col: 1 });
    expect(result).toContainEqual({ row: 1, col: 0 });
    expect(result).toContainEqual({ row: 1, col: 1 });
  });

  it("handles mixed cells and ranges", () => {
    const result = parseCellList("A1, C1:C3");
    expect(result).toHaveLength(4); // A1 + C1,C2,C3
  });

  it("skips invalid references silently", () => {
    const result = parseCellList("A1, INVALID, B2");
    expect(result).toHaveLength(2);
  });

  it("returns empty for empty string", () => {
    expect(parseCellList("")).toEqual([]);
  });

  it("handles reversed range (D5:A1)", () => {
    const result = parseCellList("B2:A1");
    expect(result).toHaveLength(4);
  });
});

// ============================================================================
// formatConstraint
// ============================================================================

describe("formatConstraint", () => {
  it("formats lessEqual constraint", () => {
    expect(formatConstraint({ cellRef: "$A$1", operator: "lessEqual", rhsRef: "$B$1" }))
      .toBe("$A$1 <= $B$1");
  });

  it("formats greaterEqual constraint", () => {
    expect(formatConstraint({ cellRef: "$A$1", operator: "greaterEqual", rhsRef: "100" }))
      .toBe("$A$1 >= 100");
  });

  it("formats equal constraint", () => {
    expect(formatConstraint({ cellRef: "$A$1", operator: "equal", rhsRef: "$C$1" }))
      .toBe("$A$1 = $C$1");
  });

  it("formats integer constraint (no rhs)", () => {
    expect(formatConstraint({ cellRef: "$A$1", operator: "integer", rhsRef: "" }))
      .toBe("$A$1 = int");
  });

  it("formats binary constraint (no rhs)", () => {
    expect(formatConstraint({ cellRef: "$A$1", operator: "binary", rhsRef: "" }))
      .toBe("$A$1 = bin");
  });

  it("formats allDifferent constraint", () => {
    expect(formatConstraint({ cellRef: "$A$1:$A$5", operator: "allDifferent", rhsRef: "" }))
      .toBe("$A$1:$A$5 = dif");
  });
});
