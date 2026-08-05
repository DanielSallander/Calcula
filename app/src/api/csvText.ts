//! FILENAME: app/src/api/csvText.ts
// PURPOSE: The ONE CSV parser/serializer (Wave 3, item 9). Three surfaces read
//          and write CSV — the CsvImportExport extension's dialogs, the
//          object-script worker's pure `api.text` helpers, and the Rust
//          QuickJS realm's `Calcula.text` ops — and they must never disagree
//          about what a CSV means. The TS truth lives here; the Rust twin is a
//          line-for-line port in core/script-engine/src/ops/text.rs, pinned to
//          this file by mirrored table-driven fixtures
//          (src/api/__tests__/csvText.test.ts <-> ops/text.rs tests).
// CONTEXT: API-layer on purpose (decision matrix: an interchange format is a
//          Bridge). PURE + dependency-free — no Tauri, no DOM — so the
//          hardened script worker bundle can import it, and so can the
//          extension (via @api/csvText) under the facade rule.

// ============================================================================
// Core parsing / serialization (shared by every caller)
// ============================================================================

/**
 * Parse CSV text into rows of fields. RFC-4180-ish, matching the import
 * dialog's historical semantics exactly:
 *  - `quote` opens a quoted region only at FIELD START; mid-field quotes are
 *    literal characters;
 *  - inside a quoted region, a doubled quote is an escaped quote;
 *  - delimiters and line endings inside a quoted region are field content;
 *  - `\r\n`, `\n` and `\r` all end a row;
 *  - a trailing newline does not produce a phantom empty row;
 *  - `quote: null` disables quoting entirely (the dialogs' textQualifier "").
 *
 * Iterates CODE POINTS (like the Rust twin's `chars()`), so an astral-plane
 * delimiter or quote behaves identically in both realms.
 */
export function parseCsvText(text: string, delimiter: string, quote: string | null): string[][] {
  const chars = Array.from(text);
  const len = chars.length;
  const rows: string[][] = [];

  let i = 0;
  while (i < len) {
    const row: string[] = [];
    let field = "";
    let inQuoted = false;

    while (i < len) {
      const ch = chars[i];

      // Handle text qualifier
      if (quote !== null && ch === quote) {
        if (!inQuoted) {
          // Start of quoted field (only valid at field start)
          if (field.length === 0) {
            inQuoted = true;
            i++;
            continue;
          }
        } else {
          // Inside quoted field - check for escaped qualifier (doubled)
          if (i + 1 < len && chars[i + 1] === quote) {
            field += quote;
            i += 2;
            continue;
          }
          // End of quoted region
          inQuoted = false;
          i++;
          continue;
        }
      }

      // Delimiter outside quotes = next field
      if (!inQuoted && ch === delimiter) {
        row.push(field);
        field = "";
        i++;
        continue;
      }

      // Line ending outside quotes = end of row
      if (!inQuoted && (ch === "\r" || ch === "\n")) {
        if (ch === "\r" && i + 1 < len && chars[i + 1] === "\n") {
          i++;
        }
        i++;
        break;
      }

      field += ch;
      i++;
    }

    // Push the last field of the row
    row.push(field);

    // Don't push a completely empty trailing row
    if (i >= len && row.length === 1 && row[0] === "") {
      break;
    }

    rows.push(row);
  }

  return rows;
}

/**
 * Serialize rows of fields to CSV text: a field containing the delimiter, the
 * quote char, `\r` or `\n` is wrapped in quotes with inner quotes doubled;
 * everything else is emitted verbatim.
 */
export function toCsvText(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  delimiter: string,
  quote: string,
  lineEnding: string,
): string {
  const lines: string[] = [];
  for (const row of rows) {
    const fields = row.map((value) => {
      const needsQuoting =
        value.includes(delimiter) ||
        value.includes(quote) ||
        value.includes("\r") ||
        value.includes("\n");
      if (needsQuoting) {
        const escaped = value.split(quote).join(quote + quote);
        return quote + escaped + quote;
      }
      return value;
    });
    lines.push(fields.join(delimiter));
  }
  return lines.join(lineEnding);
}

// ============================================================================
// The script-facing wrappers (api.text.parseCsv / api.text.toCsv)
// ============================================================================
// Option handling and every error MESSAGE mirror the Rust QuickJS twin
// (core/script-engine/src/ops/text.rs) word for word, so a script moved
// between the worker realm and the notebook realm fails the same way.

/** What a script's CSV cell may be; everything else serializes as "". */
export type CsvCellValue = string | number | boolean | null | undefined;

