//! FILENAME: app/extensions/CsvImportExport/lib/__tests__/csv-roundtrip-stress.test.ts
// PURPOSE: Round-trip and stress tests for CSV parse/export pipeline.

import { describe, it, expect } from "vitest";
import { parseCsv, type CsvParseOptions } from "../csvParser";
import { exportToCsv, type CsvExportOptions } from "../csvExporter";

// ============================================================================
// Helpers
// ============================================================================

function parseOpts(overrides: Partial<CsvParseOptions> = {}): CsvParseOptions {
  return { delimiter: ",", textQualifier: '"', hasHeaders: false, skipRows: 0, ...overrides };
}

function exportOpts(overrides: Partial<CsvExportOptions> = {}): CsvExportOptions {
  return { delimiter: ",", textQualifier: '"', lineEnding: "\r\n", ...overrides };
}

/** Parse -> export -> re-parse round-trip. Returns the re-parsed data. */
function roundTrip(
  data: string[][],
  pOpts: Partial<CsvParseOptions> = {},
  eOpts: Partial<CsvExportOptions> = {},
): string[][] {
  const csv = exportToCsv(data, exportOpts(eOpts));
  const parsed = parseCsv(csv, parseOpts(pOpts));
  return parsed;
}

// ============================================================================
// Round-trip tests: 20 data shapes
// ============================================================================

