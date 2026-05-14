//! FILENAME: app/extensions/CsvImportExport/lib/__tests__/csvParser.test.ts
// PURPOSE: Tests for CSV parsing, delimiter detection, and export logic.

import { describe, it, expect } from "vitest";
import {
  parseCsv,
  detectDelimiter,
  createDefaultParseOptions,
  parseCsvPreview,
  type CsvParseOptions,
} from "../csvParser";
import {
  exportToCsv,
  createDefaultExportOptions,
  type CsvExportOptions,
} from "../csvExporter";

// ============================================================================
// Helper
// ============================================================================

function opts(overrides: Partial<CsvParseOptions> = {}): CsvParseOptions {
  return { delimiter: ",", textQualifier: '"', hasHeaders: false, skipRows: 0, ...overrides };
}

// ============================================================================
// detectDelimiter
// ============================================================================

describe("detectDelimiter", () => {
  it("detects comma-delimited data", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n4,5,6")).toBe(",");
  });

  it("detects semicolon-delimited data", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n4;5;6")).toBe(";");
  });

  it("detects tab-delimited data", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("detects pipe-delimited data", () => {
    expect(detectDelimiter("a|b|c\n1|2|3\n4|5|6")).toBe("|");
  });

  it("returns comma for empty input", () => {
    expect(detectDelimiter("")).toBe(",");
  });

  it("returns comma for single value with no delimiters", () => {
    expect(detectDelimiter("hello")).toBe(",");
  });

  it("prefers consistent delimiter over higher-count inconsistent one", () => {
    // semicolons appear consistently 2 per line, commas inconsistently
    const data = "a;b;c\n1;2;3\n4;5;6";
    expect(detectDelimiter(data)).toBe(";");
  });

  it("ignores delimiters inside quoted fields", () => {
    const data = '"a,b",c,d\n1,2,3\n4,5,6';
    // comma appears consistently (2 per line outside quotes)
    expect(detectDelimiter(data)).toBe(",");
  });

  it("uses only first 10 lines for detection", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `a;b;${i}`);
    expect(detectDelimiter(lines.join("\n"))).toBe(";");
  });
});

// ============================================================================
// createDefaultParseOptions
// ============================================================================

describe("createDefaultParseOptions", () => {
  it("defaults to comma delimiter", () => {
    expect(createDefaultParseOptions().delimiter).toBe(",");
  });

  it("uses semicolon when locale decimal is comma", () => {
    expect(createDefaultParseOptions(",").delimiter).toBe(";");
  });

  it("uses comma when locale decimal is period", () => {
    expect(createDefaultParseOptions(".").delimiter).toBe(",");
  });
});

// ============================================================================
// parseCsv - Basic parsing
// ============================================================================

