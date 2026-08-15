//! FILENAME: app/src/core/lib/gridRenderer/rendering/overflowMarker.ts
// PURPOSE: Excel's rule for a cell whose content does not fit its column.
// CONTEXT: Excel does NOT have one overflow behaviour, it has two, and which one
//          you get is decided by the VALUE'S TYPE, not by the text:
//
//            - TEXT spills into absolutely-empty neighbours and is CLIPPED
//              mid-glyph against occupied ones. It never shows a marker of any
//              kind, and it is never ellipsised.
//            - NUMBERS, DATES and TIMES cannot spill (Excel's spill conditions
//              require "the cell value is text"), so a too-narrow one has
//              nowhere to go and Excel paints '#' REPEATED TO FILL THE COLUMN.
//
//          Calcula used to ellipsise BOTH ("1234,5..."), which is wrong for both
//          halves at once. Swapping the ellipsis for '####' everywhere would have
//          been wrong in a new way: text that Excel spills or clips would have
//          been replaced by a wall of hashes.
//
//          The marker is four ASCII '#' (0x23) repeated - never a Unicode
//          ellipsis glyph, and never a literal four in a column with room for
//          more.
//
// WHY A SEPARATE MODULE. This is the decision the renderer makes on the hottest
// paint path, and it is the part with real Excel semantics in it (the General
// ladder below). Keeping it pure - strings and a measure callback, no canvas, no
// cell records - is what lets it be tested directly at the value level instead of
// through a rendered frame.

import { isNumericValue, isErrorValue } from "../styles/cellFormatting";

// ============================================================================
// The marker
// ============================================================================

/** The overflow marker character: ASCII '#', U+0023. Never a Unicode glyph. */
export const MARKER_CHAR = "#";

/**
 * Excel prints at least four '#'. It is the familiar "#####" only because a
 * column narrow enough to trigger it usually has room for about that many.
 */
const MIN_MARKER_CHARS = 4;

/**
 * Sanity ceiling. A cell wide enough to want more '#' than this is not a cell
 * that overflowed; the cap only stops a degenerate `measure` (a stubbed context
 * reporting a hairline width) from allocating a megabyte string mid-frame.
 */
const MAX_MARKER_CHARS = 512;

/**
 * The marker for a cell of `availableWidth` px, at the font `measure` reports.
 *
 * Excel REPEATS '#' to fill the column rather than printing exactly four, so a
 * wide-but-still-insufficient cell reads as a solid run of hashes. Below four
 * characters' worth of room Excel still shows four and lets them clip, which is
 * what the floor here reproduces.
 */
export function overflowMarker(
  availableWidth: number,
  measure: (text: string) => number
): string {
  const one = measure(MARKER_CHAR);
  if (!(one > 0) || !(availableWidth > 0)) {
    return MARKER_CHAR.repeat(MIN_MARKER_CHARS);
  }
  const fits = Math.floor(availableWidth / one);
  const count = Math.min(MAX_MARKER_CHARS, Math.max(MIN_MARKER_CHARS, fits));
  return MARKER_CHAR.repeat(count);
}

// ============================================================================
// Which overflow rule applies: the value's type
// ============================================================================

/**
 * Which of Excel's two overflow behaviours a cell gets.
 *
 * "numeric" is every value that CANNOT spill - numbers, dates, times and error
 * literals alike. It is not a claim that the display text parses as a number.
 */
export type CellContentKind = "text" | "numeric";

/**
 * `CellData.overflow` as the backend sends it.
 *
 * Kept as a local alias rather than imported from the types barrel so this
 * module stays a pure string/measure unit with no dependency on the transport
 * shape; the renderer passes the field in.
 */
export type TransportedOverflowClass = "text" | "numeric" | "unrepresentable";

/**
 * Format display names (`format_number_format_name`, api_types.rs) whose format
 * the engine applies to NUMBERS ONLY. `format_cell_value_with_color` routes a
 * `CellValue::Text` through `format_text_with_color` instead, so a display
 * produced under one of these came from a numeric value.
 */
const NUMERIC_ONLY_FORMAT_PREFIXES = [
  "Number (",
  "Currency (",
  "Accounting (",
  "Fraction (",
  "Percentage (",
  "Scientific (",
  "Date (",
  "Time (",
];

/** The one format that means "show the value exactly as typed": Excel's `@`. */
const TEXT_FORMAT_CODE = "@";

/**
 * What a format alone can tell us about the value behind a display string.
 *
 * - `numeric-only`: the engine applies this format to numbers and nothing else.
 * - `text-only`: Excel's Text format - the value is shown exactly as typed and
 *   is not evaluated as a number, so digits in it are STILL text.
 * - `ambiguous`: `General`, and any multi-section custom code, render both. The
 *   value has to be inspected.
 */
