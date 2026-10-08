//! FILENAME: app/extensions/Charts/lib/__tests__/chartDisplayValues.test.ts
// PURPOSE: ParsedChartData.displayValues (contract 4.9): the range and pivot
//          readers carry every datum's SOURCE TEXT beside its number, so a Card
//          shows a text cell as its text (never as the 0 the parser wrote) and
//          a currency cell keeps its format; the filters keep the text aligned
//          with the numbers; a transform (which makes numbers the source never
//          showed) drops it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getRangeCellsTyped: vi.fn(),
  getView: vi.fn(),
}));

vi.mock("@api/lib", () => ({
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1", sheetId: "s0", visibility: "visible" }], activeIndex: 0 })),
  getRangeCellsTyped: h.getRangeCellsTyped,
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
vi.mock("@api/pivot", () => ({ pivot: { getView: h.getView, getInfo: vi.fn(async () => null) } }));

import { readChartDataResolved } from "../chartDataReader";
import { registerChartTransform, unregisterChartTransform } from "@api/chartTransforms";
import { applyChartFilters, applySelectionKeep } from "../chartFilters";
import { extractChartData } from "../pivotChartDataReader";
import type { ChartSpec, ParsedChartData } from "../../types";
import type { PivotViewResponse } from "@api/pivot";

const cell = (row: number, col: number, display: string) => ({ row, col, value: display, display, formula: null, type: "text" });

/** Region | Sales | Manager : one text field beside a currency field. */
const GRID = [
  cell(0, 0, "Region"), cell(0, 1, "Sales"), cell(0, 2, "Manager"),
  cell(1, 0, "North"), cell(1, 1, "$1,234.50"), cell(1, 2, "Ann"),
  cell(2, 0, "South"), cell(2, 1, "$99.00"), cell(2, 2, "Bo"),
];

const axis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "multiRowCard",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Sales", sourceIndex: 1, color: null },
      { name: "Manager", sourceIndex: 2, color: null },
    ],
    title: null,
    xAxis: axis,
    yAxis: axis,
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

beforeEach(() => {
  h.getRangeCellsTyped.mockReset();
  h.getRangeCellsTyped.mockImplementation(async () => GRID);
});

describe("range reader: displayValues", () => {
  it("columns orientation: every datum's text, aligned [series][category]", async () => {
    const { data } = await readChartDataResolved(spec());
    expect(data.series.map((s) => s.values)).toEqual([[1234.5, 99], [0, 0]]);
    expect(data.displayValues).toEqual([["$1,234.50", "$99.00"], ["Ann", "Bo"]]);
  });

  it("rows orientation: the same, read across", async () => {
    const rowsGrid = [
      cell(0, 0, "Metric"), cell(0, 1, "Q1"), cell(0, 2, "Q2"),
      cell(1, 0, "Owner"), cell(1, 1, "Ann"), cell(1, 2, "Bo"),
    ];
    h.getRangeCellsTyped.mockImplementation(async () => rowsGrid);
    const { data } = await readChartDataResolved(
      spec({
        data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 1, endCol: 2 },
        seriesOrientation: "rows",
        categoryIndex: 0,
        series: [{ name: "Owner", sourceIndex: 1, color: null }],
      }),
    );
    expect(data.categories).toEqual(["Q1", "Q2"]);
    expect(data.displayValues).toEqual([["Ann", "Bo"]]);
  });

  it("a chart filter keeps the text with its number (hidden series and category drop from both)", async () => {
    const { data } = await readChartDataResolved(spec({ filters: { hiddenSeries: [0], hiddenCategories: [0] } }));
    expect(data.series.map((s) => s.name)).toEqual(["Manager"]);
    expect(data.categories).toEqual(["South"]);
    expect(data.displayValues).toEqual([["Bo"]]);
  });

  it("a transform drops the text: the numbers are no longer the source's", async () => {
    // A custom transform that SPREADS its input and doubles the numbers: the
    // shape a third-party transform naturally writes, and the one that would
    // carry "$99.00" beside a recomputed 198 if the reader kept the text.
    registerChartTransform("test:double", {
      apply: (d: ParsedChartData) => ({
        ...d,
        series: d.series.map((s) => ({ ...s, values: s.values.map((v) => v * 2) })),
      }),
    });
    try {
      const { data } = await readChartDataResolved(
        spec({ transform: [{ type: "test:double" }] } as unknown as Partial<ChartSpec>),
      );
      expect(data.series[0].values).toEqual([2469, 198]);
      expect(data.displayValues).toBeUndefined();
    } finally {
      unregisterChartTransform("test:double");
    }
  });
});

describe("chartFilters keep displayValues aligned", () => {
  const DATA: ParsedChartData = {
    categories: ["a", "b", "c"],
    series: [
      { name: "x", values: [1, 2, 3], color: null },
      { name: "y", values: [4, 5, 6], color: null },
    ],
    displayValues: [["1", "2", "3"], ["four", "five", "six"]],
  };

  it("applyChartFilters", () => {
    const out = applyChartFilters(DATA, { hiddenSeries: [0], hiddenCategories: [1] });
    expect(out.displayValues).toEqual([["four", "six"]]);
  });

  it("applySelectionKeep", () => {
    const out = applySelectionKeep(DATA, ["c", "a"]);
    expect(out.categories).toEqual(["a", "c"]);
    expect(out.displayValues).toEqual([["1", "3"], ["four", "six"]]);
  });

  it("data without displayValues stays without", () => {
    const { displayValues: _d, ...plain } = DATA;
    expect(applyChartFilters(plain, { hiddenSeries: [0] }).displayValues).toBeUndefined();
    expect(applySelectionKeep(plain, ["a"]).displayValues).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pivot reader
// ---------------------------------------------------------------------------

function pivotView(rows: PivotViewResponse["rows"]): PivotViewResponse {
  return {
    pivotId: "p1",
    version: 1,
    rowCount: rows.length,
    colCount: 2,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    columns: [
      { viewCol: 0, colType: "RowLabel", depth: 0, widthHint: 80 },
      { viewCol: 1, colType: "Data", depth: 0, widthHint: 80 },
    ],
    rows,
  } as unknown as PivotViewResponse;
}

const header = {
  viewRow: 0, rowType: "ColumnHeader", depth: 0, visible: true,
  cells: [
    { cellType: "RowLabelHeader", value: "Region", backgroundStyle: "Header" },
    { cellType: "ColumnHeader", value: "Sum of Sales", backgroundStyle: "Header" },
  ],
};

describe("pivot reader: displayValues", () => {
  it("carries the pivot's formatted text; an unformatted number is \"\" (the visual's units write it)", () => {
    const view = pivotView([
      header,
      { viewRow: 1, rowType: "Data", depth: 0, visible: true, cells: [
        { cellType: "RowHeader", value: "North", backgroundStyle: "Normal" },
        { cellType: "Data", value: 1234.5, formattedValue: "$1,234.50", backgroundStyle: "Normal" },
      ] },
      { viewRow: 2, rowType: "Data", depth: 0, visible: true, cells: [
        { cellType: "RowHeader", value: "South", backgroundStyle: "Normal" },
        { cellType: "Data", value: 99, backgroundStyle: "Normal" },
      ] },
    ] as PivotViewResponse["rows"]);
    const data = extractChartData(view, {});
    expect(data.series[0].values).toEqual([1234.5, 99]);
    expect(data.displayValues).toEqual([["$1,234.50", ""]]);
  });

  it("all plain numbers: the field is absent", () => {
    const view = pivotView([
      header,
      { viewRow: 1, rowType: "Data", depth: 0, visible: true, cells: [
        { cellType: "RowHeader", value: "North", backgroundStyle: "Normal" },
        { cellType: "Data", value: 1 / 3, backgroundStyle: "Normal" },
      ] },
    ] as PivotViewResponse["rows"]);
    expect(extractChartData(view, {}).displayValues).toBeUndefined();
  });

  it("a pivot with NO row fields (only the grand total) still charts its total: a Card on a measure", () => {
    const view = pivotView([
      header,
      { viewRow: 1, rowType: "GrandTotal", depth: 0, visible: true, cells: [
        { cellType: "GrandTotalRow", value: "Grand Total", backgroundStyle: "GrandTotal" },
        { cellType: "GrandTotal", value: 11732, formattedValue: "11,732", backgroundStyle: "GrandTotal" },
      ] },
    ] as PivotViewResponse["rows"]);
    const data = extractChartData(view, {});
    expect(data.categories).toEqual(["Grand Total"]);
    expect(data.series[0].values).toEqual([11732]);
    expect(data.displayValues).toEqual([["11,732"]]);
  });

  it("with row fields the grand total stays out unless asked for (unchanged)", () => {
    const view = pivotView([
      header,
      { viewRow: 1, rowType: "Data", depth: 0, visible: true, cells: [
        { cellType: "RowHeader", value: "North", backgroundStyle: "Normal" },
        { cellType: "Data", value: 5, backgroundStyle: "Normal" },
      ] },
      { viewRow: 2, rowType: "GrandTotal", depth: 0, visible: true, cells: [
        { cellType: "GrandTotalRow", value: "Grand Total", backgroundStyle: "GrandTotal" },
        { cellType: "GrandTotal", value: 5, backgroundStyle: "GrandTotal" },
      ] },
    ] as PivotViewResponse["rows"]);
    expect(extractChartData(view, {}).categories).toEqual(["North"]);
    expect(extractChartData(view, { includeGrandTotal: true }).categories).toEqual(["North", "Grand Total"]);
  });
});
