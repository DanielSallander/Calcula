//! FILENAME: app/src/core/lib/__tests__/formulaRefParserDeletedSheet.test.ts
// PURPOSE: A reference to a DELETED sheet (`=#REF!A1`) highlights nothing.
// CONTEXT: NEW-refparser-ref-sheet (round D). Since round C the backend writes
//          Excel's text for a reference whose sheet was deleted -- `=#REF!A1`,
//          `=SUM(#REF!A1:A3)` (parser::ast::REF_ERROR_SHEET). The reference
//          reader skipped the `#` and read `REF!` as a sheet prefix, so editing
//          such a formula highlighted A1 on a real sheet called REF (and on no
//          sheet at all, A1 of an unknown "REF"), and the highlight could be
//          dragged, rewriting the reference to `REF!B2`. Excel colours nothing
//          in `=#REF!A1`. A sheet that is really CALLED `#REF!` is quoted
//          (`'#REF!'!A1`) and is still read as that sheet.
//
// SABOTAGE: drop the `isDeletedSheetPrefix` skip from both readers.

import { describe, it, expect } from "vitest";
import {
  findReferenceAtCell,
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
} from "../formulaRefParser";

describe("a reference to a deleted sheet (#REF!A1)", () => {
  const cases: Array<[string, Array<{ sheetName?: string; startRow: number; startCol: number }>]> = [
    ["=#REF!A1", []],
    ["=SUM(#REF!A1:A3)+1", []],
    ["=#REF!$B$2*2", []],
    ["=#ref!A1", []],
    ["=B2+#REF!A1", [{ startRow: 1, startCol: 1 }]],
    ["=#REF!A1+Data!C3", [{ sheetName: "Data", startRow: 2, startCol: 2 }]],
    ["='#REF!'!A1", [{ sheetName: "#REF!", startRow: 0, startCol: 0 }]],
    ["=REF!A1", [{ sheetName: "REF", startRow: 0, startCol: 0 }]],
  ];

  for (const [formula, expected] of cases) {
    it(`highlights only real references in ${formula}`, () => {
      for (const refs of [parseFormulaReferences(formula), parseFormulaReferencesWithPositions(formula)]) {
        expect(
          refs.map((r) => ({ sheetName: r.sheetName, startRow: r.startRow, startCol: r.startCol })),
        ).toEqual(expected.map((e) => ({ sheetName: e.sheetName, startRow: e.startRow, startCol: e.startCol })));
      }
    });
  }

  it("nothing on a real sheet named REF can be picked up as the deleted reference", () => {
    const refs = parseFormulaReferencesWithPositions("=#REF!A1");
    expect(findReferenceAtCell(refs, 0, 0, "REF", "Sheet1")).toBe(-1);
  });

  it("an error value alone still parses to nothing", () => {
    expect(parseFormulaReferences("=A1+#REF!+B2").map((r) => r.startRow)).toEqual([0, 1]);
  });
});