export type FormatValueClass = "numeric-only" | "text-only" | "ambiguous";

/**
 * Format classification is a handful of string compares, and a viewport reuses
 * the same few format names thousands of times per frame. Memoised by the format
 * string, bounded so a workbook full of distinct custom codes cannot grow it
 * without limit.
 */
const formatClassCache = new Map<string, FormatValueClass>();
const FORMAT_CACHE_LIMIT = 256;

/** Classify a `StyleData.numberFormat` by what values it can render. */
export function classifyNumberFormat(numberFormat: string): FormatValueClass {
  const cached = formatClassCache.get(numberFormat);
  if (cached !== undefined) return cached;

  const answer = computeFormatClass(numberFormat);
  if (formatClassCache.size >= FORMAT_CACHE_LIMIT) {
    formatClassCache.clear();
  }
  formatClassCache.set(numberFormat, answer);
  return answer;
}

/** True when the format can only have been applied to a numeric value. */
export function isNumericOnlyFormat(numberFormat: string): boolean {
  return classifyNumberFormat(numberFormat) === "numeric-only";
}

/** True for Excel's Text format - digits under it are text, not numbers. */
export function isTextFormat(numberFormat: string): boolean {
  return classifyNumberFormat(numberFormat) === "text-only";
}

/** Strip `"..."` literals and `\x` escapes so only placeholders remain. */
function stripFormatLiterals(code: string): string {
  return code.replace(/"[^"]*"/g, "").replace(/\\./g, "");
}

function computeFormatClass(numberFormat: string): FormatValueClass {
  if (numberFormat === "" || numberFormat === "General") return "ambiguous";
  if (numberFormat === TEXT_FORMAT_CODE) return "text-only";
  for (const prefix of NUMERIC_ONLY_FORMAT_PREFIXES) {
    if (numberFormat.startsWith(prefix)) return "numeric-only";
  }
  // A `NumberFormat::Custom` arrives as its raw Excel format code.
  const bare = stripFormatLiterals(numberFormat);
  if (bare.includes(TEXT_FORMAT_CODE)) {
    // `0.00;-0.00;"-";@` has numeric sections AND a text section: what a value
    // renders as depends on the value. `"total: "@` is text and only text.
    return numberFormat.includes(";") || /[0#?]/.test(bare) ? "ambiguous" : "text-only";
  }
  return /[0#?]/.test(bare) ? "numeric-only" : "ambiguous";
}

/** True when `General` (or an absent format) is in force - the ladder's gate. */
export function isGeneralFormat(numberFormat: string): boolean {
  return numberFormat === "" || numberFormat === "General";
}

/** Cheap pre-test for an error literal; every one of them starts with '#'. */
function looksLikeError(display: string): boolean {
  return display.charCodeAt(0) === 35 /* '#' */ && isErrorValue(display);
}

function hasAsciiDigit(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) return true;
  }
  return false;
}

/**
 * Decide which overflow rule a cell gets.
 *
 * @param display        the engine-formatted text the cell paints
 * @param numberFormat   `StyleData.numberFormat` - the backend's display name
 * @param isFormulaText  Show Formulas mode is painting the formula source, which
 *                       is text no matter what the cell evaluates to
 *
 * PRECISION, STATED HONESTLY. `CellData` carries only the formatted `display`
 * string, so this cannot ask the engine what the value's type was; it infers it
 * from the format plus the text. That inference is exact for every General cell
 * (`isNumericValue` is the same test the renderer already uses to right-align
 * one) and for every cell under a numeric-only format holding a number. It has
 * one blind spot: TEXT stored in a cell carrying an explicitly numeric format
 * (a pasted header in a Date column, say) reads as numeric here if it contains a
 * digit, and would show the marker where Excel shows the text. Removing the
 * blind spot needs the value's type on the wire - see BUG-0066.
 */
export function classifyCellContent(
  display: string,
  numberFormat: string,
  isFormulaText: boolean,
  transported?: TransportedOverflowClass
): CellContentKind {
  if (display === "" || isFormulaText) return "text";
  // The backend decided this where the CellValue and the CellStyle were both in
  // hand, so it beats any inference from the formatted string (BUG-0066).
  if (transported === "numeric" || transported === "unrepresentable") return "numeric";
  if (transported === "text") return "text";
  // An error literal is not text: it cannot spill, and Excel marks it when the
  // column is too narrow just as it marks a number.
  if (looksLikeError(display)) return "numeric";
  const formatClass = classifyNumberFormat(numberFormat);
  // Excel's Text format is decisive on its own: "12345" under `@` is text, is
  // left-aligned, and spills exactly the way prose does.
  if (formatClass === "text-only") return "text";
  if (formatClass === "numeric-only") {
    return hasAsciiDigit(display) ? "numeric" : "text";
  }
  return isNumericValue(display) ? "numeric" : "text";
}

