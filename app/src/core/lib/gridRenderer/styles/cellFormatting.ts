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
 * `#CIRCULAR!` and `#CONFLICT` were all introduced after this array was written,
 * so a cell holding one of them rendered as ORDINARY LEFT-ALIGNED BLACK TEXT —
 * indistinguishable from a user who had typed the string. That is the one place
 * an error must never hide, because `#LIMIT!` in particular means a number the
 * user is looking at was never computed.
 *
 * `CellError::Parse` is deliberately absent: it has no literal of its own and
 * surfaces as `#VALUE!`. `#NULL!`, `#NUM!` and `#ERROR` have no engine variant
 * but are Excel literals that can arrive by import, so they stay.
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
  "#CONFLICT",
  "#BLOCKED!",
  "#LIMIT!",
];

/**
 * Determine if a string represents an error value.
 */
export function isErrorValue(value: string): boolean {
  const upper = value.toUpperCase();
  return CELL_ERROR_LITERALS.some((pattern) => upper.startsWith(pattern.replace("?", "")));
}