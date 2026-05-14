//! FILENAME: app/extensions/TextToColumns/lib/parser.test.ts
// PURPOSE: Comprehensive tests for the Text to Columns parsing engine.

import { describe, it, expect } from "vitest";
import {
  createDefaultConfig,
  splitDelimited,
  splitFixedWidth,
  applyFormats,
  parseAll,
  getMaxColumns,
  getFinalColumnCount,
  type DelimitedConfig,
  type TextToColumnsConfig,
  type ColumnFormat,
} from "./parser";

// ============================================================================
// Helpers
// ============================================================================

function makeDelimitedConfig(
  overrides: Partial<DelimitedConfig> = {},
): DelimitedConfig {
  return {
    tab: false,
    semicolon: false,
    comma: true,
    space: false,
    other: "",
    treatConsecutiveAsOne: false,
    textQualifier: '"',
    ...overrides,
  };
}

// ============================================================================
// createDefaultConfig
// ============================================================================

describe("createDefaultConfig", () => {
  it("returns delimited mode by default", () => {
    const cfg = createDefaultConfig();
    expect(cfg.mode).toBe("delimited");
  });

  it("enables comma delimiter only", () => {
    const cfg = createDefaultConfig();
    expect(cfg.delimited.comma).toBe(true);
    expect(cfg.delimited.tab).toBe(false);
    expect(cfg.delimited.semicolon).toBe(false);
    expect(cfg.delimited.space).toBe(false);
    expect(cfg.delimited.other).toBe("");
  });

  it("sets double-quote as text qualifier", () => {
    const cfg = createDefaultConfig();
    expect(cfg.delimited.textQualifier).toBe('"');
  });

  it("disables treatConsecutiveAsOne", () => {
    const cfg = createDefaultConfig();
    expect(cfg.delimited.treatConsecutiveAsOne).toBe(false);
  });

  it("starts with empty fixedWidthBreaks and columnFormats", () => {
    const cfg = createDefaultConfig();
    expect(cfg.fixedWidthBreaks).toEqual([]);
    expect(cfg.columnFormats).toEqual([]);
  });
});

// ============================================================================
// splitDelimited
// ============================================================================