// ============================================================================
// General's ladder: round, then go scientific, and only then give up
// ============================================================================

/**
 * A `General` numeric display, taken apart.
 *
 * `General` never emits a thousands separator (`format_general`,
 * core/engine/src/number_format.rs), so whichever of '.' or ',' appears is the
 * locale's DECIMAL separator - which is how this stays locale-correct on sv-SE
 * without the renderer having to plumb `LocaleSettings` onto the paint path.
 */
export interface ParsedGeneralNumber {
  value: number;
  /** The separator the engine used, to be put back on a re-rendered value. */
  decimalSeparator: string;
  /** How many decimals the engine displayed. */
  decimals: number;
}

const GENERAL_NUMBER = /^(-?\d+)(?:([.,])(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Recover the number behind a `General` display, or null if it is not one. */
export function parseGeneralNumber(display: string): ParsedGeneralNumber | null {
  const m = GENERAL_NUMBER.exec(display);
  if (!m) return null;
  const decimalSeparator = m[2] ?? ".";
  const fraction = m[3];
  let canonical = fraction !== undefined ? `${m[1]}.${fraction}` : m[1];
  if (m[4] !== undefined) canonical = `${canonical}e${m[4]}`;
  const value = Number(canonical);
  if (!Number.isFinite(value)) return null;
  return { value, decimalSeparator, decimals: fraction?.length ?? 0 };
}

function withSeparator(text: string, decimalSeparator: string): string {
  return decimalSeparator === "." ? text : text.replace(".", decimalSeparator);
}

/** `1234.5678` at 1 decimal -> `1234.6`. Excel ROUNDS, it does not truncate. */
export function renderWithDecimals(
  value: number,
  decimals: number,
  decimalSeparator: string
): string {
  return withSeparator(value.toFixed(decimals), decimalSeparator);
}

/**
 * Excel's exponential spelling: uppercase E, a signed exponent, and the exponent
 * padded to at least two digits - `25000000` becomes `2.5E+07`, never `2.5e+7`.
 */
export function renderScientific(
  value: number,
  mantissaDecimals: number,
  decimalSeparator: string
): string {
  const raw = value.toExponential(mantissaDecimals);
  const m = /^(-?[0-9.]+)e([+-])(\d+)$/.exec(raw);
  if (!m) return withSeparator(raw.toUpperCase(), decimalSeparator);
  return `${withSeparator(m[1], decimalSeparator)}E${m[2]}${m[3].padStart(2, "0")}`;
}

/** Most mantissa decimals the scientific rung will try, matching the engine. */
const MAX_SCIENTIFIC_DECIMALS = 5;

/**
 * The largest digit count in `[0, maxDigits]` whose rendering still fits.
 *
 * The caller has ALREADY established that 0 digits fits, which is what makes
 * this a search rather than a scan: `render` is monotone non-decreasing in its
 * argument, so the answer is the last index satisfying a monotone predicate.
 * Returns `digits: 0` (and no measurement) when there is nothing above zero to
 * try, so the caller can reuse the width it already has.
 */
function mostDigitsThatFit(
  maxDigits: number,
  availableWidth: number,
  measure: (text: string) => number,
  render: (digits: number) => string
): { digits: number; text: string; width: number } {
  let lo = 0;
  let hi = Math.max(0, maxDigits);
  let bestText = "";
  let bestWidth = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = render(mid);
    const width = measure(candidate);
    if (width <= availableWidth) {
      lo = mid;
      bestText = candidate;
      bestWidth = width;
    } else {
      hi = mid - 1;
    }
  }
  return { digits: lo, text: bestText, width: bestWidth };
}

/** What {@link fitNumericDisplay} decided a numeric cell should paint. */
export interface NumericFit {
  /** The glyphs to draw. */
  text: string;
  /** True when `text` is the '####' marker rather than a value. */
  marker: boolean;
  /** Measured width of `text`. */
  width: number;
  /**
   * How the answer was reached, for tests and for anyone reading a frame:
   * "fits" | "rounded" | "scientific" | "marker".
   */
  rung: "fits" | "rounded" | "scientific" | "marker";
}

export interface NumericFitInput {
  display: string;
  /** `StyleData.numberFormat`. */
  numberFormat: string;
  /** Width the glyphs may occupy, already net of padding and indent. */
  availableWidth: number;
  /** `ctx.measureText(...).width` at the font the cell will actually paint. */
  measure: (text: string) => number;
  /** Width of `display`, when the caller has already measured it. */
  displayWidth?: number;
  /**
   * `CellData.overflow`. `"unrepresentable"` short-circuits the whole ladder:
   * Excel refuses a negative serial under a Date or Time format at EVERY width,
   * and widening never clears it.
   */
  transported?: TransportedOverflowClass;
}

/**
 * Excel's ladder for a numeric cell, in order (evidence item 3.5):
 *
 *   1. It fits -> paint it.
 *   2. The format is `General` -> drop displayed decimals until it fits, then
 *      switch to scientific notation. `General` is the only NEGOTIATING format:
 *      every explicit format (Number with fixed decimals, Currency, Accounting,
 *      any Date, Percentage) renders what you asked for or gives up, because
 *      Excel will not silently alter a format you chose.
 *   3. Give up -> '#' repeated to fill the width.
 *
 * Shrink-to-fit sits ABOVE this ladder and is the caller's business: it changes
 * the font, so it has already happened by the time `measure` is handed over.
 *
 * RUNG 0, ABOVE ALL OF IT: Excel's width-INDEPENDENT refusal for a NEGATIVE
 * value under a Date or Time format. A serial below zero has no representation
 * in the 1900 date system, so Microsoft's remedy is "verify that dates and
 * times are positive values" rather than "widen the column" - widening never
 * clears it. `display` cannot carry that (the engine renders -1.0 as the
 * plausible "1900-01-01"), so it arrives as `transported` from the backend,
 * which is where the value's sign still exists. BUG-0066.
 */
export function fitNumericDisplay(input: NumericFitInput): NumericFit {
  const { display, numberFormat, availableWidth, measure } = input;

  if (input.transported === "unrepresentable") {
    const refusal = overflowMarker(availableWidth, measure);
    return { text: refusal, marker: true, width: measure(refusal), rung: "marker" };
  }

  const displayWidth = input.displayWidth ?? measure(display);

  if (displayWidth <= availableWidth) {
    return { text: display, marker: false, width: displayWidth, rung: "fits" };
  }

  if (isGeneralFormat(numberFormat)) {
    const parsed = parseGeneralNumber(display);
    if (parsed) {
      // BOTH RUNGS ARE SEARCHED, NOT WALKED. Adding a decimal (or a mantissa
      // digit) only appends glyphs, so width is MONOTONE in the digit count and
      // "the most digits that still fit" is a binary search. Walking it was
      // measured on a dense adversarial viewport at 12.5 measureText calls per
      // cell -- a General value carries up to 10 significant digits, so the walk
      // could spend a dozen measurements discovering that none of the long forms
      // fit. Each rung now costs its cheapest candidate plus ~log2(n).
      const zero = renderWithDecimals(parsed.value, 0, parsed.decimalSeparator);
      if (measure(zero) <= availableWidth) {
        const best = mostDigitsThatFit(parsed.decimals - 1, availableWidth, measure, (d) =>
          renderWithDecimals(parsed.value, d, parsed.decimalSeparator)
        );
        const text = best.digits === 0 ? zero : best.text;
        return {
          text,
          marker: false,
          width: best.digits === 0 ? measure(zero) : best.width,
          rung: "rounded",
        };
      }
      // Not even the integer fits, so drop to exponential. Its shortest form is
      // the zero-decimal mantissa; if THAT will not fit, nothing will.
      const shortest = renderScientific(parsed.value, 0, parsed.decimalSeparator);
      const shortestWidth = measure(shortest);
      if (shortestWidth <= availableWidth) {
        const best = mostDigitsThatFit(MAX_SCIENTIFIC_DECIMALS, availableWidth, measure, (k) =>
          renderScientific(parsed.value, k, parsed.decimalSeparator)
        );
        return {
          text: best.digits === 0 ? shortest : best.text,
          marker: false,
          width: best.digits === 0 ? shortestWidth : best.width,
          rung: "scientific",
        };
      }
    }
  }

  const text = overflowMarker(availableWidth, measure);
  return { text, marker: true, width: measure(text), rung: "marker" };
}

// ============================================================================
// Spill: which neighbour blocks it
// ============================================================================

/** The little of a neighbouring cell that the spill test needs. */
export interface SpillNeighbour {
  display?: string;
  formula?: string | null;
}

/**
 * Excel requires the adjacent cell to be "ABSOLUTELY empty - does not contain
 * spaces, non-printing characters, empty strings, etc.".
 *
 * The "empty strings" clause is the one a blank-looking test misses: a neighbour
 * holding `=""` displays nothing and BLOCKS the spill in Excel. Calcula's old
 * test was `(adjCell.display ?? "") !== ""`, so text spilled straight through
 * such a cell.
 */
export function blocksSpill(neighbour: SpillNeighbour | undefined): boolean {
  if (!neighbour) return false;
  if ((neighbour.display ?? "") !== "") return true;
  // Displays as nothing, but something is there producing the nothing.
  return neighbour.formula != null && neighbour.formula !== "";
}
