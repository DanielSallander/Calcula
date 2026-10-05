//! FILENAME: app/extensions/FillSeries/lib/seriesPlan.ts
// PURPOSE: What Fill > Series... writes, one LINE (a column for "Series in
//          Columns", a row for "Rows") at a time. Pure: cells in, writes out.
// CONTEXT: Home tab 2026-10-04 (fill.series). Measured in live Excel 16 (build
//          20430) on 2026-10-04 through Range.DataSeries, the dialog's own
//          object-model call; the cases D1..D22 are pinned in
//          __tests__/seriesPlan.test.ts:
//            - each line starts from its FIRST cell; later values in the line
//              are overwritten (D9);
//            - Linear adds the step, Growth multiplies by it (D1, D3, D16);
//            - a Stop value ends the line, and cells past it are left
//              UNTOUCHED (D2, D15); the comparison follows the series'
//              direction and is made at Excel's 15 significant digits, so a
//              0.3 step stops ON 0.9 (D22);
//            - a first cell that is not a number (blank, text) CLEARS the rest
//              of its line -- Excel does exactly that, and the user asked for a
//              series over those cells (D11, D12);
//            - Trend fits the line's leading run of numbers -- least squares for
//              Linear, an exponential fit for Growth -- and REPLACES those
//              values with the fitted ones; with one value there is nothing to
//              fit and the step is used (D7, D8, D20);
//            - Date steps by Day, Weekday (Saturday and Sunday skipped), Month
//              or Year; months and years keep the START's day where the target
//              month has it, clamped where it does not (Jan 31 -> Feb 28 ->
//              Mar 31, D4, D6);
//            - the start cell's format goes with the values (D18).
//          AutoFill is not here: it is the fill handle's own machinery
//          (lib/runSeries.ts hands it to @api/fillPatterns).

/** A cell of the line, as read from the sheet (index 0 is the start). */
export interface SeriesLineCell {
  row: number;
  col: number;
  kind: "empty" | "number" | "text";
  /** The number, when kind is "number". */
  value: number | null;
  styleIndex: number;
}

export type SeriesIn = "rows" | "columns";
export type SeriesType = "linear" | "growth" | "date" | "autofill";
export type DateUnit = "day" | "weekday" | "month" | "year";

export interface SeriesOptions {
  seriesIn: SeriesIn;
  type: SeriesType;
  dateUnit: DateUnit;
  step: number;
  /** null: no stop value (the line is filled to its end). */
  stop: number | null;
  trend: boolean;
}

/** One cell to write: canonical text (invariant decimal point), plus the
 *  style to give it (the start cell's) when one applies. */
export interface SeriesWrite {
  row: number;
  col: number;
  value: string;
  styleIndex?: number;
}

/** Excel's precision: 15 significant digits, so 0.1 + 0.2 is 0.3. */
export function formatSeriesNumber(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  const rounded = Number(n.toPrecision(15));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** The direction of Excel's dialog default: Rows when the selection is wider
 *  than it is tall, Columns otherwise. */
export function defaultSeriesIn(r: { startRow: number; startCol: number; endRow: number; endCol: number }): SeriesIn {
  const rows = Math.abs(r.endRow - r.startRow) + 1;
  const cols = Math.abs(r.endCol - r.startCol) + 1;
  return cols > rows ? "rows" : "columns";
}

/** A number typed into Step or Stop: either decimal mark; null when blank or
 *  not a number. */
export function parseSeriesNumber(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const normalised = t.includes(",") && !t.includes(".") ? t.replace(",", ".") : t;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(normalised)) return null;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

// ============================================================================
// Dates (Excel's 1900 serials; serial 1 = 1900-01-01, 25569 = 1970-01-01)
// ============================================================================

const MS_PER_DAY = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);

function serialToUtc(serial: number): { y: number; m: number; d: number; frac: number } {
  const whole = Math.floor(serial);
  const date = new Date(EPOCH + whole * MS_PER_DAY);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate(), frac: serial - whole };
}

function utcToSerial(y: number, m: number, d: number, frac: number): number {
  return Math.round((Date.UTC(y, m, d) - EPOCH) / MS_PER_DAY) + frac;
}

/** The start date moved by `months`, its day kept where the month has it. */
function addMonths(serial: number, months: number): number {
  const { y, m, d, frac } = serialToUtc(serial);
  const target = m + months;
  const ty = y + Math.floor(target / 12);
  const tm = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return utcToSerial(ty, tm, Math.min(d, lastDay), frac);
}

/** Saturday or Sunday (Excel serial 1 is a Sunday in its 1900 system; the
 *  JS date of a serial >= 61 is the true weekday). */
function isWeekend(serial: number): boolean {
  const day = new Date(EPOCH + Math.floor(serial) * MS_PER_DAY).getUTCDay();
  return day === 0 || day === 6;
}