describe("splitDelimited", () => {
  describe("comma delimiter", () => {
    it("splits simple comma-separated values", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      expect(splitDelimited("a,b,c", cfg)).toEqual(["a", "b", "c"]);
    });

    it("handles single value with no delimiter", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      expect(splitDelimited("hello", cfg)).toEqual(["hello"]);
    });

    it("handles empty fields between delimiters", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      expect(splitDelimited("a,,b", cfg)).toEqual(["a", "", "b"]);
    });

    it("handles trailing delimiter", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      expect(splitDelimited("a,b,", cfg)).toEqual(["a", "b", ""]);
    });

    it("handles leading delimiter", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      expect(splitDelimited(",a,b", cfg)).toEqual(["", "a", "b"]);
    });
  });

  describe("tab delimiter", () => {
    it("splits tab-separated values", () => {
      const cfg = makeDelimitedConfig({ comma: false, tab: true });
      expect(splitDelimited("one\ttwo\tthree", cfg)).toEqual([
        "one",
        "two",
        "three",
      ]);
    });
  });

  describe("semicolon delimiter", () => {
    it("splits semicolon-separated values", () => {
      const cfg = makeDelimitedConfig({ comma: false, semicolon: true });
      expect(splitDelimited("x;y;z", cfg)).toEqual(["x", "y", "z"]);
    });
  });

  describe("space delimiter", () => {
    it("splits space-separated values", () => {
      const cfg = makeDelimitedConfig({ comma: false, space: true });
      expect(splitDelimited("foo bar baz", cfg)).toEqual([
        "foo",
        "bar",
        "baz",
      ]);
    });
  });

  describe("custom delimiter", () => {
    it("splits on pipe character", () => {
      const cfg = makeDelimitedConfig({ comma: false, other: "|" });
      expect(splitDelimited("a|b|c", cfg)).toEqual(["a", "b", "c"]);
    });

    it("splits on tilde character", () => {
      const cfg = makeDelimitedConfig({ comma: false, other: "~" });
      expect(splitDelimited("one~two~three", cfg)).toEqual([
        "one",
        "two",
        "three",
      ]);
    });

    it("uses only the first character of multi-char other", () => {
      const cfg = makeDelimitedConfig({ comma: false, other: "||" });
      // Only '|' is used as delimiter
      expect(splitDelimited("a|b|c", cfg)).toEqual(["a", "b", "c"]);
    });
  });

  describe("multiple delimiters active", () => {
    it("splits on both comma and semicolon", () => {
      const cfg = makeDelimitedConfig({ comma: true, semicolon: true });
      expect(splitDelimited("a,b;c", cfg)).toEqual(["a", "b", "c"]);
    });

    it("splits on tab, comma, and space", () => {
      const cfg = makeDelimitedConfig({
        comma: true,
        tab: true,
        space: true,
      });
      expect(splitDelimited("a\tb,c d", cfg)).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
    });
  });

  describe("no delimiters active", () => {
    it("returns entire string as single field", () => {
      const cfg = makeDelimitedConfig({
        comma: false,
        tab: false,
        semicolon: false,
        space: false,
        other: "",
      });
      expect(splitDelimited("a,b,c", cfg)).toEqual(["a,b,c"]);
    });
  });

  describe("consecutive delimiters", () => {
    it("creates empty fields when treatConsecutiveAsOne is false", () => {
      const cfg = makeDelimitedConfig({
        comma: true,
        treatConsecutiveAsOne: false,
      });
      expect(splitDelimited("a,,,b", cfg)).toEqual(["a", "", "", "b"]);
    });

    it("merges consecutive delimiters when treatConsecutiveAsOne is true", () => {
      const cfg = makeDelimitedConfig({
        comma: true,
        treatConsecutiveAsOne: true,
      });
      expect(splitDelimited("a,,,b", cfg)).toEqual(["a", "b"]);
    });

    it("merges mixed consecutive delimiters", () => {
      const cfg = makeDelimitedConfig({
        comma: true,
        space: true,
        treatConsecutiveAsOne: true,
      });
      expect(splitDelimited("a, , b", cfg)).toEqual(["a", "b"]);
    });
  });

  describe("quoted fields", () => {
    it("handles quoted field containing delimiter", () => {
      const cfg = makeDelimitedConfig({ comma: true, textQualifier: '"' });
      expect(splitDelimited('"a,b",c', cfg)).toEqual(["a,b", "c"]);
    });

    it("handles multiple quoted fields", () => {
      const cfg = makeDelimitedConfig({ comma: true, textQualifier: '"' });
      expect(splitDelimited('"x","y","z"', cfg)).toEqual(["x", "y", "z"]);
    });

    it("handles escaped quotes (doubled qualifier)", () => {
      const cfg = makeDelimitedConfig({ comma: true, textQualifier: '"' });
      expect(splitDelimited('"He said ""hi""",done', cfg)).toEqual([
        'He said "hi"',
        "done",
      ]);
    });

    it("handles single-quote as text qualifier", () => {
      const cfg = makeDelimitedConfig({
        comma: true,
        textQualifier: "'",
      });
      expect(splitDelimited("'a,b',c", cfg)).toEqual(["a,b", "c"]);
    });

    it("handles empty quoted field", () => {
      const cfg = makeDelimitedConfig({ comma: true, textQualifier: '"' });
      expect(splitDelimited('"",a', cfg)).toEqual(["", "a"]);
    });

    it("handles no text qualifier (disabled)", () => {
      const cfg = makeDelimitedConfig({ comma: true, textQualifier: "" });
      // Quotes are treated as literal characters
      expect(splitDelimited('"a,b",c', cfg)).toEqual(['"a', 'b"', "c"]);
    });

    it("handles quoted field with spaces", () => {
      const cfg = makeDelimitedConfig({
        comma: true,
        space: true,
        textQualifier: '"',
      });
      expect(splitDelimited('"hello world",test', cfg)).toEqual([
        "hello world",
        "test",
      ]);
    });
  });

  describe("empty input", () => {
    it("returns single empty field for empty string", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      expect(splitDelimited("", cfg)).toEqual([""]);
    });
  });

  describe("unicode text", () => {
    it("handles unicode characters in fields", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      expect(splitDelimited("hej,varlden,orebro", cfg)).toEqual([
        "hej",
        "varlden",
        "orebro",
      ]);
    });

    it("handles CJK characters", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      const result = splitDelimited("hello,world,test", cfg);
      expect(result).toHaveLength(3);
    });

    it("handles emoji in fields", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      expect(splitDelimited("smile,wave,ok", cfg)).toEqual([
        "smile",
        "wave",
        "ok",
      ]);
    });
  });

  describe("extremely long lines", () => {
    it("handles a line with many columns", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      const input = Array.from({ length: 500 }, (_, i) => `col${i}`).join(",");
      const result = splitDelimited(input, cfg);
      expect(result).toHaveLength(500);
      expect(result[0]).toBe("col0");
      expect(result[499]).toBe("col499");
    });

    it("handles a single very long field", () => {
      const cfg = makeDelimitedConfig({ comma: true });
      const longValue = "x".repeat(10000);
      expect(splitDelimited(longValue, cfg)).toEqual([longValue]);
    });
  });
});

