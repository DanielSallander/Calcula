//! FILENAME: app/src/core/lib/fillEngine.ts
// PURPOSE: The fill-handle's pattern/series machinery, extracted so the DRAG
//          gesture (core/hooks/useFillHandle) and the SCRIPT surface
//          (api.fillRange, scriptHost) run the IDENTICAL code: same series
//          inference, same formula shifting, same merge replication. One
//          implementation, two callers — the two can never disagree about what
//          "fill down" means.
// CONTEXT: Everything here was moved VERBATIM from useFillHandle.ts (Wave 3,
//          item 10). Pure logic + tauri-api calls only: no React, no grid
//          state, so the script host can drive it without a component tree.

import {
  shiftFormulasBatch,
  getMergedRegions,
  mergeCells,
  type CellUpdateInput,
  type FormulaShiftInput,
} from "./tauri-api";
import { FillListRegistry, type FillListMatch } from "./fillLists";

/**
 * Fill direction enumeration.
 */
export type FillDirection = "down" | "up" | "right" | "left" | null;

/**
 * Detect pattern in values for auto-fill.
 */
export interface PatternResult {
  type: "copy" | "increment" | "series" | "text-increment" | "weekday" | "month" | "date-series" | "custom-list";
  baseValues: string[];
  step: number;
  /** For weekday/month: which list variant (full vs short) */
  listVariant?: "full" | "short";
  /** For weekday/month: starting index in the list */
  startIndex?: number;
  /** For date-series: parsed dates as [year, month, day] tuples */
  parsedDates?: [number, number, number][];
  /** For date-series: the separator used (e.g., "/" or "-") */
  dateSeparator?: string;
  /** For date-series: detected format "mdy" | "dmy" | "ymd" */
  dateFormat?: string;
  /** For custom-list: the matched fill list result */
  fillListMatch?: FillListMatch;
}

// ---------------------------------------------------------------------------
// Weekday / Month name lists (kept for generateFillValue backward compat)
// ---------------------------------------------------------------------------

const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Try to find a value in a cyclic list (case-insensitive).
 * Returns the index or -1 if not found.
 */
function findInList(value: string, list: string[]): number {
  const lower = value.trim().toLowerCase();
  return list.findIndex((item) => item.toLowerCase() === lower);
}

// ---------------------------------------------------------------------------
// Date series detection
// ---------------------------------------------------------------------------

/**
 * Try to parse a string as a date. Returns [year, month, day] or null.
 * Supports: M/D/YYYY, D/M/YYYY, YYYY-MM-DD, M-D-YYYY, D.M.YYYY
 */
function tryParseDate(value: string): { ymd: [number, number, number]; sep: string; format: string } | null {
  const trimmed = value.trim();

  // YYYY-MM-DD or YYYY/MM/DD
  let m = trimmed.match(/^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/);
  if (m) {
    const [, ys, sep, ms, ds] = m;
    const y = parseInt(ys, 10);
    const mo = parseInt(ms, 10);
    const d = parseInt(ds, 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return { ymd: [y, mo, d], sep, format: "ymd" };
    }
  }

  // M/D/YYYY or M-D-YYYY or M.D.YYYY  (assume MDY for slash/dash, DMY for dot)
  m = trimmed.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/);
  if (m) {
    const [, a, sep, b, ys] = m;
    const y = parseInt(ys, 10);
    const n1 = parseInt(a, 10);
    const n2 = parseInt(b, 10);

    if (sep === ".") {
      // European: D.M.YYYY
      if (n2 >= 1 && n2 <= 12 && n1 >= 1 && n1 <= 31) {
        return { ymd: [y, n2, n1], sep, format: "dmy" };
      }
    } else {
      // US: M/D/YYYY or M-D-YYYY
      if (n1 >= 1 && n1 <= 12 && n2 >= 1 && n2 <= 31) {
        return { ymd: [y, n1, n2], sep, format: "mdy" };
      }
      // Try DMY if MDY doesn't work
      if (n2 >= 1 && n2 <= 12 && n1 >= 1 && n1 <= 31) {
        return { ymd: [y, n2, n1], sep, format: "dmy" };
      }
    }
  }

  return null;
}

