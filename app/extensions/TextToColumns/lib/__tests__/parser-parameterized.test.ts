//! FILENAME: app/extensions/TextToColumns/lib/__tests__/parser-parameterized.test.ts
// PURPOSE: Parameterized tests for Text to Columns parser functions.

import { describe, it, expect } from "vitest";
import {
  splitDelimited,
  splitFixedWidth,
  applyFormats,
  parseAll,
  DelimitedConfig,
  ColumnFormat,
  TextToColumnsConfig,
  createDefaultConfig,
} from "../../lib/parser";

// ============================================================================
// Helpers
// ============================================================================

function makeDelimConfig(overrides: Partial<DelimitedConfig> = {}): DelimitedConfig {
  return {
    tab: false,
    semicolon: false,
    comma: false,
    space: false,
    other: "",
    treatConsecutiveAsOne: false,
    textQualifier: '"',
    ...overrides,
  };
}

// ============================================================================
// splitDelimited - delimiter combos (20 tests)
// ============================================================================

describe("splitDelimited - single delimiter types", () => {
  const delimCases = [
    { name: "comma", cfg: { comma: true }, input: "a,b,c", expected: ["a", "b", "c"] },
    { name: "tab", cfg: { tab: true }, input: "a\tb\tc", expected: ["a", "b", "c"] },
    { name: "semicolon", cfg: { semicolon: true }, input: "a;b;c", expected: ["a", "b", "c"] },
    { name: "space", cfg: { space: true }, input: "a b c", expected: ["a", "b", "c"] },
    { name: "custom pipe", cfg: { other: "|" }, input: "a|b|c", expected: ["a", "b", "c"] },
  ] as const;

  const qualifiers = [
    { name: "double-quote", qual: '"' },
    { name: "single-quote", qual: "'" },
    { name: "none", qual: "" },
    { name: "tilde", qual: "~" },
  ] as const;

  const combos = delimCases.flatMap((d) =>
    qualifiers.map((q) => ({
      delimName: d.name,
      qualName: q.name,
      cfg: d.cfg,
      input: d.input,
      expected: d.expected,
      qual: q.qual,
    })),
  );

  it.each(combos)(
    "splits with $delimName delimiter and $qualName qualifier",
    ({ cfg, input, expected, qual }) => {
      const config = makeDelimConfig({ ...cfg, textQualifier: qual });
      const result = splitDelimited(input, config);
      expect(result).toEqual(expected);
    },
  );
});

// ============================================================================
// splitDelimited - consecutive delimiter merging (5 tests)
// ============================================================================

describe("splitDelimited - consecutive delimiter merging", () => {
  const cases = [
    { name: "comma", cfg: { comma: true }, input: "a,,b,,,c" },
    { name: "tab", cfg: { tab: true }, input: "a\t\tb\t\t\tc" },
    { name: "semicolon", cfg: { semicolon: true }, input: "a;;b;;;c" },
    { name: "space", cfg: { space: true }, input: "a  b   c" },
    { name: "pipe", cfg: { other: "|" }, input: "a||b|||c" },
  ];

  it.each(cases)(
    "merges consecutive $name delimiters",
    ({ cfg, input }) => {
      const config = makeDelimConfig({ ...cfg, treatConsecutiveAsOne: true });
      const result = splitDelimited(input, config);
      expect(result).toEqual(["a", "b", "c"]);
    },
  );
});

// ============================================================================
// splitFixedWidth - 10 break patterns (10 tests)
// ============================================================================

