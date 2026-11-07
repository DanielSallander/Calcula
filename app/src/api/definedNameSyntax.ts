//! FILENAME: app/src/api/definedNameSyntax.ts
// PURPOSE: Whether a string is a name Excel accepts as a DEFINED NAME, or as
//          a TABLE name -- the WHOLE rule, so a dialog can say so as the user
//          types instead of only after the backend refused.
// CONTEXT: BUG-0741 (ledger programme 2, lane names). The Name Manager's and
//          the Name Box's validators were each a "first filter" that checked
//          the characters and an A1 cell, and let `R1C1`, `RC`, `A1.B1` and
//          256-character names through to a backend refusal -- while they
//          REFUSED names Excel takes (`\abc`, `a\b`, `abc?`, `NULL`). The
//          authority is `identity::is_valid_defined_name`
//          (core/identity/src/defined_name_syntax.rs), which every backend
//          name door asks; this is its mirror, measured against the same live
//          probes [LIVE, Excel 16, 2026-11-06, lane names q1-q4.ps1], and
//          `definedNameSyntax.test.ts` holds the two lists Excel answered.

/** Excel's longest defined name [LIVE: 255 characters accepted, 256 refused]. */
export const MAX_DEFINED_NAME_CHARS = 255;

/** ASCII-only upper case: Rust's `to_ascii_uppercase`, never a fold INTO ASCII
 *  (`toUpperCase` turns `ß` into `SS`). */
function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** A run of ASCII digits read as a number in 1..max (leading zeros allowed). */
function digitsInRange(digits: string, max: number): boolean {
  if (digits.length === 0) return false;
  const significant = digits.replace(/^0+/, "");
  if (significant.length === 0 || significant.length > 10) return false;
  const n = Number(significant);
  return n >= 1 && n <= max;
}

/** An A1 cell: columns A-XFD, rows 1-1048576 (ASCII case fold only). */
function looksLikeA1Cell(s: string): boolean {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(s);
  if (!m) return false;
  let col = 0;
  for (const ch of asciiUpper(m[1])) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
    if (col > 16384) return false;
  }
  return digitsInRange(m[2], 1_048_576);
}

/** `R`, `C`, `RC` exactly, or a name BEGINNING with R<row> / C<col> / RC<col>
 *  whose number is a real one and is not followed by a period. */
function looksLikeR1C1Reference(s: string): boolean {
  const upper = asciiUpper(s);
  if (upper === "R" || upper === "C" || upper === "RC") return true;
  const refuses = (rest: string, max: number): boolean => {
    const m = /^[0-9]*/.exec(rest)![0];
    if (!digitsInRange(m, max)) return false;
    return !rest.slice(m.length).startsWith(".");
  };
  if (upper.startsWith("RC") && refuses(upper.slice(2), 16384)) return true;
  if (upper.startsWith("R") && refuses(upper.slice(1), 1_048_576)) return true;
  if (upper.startsWith("C") && refuses(upper.slice(1), 16384)) return true;
  return false;
}

/** A Lotus-style range: an A1 cell, periods, an A1 cell (`A1.B1`, `A1..B1`). */
function looksLikeDottedRange(s: string): boolean {
  const dot = s.indexOf(".");
  if (dot < 0 || !looksLikeA1Cell(s.slice(0, dot))) return false;
  const rest = s.slice(dot).replace(/^\.+/, "");
  const second = rest.split(".")[0] ?? "";
  return second.length > 0 && looksLikeA1Cell(second);
}

/** Is `ch` a letter (any script) or a digit? Mirrors Rust's `is_alphanumeric`. */
function isAlphanumeric(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Whether Excel accepts `name` as a TABLE name: a letter, underscore or
 * backslash first; then letters, digits, `_`, `.`, `\` and `?`; at most 255
 * characters; never an A1 cell, an R1C1 reference, a Lotus `A1.B1` range,
 * `TRUE` or `FALSE` -- except that a name beginning with a backslash is never
 * a reference (`\A1`, `\R1C1` are names). `NULL` is a name.
 */
export function isValidTableName(name: string): boolean {
  const chars = Array.from(name);
  if (chars.length === 0 || chars.length > MAX_DEFINED_NAME_CHARS) return false;
  const first = chars[0];
  const leadingBackslash = first === "\\";
  if (!leadingBackslash && !(first === "_" || /\p{L}/u.test(first))) return false;
  for (const ch of chars.slice(1)) {
    if (!isAlphanumeric(ch) && ch !== "_" && ch !== "." && ch !== "\\" && ch !== "?") return false;
  }
  if (leadingBackslash) return true;
  if (looksLikeA1Cell(name) || looksLikeR1C1Reference(name) || looksLikeDottedRange(name)) return false;
  const upper = asciiUpper(name);
  return upper !== "TRUE" && upper !== "FALSE";
}

/**
 * Whether Excel accepts `name` as a DEFINED NAME: the table rule, plus a
 * defined name's own refusal of a two-character name beginning with a
 * backslash (`\a`, `\1`, `\\` are refused; `\` and `\ab` are names).
 */
export function isValidDefinedName(name: string): boolean {
  if (name.startsWith("\\") && Array.from(name).length === 2) return false;
  return isValidTableName(name);
}
