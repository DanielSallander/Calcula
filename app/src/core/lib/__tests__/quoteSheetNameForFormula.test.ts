//! FILENAME: app/src/core/lib/__tests__/quoteSheetNameForFormula.test.ts
// PURPOSE: The ONE rule the text handed to an external edit spells a sheet
//          name with (core/lib/formulaEditTarget.ts): bare exactly when the
//          backend lexer reads the name as one plain identifier -- the
//          backend's own `is_bare_sheet_name` (core/engine/src/ast_render.rs)
//          -- and apostrophe-quoted otherwise.
// CONTEXT: Review B (2026-09-28). Core's display helper `formatSheetName`
//          quotes only whitespace, ' ! [ ] and a leading digit, so header and
//          GETPIVOTDATA picks handed a floating grid's edit `Q1-2026!C:C`; the
//          floating grid's own rule quoted anything outside [A-Za-z0-9_] but
//          left `2024Budget` and `TRUE` bare. Every "bare" / "quoted" answer
//          below was checked against the real `parser::parse` (a scratch
//          crate over core/parser): the bare spellings parse, and each name
//          listed as quoted FAILS bare (`=SUM(Q1-2026!C:C)` -> "Expected
//          RParen, found Exclamation"; `=2024Budget!A1`; `=TRUE!A1`;
//          `=Q1.!A1`; `=a..b!A1`; `=Sales(EU)!A1`; `=Tab+1!A1`; `=Å!A1`).

import { describe, it, expect } from "vitest";
import { isBareSheetName, quoteSheetNameForFormula } from "../formulaEditTarget";
import { quoteSheetNameForFormula as viaApi } from "../../../api/externalEdit";

describe("isBareSheetName mirrors the backend's is_bare_sheet_name", () => {
  it.each(["Sheet1", "A1", "C3", "Sheet.1", "_x", "Data", "Q1_2026", "a.b.c"])(
    "%s is bare",
    (name) => {
      expect(isBareSheetName(name)).toBe(true);
    },
  );

  it.each([
    "Q1-2026",
    "2024Budget",
    "2024",
    "TRUE",
    "false",
    "True",
    "Q1.",
    "a..b",
    ".x",
    "Sales(EU)",
    "Tab+1",
    "Q1 2026",
    "R&D",
    "Å",
    "it's",
    "",
  ])("%s must be quoted", (name) => {
    expect(isBareSheetName(name)).toBe(false);
  });
});

describe("quoteSheetNameForFormula", () => {
  it("quotes what is not bare, doubling an inner apostrophe", () => {
    expect(quoteSheetNameForFormula("Q1-2026")).toBe("'Q1-2026'");
    expect(quoteSheetNameForFormula("TRUE")).toBe("'TRUE'");
    expect(quoteSheetNameForFormula("Bob's")).toBe("'Bob''s'");
  });

  it("leaves a bare name -- the default names -- as it is", () => {
    expect(quoteSheetNameForFormula("Sheet1")).toBe("Sheet1");
    expect(quoteSheetNameForFormula("Sheet.1")).toBe("Sheet.1");
  });

  it("is the binding @api/externalEdit hands extensions (one rule, not a copy)", () => {
    expect(viaApi).toBe(quoteSheetNameForFormula);
  });
});
