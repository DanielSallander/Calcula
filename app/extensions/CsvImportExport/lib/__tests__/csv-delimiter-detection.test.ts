//! FILENAME: app/extensions/CsvImportExport/lib/__tests__/csv-delimiter-detection.test.ts
// PURPOSE: Deep tests for CSV delimiter auto-detection edge cases.

import { describe, it, expect } from "vitest";
import { detectDelimiter } from "../csvParser";

// ============================================================================
// Ambiguous / equal-frequency delimiters
// ============================================================================

describe("detectDelimiter - ambiguous cases", () => {
  it("picks a winner when comma and semicolon appear equally often", () => {
    // 2 commas, 2 semicolons per line - both consistent.
    // Algorithm iterates candidates in order [",", ";", "\t", "|"].
    // Comma is checked first, so it wins on equal score.
    const text = "a,b;c,d;e\nf,g;h,i;j\n";
    const delim = detectDelimiter(text);
    // Both have count=2 per line, consistent, same score. Comma wins by order.
    expect([",", ";"]).toContain(delim);
  });

  it("picks the delimiter with higher per-line count when both are consistent", () => {
    // 3 tabs vs 1 comma per line
    const text = "a\tb\tc\td,x\ne\tf\tg\th,y\n";
    expect(detectDelimiter(text)).toBe("\t");
  });
});

// ============================================================================
// Tab-delimited with commas in data
// ============================================================================

describe("detectDelimiter - tab-delimited with commas in data", () => {
  it("detects tab when commas appear inside fields but tabs are structural", () => {
    const text = [
      "Name\tAddress\tCity",
      "John\t123 Main St, Apt 4\tNew York",
      "Jane\t456 Oak Ave, Suite 10\tChicago",
    ].join("\n");
    expect(detectDelimiter(text)).toBe("\t");
  });

  it("detects tab over comma even with many commas in text fields", () => {
    const text = [
      "id\tdescription\tprice",
      "1\tRed, green, and blue items, all sizes\t9.99",
      "2\tSmall, medium, large, extra-large\t19.99",
      "3\tOne, two, three, four, five\t29.99",
    ].join("\n");
    expect(detectDelimiter(text)).toBe("\t");
  });
});

// ============================================================================
// Semicolon-delimited with commas in quoted fields
// ============================================================================

describe("detectDelimiter - semicolon with quoted commas", () => {
  it("detects semicolon when commas appear only inside quotes", () => {
    const text = [
      '"Name";"Amount";"Note"',
      '"Smith";"1,500.00";"OK"',
      '"Jones";"2,300.50";"Pending"',
    ].join("\n");
    expect(detectDelimiter(text)).toBe(";");
  });

  it("detects semicolon in European CSV with comma decimals", () => {
    const text = [
      "Produkt;Pris;Antal",
      "Brod;12,50;3",
      "Mjolk;9,90;2",
      "Ost;45,00;1",
    ].join("\n");
    expect(detectDelimiter(text)).toBe(";");
  });
});

// ============================================================================
// Pipe-delimited data
// ============================================================================

describe("detectDelimiter - pipe-delimited", () => {
  it("detects pipe delimiter", () => {
    const text = [
      "id|name|value",
      "1|alpha|100",
      "2|beta|200",
      "3|gamma|300",
    ].join("\n");
    expect(detectDelimiter(text)).toBe("|");
  });

  it("detects pipe even when commas appear in data", () => {
    const text = [
      "id|desc|amount",
      "1|Item A, premium|1,000",
      "2|Item B, basic|2,000",
    ].join("\n");
    expect(detectDelimiter(text)).toBe("|");
  });
});

// ============================================================================
// Space-delimited (not a candidate in current algorithm)
// ============================================================================

describe("detectDelimiter - space-delimited", () => {
  it("falls back to comma for space-only-delimited data (space not a candidate)", () => {
    const text = "a b c\nd e f\ng h i\n";
    // Space is not in the candidate list, so default comma wins
    const delim = detectDelimiter(text);
    expect(delim).toBe(",");
  });
});

// ============================================================================
// Single-column data (no delimiter)
// ============================================================================

