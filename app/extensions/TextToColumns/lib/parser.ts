//! FILENAME: app/extensions/TextToColumns/lib/parser.ts
// PURPOSE: Pure parsing engines for Text to Columns.
// CONTEXT: Shared between live preview (wizard) and final execution.
//          No React or API dependencies - pure string manipulation.

// ============================================================================
// Types
// ============================================================================

/** Delimiter configuration for the delimited parsing mode. */
export interface DelimitedConfig {
  /** Which standard delimiters are active. */
  tab: boolean;
  semicolon: boolean;
  comma: boolean;
  space: boolean;
  /** Custom single-character delimiter (empty string = disabled). */
  other: string;
  /** If true, consecutive delimiters are merged into one. */
  treatConsecutiveAsOne: boolean;
  /** Character used to quote fields (e.g. `"` or `'`). Empty = none. */
  textQualifier: string;
}

/** Column format applied after splitting. */
export type ColumnFormat =
  | "general"
  | "text"
  | "date:MDY"
  | "date:DMY"
  | "date:YMD"
  | "skip";

/** Full configuration passed from the wizard to the execution step. */
export interface TextToColumnsConfig {
  mode: "delimited" | "fixedWidth";
  delimited: DelimitedConfig;
  /** Sorted ascending array of character break positions for fixed-width mode. */
  fixedWidthBreaks: number[];
  /** Per-column format. Index 0 = first result column, etc. */
  columnFormats: ColumnFormat[];
}

// ============================================================================
// Default configuration
// ============================================================================

export function createDefaultConfig(): TextToColumnsConfig {
  return {
    mode: "delimited",
    delimited: {
      tab: false,
      semicolon: false,
      comma: true,
      space: false,
      other: "",
      treatConsecutiveAsOne: false,
      textQualifier: '"',
    },
    fixedWidthBreaks: [],
    columnFormats: [],
  };
}

// ============================================================================
// Delimited parser
// ============================================================================

/**
 * Build the set of active delimiter characters from the config.
 */
function getActiveDelimiters(cfg: DelimitedConfig): Set<string> {
  const delims = new Set<string>();
  if (cfg.tab) delims.add("\t");
  if (cfg.semicolon) delims.add(";");
  if (cfg.comma) delims.add(",");
  if (cfg.space) delims.add(" ");
  if (cfg.other && cfg.other.length > 0) delims.add(cfg.other.charAt(0));
  return delims;
}

/**
 * Split a single text string using delimiter rules.
 * Handles text qualifiers and consecutive delimiter merging.
 */
export function splitDelimited(text: string, cfg: DelimitedConfig): string[] {
  const delims = getActiveDelimiters(cfg);
  if (delims.size === 0) return [text];

  const qualifier = cfg.textQualifier;
  const hasQualifier = qualifier.length > 0;
  const fields: string[] = [];
  let current = "";
  let inQualified = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Handle text qualifier
    if (hasQualifier && ch === qualifier) {
      if (inQualified) {
        // Check for escaped qualifier (doubled qualifier, e.g. "")
        if (i + 1 < text.length && text[i + 1] === qualifier) {
          current += qualifier;
          i += 2;
          continue;
        }
        // End of qualified region
        inQualified = false;
        i++;
        continue;
      } else {
        // Start of qualified region
        inQualified = true;
        i++;
        continue;
      }
    }

    // Delimiters are ignored inside qualified text
    if (!inQualified && delims.has(ch)) {
      fields.push(current);
      current = "";
      i++;

      // Handle consecutive delimiters
      if (cfg.treatConsecutiveAsOne) {
        while (i < text.length && delims.has(text[i])) {
          i++;
        }
      }
      continue;
    }

    current += ch;
    i++;
  }

  // Push the last field
  fields.push(current);
  return fields;
}

// ============================================================================
// Fixed-width parser
// ============================================================================

/**
 * Split a text string at fixed character positions.
 * @param text - The input string.
 * @param breaks - Sorted array of character positions where splits occur.
 * @returns Array of substrings. Trailing whitespace is preserved per field.
 */
export function splitFixedWidth(text: string, breaks: number[]): string[] {
  if (breaks.length === 0) return [text];

  const fields: string[] = [];
  let start = 0;

  for (const pos of breaks) {
    if (pos <= start) continue;
    fields.push(text.substring(start, pos));
    start = pos;
  }

  // Remaining text after the last break
  fields.push(text.substring(start));
  return fields;
}

// ============================================================================
// Format application
// ============================================================================

/**
 * Apply column formats to a row of split fields.
 * Returns only the fields that are not "skip", with format-specific transformations.
 */
export function applyFormats(
  fields: string[],
  formats: ColumnFormat[],
): string[] {
  const result: string[] = [];

  for (let i = 0; i < fields.length; i++) {
    const fmt = formats[i] ?? "general";
    if (fmt === "skip") continue;

    const raw = fields[i].trim();

    switch (fmt) {
      case "text":
        // Prefix with single-quote to force text in spreadsheet
        // This prevents the engine from auto-converting to numbers
        result.push(raw);
        break;

      case "date:MDY":
      case "date:DMY":
      case "date:YMD":
        result.push(parseDateString(raw, fmt));
        break;

      case "general":
      default:
        result.push(raw);
        break;
    }
  }

  return result;
}

/**
 * Attempt to parse a date string according to the specified format order.
 * Returns the original string if parsing fails.
 */
function parseDateString(
  raw: string,
  fmt: "date:MDY" | "date:DMY" | "date:YMD",
): string {
  // Try common separators
  const parts = raw.split(/[\/\-\.]/);
  if (parts.length !== 3) return raw;

  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => isNaN(n))) return raw;

  let month: number, day: number, year: number;

  switch (fmt) {
    case "date:MDY":
      [month, day, year] = nums;
      break;
    case "date:DMY":
      [day, month, year] = nums;
      break;
    case "date:YMD":
      [year, month, day] = nums;
      break;
  }

  // Expand 2-digit year
  if (year < 100) {
    year += year < 30 ? 2000 : 1900;
  }

  // Validate ranges
  if (month < 1 || month > 12 || day < 1 || day > 31) return raw;

  // Return in a normalized format that the spreadsheet engine understands
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${mm}/${dd}/${year}`;
}

// ============================================================================
// Batch processing
// ============================================================================

/**
 * Parse all source values using the current configuration.
 * Returns a 2D array: rows x columns of split results.
 * Does NOT apply column formats (caller can use applyFormats separately).
 */
export function parseAll(
  values: string[],
  config: TextToColumnsConfig,
): string[][] {
  return values.map((v) => {
    if (config.mode === "delimited") {
      return splitDelimited(v, config.delimited);
    } else {
      return splitFixedWidth(v, config.fixedWidthBreaks);
    }
  });
}

/**
 * Get the maximum number of result columns from a parsed dataset.
 */
export function getMaxColumns(parsed: string[][]): number {
  let max = 0;
  for (const row of parsed) {
    if (row.length > max) max = row.length;
  }
  return max;
}

/**
 * Apply formats and filter out "skip" columns, then determine
 * the final column count (excluding skipped columns).
 */
export function getFinalColumnCount(
  maxCols: number,
  formats: ColumnFormat[],
): number {
  let count = 0;
  for (let i = 0; i < maxCols; i++) {
    const fmt = formats[i] ?? "general";
    if (fmt !== "skip") count++;
  }
  return count;
}
