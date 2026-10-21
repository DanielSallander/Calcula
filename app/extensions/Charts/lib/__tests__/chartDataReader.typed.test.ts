//! FILENAME: app/extensions/Charts/lib/__tests__/chartDataReader.typed.test.ts
// PURPOSE: The range reader classifies and counts from the TYPED read, and reads
//          text only in the APP locale (P2 S8).
// CONTEXT: The category axis used to be typed by re-parsing display text with
//          a locale GUESSER (and `Date.parse`, the browser's own reading), and
//          series detection by the same guesser. The engine already says what a
//          cell holds; the display text is consulted only to tell a DATE cell
//          from a number cell (it reads as a date in the app locale), and for a
//          text cell, read strictly in the app locale.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  getRangeCellsTyped: vi.fn(),
  getHiddenRowsInfo: vi.fn(),
  getHiddenColsInfo: vi.fn(),
}));

vi.mock("@api/lib", () => ({
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1", sheetId: "s0", visibility: "visible" }], activeIndex: 0 })),
  getRangeCellsTyped: h.getRangeCellsTyped,
  getHiddenRowsInfo: h.getHiddenRowsInfo,
  getHiddenColsInfo: h.getHiddenColsInfo,
}));
vi.mock("@api", () => ({
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1", sheetId: "s0", visibility: "visible" }], activeIndex: 0 })),
  getNamedRange: vi.fn(async () => null),
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  isSandboxTransformMounted: () => false,
  runSandboxTransform: vi.fn(),
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" } }),
}));

import { readChartDataResolved, autoDetectSeries, typedCategoryValue } from "../chartDataReader";
import { useAppLocale, useInvariantLocale } from "./appLocaleTestKit";
import type { ChartSpec } from "../../types";

type Kind = "number" | "text" | "empty";
const cell = (row: number, col: number, display: string, kind: Kind, value?: unknown) => ({
  row,
  col,
  display,
  formula: null,
  type: kind,
  value: kind === "empty" ? null : value ?? display,
});

function spec(endRow: number, over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "scatter",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Amount", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

beforeEach(() => {
  h.getRangeCellsTyped.mockReset();
  h.getHiddenRowsInfo.mockReset();
  h.getHiddenColsInfo.mockReset();
  h.getHiddenRowsInfo.mockResolvedValue({ user: [], effective: [] });
  h.getHiddenColsInfo.mockResolvedValue({ user: [], effective: [] });
});
afterEach(async () => { await useInvariantLocale(); });

describe("typedCategoryValue", () => {
  it("a number cell shown as a number is that number; shown as a date, that date", async () => {
    await useAppLocale("de-DE");
    expect(typedCategoryValue("1.234,5", 1234.5)).toBe(1234.5);
    expect(typedCategoryValue("15.01.2024", 45306)).toEqual(new Date(Date.UTC(2024, 0, 15)));
    expect(typedCategoryValue("15.01.2024", undefined)).toBeNull();
    expect(typedCategoryValue("", null)).toBeNull();
  });
});

describe("range reader: the category axis is typed from the typed read", () => {
  it("de-DE date cells -> a temporal axis at the cells' serials", async () => {
    await useAppLocale("de-DE");
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "Datum", "text"), cell(0, 1, "Amount", "text"),
      cell(1, 0, "15.01.2024", "number", 45306), cell(1, 1, "1", "number", 1),
      cell(2, 0, "01.02.2024", "number", 45323), cell(2, 1, "2", "number", 2),
    ]);
    const { data } = await readChartDataResolved(spec(2));
    expect(data.categoryField).toEqual({ type: "temporal", values: [Date.UTC(2024, 0, 15), Date.UTC(2024, 1, 1)] });
  });

  it("de-DE number cells -> a quantitative axis at the cells' values, never the guessed text", async () => {
    await useAppLocale("de-DE");
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "X", "text"), cell(0, 1, "Amount", "text"),
      cell(1, 0, "1.234", "number", 1234), cell(1, 1, "1", "number", 1),
      cell(2, 0, "2,5", "number", 2.5), cell(2, 1, "2", "number", 2),
    ]);
    const { data } = await readChartDataResolved(spec(2));
    // The old guesser read "1.234" as 1.234 (a decimal point) in every locale.
    expect(data.categoryField).toEqual({ type: "quantitative", values: [1234, 2.5] });
  });

  it("a number cell under a scaling format ('1,2K') is its VALUE, not its text", async () => {
    await useAppLocale("de-DE");
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "X", "text"), cell(0, 1, "Amount", "text"),
      cell(1, 0, "1,2K", "number", 1200), cell(1, 1, "1", "number", 1),
      cell(2, 0, "3,4K", "number", 3400), cell(2, 1, "2", "number", 2),
    ]);
    const { data } = await readChartDataResolved(spec(2));
    expect(data.categoryField).toEqual({ type: "quantitative", values: [1200, 3400] });
  });

  it("after a transform rebuilt the categories, the text decides", async () => {
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "X", "text"), cell(0, 1, "Amount", "text"),
      cell(1, 0, "1.2K", "number", 1200), cell(1, 1, "1", "number", 1),
      cell(2, 0, "3.4K", "number", 3400), cell(2, 1, "2", "number", 2),
    ]);
    const { data } = await readChartDataResolved(spec(2, { transform: [{ type: "sort", field: "$category", order: "desc" }] }));
    // "3.4K" / "1.2K" are not numbers as text: nominal once the typing is gone.
    expect(data.categoryField).toBeUndefined();
  });

  it("a TEXT category cell keeps the axis nominal, even one that reads as a number", async () => {
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "Year", "text"), cell(0, 1, "Amount", "text"),
      cell(1, 0, "2023", "text"), cell(1, 1, "1", "number", 1),
      cell(2, 0, "2024", "number", 2024), cell(2, 1, "2", "number", 2),
    ]);
    const { data } = await readChartDataResolved(spec(2));
    expect(data.categoryField).toBeUndefined();
  });

  it("a hidden category row is left out and the rest stay typed", async () => {
    h.getHiddenRowsInfo.mockResolvedValue({ user: [2], effective: [2] });
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "X", "text"), cell(0, 1, "Amount", "text"),
      cell(1, 0, "10", "number", 10), cell(1, 1, "1", "number", 1),
      cell(2, 0, "abc", "text"), cell(2, 1, "2", "number", 2),
      cell(3, 0, "30", "number", 30), cell(3, 1, "3", "number", 3),
    ]);
    const { data } = await readChartDataResolved(spec(3));
    expect(data.categories).toEqual(["10", "30"]);
    expect(data.categoryField).toEqual({ type: "quantitative", values: [10, 30] });
  });
});

