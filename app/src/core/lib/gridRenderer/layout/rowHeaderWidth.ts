//! FILENAME: app/src/core/lib/gridRenderer/layout/rowHeaderWidth.ts
// PURPOSE: Excel-style auto-sizing of the row-number gutter.
// CONTEXT: Excel sizes the row header to fit the largest row NUMBER currently in
//          view — a narrow gutter for rows 1..99, widening as the digit count
//          grows while you scroll down. Core/pure; no imports.

/** Approx. advance (px) of one digit in the header font (12px system-ui). */
const DIGIT_WIDTH = 7;
/** Total horizontal padding (px) inside the gutter (both sides combined). */
const GUTTER_PADDING = 16;
/** Floor width (px): the gutter never renders narrower than a 2-digit number. */
export const MIN_ROW_HEADER_WIDTH = 30;

/**
 * Excel-style row-header width for the largest visible row NUMBER (1-based).
 * Digit count drives the width, so rows 1..99 get the narrow floor and rows in
 * the hundred-thousands get a wider gutter — matching how Excel auto-widens the
 * row-number column as you scroll toward larger row numbers.
 */
export function computeRowHeaderWidth(maxVisibleRowNumber: number): number {
  const n = Math.max(1, Math.floor(maxVisibleRowNumber));
  // Floor at 2 digits so the gutter doesn't visibly twitch between rows 9 and 10.
  const digits = Math.max(2, String(n).length);
  return Math.max(MIN_ROW_HEADER_WIDTH, digits * DIGIT_WIDTH + GUTTER_PADDING);
}
