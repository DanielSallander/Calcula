//! FILENAME: app/src/core/lib/__tests__/r1c1.test.ts
// PURPOSE: Validate the frontend A1<->R1C1 conversion (formula bar + show-formulas
//          display and the edit round-trip) against the Rust reference behaviour.

import { describe, it, expect } from "vitest";
import {
  refA1ToR1C1,
  refR1C1ToA1,
  formulaA1ToR1C1,
  formulaR1C1ToA1,
  colIndexToLetter,
  letterToColIndex,
} from "../r1c1";

describe("column index helpers", () => {
  it("round-trips columns", () => {
    for (const col of [0, 1, 25, 26, 27, 51, 52, 701, 702, 16383]) {
      expect(letterToColIndex(colIndexToLetter(col))).toBe(col);
    }
    expect(colIndexToLetter(0)).toBe("A");
    expect(colIndexToLetter(25)).toBe("Z");
    expect(colIndexToLetter(26)).toBe("AA");
  });
});

describe("single reference conversion (base E6 = row 5, col 4)", () => {
  const R = 5;
  const C = 4;
  it("relative self / neighbours", () => {
    expect(refA1ToR1C1("E6", R, C)).toBe("RC");
    expect(refA1ToR1C1("E5", R, C)).toBe("R[-1]C");
    expect(refA1ToR1C1("F6", R, C)).toBe("RC[1]");
    expect(refA1ToR1C1("A1", R, C)).toBe("R[-5]C[-4]");
  });
  it("absolute / mixed", () => {
    expect(refA1ToR1C1("$E$6", R, C)).toBe("R6C5");
    expect(refA1ToR1C1("$E6", R, C)).toBe("RC5");
    expect(refA1ToR1C1("E$6", R, C)).toBe("R6C");
  });
  it("round-trips back to A1", () => {
    for (const a1 of ["E6", "E5", "F6", "A1", "$E$6", "$E6", "E$6", "Z100"]) {
      expect(refR1C1ToA1(refA1ToR1C1(a1, R, C), R, C)).toBe(a1);
    }
  });
});

describe("formula conversion", () => {
  it("converts references at cell A1 (0,0)", () => {
    expect(formulaA1ToR1C1("=B1", 0, 0)).toBe("=RC[1]");
    expect(formulaA1ToR1C1("=A1+A2", 0, 0)).toBe("=RC+R[1]C");
    expect(formulaA1ToR1C1("=SUM(A1:B2)", 0, 0)).toBe("=SUM(RC:R[1]C[1])");
  });

  it("round-trips A1 -> R1C1 -> A1", () => {
    const base: [number, number] = [5, 4]; // E6
    for (const f of ["=E6+4", "=SUM(A1:B2)*E6", "=$A$1+E5", "=IF(F6>0,E6,A1)"]) {
      const r1c1 = formulaA1ToR1C1(f, base[0], base[1]);
      expect(formulaR1C1ToA1(r1c1, base[0], base[1])).toBe(f);
    }
  });

  it("preserves text inside string literals", () => {
    expect(formulaA1ToR1C1('="A1 is a cell"&A1', 0, 0)).toBe('="A1 is a cell"&RC');
    expect(formulaR1C1ToA1('="use RC here"&RC', 0, 0)).toBe('="use RC here"&A1');
  });

  it("does not mistake function names for references", () => {
    // LOG10 ends in digits but is followed by "(" — must not be converted.
    expect(formulaA1ToR1C1("=LOG10(A1)", 0, 0)).toBe("=LOG10(RC)");
    expect(formulaA1ToR1C1("=SUM(A1,B1)", 0, 0)).toBe("=SUM(RC,RC[1])");
  });

  it("R1C1 input converts back to A1 for storage", () => {
    // User types R1C1 while editing cell E6 (row 5, col 4).
    expect(formulaR1C1ToA1("=RC+4", 5, 4)).toBe("=E6+4");
    expect(formulaR1C1ToA1("=R[-1]C", 5, 4)).toBe("=E5");
    expect(formulaR1C1ToA1("=R6C5", 5, 4)).toBe("=$E$6");
  });

  it("leaves already-A1 refs untouched when converting R1C1->A1 (mixed input)", () => {
    // A ref inserted by clicking (A1) mixed with a typed R1C1 ref.
    expect(formulaR1C1ToA1("=R[-1]C+B2", 5, 4)).toBe("=E5+B2");
  });
});