describe("range reader: a text cell's number is read in the app locale", () => {
  it("sv-SE text '1 234,5' is 1234.5 (it is a text cell, so its kind stays text)", async () => {
    await useAppLocale("sv-SE");
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "Item", "text"), cell(0, 1, "Amount", "text"),
      cell(1, 0, "A", "text"), cell(1, 1, "1 234,5", "text"),
    ]);
    const { data } = await readChartDataResolved(spec(1, { mark: "bar" }));
    expect(data.series[0].values).toEqual([1234.5]);
    expect(data.datumKinds?.[0]).toEqual(["text"]);
  });

  it("the en-US spelling is not an sv-SE number", async () => {
    await useAppLocale("sv-SE");
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "Item", "text"), cell(0, 1, "Amount", "text"),
      cell(1, 0, "A", "text"), cell(1, 1, "1,234.5", "text"),
    ]);
    const { data } = await readChartDataResolved(spec(1, { mark: "bar" }));
    expect(data.series[0].values).toEqual([0]);
  });
});

describe("autoDetectSeries reads the typed values", () => {
  it("a column of number cells is a series whatever its display text looks like", async () => {
    await useAppLocale("de-DE");
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "Item", "text"), cell(0, 1, "When", "text"), cell(0, 2, "Note", "text"),
      cell(1, 0, "A", "text"), cell(1, 1, "15.01.2024", "number", 45306), cell(1, 2, "n/a", "text"),
    ]);
    const res = await autoDetectSeries({ sheetIndex: 0, startRow: 0, startCol: 0, endRow: 1, endCol: 2 }, true);
    expect(res.series.map((s) => s.name)).toEqual(["When"]);
  });

  it("a de-DE text number counts; an en-US one does not", async () => {
    await useAppLocale("de-DE");
    h.getRangeCellsTyped.mockResolvedValue([
      cell(0, 0, "Item", "text"), cell(0, 1, "De", "text"), cell(0, 2, "En", "text"),
      cell(1, 0, "A", "text"), cell(1, 1, "1.234,5", "text"), cell(1, 2, "1,234.5", "text"),
    ]);
    const res = await autoDetectSeries({ sheetIndex: 0, startRow: 0, startCol: 0, endRow: 1, endCol: 2 }, true);
    expect(res.series.map((s) => s.name)).toEqual(["De"]);
  });
});
