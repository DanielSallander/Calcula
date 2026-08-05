//! FILENAME: app/extensions/CsvImportExport/lib/csvParser.ts
// PURPOSE: Pure CSV parser with support for delimiters, text qualifiers, and encoding.
// CONTEXT: Used by the CSV Import dialog to parse raw text into a 2D array.
//          The core parsing loop is the shared @api/csvText module (facade
//          rule), which the script worker's api.text.parseCsv also uses.

import { parseCsvText } from "@api/csvText";

// ============================================================================
// Types
// ============================================================================

export interface CsvParseOptions {
  /** Field delimiter character. Default: "," */
  delimiter: string;
  /** Text qualifier character (for quoting fields). Default: '"' */
  textQualifier: string;
  /** Whether the first row contains headers */
  hasHeaders: boolean;
  /** Number of rows to skip from the start (before headers) */
  skipRows: number;
}

/**
 * Create default CSV parse options.
 * If a locale decimal separator is provided, the default delimiter is adjusted:
 * locales using ',' as decimal get ';' as CSV delimiter.
 */
export function createDefaultParseOptions(localeDecimalSeparator?: string): CsvParseOptions {
  return {
    delimiter: localeDecimalSeparator === "," ? ";" : ",",
    textQualifier: '"',
    hasHeaders: false,
    skipRows: 0,
  };
}

// ============================================================================
// Delimiter detection
// ============================================================================

/**
 * Auto-detect the most likely delimiter by counting occurrences in the first few lines.
 * Checks comma, semicolon, tab, and pipe.
 */
export function detectDelimiter(text: string): string {
  const candidates = [",", ";", "\t", "|"];
  const lines = text.split(/\r?\n/).slice(0, 10).filter((l) => l.length > 0);

  if (lines.length === 0) return ",";

  let bestDelim = ",";
  let bestScore = -1;

  for (const delim of candidates) {
    // Count occurrences per line, check consistency
    const counts = lines.map((line) => {
      let count = 0;
      let inQuote = false;
      for (const ch of line) {
        if (ch === '"') inQuote = !inQuote;
        else if (ch === delim && !inQuote) count++;
      }
      return count;
    });

    // A good delimiter appears the same number of times on each line
    const first = counts[0];
    if (first === 0) continue;

    const consistent = counts.every((c) => c === first);
    const score = consistent ? first * 10 + counts.reduce((a, b) => a + b, 0) : counts.reduce((a, b) => a + b, 0);

    if (score > bestScore) {
      bestScore = score;
      bestDelim = delim;
    }
  }

  return bestDelim;
}

// ============================================================================
// CSV Parser
// ============================================================================

/**
 * Parse a CSV text string into a 2D array of strings.
 * Handles quoted fields, escaped quotes (doubled), and mixed line endings.
 *
 * The parsing itself lives in @api/csvText — ONE parser shared with the
 * script surfaces (api.text.parseCsv and the Rust QuickJS Calcula.text twin),
 * so the import dialog and a script can never disagree about what a CSV means.
 */
export function parseCsv(text: string, options: CsvParseOptions): string[][] {
  const { delimiter, textQualifier, skipRows } = options;
  const rows = parseCsvText(text, delimiter, textQualifier.length > 0 ? textQualifier : null);

  // Apply skipRows
  if (skipRows > 0) {
    return rows.slice(skipRows);
  }

  return rows;
}

/**
 * Parse a limited number of rows for preview purposes.
 */
export function parseCsvPreview(
  text: string,
  options: CsvParseOptions,
  maxRows: number,
): string[][] {
  const all = parseCsv(text, options);
  return all.slice(0, maxRows);
}