/** Convert [year, month, day] to a JS Date for arithmetic. */
function ymdToDate(ymd: [number, number, number]): Date {
  return new Date(ymd[0], ymd[1] - 1, ymd[2]);
}

/** Difference in days between two dates. */
function daysDiff(a: [number, number, number], b: [number, number, number]): number {
  const msPerDay = 86400000;
  return Math.round((ymdToDate(b).getTime() - ymdToDate(a).getTime()) / msPerDay);
}

/** Add days to a [year, month, day] tuple. */
function addDays(ymd: [number, number, number], days: number): [number, number, number] {
  const d = ymdToDate(ymd);
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

/** Add months to a [year, month, day] tuple (clamping day to end of month). */
function addMonths(ymd: [number, number, number], months: number): [number, number, number] {
  const d = ymdToDate(ymd);
  const targetMonth = d.getMonth() + months;
  d.setMonth(targetMonth);
  // If the day overflowed (e.g., Jan 31 + 1 month = Mar 3), clamp to end of target month
  if (d.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    d.setDate(0); // last day of previous month
  }
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

/** Format a [year, month, day] tuple back to the original format. */
function formatDate(ymd: [number, number, number], sep: string, format: string): string {
  const [y, mo, d] = ymd;
  const pad = (n: number) => String(n); // no zero-padding (matches common spreadsheet display)
  switch (format) {
    case "ymd":
      return `${y}${sep}${String(mo).padStart(2, "0")}${sep}${String(d).padStart(2, "0")}`;
    case "dmy":
      return `${pad(d)}${sep}${pad(mo)}${sep}${y}`;
    case "mdy":
    default:
      return `${pad(mo)}${sep}${pad(d)}${sep}${y}`;
  }
}

/**
 * Try to detect a date series pattern from display values.
 */
function detectDateSeries(values: string[]): PatternResult | null {
  if (values.length === 0) return null;

  const parsed = values.map(tryParseDate);
  if (parsed.some((p) => p === null)) return null;

  const nonNull = parsed as NonNullable<typeof parsed[0]>[];
  const sep = nonNull[0].sep;
  const fmt = nonNull[0].format;
  const dates = nonNull.map((p) => p.ymd);

  if (values.length === 1) {
    // Single date: increment by 1 day
    return {
      type: "date-series",
      baseValues: values,
      step: 1,
      parsedDates: dates,
      dateSeparator: sep,
      dateFormat: fmt,
    };
  }

  // Check for consistent day difference
  const diffs: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    diffs.push(daysDiff(dates[i - 1], dates[i]));
  }

  if (diffs.every((d) => d === diffs[0]) && diffs[0] !== 0) {
    return {
      type: "date-series",
      baseValues: values,
      step: diffs[0],
      parsedDates: dates,
      dateSeparator: sep,
      dateFormat: fmt,
    };
  }

  // Check for consistent month difference (e.g., 1/31, 2/28, 3/31)
  const monthDiffs: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const [y1, m1] = dates[i - 1];
    const [y2, m2] = dates[i];
    monthDiffs.push((y2 - y1) * 12 + (m2 - m1));
  }
  if (monthDiffs.every((d) => d === monthDiffs[0]) && monthDiffs[0] !== 0) {
    // Use negative step to signal "months" mode (step = month count, negated)
    return {
      type: "date-series",
      baseValues: values,
      step: -monthDiffs[0], // negative = months mode
      parsedDates: dates,
      dateSeparator: sep,
      dateFormat: fmt,
    };
  }

  return null;
}

/**
 * Analyze source values to detect fill pattern.
 */
