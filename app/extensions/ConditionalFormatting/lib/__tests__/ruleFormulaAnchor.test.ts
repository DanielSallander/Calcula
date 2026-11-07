//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/ruleFormulaAnchor.test.ts
// PURPOSE: BUG-0748 (dialog part) -- a rule formula typed in New Rule (or a
//          Highlight Cells Rules dialog) is relative to the ACTIVE cell and is
//          stored for the rule's anchor, wrapping round the sheet's edge.
// CONTEXT: Excel 16 [LIVE] 2026-11-06 (lane uiforms probe4): A2:E10 selected
//          with B5 active -- New Rule "=$C5>100" is stored =$C2>100, "=A4<>B5"
//          is stored =XFD1<>A2, and Greater Than "=$C5" is stored =$C2. The
//          shift is the backend's fill shifter (here its test double, which
//          keeps the contract the backend's own tests pin -- checked first).

import { describe, it, expect, vi } from "vitest";
import { fakeShift, fakeShiftBatch } from "./fakeFillShifter";
import {
  moveRuleFormula,
  mergeShiftVariants,
  ruleForAnchor,
  ruleAnchorOf,
} from "../ruleFormulaAnchor";

describe("the test double keeps the backend fill shifter's pinned contract", () => {
  // The cases are commands/structure.rs's own assertions.
  it.each([
    ["=A1*1.5", 1, 1, "=B2*1.5"],
    ["=A1", -3, 0, "=#REF!"],
    ["=B1", 0, -2, "=#REF!"],
    ["=A1+B1", -3, 0, "=#REF!+#REF!"],
    ["=A1+B9", -3, 0, "=#REF!+B6"],
    ["=XFD1", 0, 1, "=#REF!"],
    ["=A1048576", 1, 0, "=#REF!"],
    ["=XFC1", 0, 1, "=XFD1"],
    ["=SUM(A1:A5)", -3, 0, "=SUM(#REF!)"],
    ["=SUM(A1:$A$5)", -3, 0, "=SUM(#REF!)"],
    ["=SUM(A5:A9)", 1, 0, "=SUM(A6:A10)"],
    ["=SUM(1:1)", 1, 0, "=SUM(2:2)"],
    ["=SUM(1:3)", -1, 0, "=SUM(#REF!)"],
    ["=SUM(A:A)", 0, 1, "=SUM(B:B)"],
    ["=SUM($A:$A)", 0, 1, "=SUM($A:$A)"],
    ["=SUM(A:A)", 3, 0, "=SUM(A:A)"],
  ])("%s moved (%i, %i) is %s", (formula, dr, dc, expected) => {
    expect(fakeShift(formula, dr, dc)).toBe(expected);
  });
});

describe("a New Rule entry is restated for the rule's anchor (Excel's rule)", () => {
  const A2_E10 = [{ startRow: 1, startCol: 0, endRow: 9, endCol: 4 }];
  const B5 = { row: 4, col: 1 };

  it("[LIVE] =$C5>100 typed with B5 active in A2:E10 is stored =$C2>100", async () => {
    const rule = await ruleForAnchor({ type: "expression", formula: "=$C5>100" }, A2_E10, B5, fakeShiftBatch);
    expect(rule).toEqual({ type: "expression", formula: "=$C2>100" });
  });

  it("[LIVE] =A4<>B5 typed with B5 active is stored =XFD1<>A2: a reference past the edge WRAPS", async () => {
    const rule = await ruleForAnchor({ type: "expression", formula: "=A4<>B5" }, A2_E10, B5, fakeShiftBatch);
    expect(rule).toEqual({ type: "expression", formula: "=XFD1<>A2" });
  });

  it("[LIVE] a Greater Than operand =$C5 is stored =$C2; a plain value operand is a value, untouched", async () => {
    const rule = await ruleForAnchor(
      { type: "cellValue", operator: "between", value1: "=$C5", value2: "10" },
      A2_E10,
      B5,
      fakeShiftBatch,
    );
    expect(rule).toEqual({ type: "cellValue", operator: "between", value1: "=$C2", value2: "10" });
  });

  it("typed at the anchor itself (or with no active cell known) nothing moves and the shifter is not asked", async () => {
    const shift = vi.fn(fakeShiftBatch);
    const typed = { type: "expression" as const, formula: "=A2>1" };
    expect(await ruleForAnchor(typed, A2_E10, { row: 1, col: 0 }, shift)).toBe(typed);
    expect(await ruleForAnchor(typed, A2_E10, null, shift)).toBe(typed);
    expect(shift).not.toHaveBeenCalled();
  });

  it("a rule kind with no position-relative formula is untouched", async () => {
    const top = { type: "topBottom" as const, ruleType: "topItems" as const, rank: 10 };
    expect(await ruleForAnchor(top, A2_E10, B5, fakeShiftBatch)).toBe(top);
  });

  it("the anchor of several ranges is the top-left of their bounding rectangle", () => {
    expect(ruleAnchorOf([
      { startRow: 5, startCol: 4, endRow: 6, endCol: 5 },
      { startRow: 2, startCol: 1, endRow: 3, endCol: 2 },
    ])).toEqual({ row: 2, col: 1 });
    expect(ruleAnchorOf([])).toBeNull();
  });
});

