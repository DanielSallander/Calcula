//! FILENAME: app/extensions/DataValidation/lib/__tests__/listSourceRef.test.ts
// PURPOSE: The Source box is the only way a user can describe an approved list.
//          These tests pin what its text means in BOTH directions.
// CONTEXT: Two silent defects live here. Typing "=$A$1:$A$4" used to build a
//          literal list whose single approved value was the string
//          "=$A$1:$A$4" — the dropdown offered the reference itself. And a
//          range-backed rule made by a script rendered as the pseudo-string
//          "=1:0:4:0", which OK re-saved as a literal: OPENING the dialog
//          destroyed the rule, with no error anywhere.

import { describe, it, expect } from "vitest";
import type { ListSource } from "@api";
import {
  MAX_LIST_SOURCE_CELLS,
  formatListSourceText,
  parseListSourceText,
} from "../listSourceRef";

const SHEETS = ["Sheet1", "Data", "My Sheet", "O'Brien"];
const CURRENT = 0;

describe("parseListSourceText", () => {
  it("reads an '='-prefixed source as a RANGE, never as a one-value literal list", () => {
    const parsed = parseListSourceText("=$A$1:$A$4", SHEETS, CURRENT);
    expect(parsed).toEqual({
      kind: "range",
      range: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 0 },
    });
  });

  it("accepts a reference with no anchors and in either case", () => {
    expect(parseListSourceText("=a1:b2", SHEETS, CURRENT)).toEqual({
      kind: "range",
      range: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    });
  });

  it("normalises a reference written bottom-right first", () => {
    expect(parseListSourceText("=$C$9:$A$4", SHEETS, CURRENT)).toEqual({
      kind: "range",
      range: { sheetIndex: 0, startRow: 3, startCol: 0, endRow: 8, endCol: 2 },
    });
  });

  it("treats a single cell as a one-cell range", () => {
    expect(parseListSourceText("=$B$2", SHEETS, CURRENT)).toEqual({
      kind: "range",
      range: { sheetIndex: 0, startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
    });
  });

  it("stores the sheet EXPLICITLY for an unqualified reference", () => {
    // Left open, the list would resolve against whichever sheet is active when
    // the dropdown is opened, not the sheet the rule was written on.
    const parsed = parseListSourceText("=$A$1:$A$4", SHEETS, 2);
    expect(parsed).toMatchObject({ kind: "range", range: { sheetIndex: 2 } });
  });

  it("resolves a sheet-qualified reference by name, case-insensitively", () => {
    expect(parseListSourceText("=data!$A$1:$A$4", SHEETS, CURRENT)).toMatchObject({
      kind: "range",
      range: { sheetIndex: 1 },
    });
  });

  it("resolves a quoted sheet name, including a doubled apostrophe", () => {
    expect(parseListSourceText("='My Sheet'!$A$1:$A$4", SHEETS, CURRENT)).toMatchObject({
      kind: "range",
      range: { sheetIndex: 2 },
    });
    expect(parseListSourceText("='O''Brien'!$A$1:$A$4", SHEETS, CURRENT)).toMatchObject({
      kind: "range",
      range: { sheetIndex: 3 },
    });
  });

  it("refuses a sheet name no sheet has", () => {
    const parsed = parseListSourceText("=Nope!$A$1:$A$4", SHEETS, CURRENT);
    expect(parsed).toEqual({ kind: "error", message: 'There is no sheet named "Nope".' });
  });

  it("refuses a reference it cannot parse instead of keeping it as a value", () => {
    // This is the old defect exactly: an unparseable reference used to become
    // the dropdown's only approved value.
    const parsed = parseListSourceText("=A1:A4:A9", SHEETS, CURRENT);
    expect(parsed.kind).toBe("error");
  });

  it("refuses the '=1:0:4:0' coordinate string the dialog used to render", () => {
    const parsed = parseListSourceText("=1:0:4:0", SHEETS, CURRENT);
    expect(parsed.kind).toBe("error");
  });

  it("refuses a whole column or row AS one, not as an unreadable reference", () => {
    // `=$A:$A` is a legitimate Excel spelling, so "that is not a cell range"
    // would be a lie; the resolver walks the source once per validated cell,
    // which is the real reason. Assert the reason, or the guard that gives it
    // can be deleted without a test noticing.
    const reason =
      "A whole column or row is too large for a list source. Give the rows too, like =$A$1:$A$100.";
    expect(parseListSourceText("=$A:$A", SHEETS, CURRENT)).toEqual({ kind: "error", message: reason });
    expect(parseListSourceText("=1:1", SHEETS, CURRENT)).toEqual({ kind: "error", message: reason });
  });

  it("refuses a range larger than the source cap", () => {
    const parsed = parseListSourceText("=$A$1:$Z$1000", SHEETS, CURRENT);
    expect(parsed).toEqual({
      kind: "error",
      message: `That range covers 26000 cells; a list source is limited to ${MAX_LIST_SOURCE_CELLS}.`,
    });
  });

  it("refuses a range off the end of the sheet, which would resolve to nothing", () => {
    expect(parseListSourceText("=$A$1:$A$2000000", SHEETS, CURRENT).kind).toBe("error");
  });

  it("refuses a #REF! source rather than rebinding it to the open sheet", () => {
    expect(parseListSourceText("=#REF!$A$1:$A$4", SHEETS, CURRENT).kind).toBe("error");
  });

  it("still reads a comma-separated inline list", () => {
    expect(parseListSourceText(" Yes, No ,Maybe ", SHEETS, CURRENT)).toEqual({
      kind: "values",
      values: ["Yes", "No", "Maybe"],
    });
  });

  it("refuses an empty source, which would approve nothing at all", () => {
    // An empty value list is not a permissive rule: the backend compares the
    // entry against no values, so every non-blank entry is rejected.
    expect(parseListSourceText("", SHEETS, CURRENT).kind).toBe("error");
    expect(parseListSourceText("  , , ", SHEETS, CURRENT).kind).toBe("error");
    expect(parseListSourceText("=", SHEETS, CURRENT).kind).toBe("error");
  });
});