export function detectPattern(values: string[]): PatternResult {
  if (values.length === 0) {
    return { type: "copy", baseValues: [""], step: 0 };
  }

  // Try custom fill lists first (user-defined lists have highest priority)
  const listMatch = FillListRegistry.matchValues(values);
  if (listMatch) {
    return {
      type: "custom-list",
      baseValues: values,
      step: listMatch.step,
      fillListMatch: listMatch,
    };
  }

  // Try date series (named sequences are now handled by the fill list registry above)
  const dateSeries = detectDateSeries(values);
  if (dateSeries) return dateSeries;

  if (values.length === 1) {
    const val = values[0];

    // Check for text + number pattern (e.g., "Item 1")
    const textNumMatch = val.match(/^(.+?)(\d+)$/);
    if (textNumMatch) {
      return {
        type: "text-increment",
        baseValues: [textNumMatch[1]],
        step: 1,
      };
    }

    // Single number - copy by default
    if (!isNaN(parseFloat(val)) && val.trim() !== "") {
      return { type: "copy", baseValues: values, step: 0 };
    }

    // Text - copy
    return { type: "copy", baseValues: values, step: 0 };
  }

  // Multiple values - try to detect series
  const numbers = values.map((v) => parseFloat(v));
  const allNumbers = numbers.every((n) => !isNaN(n));

  if (allNumbers && values.length >= 2) {
    // Check for arithmetic sequence
    const diffs: number[] = [];
    for (let i = 1; i < numbers.length; i++) {
      diffs.push(numbers[i] - numbers[i - 1]);
    }

    // Check if all differences are the same
    const allSameDiff = diffs.every((d) => Math.abs(d - diffs[0]) < 0.0001);
    if (allSameDiff) {
      return {
        type: "series",
        baseValues: values,
        step: diffs[0],
      };
    }
  }

  // Check for text + number patterns in multiple values
  const textNumMatches = values.map((v) => v.match(/^(.+?)(\d+)$/));
  if (textNumMatches.every((m) => m !== null)) {
    const prefixes = textNumMatches.map((m) => m![1]);
    if (prefixes.every((p) => p === prefixes[0])) {
      const nums = textNumMatches.map((m) => parseInt(m![2], 10));
      if (nums.length >= 2) {
        const step = nums[1] - nums[0];
        const isSequential = nums.every((n, i) => i === 0 || n - nums[i - 1] === step);
        if (isSequential) {
          return {
            type: "text-increment",
            baseValues: [prefixes[0]],
            step,
          };
        }
      }
    }
  }

  // Default to repeating pattern
  return { type: "copy", baseValues: values, step: 0 };
}

/**
 * Generate fill value based on pattern and index.
 */
export function generateFillValue(
  pattern: PatternResult,
  sourceValues: string[],
  index: number
): string {
  switch (pattern.type) {
    case "copy":
      return sourceValues[index % sourceValues.length];

    case "increment": {
      const baseNum = parseFloat(sourceValues[0]);
      return String(baseNum + index + 1);
    }

    case "series": {
      const lastNum = parseFloat(sourceValues[sourceValues.length - 1]);
      const offset = index - sourceValues.length + 1;
      if (offset > 0) {
        return String(lastNum + pattern.step * offset);
      }
      return sourceValues[index];
    }

    case "text-increment": {
      const prefix = pattern.baseValues[0];
      const baseMatch = sourceValues[sourceValues.length - 1].match(/(\d+)$/);
      const baseNum = baseMatch ? parseInt(baseMatch[1], 10) : 0;
      const offset = index - sourceValues.length + 1;
      if (offset > 0) {
        return `${prefix}${baseNum + pattern.step * offset}`;
      }
      return sourceValues[index];
    }

    case "custom-list": {
      const match = pattern.fillListMatch!;
      const offset = index - sourceValues.length + 1;
      if (offset > 0) {
        // Find the index of the last source value in the list
        const listItems = match.list.items;
        const lowerItems = listItems.map((item) => item.toLowerCase());
        const lastVal = sourceValues[sourceValues.length - 1].trim().toLowerCase();
        const lastIdx = lowerItems.indexOf(lastVal);
        if (lastIdx >= 0) {
          return FillListRegistry.generateValue(match, lastIdx, offset);
        }
      }
      return sourceValues[index];
    }

    case "weekday": {
      const list = pattern.listVariant === "full" ? WEEKDAY_FULL : WEEKDAY_SHORT;
      const offset = index - sourceValues.length + 1;
      if (offset > 0) {
        const lastIdx = findInList(sourceValues[sourceValues.length - 1], list);
        const newIdx = ((lastIdx + pattern.step * offset) % 7 + 7) % 7;
        return list[newIdx];
      }
      return sourceValues[index];
    }

    case "month": {
      const list = pattern.listVariant === "full" ? MONTH_FULL : MONTH_SHORT;
      const offset = index - sourceValues.length + 1;
      if (offset > 0) {
        const lastIdx = findInList(sourceValues[sourceValues.length - 1], list);
        const newIdx = ((lastIdx + pattern.step * offset) % 12 + 12) % 12;
        return list[newIdx];
      }
      return sourceValues[index];
    }

    case "date-series": {
      const dates = pattern.parsedDates!;
      const sep = pattern.dateSeparator!;
      const fmt = pattern.dateFormat!;
      const offset = index - sourceValues.length + 1;
      if (offset > 0) {
        const lastDate = dates[dates.length - 1];
        if (pattern.step < 0) {
          // Months mode: step is negated month count
          const monthStep = -pattern.step;
          const newDate = addMonths(lastDate, monthStep * offset);
          return formatDate(newDate, sep, fmt);
        } else {
          const newDate = addDays(lastDate, pattern.step * offset);
          return formatDate(newDate, sep, fmt);
        }
      }
      return sourceValues[index];
    }

    default:
      return sourceValues[index % sourceValues.length];
  }
}

