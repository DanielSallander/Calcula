//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frRefs.test.ts
// PURPOSE: A floating grid's sheet-qualified reference text -- what its cell
//          picks insert into its own formula, what its click-pick inserts into
//          Core's, and the Name Box address -- spells the sheet the way the
//          formula PARSER needs it.
// CONTEXT: Review B (2026-09-28). The extension's own rule quoted anything
//          outside [A-Za-z0-9_] but left a leading-digit name and TRUE/FALSE
//          bare, and the backend parser rejects `2024Budget!C3` ("Expected
//          RParen, found Identifier") and `TRUE!C3`. It now uses Core's ONE
//          rule through @api/externalEdit (`quoteSheetNameForFormula`, the
//          backend's `is_bare_sheet_name`), so a header pick and a cell pick
//          in the same edit can no longer quote one sheet two ways.

import { describe, it, expect } from "vitest";
import { buildQualifiedRef } from "../frRefs";

describe("buildQualifiedRef quotes the sheet by the parser's rule", () => {
  it("a leading digit is quoted (it lexes as a number)", () => {
    expect(buildQualifiedRef("2024Budget", 2, 2)).toBe("'2024Budget'!C3");
    expect(buildQualifiedRef("2024", 0, 0, 1, 1)).toBe("'2024'!A1:B2");
  });

  it("TRUE / FALSE are quoted (they lex as booleans)", () => {
    expect(buildQualifiedRef("TRUE", 2, 2)).toBe("'TRUE'!C3");
    expect(buildQualifiedRef("false", 2, 2)).toBe("'false'!C3");
  });

  it("a punctuated name is quoted, an inner apostrophe doubled", () => {
    expect(buildQualifiedRef("Q1-2026", 2, 2)).toBe("'Q1-2026'!C3");
    expect(buildQualifiedRef("My Float's", 0, 0)).toBe("'My Float''s'!A1");
  });

  it("control: a bare identifier stays bare, and no name gives a local ref", () => {
    expect(buildQualifiedRef("Sheet1", 2, 2)).toBe("Sheet1!C3");
    expect(buildQualifiedRef("Float1", 0, 0, 3, 2)).toBe("Float1!A1:C4");
    expect(buildQualifiedRef(null, 0, 0, 3, 2)).toBe("A1:C4");
  });
});
