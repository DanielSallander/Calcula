//! FILENAME: app/extensions/CsvImportExport/lib/__tests__/csv-unusual-data.test.ts
// PURPOSE: Tests with unusual CSV data shapes to find edge cases in parsing and export.

import { describe, it, expect } from "vitest";
import {
  parseCsv,
  detectDelimiter,
  createDefaultParseOptions,
  type CsvParseOptions,
} from "../csvParser";
import {
  exportToCsv,
  createDefaultExportOptions,
  type CsvExportOptions,
} from "../csvExporter";

// ============================================================================
// Test Helpers
// ============================================================================

function opts(overrides: Partial<CsvParseOptions> = {}): CsvParseOptions {
  return { delimiter: ",", textQualifier: '"', hasHeaders: false, skipRows: 0, ...overrides };
}

// ============================================================================
// CSV with 0 rows (header only)
// ============================================================================

describe("CSV with header only (0 data rows)", () => {
  it("parseCsv returns single row for header-only input", () => {
    const result = parseCsv("Name,Age,City", opts());
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(["Name", "Age", "City"]);
  });

  it("parseCsv with hasHeaders returns single header row", () => {
    const result = parseCsv("Name,Age,City", opts({ hasHeaders: true }));
    expect(result).toHaveLength(1);
  });

  it("parseCsv returns empty array for empty string", () => {
    const result = parseCsv("", opts());
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// CSV with 1000 columns
// ============================================================================

describe("CSV with 1000 columns", () => {
  const header = Array.from({ length: 1000 }, (_, i) => `Col${i}`).join(",");
  const row = Array.from({ length: 1000 }, (_, i) => `${i}`).join(",");
  const csv = `${header}\n${row}`;

  it("parseCsv handles 1000 columns", () => {
    const result = parseCsv(csv, opts());
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1000);
    expect(result[1]).toHaveLength(1000);
    expect(result[0][999]).toBe("Col999");
    expect(result[1][999]).toBe("999");
  });

  it("detectDelimiter identifies comma with 1000 columns", () => {
    expect(detectDelimiter(csv)).toBe(",");
  });
});

// ============================================================================
// CSV with cell containing 100K characters
// ============================================================================

describe("CSV with cell containing 100K characters", () => {
  const bigCell = "X".repeat(100_000);
  const csv = `A,"${bigCell}",C`;

  it("parseCsv preserves 100K character cell content", () => {
    const result = parseCsv(csv, opts());
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(3);
    expect(result[0][1].length).toBe(100_000);
  });

  it("parseCsv correctly parses fields around the large cell", () => {
    const result = parseCsv(csv, opts());
    expect(result[0][0]).toBe("A");
    expect(result[0][2]).toBe("C");
  });
});

// ============================================================================
// CSV where every cell is quoted
// ============================================================================

describe("CSV where every cell is quoted", () => {
  const csv = '"A","B","C"\n"1","2","3"\n"X","Y","Z"';

  it("parseCsv strips quotes from all cells", () => {
    const result = parseCsv(csv, opts());
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(["A", "B", "C"]);
    expect(result[1]).toEqual(["1", "2", "3"]);
    expect(result[2]).toEqual(["X", "Y", "Z"]);
  });

  it("detectDelimiter works when all cells are quoted", () => {
    expect(detectDelimiter(csv)).toBe(",");
  });
});

// ============================================================================
// CSV with only newlines
// ============================================================================

describe("CSV with only newlines", () => {
  it("parseCsv handles input of just LF newlines", () => {
    const result = parseCsv("\n\n\n", opts());
    // Each newline produces an empty row
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const row of result) {
      // Each row should have at least one field (empty string)
      expect(row.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("parseCsv handles input of just CRLF newlines", () => {
    const result = parseCsv("\r\n\r\n\r\n", opts());
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("detectDelimiter returns comma for newline-only input", () => {
    expect(detectDelimiter("\n\n\n")).toBe(",");
  });
});

// ============================================================================
// CSV with only commas
// ============================================================================

describe("CSV with only commas", () => {
  it("parseCsv treats consecutive commas as empty fields", () => {
    const result = parseCsv(",,,", opts());
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(["", "", "", ""]);
  });

  it("parseCsv handles multi-row all-comma input", () => {
    const result = parseCsv(",,\n,,\n,,", opts());
    expect(result).toHaveLength(3);
    for (const row of result) {
      expect(row).toEqual(["", "", ""]);
    }
  });

  it("detectDelimiter identifies comma for comma-only input", () => {
    expect(detectDelimiter(",,,")).toBe(",");
  });
});
