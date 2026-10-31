//! FILENAME: app/src/api/__tests__/sheetNameCallSites.test.ts
// PURPOSE: The api/core lookups that compared sheet names with toLowerCase now
//          answer by Excel's sheet-name case rule (@api/sheetNames), through the
//          REAL functions. Each is asked one pair JavaScript's toLowerCase
//          MERGES and Excel keeps apart [LIVE] -- the Angstrom sign U+212B
//          against a-ring U+00E5 -- and one it SPLITS and Excel calls one name
//          [LIVE] -- sigma U+03C3 against capital sigma U+03A3, which JS
//          lowercases after a letter to FINAL sigma U+03C2.

import { describe, it, expect } from "vitest";
import { resolveSheetRefIn } from "../scriptHost/host";
import { namesTheActiveSheet } from "../scriptHost/scriptPreview/formSources";
import { matchPageNavigatorOverride } from "../buttonControlService";
import { findReferenceAtCell, parseFormulaReferencesWithPositions } from "../../core/lib/formulaRefParser";

const A_RING = "Qå";
const ANGSTROM = "QÅ";
const SIGMA = "Qσ";
const CAPITAL_SIGMA = "QΣ";

describe("api/core sheet-name lookups follow Excel's case rule", () => {
  it("a script's sheet reference (resolveSheetRefIn)", () => {
    const sheets = [
      { index: 0, name: A_RING },
      { index: 1, name: CAPITAL_SIGMA },
    ] as Parameters<typeof resolveSheetRefIn>[0];
    expect(() => resolveSheetRefIn(sheets, ANGSTROM, "t"), "Angstrom sign named the a-ring sheet").toThrow(
      /no sheet named/,
    );
    expect(resolveSheetRefIn(sheets, SIGMA, "t"), "sigma did not find the capital-sigma sheet").toBe(1);
  });

  it("a script form's sheet-qualified source (namesTheActiveSheet)", () => {
    expect(namesTheActiveSheet(ANGSTROM, A_RING)).toBe(false);
    expect(namesTheActiveSheet(SIGMA, CAPITAL_SIGMA)).toBe(true);
  });

  it("a page navigator override found by name (matchPageNavigatorOverride)", () => {
    const base = { sheetId: "", text: "x" };
    const overrides = [{ ...base, sheetName: ANGSTROM }, { ...base, sheetName: SIGMA, text: "y" }];
    expect(matchPageNavigatorOverride(overrides, { name: A_RING }, [])).toBeUndefined();
    expect(matchPageNavigatorOverride(overrides, { name: CAPITAL_SIGMA }, [])?.text).toBe("y");
  });

  it("the formula-reference hit test on the viewed sheet (findReferenceAtCell)", () => {
    const toARing = parseFormulaReferencesWithPositions(`='${A_RING}'!A1`);
    expect(toARing.length).toBe(1);
    expect(findReferenceAtCell(toARing, 0, 0, ANGSTROM, "Other"), "a-ring ref hit on the Angstrom sheet").toBe(-1);
    const toSigma = parseFormulaReferencesWithPositions(`='${SIGMA}'!A1`);
    expect(findReferenceAtCell(toSigma, 0, 0, CAPITAL_SIGMA, "Other"), "sigma ref missed on its own sheet").toBe(0);
  });
});
