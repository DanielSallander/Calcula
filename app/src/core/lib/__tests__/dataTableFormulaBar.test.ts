//! FILENAME: app/src/core/lib/__tests__/dataTableFormulaBar.test.ts
// PURPOSE: BUG-0752 -- the formula bar shows a data table's body as Excel does:
//          `{=TABLE(,A1)}`, never Calcula's identity argument, and in R1C1 with
//          absolute inputs (`{=TABLE(,R1C1)}`) [LIVE, Excel 16 over COM,
//          2026-11-06, dtable/probe1.ps1].
// SABOTAGE: return `formula` unchanged from `dataTableFormulaBarText` -- fails
//           at the first expectation.

import { describe, expect, it } from "vitest";
import { dataTableFormulaBarText } from "../dataTableCopy";

describe("dataTableFormulaBarText", () => {
  it("shows Excel's braces round the marker", () => {
    expect(dataTableFormulaBarText("=TABLE(,A1)", false)).toBe("{=TABLE(,A1)}");
    expect(dataTableFormulaBarText("=TABLE(A1,)", false)).toBe("{=TABLE(A1,)}");
    expect(dataTableFormulaBarText("=TABLE(A1,D1)", false)).toBe("{=TABLE(A1,D1)}");
  });

  it("never shows the identity argument Excel does not have", () => {
    expect(dataTableFormulaBarText("=TABLE(,A1,M2)", false)).toBe("{=TABLE(,A1)}");
    expect(dataTableFormulaBarText("=TABLE(;A1;M2)", false)).toBe("{=TABLE(;A1)}");
  });

  it("writes the inputs as absolute R1C1, as Excel's FormulaR1C1 does", () => {
    expect(dataTableFormulaBarText("=TABLE(,A1)", true)).toBe("{=TABLE(,R1C1)}");
    expect(dataTableFormulaBarText("=TABLE(B3,AA10,M2)", true)).toBe("{=TABLE(R3C2,R10C27)}");
  });

  it("leaves every other formula to the caller", () => {
    expect(dataTableFormulaBarText("=SUM(A1:A3)", false)).toBeNull();
    expect(dataTableFormulaBarText("=TABLES(A1)", false)).toBeNull();
    expect(dataTableFormulaBarText(null, false)).toBeNull();
    expect(dataTableFormulaBarText("12", false)).toBeNull();
  });
});
