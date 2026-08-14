// FILENAME: app/extensions/CommandLine/__tests__/a1.test.ts
// PURPOSE: Unit tests for the clean-room A1 reference parser (0-based
//          rows/cols): cells, ranges, sheet-qualified forms (quoted sheets,
//          doubled-quote escapes), normalization and the formatters.

import { describe, expect, it } from "vitest";
import {
  colLetterToIndex,
  formatA1,
  formatQualified,
  formatRange,
  indexToColLetter,
  isSingleCell,
  parseA1,
  parseQualified,
  parseRange,
  tryParseA1,
  tryParseQualified,
  tryParseRange,
} from "../cli/a1";

describe("colLetterToIndex / indexToColLetter", () => {
  it("maps single and multi letters", () => {
    expect(colLetterToIndex("A")).toBe(0);
    expect(colLetterToIndex("Z")).toBe(25);
    expect(colLetterToIndex("AA")).toBe(26);
    expect(colLetterToIndex("b")).toBe(1);
    expect(colLetterToIndex("XFD")).toBe(16383);
    expect(colLetterToIndex("A1")).toBeNull();
    expect(colLetterToIndex("")).toBeNull();
  });

  it("round-trips", () => {
    for (const i of [0, 1, 25, 26, 27, 51, 52, 701, 702, 16383]) {
      expect(colLetterToIndex(indexToColLetter(i))).toBe(i);
    }
    expect(indexToColLetter(26)).toBe("AA");
    expect(indexToColLetter(701)).toBe("ZZ");
    expect(indexToColLetter(702)).toBe("AAA");
  });
});

describe("parseA1", () => {
  it("parses cells 0-based", () => {
    expect(parseA1("B3")).toEqual({ row: 2, col: 1 });
    expect(parseA1("A1")).toEqual({ row: 0, col: 0 });
    expect(parseA1("AA10")).toEqual({ row: 9, col: 26 });
    expect(parseA1("aa10")).toEqual({ row: 9, col: 26 });
    expect(parseA1("$B$3")).toEqual({ row: 2, col: 1 });
  });

  it("rejects non-cells", () => {
    expect(tryParseA1("")).toBeNull();
    expect(tryParseA1("A")).toBeNull();
    expect(tryParseA1("12")).toBeNull();
    expect(tryParseA1("1A")).toBeNull();
    expect(tryParseA1("A0")).toBeNull();
    expect(tryParseA1("A1:B2")).toBeNull();
    expect(() => parseA1("nope")).toThrow(/not a cell reference/);
  });
});

describe("parseRange", () => {
  it("parses ranges and single cells", () => {
    expect(parseRange("A1:C9")).toEqual({ startRow: 0, startCol: 0, endRow: 8, endCol: 2 });
    expect(parseRange("A1")).toEqual({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
  });

  it("normalizes reversed corners", () => {
    expect(parseRange("C9:A1")).toEqual({ startRow: 0, startCol: 0, endRow: 8, endCol: 2 });
  });

  it("rejects junk", () => {
    expect(tryParseRange("A1:")).toBeNull();
    expect(tryParseRange(":B2")).toBeNull();
    expect(tryParseRange("A1:B2:C3")).toBeNull();
    expect(() => parseRange("x")).toThrow(/not a range/);
  });
});

describe("parseQualified", () => {
  it("parses bare, qualified and quoted-sheet references", () => {
    expect(parseQualified("A1")).toEqual({
      range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    });
    expect(parseQualified("Sheet2!A1:B2")).toEqual({
      sheet: "Sheet2",
      range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    });
    expect(parseQualified("'My Sheet'!A1")).toEqual({
      sheet: "My Sheet",
      range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    });
    // Pre-unquoted spaced name (a quoted CLI token merged back).
    expect(parseQualified("My Sheet!A1").sheet).toBe("My Sheet");
    // Doubled '' = literal quote in the sheet name.
    expect(parseQualified("'It''s data'!B2").sheet).toBe("It's data");
  });

  it("rejects malformed qualified references", () => {
    expect(tryParseQualified("Sheet2!")).toBeNull();
    expect(tryParseQualified("!A1")).toBeNull();
    expect(tryParseQualified("'Unterminated!A1")).toBeNull();
    expect(tryParseQualified("''!A1")).toBeNull();
    expect(() => parseQualified("@#!")).toThrow(/not a reference/);
  });
});

describe("formatters", () => {
  it("formats cells and ranges", () => {
    expect(formatA1({ row: 2, col: 1 })).toBe("B3");
    expect(formatRange({ startRow: 0, startCol: 0, endRow: 8, endCol: 2 })).toBe("A1:C9");
    expect(formatRange({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 })).toBe("B3");
  });

  it("labels qualified ranges, quoting spaced sheet names", () => {
    expect(formatQualified(parseQualified("Sheet2!A1:B2"))).toBe("Sheet2!A1:B2");
    expect(formatQualified(parseQualified("'My Sheet'!A1"))).toBe("'My Sheet'!A1");
    expect(formatQualified(parseQualified("B3"))).toBe("B3");
  });

  it("isSingleCell", () => {
    expect(isSingleCell(parseRange("B3"))).toBe(true);
    expect(isSingleCell(parseRange("A1:A2"))).toBe(false);
  });
});
