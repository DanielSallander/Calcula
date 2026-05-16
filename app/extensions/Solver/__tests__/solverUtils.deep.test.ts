//! FILENAME: app/extensions/Solver/__tests__/solverUtils.deep.test.ts
// PURPOSE: Deep tests for Solver utilities - large cell lists, all operators, edge cases.

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
  operatorLabels,
} from "../lib/solverUtils";
import type { ConstraintEntry } from "../lib/solverUtils";

// ============================================================================
// parseCellRef - deeper edge cases
// ============================================================================

describe("parseCellRef deep", () => {
  it("parses BA1 -> (0, 52)", () => {
    expect(parseCellRef("BA1")).toEqual({ row: 0, col: 52 });
  });

  it("parses XFD1 (Excel max column)", () => {
    // XFD = 24*26*26 + 6*26 + 4 - 1 = 16383
    const result = parseCellRef("XFD1");
    expect(result).not.toBeNull();
    expect(result!.col).toBe(16383);
  });

  it("parses Z1 -> (0, 25)", () => {
    expect(parseCellRef("Z1")).toEqual({ row: 0, col: 25 });
  });

  it("handles tabs and spaces in input", () => {
    expect(parseCellRef(" \t A1 \t ")).toEqual({ row: 0, col: 0 });
  });

  it("returns null for negative-looking row A-1", () => {
    expect(parseCellRef("A-1")).toBeNull();
  });

  it("returns null for decimal row A1.5", () => {
    expect(parseCellRef("A1.5")).toBeNull();
  });
});

// ============================================================================
// formatCellRef - deeper
// ============================================================================

describe("formatCellRef deep", () => {
  it("formats column 26 as $AA$1", () => {
    expect(formatCellRef(0, 26)).toBe("$AA$1");
  });

  it("formats large row as $A$10000", () => {
    expect(formatCellRef(9999, 0)).toBe("$A$10000");
  });

  it("round-trips with parseCellRef", () => {
    const ref = formatCellRef(49, 3);
    const parsed = parseCellRef(ref);
    expect(parsed).toEqual({ row: 49, col: 3 });
  });

  it("round-trips multi-letter column", () => {
    const ref = formatCellRef(0, 51);
    const parsed = parseCellRef(ref);
    expect(parsed).toEqual({ row: 0, col: 51 });
  });
});

// ============================================================================
// parseCellList - large inputs and edge cases
// ============================================================================

describe("parseCellList deep", () => {
  it("parses 100+ individual cells", () => {
    // Generate A1,A2,...,A120
    const refs = Array.from({ length: 120 }, (_, i) => `A${i + 1}`).join(",");
    const result = parseCellList(refs);
    expect(result).toHaveLength(120);
    expect(result[0]).toEqual({ row: 0, col: 0 });
    expect(result[119]).toEqual({ row: 119, col: 0 });
  });

  it("expands large range A1:A500 to 500 cells", () => {
    const result = parseCellList("A1:A500");
    expect(result).toHaveLength(500);
    expect(result[0]).toEqual({ row: 0, col: 0 });
    expect(result[499]).toEqual({ row: 499, col: 0 });
  });

  it("expands 2D range A1:J10 to 100 cells", () => {
    const result = parseCellList("A1:J10");
    expect(result).toHaveLength(100);
  });

  it("handles multiple ranges summing to many cells", () => {
    const result = parseCellList("A1:A50, B1:B50, C1:C50");
    expect(result).toHaveLength(150);
  });

  it("handles reversed range Z10:A1", () => {
    const result = parseCellList("B3:A1");
    expect(result).toHaveLength(6); // 3 rows x 2 cols
  });

  it("skips empty parts from trailing comma", () => {
    const result = parseCellList("A1,B1,");
    expect(result).toHaveLength(2);
  });

  it("skips empty parts from leading comma", () => {
    const result = parseCellList(",A1,B1");
    expect(result).toHaveLength(2);
  });

  it("skips empty parts from double comma", () => {
    const result = parseCellList("A1,,B1");
    expect(result).toHaveLength(2);
  });

  it("handles single-cell range A5:A5", () => {
    const result = parseCellList("A5:A5");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ row: 4, col: 0 });
  });

  it("handles absolute refs in ranges $A$1:$C$3", () => {
    const result = parseCellList("$A$1:$C$3");
    expect(result).toHaveLength(9);
  });

  it("produces cells in row-major order", () => {
    const result = parseCellList("A1:B2");
    // Should iterate rows then cols: (0,0), (0,1), (1,0), (1,1)
    expect(result[0]).toEqual({ row: 0, col: 0 });
    expect(result[1]).toEqual({ row: 0, col: 1 });
    expect(result[2]).toEqual({ row: 1, col: 0 });
    expect(result[3]).toEqual({ row: 1, col: 1 });
  });
});

