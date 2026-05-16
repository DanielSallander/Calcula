//! FILENAME: app/extensions/TextToColumns/lib/__tests__/parser-format-application.test.ts
// PURPOSE: Deep tests for TextToColumns format application logic.

import { describe, it, expect } from "vitest";
import {
  applyFormats,
  splitDelimited,
  type ColumnFormat,
  type DelimitedConfig,
} from "../parser";

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
// Date format: MDY
// ============================================================================

describe("applyFormats - date:MDY", () => {
  it("parses 2-digit year (< 30 as 2000s)", () => {
    const result = applyFormats(["01/15/25"], ["date:MDY"]);
    expect(result).toEqual(["01/15/2025"]);
  });

  it("parses 2-digit year (>= 30 as 1900s)", () => {
    const result = applyFormats(["06/01/95"], ["date:MDY"]);
    expect(result).toEqual(["06/01/1995"]);
  });

  it("parses 4-digit year unchanged", () => {
    const result = applyFormats(["12/25/2023"], ["date:MDY"]);
    expect(result).toEqual(["12/25/2023"]);
  });

  it("handles dash separators", () => {
    const result = applyFormats(["03-14-2024"], ["date:MDY"]);
    expect(result).toEqual(["03/14/2024"]);
  });

  it("handles dot separators", () => {
    const result = applyFormats(["03.14.2024"], ["date:MDY"]);
    expect(result).toEqual(["03/14/2024"]);
  });

  it("returns raw string for invalid month", () => {
    const result = applyFormats(["13/01/2024"], ["date:MDY"]);
    expect(result).toEqual(["13/01/2024"]); // month 13 is invalid
  });

  it("returns raw string for non-date text", () => {
    const result = applyFormats(["hello"], ["date:MDY"]);
    expect(result).toEqual(["hello"]);
  });
});

// ============================================================================
// Date format: DMY
// ============================================================================

describe("applyFormats - date:DMY", () => {
  it("parses DMY correctly - day first", () => {
    // 02/01/2024 in DMY = day 2, month 1
    const result = applyFormats(["02/01/2024"], ["date:DMY"]);
    expect(result).toEqual(["01/02/2024"]); // normalized to MM/DD/YYYY
  });

  it("handles ambiguous 01/02/03 in DMY (day=1, month=2, year=2003)", () => {
    const result = applyFormats(["01/02/03"], ["date:DMY"]);
    expect(result).toEqual(["02/01/2003"]);
  });

  it("handles European-style date with dots", () => {
    const result = applyFormats(["31.12.2024"], ["date:DMY"]);
    expect(result).toEqual(["12/31/2024"]);
  });
});

// ============================================================================
// Date format: YMD
// ============================================================================

describe("applyFormats - date:YMD", () => {
  it("parses ISO-style date", () => {
    const result = applyFormats(["2024-06-15"], ["date:YMD"]);
    expect(result).toEqual(["06/15/2024"]);
  });

  it("parses 2-digit year in YMD", () => {
    const result = applyFormats(["24/03/15"], ["date:YMD"]);
    expect(result).toEqual(["03/15/2024"]);
  });

  it("returns raw for too few parts", () => {
    const result = applyFormats(["2024-06"], ["date:YMD"]);
    expect(result).toEqual(["2024-06"]);
  });
});

// ============================================================================
// Skip format
// ============================================================================

describe("applyFormats - skip", () => {
  it("discards a single skipped column", () => {
    const result = applyFormats(["keep", "discard", "keep2"], ["general", "skip", "general"]);
    expect(result).toEqual(["keep", "keep2"]);
  });

  it("discards multiple skipped columns", () => {
    const result = applyFormats(
      ["a", "b", "c", "d", "e"],
      ["general", "skip", "skip", "general", "skip"],
    );
    expect(result).toEqual(["a", "d"]);
  });

  it("skipping all columns returns empty array", () => {
    const result = applyFormats(["a", "b", "c"], ["skip", "skip", "skip"]);
    expect(result).toEqual([]);
  });
});