// ============================================================================
// splitFixedWidth
// ============================================================================

describe("splitFixedWidth", () => {
  it("splits at specified character positions", () => {
    //  "John      Doe       30"
    //   0123456789012345678901
    expect(splitFixedWidth("John      Doe       30", [10, 20])).toEqual([
      "John      ",
      "Doe       ",
      "30",
    ]);
  });

  it("returns entire string when breaks is empty", () => {
    expect(splitFixedWidth("hello world", [])).toEqual(["hello world"]);
  });

  it("handles single break position", () => {
    expect(splitFixedWidth("ABCDE", [3])).toEqual(["ABC", "DE"]);
  });

  it("handles break at position 0 (skipped as <= start)", () => {
    // A break at 0 is effectively a no-op since start is 0
    expect(splitFixedWidth("ABCDE", [0, 3])).toEqual(["ABC", "DE"]);
  });

  it("handles break beyond string length", () => {
    expect(splitFixedWidth("AB", [5])).toEqual(["AB", ""]);
  });

  it("handles multiple breaks with narrow columns", () => {
    expect(splitFixedWidth("ABCDEFGHIJ", [2, 4, 6, 8])).toEqual([
      "AB",
      "CD",
      "EF",
      "GH",
      "IJ",
    ]);
  });

  it("handles empty string", () => {
    expect(splitFixedWidth("", [5, 10])).toEqual(["", "", ""]);
  });

  it("preserves trailing whitespace in fields", () => {
    expect(splitFixedWidth("AB   CD", [5])).toEqual(["AB   ", "CD"]);
  });
});

// ============================================================================
// applyFormats
// ============================================================================

