//! FILENAME: app/extensions/TextToColumns/lib/parser-stress.test.ts
// PURPOSE: Stress tests for Text to Columns parsing engine.

import { describe, it, expect } from "vitest";
import {
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

function makeDelimCfg(overrides: Partial<DelimitedConfig> = {}): DelimitedConfig {
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

function makeConfig(overrides: Partial<TextToColumnsConfig> = {}): TextToColumnsConfig {
  return {
    mode: "delimited",
    delimited: makeDelimCfg(),
    fixedWidthBreaks: [],
    columnFormats: [],
    ...overrides,
  };
}

// ============================================================================
// Stress: parse 10K rows
// ============================================================================

describe("TextToColumns stress: 10K rows delimited", () => {
  it("parses 10,000 comma-delimited rows", () => {
    const values = Array.from({ length: 10_000 }, (_, i) => `name${i},${i},${i % 2 === 0 ? "even" : "odd"}`);
    const config = makeConfig();
    const result = parseAll(values, config);
    expect(result.length).toBe(10_000);
    expect(result[0]).toEqual(["name0", "0", "even"]);
    expect(result[9999]).toEqual(["name9999", "9999", "odd"]);
    expect(getMaxColumns(result)).toBe(3);
  });

  it("parses 10,000 tab-delimited rows", () => {
    const values = Array.from({ length: 10_000 }, (_, i) => `a${i}\tb${i}\tc${i}`);
    const config = makeConfig({ delimited: makeDelimCfg({ comma: false, tab: true }) });
    const result = parseAll(values, config);
    expect(result.length).toBe(10_000);
    expect(result[5000]).toEqual(["a5000", "b5000", "c5000"]);
  });
});

// ============================================================================
// Stress: fixed width with 50 columns
// ============================================================================

describe("TextToColumns stress: fixed width 50 columns", () => {
  it("splits into 50 columns at regular 5-char intervals", () => {
    const breaks = Array.from({ length: 49 }, (_, i) => (i + 1) * 5);
    // Build a 250-char string with known content
    const text = Array.from({ length: 50 }, (_, i) => String(i).padStart(5, "0")).join("");
    const result = splitFixedWidth(text, breaks);
    expect(result.length).toBe(50);
    expect(result[0]).toBe("00000");
    expect(result[49]).toBe("00049");
    expect(result[25]).toBe("00025");
  });

  it("handles 1000 rows with 50 fixed-width columns", () => {
    const breaks = Array.from({ length: 49 }, (_, i) => (i + 1) * 4);
    const values = Array.from({ length: 1000 }, (_, r) => {
      return Array.from({ length: 50 }, (_, c) => String(c % 10).repeat(4)).join("");
    });
    const config = makeConfig({ mode: "fixedWidth", fixedWidthBreaks: breaks });
    const result = parseAll(values, config);
    expect(result.length).toBe(1000);
    expect(result[0].length).toBe(50);
    expect(result[0][0]).toBe("0000");
    expect(result[0][9]).toBe("9999");
  });

  it("fixed width with uneven break positions", () => {
    const breaks = [3, 7, 8, 20];
    const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const result = splitFixedWidth(text, breaks);
    expect(result).toEqual(["ABC", "DEFG", "H", "IJKLMNOPQRST", "UVWXYZ"]);
  });
});

// ============================================================================
// Stress: alternating delimiters
// ============================================================================

describe("TextToColumns: alternating delimiters", () => {
  it("comma and semicolon both active", () => {
    const cfg = makeDelimCfg({ comma: true, semicolon: true });
    expect(splitDelimited("a,b;c,d;e", cfg)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("comma, tab, and space all active", () => {
    const cfg = makeDelimCfg({ comma: true, tab: true, space: true });
    expect(splitDelimited("a,b\tc d", cfg)).toEqual(["a", "b", "c", "d"]);
  });

  it("all standard delimiters active with consecutive-as-one", () => {
    const cfg = makeDelimCfg({
      comma: true,
      semicolon: true,
      tab: true,
      space: true,
      treatConsecutiveAsOne: true,
    });
    const result = splitDelimited("a,,;\t  b   c", cfg);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("custom delimiter with comma", () => {
    const cfg = makeDelimCfg({ comma: true, other: "|" });
    expect(splitDelimited("a|b,c|d", cfg)).toEqual(["a", "b", "c", "d"]);
  });

  it("only custom delimiter active", () => {
    const cfg = makeDelimCfg({ comma: false, other: ":" });
    expect(splitDelimited("a:b:c", cfg)).toEqual(["a", "b", "c"]);
  });
});

// ============================================================================
// Stress: format application on large datasets
// ============================================================================

describe("TextToColumns: format application on large datasets", () => {
  it("applies general format to 5000 rows x 5 columns", () => {
    const formats: ColumnFormat[] = ["general", "text", "general", "general", "general"];
    for (let i = 0; i < 5000; i++) {
      const fields = ["  abc  ", " 123 ", "  x  ", " y ", " z "];
      const result = applyFormats(fields, formats);
      expect(result).toEqual(["abc", "123", "x", "y", "z"]);
    }
  });

  it("skip columns removes them from output", () => {
    const formats: ColumnFormat[] = ["general", "skip", "general", "skip", "text"];
    const fields = ["a", "b", "c", "d", "e"];
    const result = applyFormats(fields, formats);
    expect(result).toEqual(["a", "c", "e"]);
  });

  it("date format MDY on 1000 rows", () => {
    const formats: ColumnFormat[] = ["date:MDY"];
    for (let i = 0; i < 1000; i++) {
      const result = applyFormats(["03/15/2024"], formats);
      expect(result).toEqual(["03/15/2024"]);
    }
  });

  it("date format DMY conversion", () => {
    const result = applyFormats(["25/12/2024"], ["date:DMY"]);
    expect(result).toEqual(["12/25/2024"]);
  });

  it("date format YMD conversion", () => {
    const result = applyFormats(["2024-06-15"], ["date:YMD"]);
    expect(result).toEqual(["06/15/2024"]);
  });

  it("getFinalColumnCount with mixed formats", () => {
    const formats: ColumnFormat[] = ["general", "skip", "text", "skip", "date:MDY", "skip"];
    expect(getFinalColumnCount(6, formats)).toBe(3);
    expect(getFinalColumnCount(10, formats)).toBe(7); // indices 6-9 default to general
  });
});

// ============================================================================
// Edge cases at scale
// ============================================================================

describe("TextToColumns: edge cases at scale", () => {
  it("empty strings in 1000 rows", () => {
    const values = Array.from({ length: 1000 }, () => "");
    const config = makeConfig();
    const result = parseAll(values, config);
    expect(result.length).toBe(1000);
    result.forEach((row) => expect(row).toEqual([""]));
  });

  it("single character per row in 1000 rows", () => {
    const values = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(65 + (i % 26)));
    const config = makeConfig();
    const result = parseAll(values, config);
    expect(result.length).toBe(1000);
    expect(result[0]).toEqual(["A"]);
    expect(result[25]).toEqual(["Z"]);
  });

  it("very wide delimited rows (100 fields)", () => {
    const value = Array.from({ length: 100 }, (_, i) => `f${i}`).join(",");
    const result = splitDelimited(value, makeDelimCfg());
    expect(result.length).toBe(100);
    expect(result[0]).toBe("f0");
    expect(result[99]).toBe("f99");
  });

  it("text qualifier with many escaped quotes", () => {
    const cfg = makeDelimCfg();
    // Field with 50 escaped quotes
    const inner = '""'.repeat(50);
    const value = `"${inner}",normal`;
    const result = splitDelimited(value, cfg);
    expect(result[0]).toBe('"'.repeat(50));
    expect(result[1]).toBe("normal");
  });

  it("consecutive delimiters produce empty fields when treatConsecutiveAsOne is false", () => {
    const cfg = makeDelimCfg({ treatConsecutiveAsOne: false });
    const result = splitDelimited(",,,,,", cfg);
    expect(result).toEqual(["", "", "", "", "", ""]);
  });

  it("consecutive delimiters merge when treatConsecutiveAsOne is true", () => {
    const cfg = makeDelimCfg({ treatConsecutiveAsOne: true });
    const result = splitDelimited(",,,,,value", cfg);
    expect(result).toEqual(["", "value"]);
  });

  it("getMaxColumns on jagged parsed data", () => {
    const parsed = [["a"], ["a", "b", "c"], ["a", "b"]];
    expect(getMaxColumns(parsed)).toBe(3);
  });

  it("fixed width with zero-length text", () => {
    const result = splitFixedWidth("", [5, 10]);
    expect(result).toEqual(["", "", ""]);
  });
});