describe("the wrap is exact, or refused -- never a #REF! the user did not type", () => {
  it("a row past the top wraps to the bottom, a column past A to XFD, both at once", async () => {
    expect(await moveRuleFormula("=A1<>A2", -1, 0, fakeShiftBatch)).toBe("=A1048576<>A1");
    expect(await moveRuleFormula("=A1>0", 0, -1, fakeShiftBatch)).toBe("=XFD1>0");
    expect(await moveRuleFormula("=B2+A1", -1, -1, fakeShiftBatch)).toBe("=A1+XFD1048576");
    // ...and past the bottom / right edge round to the top / left.
    expect(await moveRuleFormula("=A1048576+XFD1", 1, 1, fakeShiftBatch)).toBe("=B1+A2");
  });

  it("absolute parts never move; a #REF! the formula already had is kept, not counted as a wrap", async () => {
    expect(await moveRuleFormula("=$A$1+A1", -1, 0, fakeShiftBatch)).toBe("=$A$1+A1048576");
    expect(await moveRuleFormula("=#REF!+A2", -1, 0, fakeShiftBatch)).toBe("=#REF!+A1");
  });

  it("text inside a string is not a reference", async () => {
    expect(await moveRuleFormula('=A2="A2"', -1, 0, fakeShiftBatch)).toBe('=A1="A2"');
  });

  it("a range whose two ends would wrap apart has no exact form: null", async () => {
    expect(await moveRuleFormula("=SUM(A1:A3)>0", -2, 0, fakeShiftBatch)).toBeNull();
    // A range that wraps WHOLE is fine.
    expect(await moveRuleFormula("=SUM(A1:A2)>0", -2, 0, fakeShiftBatch)).toBe("=SUM(A1048575:A1048576)>0");
  });

  it("an answer that does not move back to the formula is refused (the merge is checked)", async () => {
    // A shifter that answers the wrapped variant with garbage at the site.
    const liar = async (inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>) =>
      inputs.map((i) => (Math.abs(i.rowDelta) > 1000 ? fakeShift(i.formula, i.rowDelta, i.colDelta).replace("A1048576", "A7") : fakeShift(i.formula, i.rowDelta, i.colDelta)));
    expect(await moveRuleFormula("=A1<>A2", -1, 0, liar)).toBeNull();
  });
});

describe("mergeShiftVariants", () => {
  it("takes each site from the variant that kept it", () => {
    expect(mergeShiftVariants(["=#REF!<>A1", "=A1048576<>#REF!"])).toBe("=A1048576<>A1");
    expect(mergeShiftVariants(["=SUM(#REF!,C$3)", "=SUM(D:E,C$3)"])).toBe("=SUM(D:E,C$3)");
  });

  it("refuses variants that differ outside a site, or a site no variant kept", () => {
    expect(mergeShiftVariants(["=A1+1", "=A1+2"])).toBeNull();
    expect(mergeShiftVariants(["=#REF!", "=#REF!"])).toBe("=#REF!");
    expect(mergeShiftVariants(["=A1", "=B1"])).toBeNull();
  });
});
