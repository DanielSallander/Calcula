//! FILENAME: app/src/core/lib/gridRenderer/styles/cellFormatting.ts
//PURPOSE: Cell value type detection utilities
//CONTEXT: Determines if cell values are numbers, errors, or text

/**
 * Determine if a string represents a number.
 */
export function isNumericValue(value: string): boolean {
  if (value === "") {
    return false;
  }
  // Check if it's a number (possibly formatted with currency, percentage, etc.)
  const trimmed = value.trim();
  // Remove common formatting characters for number detection
  const cleaned = trimmed.replace(/[$%,\s]/g, "").replace(/^\((.+)\)$/, "-$1");
  return !isNaN(Number(cleaned)) && cleaned !== "" && isFinite(Number(cleaned));
}

/**
 * Every error literal the grid renders specially (red, centred).
 *
 * MUST COVER EVERY `CellError` VARIANT. The engine's canonical table is
 * `CellError::as_literal` in core/engine/src/cell.rs, and this list fell four
 * variants behind it: `#LIMIT!` (calculation-budget exhaustion), `#BLOCKED!`,
 * `#CIRCULAR!` and `#CONFLICT!` were all introduced after this array was
 * written, so a cell holding one of them rendered as ORDINARY LEFT-ALIGNED
 * BLACK TEXT — indistinguishable from a user who had typed the string. That is
 * the one place an error must never hide, because `#LIMIT!` in particular means
 * a number the user is looking at was never computed.
 *
 * THE SAME DEFECT WAS ALSO REACHING THIS LIST FROM THE OTHER SIDE, and D7
 * closed it (2026-08-09). The backend used to send the grid `#DIV0` / `#REF` /
 * `#VALUE` / `#CIRCULAR` / `#PARSE` — a `format!("#{:?}")` of the Rust variant
 * name — none of which any entry here matches, so a division-by-zero cell was
 * painted as plain black text while a `#DIV/0!` cell imported from xlsx was
 * painted red. The backend now forwards to `CellError::as_literal`, so the
 * strings arriving here are the ones below.
 *
 * `#NULL!`, `#NUM!` and `#ERROR` have no engine variant but are Excel literals
 * that can arrive by import, so they stay. `#SYNTAX!` is deliberately absent:
 * it is what the evaluate-formula and script surfaces answer for an unparseable
 * expression, and it never lands in a cell (`Cell::new_formula` stores an
 * unparseable formula as TEXT).
 *
 * `type-guards-exhaustive.test.ts` pins this list against cell.rs.
 */
export const CELL_ERROR_LITERALS: readonly string[] = [
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#DIV/0!",
  "#NULL!",
  "#N/A",
  "#NUM!",
  "#ERROR",
  "#CIRCULAR!",
  "#CONFLICT!",
  "#BLOCKED!",
  "#LIMIT!",
  "#SPILL!",
];

/**
 * Determine if a string represents an error value.
 */
export function isErrorValue(value: string): boolean {
  const upper = value.toUpperCase();
  return CELL_ERROR_LITERALS.some((pattern) => upper.startsWith(pattern.replace("?", "")));
}