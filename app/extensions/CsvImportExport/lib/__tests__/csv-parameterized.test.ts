//! FILENAME: app/extensions/CsvImportExport/lib/__tests__/csv-parameterized.test.ts
// PURPOSE: Parameterized tests for CSV parse, export, and round-trip across delimiter/qualifier combos.

import { describe, it, expect } from "vitest";
import { parseCsv, CsvParseOptions } from "../csvParser";
import { exportToCsv, CsvExportOptions } from "../csvExporter";

// ============================================================================
// Test data generators
// ============================================================================

const DELIMITERS = [
  { name: "comma", char: "," },
  { name: "tab", char: "\t" },
  { name: "semicolon", char: ";" },
  { name: "pipe", char: "|" },
  { name: "space", char: " " },
] as const;

const QUALIFIERS = [
  { name: "double-quote", char: '"' },
  { name: "single-quote", char: "'" },
  { name: "none", char: "" },
  { name: "custom-tilde", char: "~" },
] as const;

function buildCsvText(
  rows: string[][],
  delimiter: string,
  qualifier: string,
): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (qualifier && (cell.includes(delimiter) || cell.includes("\n") || cell.includes(qualifier))) {
            const escaped = cell.replace(new RegExp(escapeRegex(qualifier), "g"), qualifier + qualifier);
            return qualifier + escaped + qualifier;
          }
          return cell;
        })
        .join(delimiter),
    )
    .join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Simple data that won't contain any delimiter or qualifier characters
const SIMPLE_DATA: string[][] = [
  ["Alice", "30", "Engineer"],
  ["Bob", "25", "Designer"],
  ["Carol", "35", "Manager"],
];

// ============================================================================
// Parse: 5 delimiters x 4 qualifiers = 20 tests
// ============================================================================

describe("CSV Parse - delimiter x qualifier combos", () => {
  const combos = DELIMITERS.flatMap((d) =>
    QUALIFIERS.map((q) => ({
      delimName: d.name,
      delimChar: d.char,
      qualName: q.name,
      qualChar: q.char,
    })),
  );

  it.each(combos)(
    "parses with delimiter=$delimName qualifier=$qualName",
    ({ delimChar, qualChar }) => {
      const csvText = buildCsvText(SIMPLE_DATA, delimChar, qualChar);
      const options: CsvParseOptions = {
        delimiter: delimChar,
        textQualifier: qualChar,
        hasHeaders: false,
        skipRows: 0,
      };
      const result = parseCsv(csvText, options);
      expect(result.length).toBe(3);
      expect(result[0][0]).toBe("Alice");
      expect(result[1][2]).toBe("Designer");
    },
  );
});

// ============================================================================
// Export: 5 delimiters x 4 qualifiers = 20 tests
// ============================================================================

describe("CSV Export - delimiter x qualifier combos", () => {
  const combos = DELIMITERS.flatMap((d) =>
    QUALIFIERS.map((q) => ({
      delimName: d.name,
      delimChar: d.char,
      qualName: q.name,
      qualChar: q.char,
    })),
  );

  it.each(combos)(
    "exports with delimiter=$delimName qualifier=$qualName",
    ({ delimChar, qualChar }) => {
      const options: CsvExportOptions = {
        delimiter: delimChar,
        textQualifier: qualChar,
        lineEnding: "\n",
      };
      const result = exportToCsv(SIMPLE_DATA, options);
      const lines = result.split("\n");
      expect(lines.length).toBe(3);
      // Each line should contain the delimiter (except space delimiter where fields have no spaces)
      for (const line of lines) {
        const fields = line.split(delimChar);
        expect(fields.length).toBeGreaterThanOrEqual(3);
      }
    },
  );
});

// ============================================================================
// Round-trip: 5 delimiters x 4 qualifiers = 20 tests
// ============================================================================

describe("CSV Round-trip - delimiter x qualifier combos", () => {
  const combos = DELIMITERS.flatMap((d) =>
    QUALIFIERS.map((q) => ({
      delimName: d.name,
      delimChar: d.char,
      qualName: q.name,
      qualChar: q.char,
    })),
  );

  it.each(combos)(
    "round-trips with delimiter=$delimName qualifier=$qualName",
    ({ delimChar, qualChar }) => {
      const exportOpts: CsvExportOptions = {
        delimiter: delimChar,
        textQualifier: qualChar,
        lineEnding: "\n",
      };
      const csv = exportToCsv(SIMPLE_DATA, exportOpts);

      const parseOpts: CsvParseOptions = {
        delimiter: delimChar,
        textQualifier: qualChar,
        hasHeaders: false,
        skipRows: 0,
      };
      const result = parseCsv(csv, parseOpts);

      expect(result.length).toBe(SIMPLE_DATA.length);
      for (let r = 0; r < SIMPLE_DATA.length; r++) {
        for (let c = 0; c < SIMPLE_DATA[r].length; c++) {
          expect(result[r][c]).toBe(SIMPLE_DATA[r][c]);
        }
      }
    },
  );
});

// ============================================================================
// Various row counts x column counts = 15 tests
// ============================================================================

describe("CSV Parse - row count x column count", () => {
  const rowCounts = [0, 1, 10, 100, 1000];
  const colCounts = [1, 5, 50];

  const combos = rowCounts.flatMap((rows) =>
    colCounts.map((cols) => ({ rows, cols })),
  );

  it.each(combos)(
    "parses $rows rows x $cols columns",
    ({ rows, cols }) => {
      const data: string[][] = [];
      for (let r = 0; r < rows; r++) {
        const row: string[] = [];
        for (let c = 0; c < cols; c++) {
          row.push(`R${r}C${c}`);
        }
        data.push(row);
      }

      const csvText = buildCsvText(data, ",", '"');
      const options: CsvParseOptions = {
        delimiter: ",",
        textQualifier: '"',
        hasHeaders: false,
        skipRows: 0,
      };
      const result = parseCsv(csvText, options);

      if (rows === 0) {
        expect(result.length).toBe(0);
      } else {
        expect(result.length).toBe(rows);
        expect(result[0].length).toBe(cols);
        expect(result[0][0]).toBe("R0C0");
        expect(result[rows - 1][cols - 1]).toBe(`R${rows - 1}C${cols - 1}`);
      }
    },
  );
});

// ============================================================================
// Additional parse edge cases with qualifiers = 5 tests
// ============================================================================

describe("CSV Parse - fields containing delimiter with each qualifier", () => {
  const qualifiersWithChars = QUALIFIERS.filter((q) => q.char !== "");

  it.each(qualifiersWithChars)(
    "handles embedded delimiter with qualifier=$name",
    ({ char: qualChar }) => {
      // Field contains comma (delimiter), must be qualified
      const row = `${qualChar}hello${qualChar},world,${qualChar}foo,bar${qualChar}`;
      const options: CsvParseOptions = {
        delimiter: ",",
        textQualifier: qualChar,
        hasHeaders: false,
        skipRows: 0,
      };
      const result = parseCsv(row, options);
      expect(result[0][0]).toBe("hello");
      expect(result[0][1]).toBe("world");
      expect(result[0][2]).toBe("foo,bar");
    },
  );

  it.each([1, 2, 5])(
    "parses with skipRows=%i",
    (skip) => {
      const lines = Array.from({ length: 10 }, (_, i) => `val${i}`).join("\n");
      const options: CsvParseOptions = {
        delimiter: ",",
        textQualifier: '"',
        hasHeaders: false,
        skipRows: skip,
      };
      const result = parseCsv(lines, options);
      expect(result.length).toBe(10 - skip);
      expect(result[0][0]).toBe(`val${skip}`);
    },
  );
});