describe("detectDelimiter - single column / no delimiters", () => {
  it("returns comma default when no candidate delimiters found", () => {
    const text = "hello\nworld\nfoo\nbar\n";
    expect(detectDelimiter(text)).toBe(",");
  });

  it("returns comma for empty string", () => {
    expect(detectDelimiter("")).toBe(",");
  });

  it("returns comma for whitespace-only lines", () => {
    expect(detectDelimiter("   \n   \n   \n")).toBe(",");
  });
});

// ============================================================================
// Single row (minimal data)
// ============================================================================

describe("detectDelimiter - single row", () => {
  it("detects comma from a single line", () => {
    expect(detectDelimiter("a,b,c")).toBe(",");
  });

  it("detects tab from a single line", () => {
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });

  it("detects semicolon from a single line", () => {
    expect(detectDelimiter("a;b;c")).toBe(";");
  });

  it("picks delimiter with highest count in single row", () => {
    // 3 semicolons vs 1 comma
    expect(detectDelimiter("a;b;c;d,e")).toBe(";");
  });
});

// ============================================================================
// Binary-looking data with delimiter chars
// ============================================================================

describe("detectDelimiter - binary-like data", () => {
  it("handles data with null-ish characters mixed with delimiters", () => {
    const text = "\x00,\x01,\x02\n\x03,\x04,\x05\n";
    expect(detectDelimiter(text)).toBe(",");
  });

  it("handles long lines of random-looking characters with few delimiters", () => {
    const junk = "abcdefghijklmnop";
    const text = `${junk},${junk}\n${junk},${junk}\n`;
    expect(detectDelimiter(text)).toBe(",");
  });
});

// ============================================================================
// Locale-aware: semicolon with comma decimals
// ============================================================================

describe("detectDelimiter - European locale patterns", () => {
  it("cannot distinguish comma from semicolon in '1,5;2,5;3,5' (equal counts)", () => {
    // Both comma and semicolon appear 2x per line, consistently.
    // Comma wins because it is checked first in the candidate list.
    // Real-world mitigation: use createDefaultParseOptions with locale hint.
    const text = [
      "1,5;2,5;3,5",
      "4,5;5,5;6,5",
      "7,5;8,5;9,5",
    ].join("\n");
    expect(detectDelimiter(text)).toBe(",");
  });

  it("detects semicolon when comma count varies but semicolon is consistent", () => {
    const text = [
      "10;20;30",
      "1,5;2,5;3,5",
      "100;200;300",
    ].join("\n");
    // Semicolons: 2 per line, consistent. Commas: 0, 2, 0 - inconsistent.
    expect(detectDelimiter(text)).toBe(";");
  });
});

// ============================================================================
// Very short vs very long samples
// ============================================================================

describe("detectDelimiter - sample length", () => {
  it("correctly detects from very short (2-char) input", () => {
    expect(detectDelimiter("a,b")).toBe(",");
  });

  it("only uses first 10 lines for detection", () => {
    // First 10 lines: semicolon-delimited. Lines 11+: comma-delimited.
    const semiLines = Array.from({ length: 10 }, (_, i) => `a${i};b${i};c${i}`);
    const commaLines = Array.from({ length: 100 }, (_, i) => `x${i},y${i},z${i}`);
    const text = [...semiLines, ...commaLines].join("\n");
    expect(detectDelimiter(text)).toBe(";");
  });
});

// ============================================================================
// Quoted fields containing the "wrong" delimiter
// ============================================================================

describe("detectDelimiter - quoted fields with wrong delimiter", () => {
  it("ignores commas inside quotes when semicolons are structural", () => {
    const text = [
      '"a,b";c;d',
      '"e,f";g;h',
      '"i,j";k;l',
    ].join("\n");
    // Outside quotes: 2 semicolons per line. Commas inside quotes are ignored.
    expect(detectDelimiter(text)).toBe(";");
  });

  it("ignores semicolons inside quotes when commas are structural", () => {
    const text = [
      'a,"b;c",d',
      'e,"f;g",h',
      'i,"j;k",l',
    ].join("\n");
    // Outside quotes: 2 commas per line. Semicolons inside quotes are ignored.
    expect(detectDelimiter(text)).toBe(",");
  });

  it("handles mixed quoted delimiters across many rows", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`"val;${i}",data${i},"more;stuff"`);
    }
    expect(detectDelimiter(lines.join("\n"))).toBe(",");
  });
});