// ============================================================================
// formatConstraint - all operators
// ============================================================================

describe("formatConstraint deep", () => {
  const allOperators: Array<{ op: ConstraintEntry["operator"]; label: string }> = [
    { op: "lessEqual", label: "<=" },
    { op: "greaterEqual", label: ">=" },
    { op: "equal", label: "=" },
    { op: "integer", label: "int" },
    { op: "binary", label: "bin" },
    { op: "allDifferent", label: "dif" },
  ];

  it.each(allOperators)("formats $op operator correctly", ({ op, label }) => {
    const result = formatConstraint({ cellRef: "$X$1", operator: op, rhsRef: "$Y$1" });
    if (op === "integer" || op === "binary" || op === "allDifferent") {
      expect(result).toBe(`$X$1 = ${label}`);
    } else {
      expect(result).toBe(`$X$1 ${label} $Y$1`);
    }
  });

  it("integer/binary/allDifferent ignore rhsRef value", () => {
    expect(formatConstraint({ cellRef: "$A$1", operator: "integer", rhsRef: "999" }))
      .toBe("$A$1 = int");
    expect(formatConstraint({ cellRef: "$A$1", operator: "binary", rhsRef: "whatever" }))
      .toBe("$A$1 = bin");
    expect(formatConstraint({ cellRef: "$A$1", operator: "allDifferent", rhsRef: "$Z$99" }))
      .toBe("$A$1 = dif");
  });

  it("handles numeric rhs for comparison operators", () => {
    expect(formatConstraint({ cellRef: "$A$1", operator: "lessEqual", rhsRef: "100" }))
      .toBe("$A$1 <= 100");
    expect(formatConstraint({ cellRef: "$A$1", operator: "greaterEqual", rhsRef: "0" }))
      .toBe("$A$1 >= 0");
    expect(formatConstraint({ cellRef: "$A$1", operator: "equal", rhsRef: "42" }))
      .toBe("$A$1 = 42");
  });

  it("handles range cell ref for allDifferent", () => {
    const result = formatConstraint({ cellRef: "$A$1:$A$100", operator: "allDifferent", rhsRef: "" });
    expect(result).toBe("$A$1:$A$100 = dif");
  });
});

// ============================================================================
// operatorLabels - completeness
// ============================================================================

describe("operatorLabels", () => {
  it("has exactly 6 operators", () => {
    expect(Object.keys(operatorLabels)).toHaveLength(6);
  });

  it("maps lessEqual to <=", () => {
    expect(operatorLabels.lessEqual).toBe("<=");
  });

  it("maps greaterEqual to >=", () => {
    expect(operatorLabels.greaterEqual).toBe(">=");
  });

  it("maps equal to =", () => {
    expect(operatorLabels.equal).toBe("=");
  });

  it("maps integer to int", () => {
    expect(operatorLabels.integer).toBe("int");
  });

  it("maps binary to bin", () => {
    expect(operatorLabels.binary).toBe("bin");
  });

  it("maps allDifferent to dif", () => {
    expect(operatorLabels.allDifferent).toBe("dif");
  });
});