describe("splitFixedWidth - break patterns", () => {
  const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const breakPatterns = [
    { name: "single break at 5", breaks: [5], expected: ["ABCDE", "FGHIJKLMNOPQRSTUVWXYZ"] },
    { name: "two equal halves", breaks: [13], expected: ["ABCDEFGHIJKLM", "NOPQRSTUVWXYZ"] },
    { name: "three parts 5-5-rest", breaks: [5, 10], expected: ["ABCDE", "FGHIJ", "KLMNOPQRSTUVWXYZ"] },
    { name: "four parts", breaks: [3, 6, 9], expected: ["ABC", "DEF", "GHI", "JKLMNOPQRSTUVWXYZ"] },
    { name: "every 2 chars", breaks: [2, 4, 6, 8, 10], expected: ["AB", "CD", "EF", "GH", "IJ", "KLMNOPQRSTUVWXYZ"] },
    { name: "single char splits", breaks: [1, 2, 3], expected: ["A", "B", "C", "DEFGHIJKLMNOPQRSTUVWXYZ"] },
    { name: "break at end", breaks: [26], expected: ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", ""] },
    { name: "break near end", breaks: [24, 25], expected: ["ABCDEFGHIJKLMNOPQRSTUVWX", "Y", "Z"] },
    { name: "no breaks", breaks: [], expected: ["ABCDEFGHIJKLMNOPQRSTUVWXYZ"] },
    { name: "many even breaks", breaks: [4, 8, 12, 16, 20, 24], expected: ["ABCD", "EFGH", "IJKL", "MNOP", "QRST", "UVWX", "YZ"] },
  ];

  it.each(breakPatterns)(
    "splits with $name",
    ({ breaks, expected }) => {
      const result = splitFixedWidth(text, breaks);
      expect(result).toEqual(expected);
    },
  );
});

// ============================================================================
// applyFormats - format types x data patterns (25 tests)
// ============================================================================

describe("applyFormats - format types x data patterns", () => {
  const formats: Array<{ name: string; fmt: ColumnFormat }> = [
    { name: "general", fmt: "general" },
    { name: "text", fmt: "text" },
    { name: "date:MDY", fmt: "date:MDY" },
    { name: "date:DMY", fmt: "date:DMY" },
    { name: "date:YMD", fmt: "date:YMD" },
  ];

  const dataPatterns = [
    { name: "simple-text", fields: ["hello", "world", "foo"] },
    { name: "numbers", fields: ["123", "456.78", "0"] },
    { name: "dates-slash", fields: ["01/15/2024", "15/01/2024", "2024/01/15"] },
    { name: "dates-dash", fields: ["01-15-2024", "15-01-2024", "2024-01-15"] },
    { name: "mixed", fields: ["hello", "123", "01/15/2024"] },
  ];

  const combos = formats.flatMap((f) =>
    dataPatterns.map((d) => ({
      fmtName: f.name,
      fmt: f.fmt,
      dataName: d.name,
      fields: d.fields,
    })),
  );

  it.each(combos)(
    "applies $fmtName format to $dataName data",
    ({ fmt, fields }) => {
      const fmts: ColumnFormat[] = fields.map(() => fmt);
      const result = applyFormats(fields, fmts);
      expect(result.length).toBe(fields.length);
      // All non-skip formats should produce a string
      for (const val of result) {
        expect(typeof val).toBe("string");
      }
    },
  );
});

// ============================================================================
// applyFormats - skip column (5 tests)
// ============================================================================

describe("applyFormats - skip column filtering", () => {
  const cases = [
    { name: "skip first", formats: ["skip", "general", "general"] as ColumnFormat[], fields: ["a", "b", "c"], expectedLen: 2 },
    { name: "skip middle", formats: ["general", "skip", "general"] as ColumnFormat[], fields: ["a", "b", "c"], expectedLen: 2 },
    { name: "skip last", formats: ["general", "general", "skip"] as ColumnFormat[], fields: ["a", "b", "c"], expectedLen: 2 },
    { name: "skip all", formats: ["skip", "skip", "skip"] as ColumnFormat[], fields: ["a", "b", "c"], expectedLen: 0 },
    { name: "skip none", formats: ["general", "text", "general"] as ColumnFormat[], fields: ["a", "b", "c"], expectedLen: 3 },
  ];

  it.each(cases)(
    "$name",
    ({ formats: fmts, fields, expectedLen }) => {
      const result = applyFormats(fields, fmts);
      expect(result.length).toBe(expectedLen);
    },
  );
});

// ============================================================================
// parseAll - mode x data shapes (10 tests)
// ============================================================================

describe("parseAll - delimited mode x data shapes", () => {
  const dataShapes = [
    { name: "empty", values: [] as string[] },
    { name: "single-cell", values: ["hello"] },
    { name: "single-row-multi-col", values: ["a,b,c,d,e"] },
    { name: "multi-row", values: ["a,b", "c,d", "e,f"] },
    { name: "ragged", values: ["a,b,c", "d", "e,f"] },
  ];

  it.each(dataShapes)(
    "delimited mode with $name data",
    ({ values }) => {
      const config: TextToColumnsConfig = {
        ...createDefaultConfig(),
        mode: "delimited",
        delimited: makeDelimConfig({ comma: true }),
      };
      const result = parseAll(values, config);
      expect(result.length).toBe(values.length);
    },
  );
});

describe("parseAll - fixed-width mode x data shapes", () => {
  const dataShapes = [
    { name: "empty", values: [] as string[], breaks: [5] },
    { name: "single-cell", values: ["ABCDEFGHIJ"], breaks: [5] },
    { name: "multi-row-even", values: ["ABCDE12345", "FGHIJ67890"], breaks: [5] },
    { name: "multi-break", values: ["ABCDEFGHIJ"], breaks: [2, 4, 6, 8] },
    { name: "short-input", values: ["AB", "CDEF"], breaks: [5, 10] },
  ];

  it.each(dataShapes)(
    "fixed-width mode with $name data",
    ({ values, breaks }) => {
      const config: TextToColumnsConfig = {
        ...createDefaultConfig(),
        mode: "fixedWidth",
        fixedWidthBreaks: breaks,
      };
      const result = parseAll(values, config);
      expect(result.length).toBe(values.length);
      if (values.length > 0) {
        // Should have splits
        expect(result[0].length).toBeGreaterThanOrEqual(1);
      }
    },
  );
});
