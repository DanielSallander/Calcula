//! FILENAME: app/extensions/Charts/lib/chartFieldTypes.ts
// PURPOSE: Field-type inference + numeric/date parsing for chart data (C2).
// CONTEXT: The category column is classified as quantitative (numbers), temporal
//          (dates), or nominal (text). A typed CategoryField lets scatter/bubble
//          render a value- or time-proportional X axis. Also hosts the shared
//          display-number parser and calendar-aware time-tick generator. Kept
//          dependency-free of chartDataReader to avoid an import cycle.

import type { CategoryField } from "../types";

// ============================================================================
// Number parsing
// ============================================================================

/**
 * Parse a display-formatted number string to a numeric value.
 * Handles currency symbols ($, EUR, GBP), thousands separators (comma, space,
 * period), percentage signs, parenthesized negatives, and trailing units.
 */
export function parseDisplayNumber(raw: string): number {
  if (!raw || raw.trim() === "" || raw === "-" || raw === "--") return NaN;

  let s = raw.trim();

  // Handle parenthesized negatives: (123) -> -123
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  // Handle leading minus
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }

  // Strip currency symbols and common prefixes/suffixes ($, EUR, GBP, JPY, CNY, INR)
  s = s.replace(/[$€£¥￥₹]/g, "");

  // Strip percentage (but remember it for later)
  const isPercent = s.endsWith("%");
  if (isPercent) {
    s = s.slice(0, -1);
  }

  // Strip spaces used as thousands separators (incl. non-breaking spaces)
  s = s.replace(/[\s ]/g, "");

  // European decimal comma: a single trailing comma with 1-2 digits, no period
  if (!s.includes(".") && /,\d{1,2}$/.test(s)) {
    s = s.replace(/,/, ".");
  }

  // Strip remaining commas (thousands separators)
  s = s.replace(/,/g, "");

  // Strip trailing units text (e.g. " units", " kg")
  s = s.replace(/[a-zA-Z\s]+$/, "");

  const num = parseFloat(s);
  if (isNaN(num)) return NaN;

  let result = negative ? -num : num;
  if (isPercent) result /= 100;
  return result;
}

// ============================================================================
// Date parsing
// ============================================================================

/**
 * Parse a date-like string to epoch milliseconds, or null if it isn't a date.
 * Bare numbers (e.g. "2024", "15.5") are intentionally rejected so numeric
 * columns are classified as quantitative, not temporal.
 */
export function parseDate(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  // Reject plain numbers — those are quantitative, not dates.
  if (/^-?\d+(\.\d+)?$/.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

// ============================================================================
// Category field-type inference
// ============================================================================

/**
 * Classify the category column. Returns a typed CategoryField when every value
 * is a date (temporal) or every value is a number (quantitative); otherwise
 * undefined (nominal — evenly-spaced categories). Temporal is checked first so
 * date strings aren't misread as numbers.
 */
export function detectCategoryField(categories: string[]): CategoryField | undefined {
  if (categories.length === 0) return undefined;

  const times = categories.map(parseDate);
  if (times.every((t) => t !== null)) {
    return { type: "temporal", values: times as number[] };
  }

  const nums = categories.map(parseDisplayNumber);
  if (nums.every((n) => Number.isFinite(n))) {
    return { type: "quantitative", values: nums };
  }

  return undefined;
}

// ============================================================================
// Calendar-aware time ticks
// ============================================================================

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
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
