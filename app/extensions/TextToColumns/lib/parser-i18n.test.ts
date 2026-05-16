//! FILENAME: app/extensions/TextToColumns/lib/parser-i18n.test.ts
// PURPOSE: Tests for unicode, multi-byte, and internationalization edge cases in Text to Columns parsing.

import { describe, it, expect } from "vitest";
import {
  splitDelimited,
  splitFixedWidth,
  createDefaultConfig,
  type DelimitedConfig,
} from "./parser";

// ============================================================================
// Helper
// ============================================================================

function delimitedCfg(overrides: Partial<DelimitedConfig> = {}): DelimitedConfig {
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
// Unicode delimiters (via "other" field)
// ============================================================================

describe("unicode delimiters", () => {
  it("splits on middle dot (·) as custom delimiter", () => {
    const cfg = delimitedCfg({ comma: false, other: "·" });
    const result = splitDelimited("Alpha·Beta·Gamma", cfg);
    expect(result).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("splits on pipe (|) as custom delimiter", () => {
    const cfg = delimitedCfg({ comma: false, other: "|" });
    const result = splitDelimited("foo|bar|baz", cfg);
    expect(result).toEqual(["foo", "bar", "baz"]);
  });

  it("splits on bullet (•) as custom delimiter", () => {
    const cfg = delimitedCfg({ comma: false, other: "•" });
    const result = splitDelimited("one•two•three", cfg);
    expect(result).toEqual(["one", "two", "three"]);
  });

  it("splits on en-dash (–) as custom delimiter", () => {
    const cfg = delimitedCfg({ comma: false, other: "–" });
    const result = splitDelimited("2024–01–15", cfg);
    expect(result).toEqual(["2024", "01", "15"]);
  });

  it("custom delimiter only uses first character of multi-char string", () => {
    const cfg = delimitedCfg({ comma: false, other: "→←" });
    // Only "→" should be used as delimiter
    const result = splitDelimited("A→B←C", cfg);
    expect(result).toEqual(["A", "B←C"]);
  });
});

// ============================================================================
// Multi-byte character splitting (fixed width)
// ============================================================================

describe("multi-byte character splitting", () => {
  it("splits CJK text at character positions (not byte positions)", () => {
    // JavaScript string indexing is by UTF-16 code units
    const text = "東京都渋谷区";
    const result = splitFixedWidth(text, [2, 4]);
    expect(result).toEqual(["東京", "都渋", "谷区"]);
  });

  it("splits mixed ASCII and CJK at correct positions", () => {
    const text = "AB東京CD";
    const result = splitFixedWidth(text, [2, 4]);
    expect(result).toEqual(["AB", "東京", "CD"]);
  });

  it("handles surrogate pairs in fixed-width split", () => {
    // Emoji like 🎉 is 2 UTF-16 code units
    const text = "A🎉BCD";
    // "A" is index 0, 🎉 is index 1-2, "B" is index 3
    const result = splitFixedWidth(text, [1, 3]);
    expect(result).toEqual(["A", "🎉", "BCD"]);
  });

  it("delimited split preserves multi-byte characters", () => {
    const cfg = delimitedCfg();
    const result = splitDelimited("日本語,テスト,データ", cfg);
    expect(result).toEqual(["日本語", "テスト", "データ"]);
  });
});

// ============================================================================
// Mixed script text
// ============================================================================

describe("mixed script text (Latin + CJK in same field)", () => {
  it("preserves mixed Latin and Chinese text", () => {
    const cfg = delimitedCfg();
    const result = splitDelimited("Hello你好,World世界", cfg);
    expect(result).toEqual(["Hello你好", "World世界"]);
  });

  it("preserves mixed Latin and Japanese text in quoted field", () => {
    const cfg = delimitedCfg();
    const result = splitDelimited('"Tokyo東京, Japan日本",data', cfg);
    expect(result).toEqual(["Tokyo東京, Japan日本", "data"]);
  });

  it("preserves mixed Latin and Korean text", () => {
    const cfg = delimitedCfg();
    const result = splitDelimited("Seoul서울,Korea한국", cfg);
    expect(result).toEqual(["Seoul서울", "Korea한국"]);
  });

  it("handles Latin, CJK, and Arabic in the same row", () => {
    const cfg = delimitedCfg();
    const result = splitDelimited("Hello,你好,مرحبا", cfg);
    expect(result).toEqual(["Hello", "你好", "مرحبا"]);
  });
});

// ============================================================================
// Zero-width characters
// ============================================================================

describe("zero-width characters", () => {
  it("preserves zero-width space (U+200B) in field values", () => {
    const cfg = delimitedCfg();
    const zwsp = "\u200B";
    const result = splitDelimited(`Hello${zwsp}World,Test`, cfg);
    expect(result).toEqual([`Hello${zwsp}World`, "Test"]);
  });

  it("preserves zero-width non-joiner (U+200C) in field values", () => {
    const cfg = delimitedCfg();
    const zwnj = "\u200C";
    const result = splitDelimited(`A${zwnj}B,C`, cfg);
    expect(result[0]).toBe(`A${zwnj}B`);
    expect(result[0].length).toBe(3); // A + ZWNJ + B
  });

  it("preserves zero-width joiner (U+200D) in emoji ZWJ sequences", () => {
    const cfg = delimitedCfg();
    // Family emoji: person + ZWJ + person + ZWJ + child
    const family = "👨\u200D👩\u200D👧";
    const result = splitDelimited(`${family},label`, cfg);
    expect(result[0]).toBe(family);
  });

  it("does not treat zero-width space as a space delimiter", () => {
    const cfg = delimitedCfg({ comma: false, space: true });
    const zwsp = "\u200B";
    const result = splitDelimited(`Hello${zwsp}World Test`, cfg);
    // ZWSP should NOT split; regular space SHOULD split
    expect(result).toEqual([`Hello${zwsp}World`, "Test"]);
  });
});

// ============================================================================
// Combining diacritical marks
// ============================================================================

describe("combining diacritical marks", () => {
  it("preserves precomposed accented characters (NFC)", () => {
    const cfg = delimitedCfg();
    // NFC: é is a single code point U+00E9
    const result = splitDelimited("café,naïve,résumé", cfg);
    expect(result).toEqual(["café", "naïve", "résumé"]);
  });

  it("preserves decomposed accented characters (NFD)", () => {
    const cfg = delimitedCfg();
    // NFD: é = e + U+0301 combining acute accent
    const eAcute = "e\u0301";
    const result = splitDelimited(`caf${eAcute},data`, cfg);
    expect(result[0]).toBe(`caf${eAcute}`);
    // NFD form has more code units than visual characters
    expect(result[0].length).toBe(5); // c + a + f + e + combining accent
  });

  it("fixed-width split may bisect combining mark sequences", () => {
    // This documents the behavior: fixed-width splits by code unit index,
    // which can separate a base character from its combining mark
    const text = "e\u0301ABC"; // é (decomposed) + ABC
    const result = splitFixedWidth(text, [1]);
    // Split between 'e' and combining accent - this is a known edge case
    expect(result[0]).toBe("e");
    expect(result[1]).toBe("\u0301ABC");
  });

  it("handles Vietnamese text with stacked combining marks", () => {
    const cfg = delimitedCfg();
    // Vietnamese can have multiple combining marks
    const result = splitDelimited("Việt Nam,Hà Nội", cfg);
    expect(result).toEqual(["Việt Nam", "Hà Nội"]);
  });

  it("handles text with combining marks inside quoted fields", () => {
    const cfg = delimitedCfg();
    const result = splitDelimited('"Stra\u00DFe, München",Berlin', cfg);
    expect(result).toEqual(["Straße, München", "Berlin"]);
  });
});
