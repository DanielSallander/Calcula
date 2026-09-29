//! FILENAME: app/src/shell/SheetTabs/__tests__/sheetRangePrefix.test.ts
// PURPOSE: The 3-D prefix a Shift+click on a sheet tab inserts in point mode
//          is text the formula parser reads back as the same two sheets.
// CONTEXT: W13 (wave C). SheetTabs quoted the pair only for whitespace and
//          ' ! [ ], so Q1-2026 through Q2 was inserted as `Q1-2026:Q2!` and
//          the formula failed on Enter; TRUE and a trailing-dot name likewise.
//          The backend's own rendering (ast_render.rs, Sheet3DRef) quotes the
//          PAIR as one: `'Q1-2026:Q2'!`.

import { describe, it, expect } from "vitest";
import { sheetRangePrefix } from "../sheetRangePrefix";

describe("sheetRangePrefix", () => {
  it.each([
    ["Q1-2026", "Summary", "'Q1-2026:Summary'!"],
    ["Summary", "TRUE", "'Summary:TRUE'!"],
    ["Jan.", "Feb", "'Jan.:Feb'!"],
    ["My Sheet", "Other", "'My Sheet:Other'!"],
    ["Bob's", "Ann's", "'Bob''s:Ann''s'!"],
    ["2024", "2025", "'2024:2025'!"],
  ])("%s through %s is quoted as one pair: %s", (start, end, expected) => {
    expect(sheetRangePrefix(start, end)).toBe(expected);
  });

  it.each([
    // The range grammar reads these as cells, columns or R1C1 first
    // (the backend's sheet_range_renders_bare), so the pair is quoted.
    ["Q1", "Q4", "'Q1:Q4'!"],
    ["N", "Other", "'N:Other'!"],
    ["Data", "R1C1", "'Data:R1C1'!"],
  ])("a reference-shaped half (%s:%s) is quoted: %s", (start, end, expected) => {
    expect(sheetRangePrefix(start, end)).toBe(expected);
  });

  it("control: two plain identifiers -- the default names -- stay bare", () => {
    expect(sheetRangePrefix("Sheet1", "Sheet3")).toBe("Sheet1:Sheet3!");
    expect(sheetRangePrefix("Sales_2025", "Sales.EU")).toBe("Sales_2025:Sales.EU!");
  });
});