export interface ScriptParseCsvOptions {
  /** Field delimiter — exactly one character. Default: ",". */
  delimiter?: string;
  /** Quote character — exactly one character, or "" to disable quoting
   *  entirely. Default: '"'. */
  quote?: string;
  /** When true, the first parsed row is split off as `headers`. */
  hasHeaders?: boolean;
}

export interface ScriptParseCsvResult {
  rows: string[][];
  /** Present only when `hasHeaders` was true (the first row, possibly []). */
  headers?: string[];
}

export interface ScriptToCsvOptions {
  /** Field delimiter — exactly one character. Default: ",". */
  delimiter?: string;
  /** Quote character — exactly one character (never empty here: a serializer
   *  with no way to escape its own delimiter would emit ambiguous text).
   *  Default: '"'. */
  quote?: string;
  /** One of "\r\n" (default), "\n", "\r". */
  lineEnding?: string;
  /** Emitted as the first line — the symmetric inverse of parseCsv's
   *  hasHeaders split. */
  headers?: ReadonlyArray<CsvCellValue>;
}

/** Rust twin: `read_char_option`. Missing/undefined/null = the default; an
 *  empty string only where the caller allows it; longer than one CODE POINT
 *  throws. Returns null for "disabled" (the allow-empty case). */
function readCharOption(
  options: Record<string, unknown> | undefined,
  key: string,
  defaultCh: string,
  allowEmpty: boolean,
): string | null {
  const value = options?.[key];
  if (value === undefined || value === null) return defaultCh;
  if (typeof value !== "string") {
    throw new TypeError(`${key} must be a string`);
  }
  const points = Array.from(value);
  if (points.length === 0) {
    if (allowEmpty) return null;
    throw new Error(`${key} must be exactly one character`);
  }
  if (points.length > 1) {
    throw new Error(`${key} must be exactly one character`);
  }
  return points[0];
}

function optionsBag(options: unknown, label: string): Record<string, unknown> | undefined {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${label} options must be an object`);
  }
  return options as Record<string, unknown>;
}

/** Rust twin: `value_to_csv_string`. Strings pass through, numbers and
 *  booleans stringify (JS String semantics on both sides), null/undefined
 *  become the empty string, objects/arrays defensively serialize as "". */
function cellToCsvString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return "";
}

/**
 * `api.text.parseCsv(content, options?)` — pure worker-local compute, no
 * broker round trip. Twin of `Calcula.text.parseCsv` in ops/text.rs.
 */
export function scriptParseCsv(content: string, options?: ScriptParseCsvOptions): ScriptParseCsvResult {
  if (typeof content !== "string") {
    throw new TypeError("parseCsv content must be a string");
  }
  const opts = optionsBag(options, "parseCsv");
  const delimiter = readCharOption(opts, "delimiter", ",", false);
  const quote = readCharOption(opts, "quote", '"', true);
  const hasHeaders = opts?.hasHeaders === true;

  const parsed = parseCsvText(content, delimiter as string, quote);

  if (hasHeaders) {
    const headers = parsed.length > 0 ? (parsed.shift() as string[]) : [];
    return { rows: parsed, headers };
  }
  return { rows: parsed };
}

/**
 * `api.text.toCsv(rows, options?)` — pure worker-local compute, no broker
 * round trip. Twin of `Calcula.text.toCsv` in ops/text.rs. Cells may be
 * string | number | boolean | null (null and holes serialize as "").
 */
export function scriptToCsv(
  rows: ReadonlyArray<ReadonlyArray<CsvCellValue>>,
  options?: ScriptToCsvOptions,
): string {
  if (!Array.isArray(rows)) {
    throw new TypeError("toCsv rows must be an array of arrays");
  }
  const opts = optionsBag(options, "toCsv");
  const delimiter = readCharOption(opts, "delimiter", ",", false) as string;
  const quote = readCharOption(opts, "quote", '"', false) as string;

  let lineEnding = "\r\n";
  const le = opts?.lineEnding;
  if (le !== undefined && le !== null) {
    if (typeof le !== "string") {
      throw new TypeError("lineEnding must be a string");
    }
    if (le !== "\r\n" && le !== "\n" && le !== "\r") {
      throw new Error('lineEnding must be "\\r\\n", "\\n" or "\\r"');
    }
    lineEnding = le;
  }

  const data: string[][] = [];
  const headers = opts?.headers;
  if (headers !== undefined && headers !== null) {
    if (!Array.isArray(headers)) {
      throw new TypeError("headers must be an array");
    }
    data.push(headers.map(cellToCsvString));
  }
  for (const row of rows) {
    if (!Array.isArray(row)) {
      throw new TypeError("toCsv rows must be an array of arrays");
    }
    data.push(row.map(cellToCsvString));
  }

  return toCsvText(data, delimiter, quote, lineEnding);
}
