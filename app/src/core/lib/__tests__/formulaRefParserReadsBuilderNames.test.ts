//! FILENAME: app/src/core/lib/__tests__/formulaRefParserReadsBuilderNames.test.ts
// PURPOSE: Core's reference READER (formulaRefParser: the reference highlights
//          and the range drag) reads back every sheet name Core's reference
//          BUILDERS write -- the parser's rule, quoteSheetNameForFormula (W13).
// CONTEXT: Review C. W13 moved the builders to the parser's rule, but the
//          reader kept the old grammar: a quoted name was `'[^']*'` (no
//          doubled apostrophe) and a bare name had no dots. So from an edit on
//          Sheet1, a pick of B2 on
//            - `Bob's`   (written `'Bob''s'!B2`) highlighted sheet "s";
//            - `Sheet.1` (written `Sheet.1!B2`)  highlighted B2 on SHEET1;
//            - `Q1.2026` (written `Q1.2026!B2`)  highlighted Q1 AND B2 on Sheet1,
//          no highlight could be dragged on the picked sheet, and dragging the
//          phantom Q1 rewrote the formula to `R2.2026!B2`, a sheet that does
//          not exist. All three formulas parse in the backend.

import { describe, it, expect } from "vitest";
import { rangeToReference } from "../gridRenderer/references/conversion";
import { quoteSheetNameForFormula } from "../formulaEditTarget";
import {
  buildCellReference,
  buildRangeReference,
  findReferenceAtCell,
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  updateFormulaReference,
} from "../formulaRefParser";

const EDIT_SHEET = "Sheet1";

/** Names the parser's rule writes bare, quoted, or with a doubled apostrophe. */
const NAMES = [
  "Sheet2",
  "My Sheet",
  "Q1-2026",
  "Bob's",
  "Sheet.1",
  "Q1.2026",
  "a.b.c",
  "Q1.",
  "TRUE",
  "2024Budget",
  "_x.y_",
];

describe("the reader names the sheet the builder wrote", () => {
  for (const sheet of NAMES) {
    it(`a pick of B2 on ${JSON.stringify(sheet)} highlights B2 on THAT sheet only`, () => {
      const formula = `=SUM(${rangeToReference(1, 1, 1, 1, sheet, EDIT_SHEET)})`;
      const highlights = parseFormulaReferences(formula);
      expect(highlights.map((r) => r.sheetName), formula).toEqual([sheet]);
      expect(highlights[0]).toMatchObject({ startRow: 1, startCol: 1, endRow: 1, endCol: 1 });

      const refs = parseFormulaReferencesWithPositions(formula);
      expect(refs.map((r) => r.sheetName), formula).toEqual([sheet]);
      expect(refs[0].originalText).toBe(`${quoteSheetNameForFormula(sheet)}!B2`);
      // The highlight on the picked sheet is the one a drag grabs.
      expect(findReferenceAtCell(refs, 1, 1, sheet, EDIT_SHEET), formula).toBe(0);
    });

    it(`a range drag on ${JSON.stringify(sheet)} rewrites the cells and keeps the sheet`, () => {
      const formula = `=SUM(${buildRangeReference(1, 1, 3, 2, true, true, false, false, sheet)})*2`;
      const refs = parseFormulaReferencesWithPositions(formula);
      expect(refs.map((r) => r.sheetName), formula).toEqual([sheet]);
      const idx = findReferenceAtCell(refs, 2, 1, sheet, EDIT_SHEET);
      expect(idx, formula).toBe(0);
      const moved = updateFormulaReference(formula, refs[idx], 4, 3);
      expect(moved).toBe(`=SUM(${buildRangeReference(4, 3, 6, 4, true, true, false, false, sheet)})*2`);
    });
  }

  it("a dotted name next to an unqualified reference: two highlights, each on its own sheet", () => {
    const formula = `=${buildCellReference(0, 0, false, false, "Q1.2026")}+C3`;
    expect(parseFormulaReferences(formula).map((r) => [r.sheetName, r.startRow, r.startCol])).toEqual([
      ["Q1.2026", 0, 0],
      [undefined, 2, 2],
    ]);
  });

  it("nothing on the edit's own sheet is referenced by `Q1.2026!B2`: there is no phantom Q1 to drag", () => {
    const formula = `=SUM(${rangeToReference(1, 1, 1, 1, "Q1.2026", EDIT_SHEET)})`;
    const refs = parseFormulaReferencesWithPositions(formula);
    // Q1 on Sheet1 is row 0, column 16.
    expect(findReferenceAtCell(refs, 0, 16, EDIT_SHEET, EDIT_SHEET)).toBe(-1);
  });

  it("3-D prefixes with dotted and quoted halves read as the pair", () => {
    const dotted = parseFormulaReferences("=SUM(Sheet.1:Sheet.3!B2)");
    expect(dotted.map((r) => r.sheetName)).toEqual(["Sheet.1"]);
    const quoted = parseFormulaReferences("=SUM('Bob''s:Q1-2026'!B2)");
    expect(quoted.map((r) => r.sheetName)).toEqual(["Bob's"]);
  });

  it("controls: a dot that ends a word is not a sheet name, and a function's dot is not one either", () => {
    // `Q1.` is not bare (a dot must be followed by a name character): quoted.
    expect(quoteSheetNameForFormula("Q1.")).toBe("'Q1.'");
    // A dotted function name is not a sheet prefix: only its argument is a reference.
    const refs = parseFormulaReferences("=STDEV.S(A1:A5)+Q1.5");
    expect(refs.map((r) => [r.sheetName, r.startRow, r.startCol, r.endRow])).toEqual([
      [undefined, 0, 0, 4],
      [undefined, 0, 16, 0],
    ]);
  });
});
