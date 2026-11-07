//! FILENAME: app/src/api/__tests__/definedNameSyntax.test.ts
// PURPOSE: The frontend's name rule says what Excel says, name for name --
//          the two lists Excel 16 answered [LIVE, 2026-11-06, lane names
//          q1-q4.ps1, `Names.Add` / `ListObject.Name` per name], the same
//          lists `names_lane_tests::names_take_excels_backslash_and_question_mark_rules`
//          holds the backend's `identity::is_valid_defined_name` to (BUG-0741).
// SABOTAGE (names-ts): `isValidDefinedName` drops its two-character backslash
//          refusal -- fails at "Excel refuses \\a".

import { describe, it, expect } from "vitest";
import { isValidDefinedName, isValidTableName, MAX_DEFINED_NAME_CHARS } from "../definedNameSyntax";

const ACCEPTED = [
  "\\abc", "a\\b", "abc?", "_x", "A1B", "\\", "a?b", "_", "a.b", "XFE1", "A1A", "\\ab", "\\a1", "\\_a",
  "a\\", "a?", "_?", "_\\", "\\abc?", "\\RC", "\\A1", "\\TRUE", "\\a.b", "\\r1", "\\1a", "\\.a", "\\?a",
  "\\11", "\\.1", "a?.b", "_?a", "a\\\\b", "\\\\a", "\\a\\", "\\a?", "\\XFD1", "\\R1C1", "R?", "C\\",
  "A1?", "A1\\", "a1?", "A1.B1?", "a.?", "TRUE?", "NULL", "SalesData", "Q1.Sales", "R0C0", "RCX", "R1.x",
];
const REFUSED = [
  "?abc", "R", "C", "r", "c", "R1", "\\\\", "\\a", "?", ".a", "1a", "RC", "R1C1", "Abc1", "XFD1", "\\b",
  "\\x", "\\z", "\\_", "\\.", "\\1", "\\?", "\\R", "\\C", "\\c", "\\r", "\\A", "\\B", "\\Z", "?a", "R1?",
  "C1\\", "R1\\x", "RC1?", "\\a b", "TRUE", "false", "A1.B1", "A1..B1", "R2x", "", "a b", "Data@2024",
];

describe("isValidDefinedName (Excel's defined-name rule, whole)", () => {
  it("accepts every name Excel accepts", () => {
    const wrong = ACCEPTED.filter((n) => !isValidDefinedName(n));
    expect(wrong, "Excel accepts these names").toEqual([]);
  });

  it("refuses every name Excel refuses", () => {
    const wrong = REFUSED.filter((n) => isValidDefinedName(n));
    expect(wrong, "Excel refuses \\a and these names").toEqual([]);
  });

  it("holds Excel's length limit", () => {
    expect(isValidDefinedName("a".repeat(MAX_DEFINED_NAME_CHARS))).toBe(true);
    expect(isValidDefinedName("a".repeat(MAX_DEFINED_NAME_CHARS + 1))).toBe(false);
  });
});

describe("isValidTableName (Excel's table-name rule)", () => {
  it("takes a two-character backslash name a defined name may not have", () => {
    for (const n of ["\\abc", "a\\b", "abc?", "\\", "\\a", "_x", "a?b", "\\ab"]) {
      expect(isValidTableName(n), n).toBe(true);
    }
    expect(isValidDefinedName("\\a")).toBe(false);
    expect(isValidTableName("R1C1")).toBe(false);
  });
});