describe("CSV round-trip: data shapes", () => {
  it("1. simple 3x3 grid", () => {
    const data = [["a", "b", "c"], ["1", "2", "3"], ["x", "y", "z"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("2. single cell", () => {
    const data = [["hello"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("3. single row, multiple columns", () => {
    const data = [["a", "b", "c", "d", "e"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("4. single column, multiple rows", () => {
    const data = [["row1"], ["row2"], ["row3"], ["row4"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("5. empty strings in all cells", () => {
    const data = [["", "", ""], ["", "", ""]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("6. numeric strings", () => {
    const data = [["123", "45.67", "-89", "0", "1e5"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("7. fields containing commas", () => {
    const data = [["a,b", "c,d,e"], ["no comma", "one,more"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("8. fields containing double quotes", () => {
    const data = [['say "hello"', 'a "b" c'], ["plain", "also plain"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("9. fields containing newlines", () => {
    const data = [["line1\nline2", "ok"], ["a\r\nb", "c"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("10. mixed special characters (delimiter, qualifier, newline)", () => {
    const data = [['has,comma "and" quote\nand newline', "normal"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("11. unicode content", () => {
    const data = [["cafe", "naive"], ["100 EUR", "200 JPY"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("12. very long field (1000+ chars)", () => {
    const longStr = "X".repeat(2000);
    const data = [[longStr, "short"], ["a", "b"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("13. wide row: 100 columns", () => {
    const row = Array.from({ length: 100 }, (_, i) => `col${i}`);
    const data = [row];
    expect(roundTrip(data)).toEqual(data);
  });

  it("14. tall data: 500 rows", () => {
    const data = Array.from({ length: 500 }, (_, i) => [`r${i}`, `v${i}`]);
    expect(roundTrip(data)).toEqual(data);
  });

  it("15. mixed empty and populated cells", () => {
    const data = [["a", "", "c"], ["", "b", ""], ["", "", ""]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("16. fields with leading/trailing spaces", () => {
    const data = [["  leading", "trailing  ", "  both  "]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("17. fields with tabs", () => {
    const data = [["a\tb", "c"], ["d", "e\tf"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("18. jagged rows (different column counts)", () => {
    // After export, each row gets padded to have same field count? No - export preserves.
    // parseCsv returns rows as-is, so jagged is fine.
    const data = [["a", "b", "c"], ["x", "y"], ["1"]];
    const result = roundTrip(data);
    expect(result[0]).toEqual(["a", "b", "c"]);
    expect(result[1]).toEqual(["x", "y"]);
    expect(result[2]).toEqual(["1"]);
  });

  it("19. boolean-like strings", () => {
    const data = [["true", "false", "TRUE", "FALSE", "0", "1"]];
    expect(roundTrip(data)).toEqual(data);
  });

  it("20. formula-like strings", () => {
    const data = [["=SUM(A1:B2)", "+100", "-50", "@mention"]];
    expect(roundTrip(data)).toEqual(data);
  });
});

// ============================================================================
// Stress tests
// ============================================================================

describe("CSV stress: 10K rows", () => {
  it("parses and re-exports 10,000 rows without data loss", () => {
    const data = Array.from({ length: 10_000 }, (_, i) => [
      `name${i}`,
      String(i * 1.5),
      i % 2 === 0 ? "even" : "odd",
    ]);
    const csv = exportToCsv(data, exportOpts());
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed.length).toBe(10_000);
    expect(parsed[0]).toEqual(["name0", "0", "even"]);
    expect(parsed[9999]).toEqual(["name9999", "14998.5", "odd"]);
    // Spot check random rows
    expect(parsed[5000]).toEqual(["name5000", "7500", "even"]);
  });
});

describe("CSV stress: 100 columns", () => {
  it("handles 100 columns across 50 rows", () => {
    const data = Array.from({ length: 50 }, (_, r) =>
      Array.from({ length: 100 }, (_, c) => `r${r}c${c}`),
    );
    const result = roundTrip(data);
    expect(result.length).toBe(50);
    expect(result[0].length).toBe(100);
    expect(result[49][99]).toBe("r49c99");
  });
});

describe("CSV stress: every printable ASCII character", () => {
  it("round-trips every printable ASCII char (32-126) in each cell", () => {
    // Build a row where each cell contains the full ASCII range
    const allAscii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
    const data = [[allAscii, allAscii, allAscii]];
    const result = roundTrip(data);
    expect(result[0][0]).toBe(allAscii);
    expect(result[0][1]).toBe(allAscii);
    expect(result[0][2]).toBe(allAscii);
  });

  it("round-trips each printable ASCII char individually in its own cell", () => {
    const row = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
    const data = [row];
    const result = roundTrip(data);
    expect(result[0]).toEqual(row);
  });
});

describe("CSV stress: mixed empty and full rows", () => {
  it("alternating empty and full rows", () => {
    const data: string[][] = [];
    for (let i = 0; i < 100; i++) {
      data.push(i % 2 === 0 ? ["a", "b", "c"] : ["", "", ""]);
    }
    const result = roundTrip(data);
    expect(result.length).toBe(100);
    expect(result[0]).toEqual(["a", "b", "c"]);
    expect(result[1]).toEqual(["", "", ""]);
    expect(result[98]).toEqual(["a", "b", "c"]);
    expect(result[99]).toEqual(["", "", ""]);
  });
});

describe("CSV: fields containing delimiter, qualifier, and newline", () => {
  it("handles all three in a single field", () => {
    const data = [['value with , and " and \n all together']];
    const result = roundTrip(data);
    expect(result[0][0]).toBe('value with , and " and \n all together');
  });

  it("multiple fields each with a different special char", () => {
    const data = [["has,comma", 'has"quote', "has\nnewline", "has\r\ncrlf"]];
    const result = roundTrip(data);
    expect(result[0]).toEqual(["has,comma", 'has"quote', "has\nnewline", "has\r\ncrlf"]);
  });
});

describe("CSV: mixed line endings", () => {
  it("parses CSV with mixed CRLF, LF, and CR line endings", () => {
    const csv = 'a,b\r\nc,d\ne,f\rg,h';
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed).toEqual([["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]]);
  });

  it("handles CR-only line endings throughout", () => {
    const csv = "a,b\rc,d\re,f";
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed).toEqual([["a", "b"], ["c", "d"], ["e", "f"]]);
  });

  it("handles LF-only line endings throughout", () => {
    const csv = "a,b\nc,d\ne,f";
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed).toEqual([["a", "b"], ["c", "d"], ["e", "f"]]);
  });
});

describe("CSV: every field quoted", () => {
  it("round-trips data where every field is quoted in source", () => {
    const csv = '"a","b","c"\r\n"1","2","3"';
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    // Re-export and re-parse
    const exported = exportToCsv(parsed, exportOpts());
    const reParsed = parseCsv(exported, parseOpts());
    expect(reParsed).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });
});

describe("CSV: no field quoted", () => {
  it("round-trips data where no field needs quoting", () => {
    const data = [["abc", "def", "ghi"], ["123", "456", "789"]];
    const csv = exportToCsv(data, exportOpts());
    // Verify no quotes in output
    expect(csv).not.toContain('"');
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed).toEqual(data);
  });
});

describe("CSV: export with different delimiters", () => {
  it("tab delimiter round-trip", () => {
    const data = [["a", "b", "c"], ["1", "2", "3"]];
    const result = roundTrip(data, { delimiter: "\t" }, { delimiter: "\t" });
    expect(result).toEqual(data);
  });

  it("semicolon delimiter round-trip", () => {
    const data = [["a", "b", "c"], ["1", "2", "3"]];
    const result = roundTrip(data, { delimiter: ";" }, { delimiter: ";" });
    expect(result).toEqual(data);
  });

  it("pipe delimiter round-trip", () => {
    const data = [["a", "b", "c"], ["1", "2", "3"]];
    const result = roundTrip(data, { delimiter: "|" }, { delimiter: "|" });
    expect(result).toEqual(data);
  });

  it("tab delimiter with fields containing tabs gets quoted", () => {
    const data = [["a\tb", "c"]];
    const csv = exportToCsv(data, exportOpts({ delimiter: "\t" }));
    expect(csv).toContain('"');
    const parsed = parseCsv(csv, parseOpts({ delimiter: "\t" }));
    expect(parsed[0][0]).toBe("a\tb");
  });

  it("semicolon delimiter with fields containing semicolons", () => {
    const data = [["a;b", "c"]];
    const result = roundTrip(data, { delimiter: ";" }, { delimiter: ";" });
    expect(result[0][0]).toBe("a;b");
  });
});

describe("CSV: consecutive empty fields", () => {
  it("parses ,,,, as five empty fields", () => {
    const csv = ",,,,";
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed).toEqual([["", "", "", "", ""]]);
  });

  it("round-trips rows with consecutive empty fields", () => {
    const data = [["", "", "", ""], ["a", "", "", "b"]];
    const result = roundTrip(data);
    expect(result).toEqual(data);
  });

  it("handles empty fields at start, middle, and end", () => {
    const data = [["", "mid", "", ""], ["", "", "val", ""]];
    const result = roundTrip(data);
    expect(result).toEqual(data);
  });
});

describe("CSV: single-column CSV", () => {
  it("parses single column data", () => {
    const csv = "a\r\nb\r\nc";
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed).toEqual([["a"], ["b"], ["c"]]);
  });

  it("round-trips single column", () => {
    const data = [["row1"], ["row2"], ["row3"]];
    const result = roundTrip(data);
    expect(result).toEqual(data);
  });
});

describe("CSV: single-row CSV", () => {
  it("parses single row with multiple columns", () => {
    const csv = "a,b,c,d,e";
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed).toEqual([["a", "b", "c", "d", "e"]]);
  });

  it("round-trips single row", () => {
    const data = [["one", "two", "three"]];
    const result = roundTrip(data);
    expect(result).toEqual(data);
  });
});

describe("CSV: header row column count mismatch", () => {
  it("header has more columns than data rows", () => {
    const csv = "h1,h2,h3,h4\r\na,b\r\nc,d";
    const parsed = parseCsv(csv, parseOpts({ hasHeaders: true }));
    // hasHeaders doesn't strip headers in parseCsv - it's metadata only
    expect(parsed[0].length).toBe(4);
    expect(parsed[1].length).toBe(2);
  });

  it("header has fewer columns than data rows", () => {
    const csv = "h1,h2\r\na,b,c,d\r\ne,f,g,h";
    const parsed = parseCsv(csv, parseOpts());
    expect(parsed[0].length).toBe(2);
    expect(parsed[1].length).toBe(4);
  });
});

describe("CSV: very wide rows (1000+ chars per field)", () => {
  it("handles fields with 1500 characters each", () => {
    const longA = "A".repeat(1500);
    const longB = "B".repeat(1500);
    const data = [[longA, longB]];
    const result = roundTrip(data);
    expect(result[0][0]).toBe(longA);
    expect(result[0][1]).toBe(longB);
    expect(result[0][0].length).toBe(1500);
  });

  it("handles 10 fields each 1000 chars with special characters", () => {
    const base = 'x,"y\n'.repeat(200); // 1000 chars with specials
    const row = Array.from({ length: 10 }, () => base);
    const data = [row];
    const result = roundTrip(data);
    for (let i = 0; i < 10; i++) {
      expect(result[0][i]).toBe(base);
    }
  });
});
