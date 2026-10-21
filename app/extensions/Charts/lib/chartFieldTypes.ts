//! FILENAME: app/extensions/Charts/lib/chartFieldTypes.ts
// PURPOSE: Field-type inference for chart data (C2), the reader of a number the
//          engine already RENDERED, and the calendar-aware time ticks.
// CONTEXT: The category column is classified as quantitative (numbers), temporal
//          (dates), or nominal (text). A typed CategoryField lets scatter/bubble
//          render a value- or time-proportional X axis. Kept dependency-free of
//          chartDataReader to avoid an import cycle.
//
//          APP LOCALE EVERYWHERE (P2 S8). The old `parseDisplayNumber` guessed
//          the locale of a display string ("a single trailing comma with 1-2
//          digits is a decimal comma"), and the guess was wrong in both
//          directions: sv-SE "1 234,500" read as 1234500 and en-US "1,25" as
//          1.25. Every number here is now read in the APP locale, which is the
//          locale Rust rendered the text in -- the typed value first wherever the
//          reader has one, the text only where it has nothing else.

import type { CategoryField } from "../types";
import { parseNumber, parseDate, decimalSeparator, monthName } from "@api/locale";

// ============================================================================
// A number the engine rendered
// ============================================================================

/** A rendered number taken apart: its value and the text around its digits. */
export interface ShownNumber {
  /** The number the text shows (a percent already divided by 100). */
  value: number;
  /** Text before the digits, sign and accounting parenthesis removed ("$", "SEK"). */
  prefix: string;
  /** Text after the digits, closing parenthesis removed (" kr", "%", " kg"). */
  suffix: string;
  /** The text is a percentage. */
  percent: boolean;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Take apart a number as the ENGINE rendered it, in the app locale: digits that
 * parse STRICTLY in the app locale (its grouping, its decimal separator), with
 * any currency or unit text around them, a leading or trailing minus, an
 * accounting parenthesis or a percent sign. Null when the text is not a number
 * in the app locale -- an ISO date ("2026-10-08"), a time ("10:30"), a code
 * ("Q3 2024"), or a number spelled in another locale ("1,234.50" under sv-SE).
 *
 * For text Rust produced (a cell's display, a pivot's formatted value). A user's
 * typed text goes through `parseNumber` from `@api/locale`, which refuses
 * anything but the locale's own currency symbol.
 */
export function splitShownNumber(text: string): ShownNumber | null {
  let s = text.trim();
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  let first = -1;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    if (isDigit(s[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  // ",5" / ".5": the decimal separator before the first digit is the number's.
  const dec = decimalSeparator();
  if (first >= dec.length && s.slice(first - dec.length, first) === dec) first -= dec.length;

  const value = parseNumber(s.slice(first, last + 1));
  if (value === null) return null;

  let prefix = s.slice(0, first);
  let suffix = s.slice(last + 1);
  // A sign belongs to the number, wherever the format put it ("-$5", "$-5",
  // "5-", "+10%"). U+2212 is the typographic minus.
  const SIGN_START = /^\s*[-+−]/;
  const SIGN_END = /[-+−]\s*$/;
  let signText = "";
  if (SIGN_START.test(prefix)) {
    signText += prefix.trim()[0];
    prefix = prefix.replace(SIGN_START, "");
  } else if (SIGN_END.test(prefix)) {
    signText += prefix.trim().slice(-1);
    prefix = prefix.replace(SIGN_END, "");
  }
  if (SIGN_START.test(suffix)) {
    signText += suffix.trim()[0];
    suffix = suffix.replace(SIGN_START, "");
  }
  if (signText.length > 1) return null;
  if (signText === "-" || signText === "−") negative = !negative;
  prefix = prefix.trim();
  // A sign left inside an affix is not an affix any more ("5 - 3").
  if (/[-+−]/.test(prefix) || /^\s*[-+−]/.test(suffix)) return null;

  const percent = suffix.includes("%");
  let n = value;
  if (percent) n /= 100;
  return { value: negative ? -n : n, prefix, suffix, percent };
}

/**
 * The number an engine-rendered text shows in the app locale, or null. See
 * {@link splitShownNumber}; the locale's own plain spelling ("1 234,5" in sv-SE,
 * "$1,000" in en-US) is read by `parseNumber` directly.
 */
export function readShownNumber(text: string): number | null {
  const direct = parseNumber(text);
  if (direct !== null) return direct;
  return splitShownNumber(text)?.value ?? null;
}

// ============================================================================
// Category field-type inference
// ============================================================================

/** Excel serial -> epoch milliseconds (UTC), honouring the 1900 leap-year slot. */
export function serialToEpochMs(serial: number): number {
  const s = serial < 60 ? serial + 1 : serial;
  return Math.round((s - 25569) * 86_400_000);
}

/**
 * Classify the category column. Returns a typed CategoryField when every value
 * is a date (temporal) or every value is a number (quantitative); otherwise
 * undefined (nominal — evenly-spaced categories).
 *
 * `typed` is what the READER knew about each category (one entry per category,
 * same order): a number for a numeric cell, a `Date` for a date-formatted cell,
 * null for anything else. When it is given it decides -- the engine's own typing
 * is never second-guessed from the text. Without it (categories a transform
 * rebuilt, a pivot's labels) each text is read in the APP locale, a date first
 * (`parseDate`) and then a number (`parseNumber`), both strict. A bare number
 * is never temporal, and a time of day alone is not a date.
 */
export function detectCategoryField(
  categories: string[],
  typed?: ReadonlyArray<number | Date | null>,
): CategoryField | undefined {
  if (categories.length === 0) return undefined;

  if (typed !== undefined && typed.length === categories.length) {
    if (typed.every((t) => t instanceof Date && Number.isFinite(t.getTime()))) {
      return { type: "temporal", values: typed.map((t) => (t as Date).getTime()) };
    }
    if (typed.every((t) => typeof t === "number" && Number.isFinite(t))) {
      return { type: "quantitative", values: typed as number[] };
    }
    return undefined;
  }

  const serials = categories.map((c) => parseDate(c));
  if (serials.every((t) => t !== null && t >= 1)) {
    return { type: "temporal", values: (serials as number[]).map(serialToEpochMs) };
  }

  const nums = categories.map((c) => parseNumber(c));
  if (nums.every((n) => n !== null)) {
    return { type: "quantitative", values: nums as number[] };
  }

  return undefined;
}

// ============================================================================
// Calendar-aware time ticks
// ============================================================================

const DAY_MS = 86_400_000;

/** Pick a "nice" step (1, 2, 5, 10, ...) so a span yields about `target` ticks. */
function niceCountStep(span: number, target: number): number {
  const raw = Math.max(1, span / Math.max(1, target));
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return Math.max(1, nice * mag);
}

function yearLabel(ms: number): string {
  return String(new Date(ms).getUTCFullYear());
}
function monthLabel(ms: number): string {
  const d = new Date(ms);
  return `${monthName(d.getUTCMonth() + 1, "short")} ${d.getUTCFullYear()}`;
}
function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${monthName(d.getUTCMonth() + 1, "short")} ${d.getUTCDate()}`;
}

/**
 * Generate calendar-aligned ticks (year / month / day granularity) for a
 * temporal domain, returning each tick's epoch-ms value and a formatted label.
 */
export function timeTicks(minMs: number, maxMs: number, target = 5): Array<{ value: number; label: string }> {
  if (!(maxMs > minMs)) return [{ value: minMs, label: dayLabel(minMs) }];

  const spanDays = (maxMs - minMs) / DAY_MS;

  // ── Year granularity ──
  if (spanDays > 365 * 2) {
    const startY = new Date(minMs).getUTCFullYear();
    const endY = new Date(maxMs).getUTCFullYear();
    const step = niceCountStep(endY - startY, target);
    const out: Array<{ value: number; label: string }> = [];
    for (let y = Math.ceil(startY / step) * step; y <= endY; y += step) {
      const v = Date.UTC(y, 0, 1);
      if (v >= minMs && v <= maxMs) out.push({ value: v, label: yearLabel(v) });
    }
    return out.length > 0 ? out : [{ value: minMs, label: yearLabel(minMs) }];
  }

  // ── Month granularity ──
  if (spanDays > 75) {
    const start = new Date(minMs);
    const totalMonths = Math.round(spanDays / 30);
    const step = [1, 2, 3, 6].find((s) => totalMonths / s <= target) ?? 6;
    const out: Array<{ value: number; label: string }> = [];
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth();
    if (start.getUTCDate() > 1) m += 1; // start at the next whole month
    m = Math.ceil(m / step) * step; // align month index to the step
    y += Math.floor(m / 12);
    m %= 12;
    for (let v = Date.UTC(y, m, 1); v <= maxMs; ) {
      if (v >= minMs) out.push({ value: v, label: monthLabel(v) });
      m += step;
      y += Math.floor(m / 12);
      m %= 12;
      v = Date.UTC(y, m, 1);
    }
    return out.length > 0 ? out : [{ value: minMs, label: monthLabel(minMs) }];
  }

  // ── Day granularity ──
  const stepDays = [1, 2, 5, 7, 14].find((s) => spanDays / s <= target) ?? 14;
  const startDay = Math.ceil(minMs / DAY_MS) * DAY_MS;
  const out: Array<{ value: number; label: string }> = [];
  for (let v = startDay; v <= maxMs; v += stepDays * DAY_MS) {
    if (v >= minMs) out.push({ value: v, label: dayLabel(v) });
  }
  return out.length > 0 ? out : [{ value: minMs, label: dayLabel(minMs) }];
}