/**
 * Represents a pending cell fill that may need formula shifting.
 */
export interface PendingFill {
  row: number;
  col: number;
  sourceValue: string;
  sourceRow: number;
  sourceCol: number;
  pattern: PatternResult;
  allSourceValues: string[];
  fillIndex: number;
  /** Style index from the source cell to propagate to the filled cell */
  sourceStyleIndex: number;
}

/**
 * Compute the fill value for a non-formula cell synchronously.
 */
function computeNonFormulaFillValue(
  pattern: PatternResult,
  allSourceValues: string[],
  fillIndex: number,
): string {
  return generateFillValue(pattern, allSourceValues, fillIndex);
}

/**
 * Process pending fills by batching formula shifts.
 * Returns an array of CellUpdateInput ready for updateCellsBatch.
 */
export async function processPendingFills(pendingFills: PendingFill[]): Promise<CellUpdateInput[]> {
  const t0 = performance.now();

  // Separate formulas from non-formulas
  const formulaFills: { index: number; fill: PendingFill }[] = [];
  const results: CellUpdateInput[] = new Array(pendingFills.length);

  for (let i = 0; i < pendingFills.length; i++) {
    const fill = pendingFills[i];
    if (fill.sourceValue.startsWith("=")) {
      formulaFills.push({ index: i, fill });
    } else {
      // Non-formula: compute synchronously
      results[i] = {
        row: fill.row,
        col: fill.col,
        value: computeNonFormulaFillValue(fill.pattern, fill.allSourceValues, fill.fillIndex),
        styleIndex: fill.sourceStyleIndex,
      };
    }
  }

  const t1 = performance.now();

  // Batch process all formulas
  if (formulaFills.length > 0) {
    const shiftInputs: FormulaShiftInput[] = formulaFills.map(({ fill }) => ({
      formula: fill.sourceValue,
      rowDelta: fill.row - fill.sourceRow,
      colDelta: fill.col - fill.sourceCol,
    }));

    const t2 = performance.now();

    try {
      const shiftedFormulas = await shiftFormulasBatch(shiftInputs);
      const t3 = performance.now();

      for (let i = 0; i < formulaFills.length; i++) {
        const { index, fill } = formulaFills[i];
        results[index] = {
          row: fill.row,
          col: fill.col,
          value: shiftedFormulas[i],
          styleIndex: fill.sourceStyleIndex,
        };
      }
      const t4 = performance.now();

      console.log(
        `[PERF][processFills] ${pendingFills.length} fills (${formulaFills.length} formulas) | ` +
        `separateLoop=${(t1 - t0).toFixed(1)}ms ` +
        `buildInputs=${(t2 - t1).toFixed(1)}ms ` +
        `shiftFormulasBatch=${(t3 - t2).toFixed(1)}ms ` +
        `assignResults=${(t4 - t3).toFixed(1)}ms ` +
        `TOTAL=${(t4 - t0).toFixed(1)}ms`
      );
    } catch (error) {
      console.error("[FillHandle] shiftFormulasBatch failed, copying formulas as-is:", error);
      // Fallback: use formulas unchanged
      for (const { index, fill } of formulaFills) {
        results[index] = {
          row: fill.row,
          col: fill.col,
          value: fill.sourceValue,
          styleIndex: fill.sourceStyleIndex,
        };
      }
    }
  }

  return results;
}

