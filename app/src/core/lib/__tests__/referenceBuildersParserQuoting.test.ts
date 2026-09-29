//! FILENAME: app/src/core/lib/__tests__/referenceBuildersParserQuoting.test.ts
// PURPOSE: Every reference Core BUILDS for a formula spells its sheet prefix by
//          the PARSER's rule (quoteSheetNameForFormula, core/lib/
//          formulaEditTarget.ts, which mirrors the backend's
//          `is_bare_sheet_name` in core/engine/src/ast_render.rs):
//            - gridRenderer/references/conversion.ts -- formatSheetName,
//              createSheetPrefix and the six builders over them: Core's own
//              cross-sheet picks (useEditing), the header picks, the chart text
//              editor (overlayTextEditor.ts);
//            - formulaRefParser.ts -- buildCellReference / buildRangeReference,
//              a reference MOVED or RESIZED by dragging its highlight.
// CONTEXT: W13 (wave C; wb-edit fixup, new defect 8). Both kept a display rule
//          that quoted only whitespace, ' ! [ ] and a leading digit, so a pick
//          on a sheet named Q1-2026 wrote `Q1-2026!A1`, TRUE wrote `TRUE!A1`
//          and `Q1.` wrote `Q1.!A1` -- none of which the parser reads back
//          (quoteSheetNameForFormula.test.ts lists the parser's verdict for each
//          name used here). The formula the user was building failed on Enter.

import { describe, it, expect } from "vitest";
import {
  formatSheetName,
  createSheetPrefix,
  cellToReference,
  rangeToReference,
  columnToReference,
  columnRangeToReference,
  rowToReference,
  rowRangeToReference,
} from "../gridRenderer/references/conversion";
import { buildCellReference, buildRangeReference } from "../formulaRefParser";
import { quoteSheetNameForFormula } from "../formulaEditTarget";

/** Names the parser REJECTS bare (see quoteSheetNameForFormula.test.ts). */
const MUST_QUOTE = ["Q1-2026", "TRUE", "false", "Q1.", "a..b", "Sales(EU)", "Tab+1", "R&D", "Å"];
/** Names the parser reads bare -- the default names among them. */
const BARE = ["Sheet1", "Sheet.1", "Q1_2026", "_x", "A1"];

describe("conversion.ts spells a sheet by the parser's rule", () => {
  it.each(MUST_QUOTE)("formatSheetName(%s) quotes it", (name) => {
    expect(formatSheetName(name)).toBe(`'${name}'`);
  });

  it.each(BARE)("formatSheetName(%s) leaves it bare", (name) => {
    expect(formatSheetName(name)).toBe(name);
  });

  it("is the parser's rule for every name, not a second copy that drifts", () => {
    for (const name of [...MUST_QUOTE, ...BARE, "My Sheet", "Bob's", "2024Budget", "Data!", "Sheet[1]"]) {
      expect(formatSheetName(name), name).toBe(quoteSheetNameForFormula(name));
    }
  });

  it("every builder carries the quoted prefix for a sheet the parser needs quoted", () => {
    expect(createSheetPrefix("Q1-2026", "Sheet1")).toBe("'Q1-2026'!");
    expect(cellToReference(0, 0, "TRUE", "Sheet1")).toBe("'TRUE'!A1");
    expect(rangeToReference(0, 0, 2, 1, "Q1.", null)).toBe("'Q1.'!A1:B3");
    expect(columnToReference(2, "R&D", "Sheet1")).toBe("'R&D'!C:C");
    expect(columnRangeToReference(0, 2, "Sales(EU)", "Sheet1")).toBe("'Sales(EU)'!A:C");
    expect(rowToReference(3, "false", "Sheet1")).toBe("'false'!4:4");
    expect(rowRangeToReference(0, 4, "Tab+1", "Sheet1")).toBe("'Tab+1'!1:5");
  });

  it("control: the same sheet gets no prefix, a default name a bare one", () => {
    expect(cellToReference(0, 0, "Q1-2026", "Q1-2026")).toBe("A1");
    expect(rangeToReference(0, 0, 0, 0, "Sheet2", "Sheet1")).toBe("Sheet2!A1");
  });
});

describe("formulaRefParser's move/resize builders spell a sheet by the parser's rule", () => {
  it("buildCellReference quotes Q1-2026 and TRUE, keeping the $ markers", () => {
    expect(buildCellReference(2, 2, true, true, "Q1-2026")).toBe("'Q1-2026'!$C$3");
    expect(buildCellReference(0, 0, false, true, "TRUE")).toBe("'TRUE'!A$1");
  });

  it("buildRangeReference quotes Q1. for a range and for a single cell", () => {
    expect(buildRangeReference(0, 0, 3, 1, false, false, true, true, "Q1.")).toBe("'Q1.'!A1:$B$4");
    expect(buildRangeReference(1, 1, 1, 1, false, false, false, false, "Q1.")).toBe("'Q1.'!B2");
  });

  it("control: a bare name stays bare, and no sheet means no prefix", () => {
    expect(buildCellReference(0, 0, false, false, "Sheet2")).toBe("Sheet2!A1");
    expect(buildRangeReference(0, 0, 1, 1, false, false, false, false)).toBe("A1:B2");
  });
});