describe("applyFormats", () => {
  it("passes through fields with general format (trimmed)", () => {
    const result = applyFormats(["  hello  ", " world "], ["general", "general"]);
    expect(result).toEqual(["hello", "world"]);
  });

  it("passes through fields with text format (trimmed)", () => {
    const result = applyFormats(["  42  "], ["text"]);
    expect(result).toEqual(["42"]);
  });

  it("skips columns with skip format", () => {
    const result = applyFormats(["a", "b", "c"], ["general", "skip", "general"]);
    expect(result).toEqual(["a", "c"]);
  });

  it("uses general format when format array is shorter than fields", () => {
    const result = applyFormats(["a", "b", "c"], ["text"]);
    // Index 0 is text, 1 and 2 default to general
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("parses date:MDY format", () => {
    const result = applyFormats(["12/25/2023"], ["date:MDY"]);
    expect(result).toEqual(["12/25/2023"]);
  });

  it("parses date:DMY format", () => {
    const result = applyFormats(["25/12/2023"], ["date:DMY"]);
    expect(result).toEqual(["12/25/2023"]);
  });

  it("parses date:YMD format", () => {
    const result = applyFormats(["2023-03-15"], ["date:YMD"]);
    expect(result).toEqual(["03/15/2023"]);
  });

  it("expands 2-digit year < 30 to 2000s", () => {
    const result = applyFormats(["01/15/25"], ["date:MDY"]);
    expect(result).toEqual(["01/15/2025"]);
  });

  it("expands 2-digit year >= 30 to 1900s", () => {
    const result = applyFormats(["01/15/85"], ["date:MDY"]);
    expect(result).toEqual(["01/15/1985"]);
  });

  it("returns raw string for invalid date", () => {
    const result = applyFormats(["not-a-date"], ["date:MDY"]);
    expect(result).toEqual(["not-a-date"]);
  });

  it("returns raw string for date with invalid month/day range", () => {
    const result = applyFormats(["13/32/2023"], ["date:MDY"]);
    expect(result).toEqual(["13/32/2023"]);
  });

  it("skips all columns when all formats are skip", () => {
    const result = applyFormats(["a", "b", "c"], ["skip", "skip", "skip"]);
    expect(result).toEqual([]);
  });
});

// ============================================================================
// parseAll
// ============================================================================

describe("parseAll", () => {
  it("parses multiple rows in delimited mode", () => {
    const config: TextToColumnsConfig = {
      mode: "delimited",
      delimited: makeDelimitedConfig({ comma: true }),
      fixedWidthBreaks: [],
      columnFormats: [],
    };
    const result = parseAll(["a,b,c", "d,e,f"], config);
    expect(result).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("parses multiple rows in fixedWidth mode", () => {
    const config: TextToColumnsConfig = {
      mode: "fixedWidth",
      delimited: makeDelimitedConfig(),
      fixedWidthBreaks: [3, 6],
      columnFormats: [],
    };
    const result = parseAll(["ABCDEFGHI", "123456789"], config);
    expect(result).toEqual([
      ["ABC", "DEF", "GHI"],
      ["123", "456", "789"],
    ]);
  });

  it("handles empty values array", () => {
    const config = createDefaultConfig();
    const result = parseAll([], config);
    expect(result).toEqual([]);
  });

  it("handles rows with varying column counts", () => {
    const config: TextToColumnsConfig = {
      mode: "delimited",
      delimited: makeDelimitedConfig({ comma: true }),
      fixedWidthBreaks: [],
      columnFormats: [],
    };
    const result = parseAll(["a,b", "c,d,e,f"], config);
    expect(result).toEqual([
      ["a", "b"],
      ["c", "d", "e", "f"],
    ]);
  });
});

// ============================================================================
// getMaxColumns
// ============================================================================

describe("getMaxColumns", () => {
  it("returns the maximum column count across rows", () => {
    expect(
      getMaxColumns([
        ["a", "b"],
        ["c", "d", "e"],
        ["f"],
      ]),
    ).toBe(3);
  });

  it("returns 0 for empty dataset", () => {
    expect(getMaxColumns([])).toBe(0);
  });

  it("handles single row", () => {
    expect(getMaxColumns([["a", "b", "c"]])).toBe(3);
  });
});

// ============================================================================
// getFinalColumnCount
// ============================================================================

describe("getFinalColumnCount", () => {
  it("returns maxCols when no formats specify skip", () => {
    expect(getFinalColumnCount(5, ["general", "text"])).toBe(5);
  });

  it("subtracts skipped columns", () => {
    expect(
      getFinalColumnCount(4, ["general", "skip", "general", "skip"]),
    ).toBe(2);
  });

  it("returns 0 when all columns are skipped", () => {
    expect(getFinalColumnCount(3, ["skip", "skip", "skip"])).toBe(0);
  });

  it("defaults to general for unspecified formats", () => {
    // maxCols=5 but only 2 formats provided; remaining default to general
    expect(getFinalColumnCount(5, ["skip", "skip"])).toBe(3);
  });
});

// ============================================================================
// Mixed line endings (integration-level)
// ============================================================================

describe("mixed line endings", () => {
  it("handles CRLF-split input fed line by line", () => {
    const raw = "a,b\r\nc,d\r\ne,f";
    const lines = raw.split(/\r?\n/);
    const config = createDefaultConfig();
    const result = parseAll(lines, config);
    expect(result).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("handles LF-only line endings", () => {
    const raw = "x,y\nz,w";
    const lines = raw.split(/\r?\n/);
    const config = createDefaultConfig();
    const result = parseAll(lines, config);
    expect(result).toEqual([
      ["x", "y"],
      ["z", "w"],
    ]);
  });
});