describe("parseCsv", () => {
  it("parses simple comma-separated values", () => {
    const result = parseCsv("a,b,c\n1,2,3", opts());
    expect(result).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("handles empty input", () => {
    expect(parseCsv("", opts())).toEqual([]);
  });

  it("handles single cell", () => {
    expect(parseCsv("hello", opts())).toEqual([["hello"]]);
  });

  it("handles trailing newline without creating empty row", () => {
    const result = parseCsv("a,b\n1,2\n", opts());
    expect(result).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("handles Windows line endings (CRLF)", () => {
    const result = parseCsv("a,b\r\n1,2\r\n3,4", opts());
    expect(result).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("handles mixed line endings", () => {
    const result = parseCsv("a,b\r\n1,2\n3,4", opts());
    expect(result).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("handles empty fields", () => {
    const result = parseCsv(",b,\n,,", opts());
    expect(result).toEqual([["", "b", ""], ["", "", ""]]);
  });

  it("uses semicolon delimiter", () => {
    const result = parseCsv("a;b;c\n1;2;3", opts({ delimiter: ";" }));
    expect(result).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("uses tab delimiter", () => {
    const result = parseCsv("a\tb\tc", opts({ delimiter: "\t" }));
    expect(result).toEqual([["a", "b", "c"]]);
  });
});

// ============================================================================
// parseCsv - Quoted fields
// ============================================================================

describe("parseCsv - quoted fields", () => {
  it("handles quoted fields", () => {
    const result = parseCsv('"hello","world"', opts());
    expect(result).toEqual([["hello", "world"]]);
  });

  it("handles fields with embedded commas in quotes", () => {
    const result = parseCsv('"a,b",c', opts());
    expect(result).toEqual([["a,b", "c"]]);
  });

  it("handles fields with embedded newlines in quotes", () => {
    const result = parseCsv('"line1\nline2",b', opts());
    expect(result).toEqual([["line1\nline2", "b"]]);
  });

  it("handles escaped quotes (doubled)", () => {
    const result = parseCsv('"say ""hello""",b', opts());
    expect(result).toEqual([['say "hello"', "b"]]);
  });

  it("handles empty quoted field", () => {
    const result = parseCsv('"",b', opts());
    expect(result).toEqual([["", "b"]]);
  });

  it("handles single-quote text qualifier", () => {
    const result = parseCsv("'a,b',c", opts({ textQualifier: "'" }));
    expect(result).toEqual([["a,b", "c"]]);
  });

  it("handles no text qualifier", () => {
    const result = parseCsv('"a",b', opts({ textQualifier: "" }));
    // Without qualifier, quotes are literal
    expect(result).toEqual([['"a"', "b"]]);
  });

  it("handles CRLF inside quoted field", () => {
    const result = parseCsv('"line1\r\nline2",b', opts());
    expect(result).toEqual([["line1\r\nline2", "b"]]);
  });
});

// ============================================================================
// parseCsv - skipRows
// ============================================================================

describe("parseCsv - skipRows", () => {
  it("skips specified number of rows", () => {
    const result = parseCsv("header\na,b\n1,2", opts({ skipRows: 1 }));
    expect(result).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("skips all rows returns empty", () => {
    const result = parseCsv("a\nb\nc", opts({ skipRows: 10 }));
    expect(result).toEqual([]);
  });

  it("skip 0 returns all rows", () => {
    const result = parseCsv("a\nb", opts({ skipRows: 0 }));
    expect(result).toEqual([["a"], ["b"]]);
  });
});

// ============================================================================
// parseCsv - Edge cases and large data
// ============================================================================

describe("parseCsv - edge cases", () => {
  it("handles row with many columns", () => {
    const cols = Array.from({ length: 100 }, (_, i) => `col${i}`);
    const result = parseCsv(cols.join(","), opts());
    expect(result[0]).toHaveLength(100);
  });

  it("handles large dataset (1000 rows)", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `${i},val${i}`);
    const result = parseCsv(rows.join("\n"), opts());
    expect(result).toHaveLength(1000);
    expect(result[999]).toEqual(["999", "val999"]);
  });

  it("handles unicode content", () => {
    const result = parseCsv("namn,pris\nkaffe,25kr\n", opts());
    expect(result[1][0]).toBe("kaffe");
  });

  it("handles fields with only whitespace", () => {
    const result = parseCsv("  , ,a", opts());
    expect(result).toEqual([["  ", " ", "a"]]);
  });

  it("handles consecutive delimiters", () => {
    const result = parseCsv("a,,b,,,c", opts());
    expect(result).toEqual([["a", "", "b", "", "", "c"]]);
  });
});

// ============================================================================
// parseCsvPreview
// ============================================================================

describe("parseCsvPreview", () => {
  it("returns at most maxRows rows", () => {
    const csv = "a\nb\nc\nd\ne";
    const result = parseCsvPreview(csv, opts(), 3);
    expect(result).toHaveLength(3);
    expect(result).toEqual([["a"], ["b"], ["c"]]);
  });

  it("returns all rows if less than maxRows", () => {
    const result = parseCsvPreview("a\nb", opts(), 10);
    expect(result).toHaveLength(2);
  });
});

// ============================================================================
// exportToCsv
// ============================================================================

describe("exportToCsv", () => {
  function exportOpts(overrides: Partial<CsvExportOptions> = {}): CsvExportOptions {
    return { delimiter: ",", textQualifier: '"', lineEnding: "\r\n", ...overrides };
  }

  it("exports simple data", () => {
    const result = exportToCsv([["a", "b"], ["1", "2"]], exportOpts());
    expect(result).toBe("a,b\r\n1,2");
  });

  it("quotes fields containing delimiter", () => {
    const result = exportToCsv([["a,b", "c"]], exportOpts());
    expect(result).toBe('"a,b",c');
  });

  it("quotes fields containing newline", () => {
    const result = exportToCsv([["line1\nline2", "b"]], exportOpts());
    expect(result).toBe('"line1\nline2",b');
  });

  it("escapes quotes by doubling", () => {
    const result = exportToCsv([['say "hi"', "b"]], exportOpts());
    expect(result).toBe('"say ""hi""",b');
  });

  it("handles empty data", () => {
    expect(exportToCsv([], exportOpts())).toBe("");
  });

  it("handles empty strings in fields", () => {
    const result = exportToCsv([["", "", ""]], exportOpts());
    expect(result).toBe(",,");
  });

  it("uses semicolon delimiter", () => {
    const result = exportToCsv([["a", "b"]], exportOpts({ delimiter: ";" }));
    expect(result).toBe("a;b");
  });

  it("uses LF line ending", () => {
    const result = exportToCsv([["a"], ["b"]], exportOpts({ lineEnding: "\n" }));
    expect(result).toBe("a\nb");
  });

  it("quotes fields containing the text qualifier itself", () => {
    const result = exportToCsv([['a"b']], exportOpts());
    expect(result).toBe('"a""b"');
  });
});

// ============================================================================
// createDefaultExportOptions
// ============================================================================

describe("createDefaultExportOptions", () => {
  it("defaults to comma delimiter", () => {
    expect(createDefaultExportOptions().delimiter).toBe(",");
  });

  it("uses semicolon for comma-decimal locales", () => {
    expect(createDefaultExportOptions(",").delimiter).toBe(";");
  });

  it("defaults to CRLF line ending", () => {
    expect(createDefaultExportOptions().lineEnding).toBe("\r\n");
  });
});

// ============================================================================
// Round-trip: parse -> export -> parse
// ============================================================================

describe("CSV round-trip", () => {
  it("round-trips simple data", () => {
    const original = [["Name", "Age"], ["Alice", "30"], ["Bob", "25"]];
    const csv = exportToCsv(original, { delimiter: ",", textQualifier: '"', lineEnding: "\n" });
    const parsed = parseCsv(csv, opts());
    expect(parsed).toEqual(original);
  });

  it("round-trips data with special characters", () => {
    const original = [["a,b", 'say "hi"'], ["line1\nline2", "normal"]];
    const csv = exportToCsv(original, { delimiter: ",", textQualifier: '"', lineEnding: "\n" });
    const parsed = parseCsv(csv, opts());
    expect(parsed).toEqual(original);
  });
});
