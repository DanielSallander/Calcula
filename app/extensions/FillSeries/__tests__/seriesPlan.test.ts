//! FILENAME: app/extensions/FillSeries/__tests__/seriesPlan.test.ts
// PURPOSE: Fill > Series... produces what EXCEL produces. Every expectation was
//          measured in live Excel 16 (build 20430) on 2026-10-04 through
//          Range.DataSeries -- the Series dialog's own object-model call -- on
//          fresh workbooks (case names D1..D22 are the probe's).
//          The planner is pure: a line of cells in, the cells to write out.

import { describe, it, expect } from "vitest";
import {
  planSeriesLine,
  defaultSeriesIn,
  parseSeriesNumber,
  type SeriesLineCell,
  type SeriesOptions,
} from "../lib/seriesPlan";

const base: SeriesOptions = {
  seriesIn: "columns",
  type: "linear",
  dateUnit: "day",
  step: 1,
  stop: null,
  trend: false,
};

/** A column line starting at row 0, col 0: numbers, text, or null (empty). */
function line(values: Array<number | string | null>, styleIndex = 0): SeriesLineCell[] {
  return values.map((v, row) => ({
    row,
    col: 0,
    kind: v === null ? "empty" : typeof v === "number" ? "number" : "text",
    value: typeof v === "number" ? v : null,
    styleIndex: row === 0 ? styleIndex : 0,
  }));
}

/** The written values by row (cells not written are absent). */
function run(values: Array<number | string | null>, opts: Partial<SeriesOptions>, styleIndex = 0) {
  const writes = planSeriesLine(line(values, styleIndex), { ...base, ...opts });
  return Object.fromEntries(writes.map((w) => [w.row, w.value]));
}

const D = (y: number, m: number, d: number): number =>
  Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);

describe("Linear and Growth (no Trend)", () => {
  it("D1 linear step 2 from the first cell", () => {
    expect(run([1, null, null, null, null, null], { step: 2 })).toEqual({ 1: "3", 2: "5", 3: "7", 4: "9", 5: "11" });
  });
  it("D2 a stop value ends the series and leaves the rest UNTOUCHED", () => {
    expect(run([1, null, null, null, null, "zz", null, null], { step: 3, stop: 10 })).toEqual({ 1: "4", 2: "7", 3: "10" });
  });
  it("D3 growth multiplies", () => {
    expect(run([2, null, null, null, null], { type: "growth", step: 3 })).toEqual({ 1: "6", 2: "18", 3: "54", 4: "162" });
  });
  it("D9 later values in the line are overwritten from the FIRST", () => {
    expect(run([1, 5, null, null, null], { step: 1 })).toEqual({ 1: "2", 2: "3", 3: "4", 4: "5" });
  });
  it("D11 / D12 a start that is not a number clears the rest of its line", () => {
    expect(run([null, null, "keep", null], {})).toEqual({ 1: "", 2: "", 3: "" });
    expect(run(["Item 1", null, null, null], {})).toEqual({ 1: "", 2: "", 3: "" });
  });
  it("D15 a stop below the start writes nothing past the start", () => {
    expect(run([5, null, "keep", null], { stop: 2 })).toEqual({});
  });
  it("D16 a negative step", () => {
    expect(run([10, null, null, null], { step: -3 })).toEqual({ 1: "7", 2: "4", 3: "1" });
  });
  it("D19 / D22 decimal steps land on the decimals Excel shows (no 0.30000000000000004)", () => {
    expect(run([0.1, null, null, null, null], { step: 0.1 })).toEqual({ 1: "0.2", 2: "0.3", 3: "0.4", 4: "0.5" });
    expect(run([0, null, null, null, null, null, null, null], { step: 0.3, stop: 0.9 })).toEqual({ 1: "0.3", 2: "0.6", 3: "0.9" });
  });
  it("D18 the start cell's format goes with the values", () => {
    const writes = planSeriesLine(line([1, null, null], 7), base);
    expect(writes.map((w) => w.styleIndex)).toEqual([7, 7]);
  });
});

describe("Trend", () => {
  it("D7 linear: a least-squares line through the starting values REPLACES them", () => {
    const out = run([1, 3, 4, null, null, null], { trend: true });
    const nums = [0, 1, 2, 3, 4, 5].map((r) => Number(out[r]));
    expect(nums.map((n) => n.toFixed(8))).toEqual(
      ["1.16666667", "2.66666667", "4.16666667", "5.66666667", "7.16666667", "8.66666667"],
    );
  });
  it("D8 growth: an exponential fit", () => {
    const out = run([1, 2, 4.5, null, null, null], { type: "growth", trend: true });
    const nums = [0, 1, 2, 3, 4, 5].map((r) => Number(out[r]));
    expect(nums.map((n) => n.toFixed(6))).toEqual(["0.980561", "2.080084", "4.412524", "9.360377", "19.856359", "42.121697"]);
  });
  it("D20 one starting value: Trend has nothing to fit, the step is used", () => {
    expect(run([4, null, null, null], { trend: true })).toEqual({ 1: "5", 2: "6", 3: "7" });
  });
});

describe("Date", () => {
  it("D14 days, step 7", () => {
    const start = D(2026, 10, 2);
    expect(run([start, null, null, null], { type: "date", dateUnit: "day", step: 7 })).toEqual({
      1: String(start + 7), 2: String(start + 14), 3: String(start + 21),
    });
  });
  it("D5 weekdays skip Saturday and Sunday (from Friday 2026-10-02)", () => {
    const out = run([D(2026, 10, 2), null, null, null, null, null], { type: "date", dateUnit: "weekday" });
    expect(out).toEqual({
      1: String(D(2026, 10, 5)),
      2: String(D(2026, 10, 6)),
      3: String(D(2026, 10, 7)),
      4: String(D(2026, 10, 8)),
      5: String(D(2026, 10, 9)),
    });
  });
  it("D4 months keep the START's day where the month has it (Jan 31 -> Feb 28 -> Mar 31)", () => {
    const out = run([D(2026, 1, 31), null, null, null, null, null], { type: "date", dateUnit: "month" });
    expect(out).toEqual({
      1: String(D(2026, 2, 28)),
      2: String(D(2026, 3, 31)),
      3: String(D(2026, 4, 30)),
      4: String(D(2026, 5, 31)),
      5: String(D(2026, 6, 30)),
    });
  });
  it("D6 years from Feb 29", () => {
    expect(run([D(2024, 2, 29), null, null, null], { type: "date", dateUnit: "year" })).toEqual({
      1: String(D(2025, 2, 28)), 2: String(D(2026, 2, 28)), 3: String(D(2027, 2, 28)),
    });
  });
});

describe("the dialog's defaults and input", () => {
  it("Series in: Rows for a wide selection, Columns otherwise", () => {
    expect(defaultSeriesIn({ startRow: 0, startCol: 0, endRow: 1, endCol: 4 })).toBe("rows");
    expect(defaultSeriesIn({ startRow: 0, startCol: 0, endRow: 9, endCol: 1 })).toBe("columns");
    expect(defaultSeriesIn({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toBe("columns");
  });
  it("a number typed with either decimal mark; anything else is not a number", () => {
    expect(parseSeriesNumber("2")).toBe(2);
    expect(parseSeriesNumber("0,5")).toBe(0.5);
    expect(parseSeriesNumber(" -1.25 ")).toBe(-1.25);
    expect(parseSeriesNumber("")).toBeNull();
    expect(parseSeriesNumber("abc")).toBeNull();
  });
});