// ============================================================================
// General format
// ============================================================================

describe("applyFormats - general", () => {
  it("trims whitespace from fields", () => {
    const result = applyFormats(["  hello  ", "  42  "], ["general", "general"]);
    expect(result).toEqual(["hello", "42"]);
  });

  it("passes through numeric strings unchanged", () => {
    const result = applyFormats(["3.14"], ["general"]);
    expect(result).toEqual(["3.14"]);
  });

  it("passes through empty string", () => {
    const result = applyFormats([""], ["general"]);
    expect(result).toEqual([""]);
  });
});

// ============================================================================
// Text format - preserves leading zeros
// ============================================================================

describe("applyFormats - text", () => {
  it("preserves leading zeros", () => {
    const result = applyFormats(["007", "00123"], ["text", "text"]);
    expect(result).toEqual(["007", "00123"]);
  });

  it("preserves numeric-looking strings as-is", () => {
    const result = applyFormats(["001-234-5678"], ["text"]);
    expect(result).toEqual(["001-234-5678"]);
  });

  it("trims whitespace even in text mode", () => {
    const result = applyFormats(["  00123  "], ["text"]);
    expect(result).toEqual(["00123"]);
  });
});

// ============================================================================
// Partially empty columns
// ============================================================================

describe("applyFormats - partially empty columns", () => {
  it("handles empty fields with date format (returns empty trimmed string)", () => {
    const result = applyFormats(["01/15/2024", "", "03/20/2024"], [
      "date:MDY",
      "date:MDY",
      "date:MDY",
    ]);
    // Empty string has no 3 parts after split, so returned as-is
    expect(result).toEqual(["01/15/2024", "", "03/20/2024"]);
  });

  it("handles empty fields with general format", () => {
    const result = applyFormats(["hello", "", "world"], ["general", "general", "general"]);
    expect(result).toEqual(["hello", "", "world"]);
  });

  it("skips empty field when format is skip", () => {
    const result = applyFormats(["a", "", "c"], ["general", "skip", "general"]);
    expect(result).toEqual(["a", "c"]);
  });
});

// ============================================================================
// More formats than data columns
// ============================================================================

describe("applyFormats - more formats than columns", () => {
  it("only processes existing fields, ignores extra formats", () => {
    const result = applyFormats(["a", "b"], [
      "general",
      "text",
      "date:MDY",
      "skip",
      "general",
    ]);
    // Only 2 fields; formats[2..4] have no data to act on
    expect(result).toEqual(["a", "b"]);
  });
});

// ============================================================================
// Fewer formats than data columns
// ============================================================================

describe("applyFormats - fewer formats than columns", () => {
  it("defaults unspecified columns to general", () => {
    const result = applyFormats(["a", "b", "c", "d"], ["text"]);
    // formats[1], [2], [3] are undefined -> "general"
    expect(result).toEqual(["a", "b", "c", "d"]);
  });

  it("empty formats array treats all as general", () => {
    const result = applyFormats(["x", "y", "z"], []);
    expect(result).toEqual(["x", "y", "z"]);
  });
});

// ============================================================================
// Integration: split + format together
// ============================================================================

describe("splitDelimited + applyFormats integration", () => {
  it("splits then applies mixed formats", () => {
    const cfg = delimitedCfg({ comma: true });
    const fields = splitDelimited("01/15/2024,007,discard,hello", cfg);
    const formats: ColumnFormat[] = ["date:MDY", "text", "skip", "general"];
    const result = applyFormats(fields, formats);
    expect(result).toEqual(["01/15/2024", "007", "hello"]);
  });

  it("handles quoted fields then format application", () => {
    const cfg = delimitedCfg({ comma: true });
    const fields = splitDelimited('"  00123  ",normal', cfg);
    const result = applyFormats(fields, ["text", "general"]);
    expect(result).toEqual(["00123", "normal"]);
  });
});
