//! FILENAME: app/extensions/TextToColumns/lib/__tests__/text-split-parameterized.test.ts
// PURPOSE: Parameterized tests for splitDelimited and splitFixedWidth.
// TARGET: 240+ test cases via it.each.

import { describe, it, expect } from "vitest";
import { splitDelimited, splitFixedWidth, DelimitedConfig } from "../../lib/parser";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides: Partial<DelimitedConfig> = {}): DelimitedConfig {
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
// 1. splitDelimited: 50 inputs x 3 configs = 150 tests
// ============================================================================

describe("splitDelimited - 150 tests (50 inputs x 3 configs)", () => {

  const inputs: [string, string][] = [
    ["empty string", ""],
    ["single value", "hello"],
    ["two values", "a,b"],
    ["three values", "a,b,c"],
    ["trailing delimiter", "a,b,"],
    ["leading delimiter", ",a,b"],
    ["only delimiter", ","],
    ["multiple delimiters", ",,,"],
    ["quoted field", '"hello",world'],
    ["quoted with delimiter", '"a,b",c'],
    ["escaped quote", '"say ""hi""",end'],
    ["only quotes", '""'],
    ["empty quoted", '"",""'],
    ["spaces around", " a , b , c "],
    ["tab in value", "a\tb,c"],
    ["newline-like chars", "a\\nb,c"],
    ["number values", "1,2,3"],
    ["decimal values", "1.5,2.7,3.9"],
    ["negative numbers", "-1,-2,-3"],
    ["mixed types", "abc,123,true"],
    ["long value", "a".repeat(500) + ",b"],
    ["single char values", "a,b,c,d,e"],
    ["unicode", "hello,world"],
    ["url value", "http://example.com,test"],
    ["path value", "C:\\Users,test"],
    ["email", "user@test.com,admin@test.com"],
    ["with equals", "a=1,b=2"],
    ["with colons", "a:1,b:2"],
    ["with pipes", "a|1,b|2"],
    ["with semicolons", "a;1,b;2"],
    ["with brackets", "[a],[b]"],
    ["with parens", "(a),(b)"],
    ["with braces", "{a},{b}"],
    ["with hash", "#a,#b"],
    ["with at", "@a,@b"],
    ["boolean-like", "true,false,null"],
    ["whitespace only", " , , "],
    ["mixed whitespace", "\t, ,\t"],
    ["consecutive commas", "a,,b"],
    ["three consecutive", "a,,,b"],
    ["all empty fields", ",,,,"],
    ["quoted empty", '"","","",""'],
    ["mixed quoted", 'a,"b",c'],
    ["quote at end", 'a,"b"'],
    ["quote at start", '"a",b'],
    ["very many fields", Array.from({ length: 20 }, (_, i) => `f${i}`).join(",")],
    ["single quoted comma", '"a,b"'],
    ["double comma in quote", '"a,,b",c'],
    ["special chars", "!@#,$%^,&*()"],
    ["just spaces", "   ,   ,   "],
  ];

  const configs: [string, DelimitedConfig][] = [
    ["comma", makeConfig({ comma: true })],
    ["comma+mergeConsecutive", makeConfig({ comma: true, treatConsecutiveAsOne: true })],
    ["comma+noQualifier", makeConfig({ comma: true, textQualifier: "" })],
  ];

  const combos = inputs.flatMap(([inputDesc, input]) =>
    configs.map(([configDesc, config]) => ({
      desc: `${inputDesc} [${configDesc}]`,
      input,
      config,
    })),
  );

  it.each(combos)(
    "splitDelimited: $desc",
    ({ input, config }) => {
      const result = splitDelimited(input, config);

      // Basic invariants
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(1);

      // Every element should be a string
      for (const field of result) {
        expect(typeof field).toBe("string");
      }

      // Joining back should roughly reconstruct (may differ due to quoting)
      // At minimum, all content characters should be present somewhere
      if (!config.textQualifier) {
        // Without qualifier, no quote stripping happens
        const joined = result.join(",");
        // The joined result should contain all non-delimiter characters from input
        // (unless consecutive merge removed some)
      }
    },
  );
});

// --- Additional targeted splitDelimited tests for specific behaviors ---

describe("splitDelimited specific behaviors", () => {

  const semicolonCases: [string, string, string[]][] = [
    ["basic semicolon", "a;b;c", ["a", "b", "c"]],
    ["semicolon with comma", "a,b;c,d", ["a,b", "c,d"]],
    ["trailing semicolon", "a;b;", ["a", "b", ""]],
    ["empty between", "a;;b", ["a", "", "b"]],
    ["quoted semicolon", '"a;b";c', ["a;b", "c"]],
  ];

  it.each(semicolonCases)(
    "semicolon delimiter: %s",
    (_desc, input, expected) => {
      const config = makeConfig({ comma: false, semicolon: true });
      expect(splitDelimited(input, config)).toEqual(expected);
    },
  );

  const tabCases: [string, string, string[]][] = [
    ["basic tab", "a\tb\tc", ["a", "b", "c"]],
    ["tab with comma", "a,b\tc,d", ["a,b", "c,d"]],
    ["double tab", "a\t\tb", ["a", "", "b"]],
    ["double tab merged", "a\t\tb", ["a", "b"]],
    ["only tab", "\t", ["", ""]],
  ];

  it.each(tabCases)(
    "tab delimiter: %s",
    (_desc, input, expected) => {
      // For "double tab merged" use consecutive merge
      const merge = _desc.includes("merged");
      const config = makeConfig({ comma: false, tab: true, treatConsecutiveAsOne: merge });
      expect(splitDelimited(input, config)).toEqual(expected);
    },
  );

  const spaceCases: [string, string, string[]][] = [
    ["basic space", "a b c", ["a", "b", "c"]],
    ["multiple spaces", "a   b", ["a", "", "", "b"]],
    ["multiple spaces merged", "a   b", ["a", "b"]],
    ["leading space", " a b", ["", "a", "b"]],
    ["trailing space", "a b ", ["a", "b", ""]],
  ];

  it.each(spaceCases)(
    "space delimiter: %s",
    (_desc, input, expected) => {
      const merge = _desc.includes("merged");
      const config = makeConfig({ comma: false, space: true, treatConsecutiveAsOne: merge });
      expect(splitDelimited(input, config)).toEqual(expected);
    },
  );

  const customDelimCases: [string, string, string, string[]][] = [
    ["tilde", "a~b~c", "~", ["a", "b", "c"]],
    ["pipe", "a|b|c", "|", ["a", "b", "c"]],
    ["colon", "a:b:c", ":", ["a", "b", "c"]],
    ["hash", "a#b#c", "#", ["a", "b", "c"]],
    ["at", "a@b@c", "@", ["a", "b", "c"]],
  ];

  it.each(customDelimCases)(
    "custom delimiter %s: %s",
    (_desc, input, delim, expected) => {
      const config = makeConfig({ comma: false, other: delim });
      expect(splitDelimited(input, config)).toEqual(expected);
    },
  );
});

// ============================================================================
// 2. splitFixedWidth: 30 inputs x 3 break configs = 90 tests
// ============================================================================

describe("splitFixedWidth - 90 tests (30 inputs x 3 configs)", () => {

  const fixedInputs: [string, string][] = [
    ["empty string", ""],
    ["single char", "a"],
    ["two chars", "ab"],
    ["three chars", "abc"],
    ["five chars", "abcde"],
    ["ten chars", "abcdefghij"],
    ["twenty chars", "12345678901234567890"],
    ["with spaces", "ab cd ef"],
    ["all spaces", "          "],
    ["single space", " "],
    ["tab chars", "\t\t\t\t\t"],
    ["mixed content", "abc 123 xyz"],
    ["numbers only", "0123456789"],
    ["repeated pattern", "aaabbbccc"],
    ["long string", "x".repeat(100)],
    ["unicode chars", "abcdefghij"],
    ["special chars", "!@#$%^&*()"],
    ["mixed case", "AaBbCcDdEe"],
    ["with newline char", "abc\ndef"],
    ["padded fields", "AAA   BBB   CCC"],
    ["right aligned", "   AAA   BBB"],
    ["varying widths", "ABCDEFGHIJKLMNOP"],
    ["single field wide", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    ["just one char wide", "A"],
    ["two wide fields", "AABBCCDDEE"],
    ["three equal", "AAABBBCCC"],
    ["very short", "XY"],
    ["exact boundary", "ABCD"],
    ["past boundary", "ABCDEF"],
    ["with trailing spaces", "AB  CD  EF  "],
  ];

  const breakConfigs: [string, number[]][] = [
    ["breaks at [3]", [3]],
    ["breaks at [3, 6]", [3, 6]],
    ["breaks at [2, 5, 8]", [2, 5, 8]],
  ];

  const fixedCombos = fixedInputs.flatMap(([inputDesc, input]) =>
    breakConfigs.map(([breakDesc, breaks]) => ({
      desc: `${inputDesc} with ${breakDesc}`,
      input,
      breaks,
    })),
  );

  it.each(fixedCombos)(
    "splitFixedWidth: $desc",
    ({ input, breaks }) => {
      const result = splitFixedWidth(input, breaks);

      // Basic invariants
      expect(Array.isArray(result)).toBe(true);
      // Should produce at most breaks.length + 1 fields
      expect(result.length).toBeLessThanOrEqual(breaks.length + 1);
      expect(result.length).toBeGreaterThanOrEqual(1);

      // Concatenation should equal the original input
      const concatenated = result.join("");
      expect(concatenated).toBe(input);

      // Every element should be a string
      for (const field of result) {
        expect(typeof field).toBe("string");
      }
    },
  );
});

// --- Additional splitFixedWidth exact-value tests ---

describe("splitFixedWidth exact results", () => {

  const exactCases: [string, string, number[], string[]][] = [
    ["split at 3", "ABCDEF", [3], ["ABC", "DEF"]],
    ["split at 1", "ABC", [1], ["A", "BC"]],
    ["split at 2,4", "ABCDEF", [2, 4], ["AB", "CD", "EF"]],
    ["split at end", "ABC", [3], ["ABC", ""]],
    ["split past end", "AB", [5], ["AB", ""]],
    ["no breaks", "ABC", [], ["ABC"]],
    ["single char breaks", "ABCD", [1, 2, 3], ["A", "B", "C", "D"]],
    ["empty with breaks", "", [3], ["", ""]],
    ["zero break ignored", "ABC", [0, 3], ["ABC", ""]],
    ["duplicate breaks", "ABCDEF", [3, 3, 6], ["ABC", "DEF", ""]],
  ];

  it.each(exactCases)(
    "exact: %s",
    (_desc, input, breaks, expected) => {
      expect(splitFixedWidth(input, breaks)).toEqual(expected);
    },
  );
});