/**
 * Replicate merged regions from the source range into the filled target range.
 * For each source merge, creates corresponding merges in every repetition of the
 * source pattern that falls within the target range.
 */
export async function replicateMergeRegions(
  sourceRange: { startRow: number; startCol: number; endRow: number; endCol: number },
  targetRange: { startRow: number; startCol: number; endRow: number; endCol: number },
  direction: FillDirection,
): Promise<void> {
  const allMerged = await getMergedRegions();

  // Find merged regions that are fully within the source range
  const sourceMerges = allMerged.filter(
    (m) =>
      m.startRow >= sourceRange.startRow &&
      m.endRow <= sourceRange.endRow &&
      m.startCol >= sourceRange.startCol &&
      m.endCol <= sourceRange.endCol,
  );

  if (sourceMerges.length === 0) return;

  const sourceRows = sourceRange.endRow - sourceRange.startRow + 1;
  const sourceCols = sourceRange.endCol - sourceRange.startCol + 1;

  if (direction === "down" || direction === "up") {
    const fillStart = direction === "down" ? sourceRange.endRow + 1 : targetRange.startRow;
    const fillEnd = direction === "down" ? targetRange.endRow : sourceRange.startRow - 1;
    const fillCount = fillEnd - fillStart + 1;
    if (fillCount <= 0) return;

    const repetitions = Math.ceil(fillCount / sourceRows);

    for (let rep = 0; rep < repetitions; rep++) {
      for (const m of sourceMerges) {
        const rowOffset = direction === "down"
          ? (rep * sourceRows) + (sourceRange.endRow + 1 - sourceRange.startRow)
          : -((rep + 1) * sourceRows);

        const newStartRow = m.startRow + rowOffset;
        const newEndRow = m.endRow + rowOffset;

        // Clip to target range
        if (newStartRow > fillEnd || newEndRow < fillStart) continue;
        const clippedStartRow = Math.max(newStartRow, fillStart);
        const clippedEndRow = Math.min(newEndRow, fillEnd);

        // Only merge if we have the full merge height (don't create partial merges)
        if (clippedEndRow - clippedStartRow !== m.endRow - m.startRow) continue;

        await mergeCells(clippedStartRow, m.startCol, clippedEndRow, m.endCol);
      }
    }
  } else if (direction === "right" || direction === "left") {
    const fillStart = direction === "right" ? sourceRange.endCol + 1 : targetRange.startCol;
    const fillEnd = direction === "right" ? targetRange.endCol : sourceRange.startCol - 1;
    const fillCount = fillEnd - fillStart + 1;
    if (fillCount <= 0) return;

    const repetitions = Math.ceil(fillCount / sourceCols);

    for (let rep = 0; rep < repetitions; rep++) {
      for (const m of sourceMerges) {
        const colOffset = direction === "right"
          ? (rep * sourceCols) + (sourceRange.endCol + 1 - sourceRange.startCol)
          : -((rep + 1) * sourceCols);

        const newStartCol = m.startCol + colOffset;
        const newEndCol = m.endCol + colOffset;

        // Clip to target range
        if (newStartCol > fillEnd || newEndCol < fillStart) continue;
        const clippedStartCol = Math.max(newStartCol, fillStart);
        const clippedEndCol = Math.min(newEndCol, fillEnd);

        // Only merge if we have the full merge width
        if (clippedEndCol - clippedStartCol !== m.endCol - m.startCol) continue;

        await mergeCells(m.startRow, clippedStartCol, m.endRow, clippedEndCol);
      }
    }
  }
}