describe("formatListSourceText", () => {
  it("renders a stored rectangle as a REFERENCE, not as its coordinates", () => {
    const source: ListSource = {
      range: { sheetIndex: 0, startRow: 1, startCol: 0, endRow: 4, endCol: 0 },
    };
    const text = formatListSourceText(source, SHEETS, CURRENT);
    expect(text).toBe("=$A$2:$A$5");
    // The old rendering was "=1:0:4:0", which OK then saved as a literal value.
    expect(text).not.toMatch(/^=\d+:\d+:\d+:\d+$/);
  });

  it("omits the sheet for a range on the sheet being edited", () => {
    const source: ListSource = {
      range: { sheetIndex: 2, startRow: 0, startCol: 0, endRow: 3, endCol: 0 },
    };
    expect(formatListSourceText(source, SHEETS, 2)).toBe("=$A$1:$A$4");
  });

  it("writes and quotes the sheet for a range on another one", () => {
    expect(
      formatListSourceText(
        { range: { sheetIndex: 1, startRow: 0, startCol: 0, endRow: 3, endCol: 0 } },
        SHEETS,
        CURRENT
      )
    ).toBe("=Data!$A$1:$A$4");
    expect(
      formatListSourceText(
        { range: { sheetIndex: 2, startRow: 0, startCol: 0, endRow: 3, endCol: 0 } },
        SHEETS,
        CURRENT
      )
    ).toBe("='My Sheet'!$A$1:$A$4");
    expect(
      formatListSourceText(
        { range: { sheetIndex: 3, startRow: 0, startCol: 0, endRow: 3, endCol: 0 } },
        SHEETS,
        CURRENT
      )
    ).toBe("='O''Brien'!$A$1:$A$4");
  });

  it("renders a sheet that no longer exists as #REF!, never as the open sheet", () => {
    const text = formatListSourceText(
      { range: { sheetIndex: 9, startRow: 0, startCol: 0, endRow: 3, endCol: 0 } },
      SHEETS,
      CURRENT
    );
    expect(text).toBe("=#REF!$A$1:$A$4");
    // And it cannot be saved back in that state.
    expect(parseListSourceText(text, SHEETS, CURRENT).kind).toBe("error");
  });

  it("renders an inline list as its values", () => {
    expect(formatListSourceText({ values: ["Yes", "No"] }, SHEETS, CURRENT)).toBe("Yes,No");
  });
});

describe("open-then-OK round trip", () => {
  // This composition IS the dialog's path: populateFromValidation formats the
  // stored rule into the Source box, and OK parses that box back. Before the
  // fix it turned a working range into a literal list of one string.
  const cases: { name: string; range: Extract<ListSource, { range: unknown }>["range"] }[] = [
    { name: "same sheet", range: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 0 } },
    { name: "another sheet", range: { sheetIndex: 1, startRow: 4, startCol: 2, endRow: 9, endCol: 4 } },
    { name: "a quoted sheet", range: { sheetIndex: 2, startRow: 1, startCol: 1, endRow: 1, endCol: 1 } },
  ];

  for (const { name, range } of cases) {
    it(`survives opening and re-saving a range on ${name}`, () => {
      const text = formatListSourceText({ range }, SHEETS, CURRENT);
      expect(parseListSourceText(text, SHEETS, CURRENT)).toEqual({ kind: "range", range });
    });
  }

  it("gives a script-made rule with no sheet the sheet it is being edited on", () => {
    // api.setDataValidation may omit sheetIndex. Formatting drops no prefix
    // (there is none to drop) and parsing pins it to the current sheet, so the
    // rule stops depending on which sheet is active when the list is opened.
    const text = formatListSourceText(
      { range: { startRow: 0, startCol: 0, endRow: 3, endCol: 0 } },
      SHEETS,
      1
    );
    expect(text).toBe("=$A$1:$A$4");
    expect(parseListSourceText(text, SHEETS, 1)).toEqual({
      kind: "range",
      range: { sheetIndex: 1, startRow: 0, startCol: 0, endRow: 3, endCol: 0 },
    });
  });
});