/** `steps` weekdays on from `serial` (backwards for a negative count). */
function addWeekdays(serial: number, steps: number): number {
  let s = serial;
  const dir = steps < 0 ? -1 : 1;
  let left = Math.abs(Math.trunc(steps));
  while (left > 0) {
    s += dir;
    if (!isWeekend(s)) left--;
  }
  return s;
}

// ============================================================================
// Trend fits
// ============================================================================

/** Least squares y = a + b*x over x = 1..n. */
function linearFit(ys: readonly number[]): { a: number; b: number } {
  const n = ys.length;
  const xMean = (n + 1) / 2;
  const yMean = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  ys.forEach((y, i) => {
    const dx = i + 1 - xMean;
    sxy += dx * (y - yMean);
    sxx += dx * dx;
  });
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: yMean - b * xMean, b };
}

// ============================================================================
// The line
// ============================================================================

/**
 * The writes for one line under Linear, Growth or Date. `line[0]` is the start
 * cell; the line is as long as the selection (or, for a lone selected cell with
 * a Stop value, as long as the caller extended it).
 */
export function planSeriesLine(line: readonly SeriesLineCell[], opts: SeriesOptions): SeriesWrite[] {
  if (line.length < 2 || opts.type === "autofill") return [];
  const start = line[0];
  const writes: SeriesWrite[] = [];

  // Trend: fit the leading run of numbers and replace the whole line.
  if (opts.trend && opts.type !== "date") {
    const ys: number[] = [];
    for (const cell of line) {
      if (cell.kind !== "number" || cell.value === null) break;
      ys.push(cell.value);
    }
    if (ys.length >= 2) {
      if (opts.type === "growth") {
        if (ys.some((y) => y <= 0)) return []; // no exponential through 0 or a sign change
        const { a, b } = linearFit(ys.map(Math.log));
        line.forEach((cell, i) => writes.push({ row: cell.row, col: cell.col, value: formatSeriesNumber(Math.exp(a + b * (i + 1))) }));
      } else {
        const { a, b } = linearFit(ys);
        line.forEach((cell, i) => writes.push({ row: cell.row, col: cell.col, value: formatSeriesNumber(a + b * (i + 1)) }));
      }
      return writes;
    }
    // One value: nothing to fit, the step is used (D20).
  }

  // A start that is not a number clears the rest of the line (D11, D12).
  if (start.kind !== "number" || start.value === null) {
    for (let i = 1; i < line.length; i++) writes.push({ row: line[i].row, col: line[i].col, value: "" });
    return writes;
  }

  const v0 = start.value;
  const valueAt = (k: number): number => {
    switch (opts.type) {
      case "growth":
        return v0 * Math.pow(opts.step, k);
      case "date":
        switch (opts.dateUnit) {
          case "weekday":
            return addWeekdays(v0, k * opts.step);
          case "month":
            return addMonths(v0, k * opts.step);
          case "year":
            return addMonths(v0, 12 * k * opts.step);
          default:
            return v0 + k * opts.step;
        }
      default:
        return v0 + k * opts.step;
    }
  };

  // Which way the series runs, for the Stop comparison.
  const rising = valueAt(1) >= v0;
  for (let k = 1; k < line.length; k++) {
    const raw = valueAt(k);
    const value = Number(formatSeriesNumber(raw));
    if (opts.stop !== null) {
      const stop = Number(formatSeriesNumber(opts.stop));
      if (rising ? value > stop : value < stop) break;
    }
    writes.push({ row: line[k].row, col: line[k].col, value: formatSeriesNumber(raw), styleIndex: start.styleIndex });
  }
  return writes;
}

/**
 * How far a LONE selected cell's series runs to reach `stop` (Excel extends a
 * one-cell selection to the Stop value): the number of cells, start included,
 * capped at `max`. 1 when the stop is behind the start or the series never
 * moves.
 */
export function cellsToStop(v0: number, opts: SeriesOptions, max: number): number {
  if (opts.stop === null || opts.type === "autofill") return 1;
  // A series that never moves (step 0; growth by 1) never reaches its stop.
  if (opts.type === "growth" ? opts.step === 1 || v0 === 0 : opts.step === 0) return 1;
  const probe: SeriesLineCell[] = [{ row: 0, col: 0, kind: "number", value: v0, styleIndex: 0 }];
  // Grow in doublings: the plan stops itself at the Stop value.
  let length = 2;
  for (;;) {
    while (probe.length < length) probe.push({ row: probe.length, col: 0, kind: "empty", value: null, styleIndex: 0 });
    const written = planSeriesLine(probe, { ...opts, trend: false }).length;
    if (written < length - 1 || length >= max) return Math.min(written + 1, max);
    length = Math.min(max, length * 2);
  }
}
