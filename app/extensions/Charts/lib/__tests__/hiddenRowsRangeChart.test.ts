//! FILENAME: app/extensions/Charts/lib/__tests__/hiddenRowsRangeChart.test.ts
// PURPOSE: A range chart leaves its source's HIDDEN rows out (Excel's default,
//          "Show data in hidden rows and columns" off), so an AutoFilter -- and
//          a table slicer, which filters through one -- filters a Card and a
//          bar chart on the same page; `plotHiddenCells` puts them back. And
//          the watch re-reads exactly the charts whose hidden rows moved
//          (canvas-review visuals finding "range visuals ignore table slicers").

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

import { readChartDataResolved, withoutHiddenLines, hiddenLinesInRange } from "../chartDataReader";
import {
  changedHiddenLines,
  installHiddenLinesWatch,
  rememberHiddenSignature,
  resetHiddenLinesWatch,
  HIDDEN_LINES_CHECK_DELAY_MS,
} from "../hiddenLinesWatch";
import { aggregateSeries } from "../../rendering/visuals/visualValues";
import type { ChartSpec } from "../../types";

const num = (row: number, col: number, v: number) => ({ row, col, value: v, display: String(v), formula: null, type: "number" });
const txt = (row: number, col: number, t: string) => ({ row, col, value: t, display: t, formula: null, type: "text" });

/** Region | Sales on rows 2..5 of the sheet (header on row 1). */
const TABLE = [
  txt(1, 0, "Region"), txt(1, 1, "Sales"),
  txt(2, 0, "East"), num(2, 1, 10),
  txt(3, 0, "West"), num(3, 1, 20),
  txt(4, 0, "North"), num(4, 1, 30),
  txt(5, 0, "South"), num(5, 1, 40),
];

const axis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "card",
    data: { sheetIndex: 0, startRow: 1, startCol: 0, endRow: 5, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: axis,
    yAxis: axis,
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

beforeEach(() => {
  resetHiddenLinesWatch();
  h.getRangeCellsTyped.mockReset();
  h.getRangeCellsTyped.mockResolvedValue(TABLE);
  h.getHiddenRowsInfo.mockReset();
  h.getHiddenColsInfo.mockReset();
  h.getHiddenColsInfo.mockResolvedValue({ user: [], effective: [] });
});

describe("range reader: hidden rows", () => {
  it("rows a table slicer / AutoFilter hid are left out of the chart and the Card", async () => {
    // A table slicer keeping East and South hides sheet rows 3 and 4.
    h.getHiddenRowsInfo.mockResolvedValue({ user: [], effective: [3, 4] });
    const { data } = await readChartDataResolved(spec(), 0, "card-1");
    expect(data.categories).toEqual(["East", "South"]);
    expect(data.series[0].values).toEqual([10, 40]);
    expect(aggregateSeries(data, 0, "auto").value).toBe(50);
    expect(h.getHiddenRowsInfo).toHaveBeenCalledWith(0);
  });

  it("plotHiddenCells: true charts them anyway (and does not even ask)", async () => {
    h.getHiddenRowsInfo.mockResolvedValue({ user: [], effective: [3, 4] });
    const { data } = await readChartDataResolved(spec({ plotHiddenCells: true }));
    expect(data.categories).toEqual(["East", "West", "North", "South"]);
    expect(h.getHiddenRowsInfo).not.toHaveBeenCalled();
  });

  it("a hidden HEADER row still names the series", async () => {
    h.getHiddenRowsInfo.mockResolvedValue({ user: [1], effective: [1, 2] });
    const { data } = await readChartDataResolved(spec());
    expect(data.series[0].name).toBe("Sales");
    expect(data.categories).toEqual(["West", "North", "South"]);
  });

  it("a failed visibility read charts every row instead of failing", async () => {
    h.getHiddenRowsInfo.mockRejectedValue(new Error("no backend"));
    const { data } = await readChartDataResolved(spec());
    expect(data.categories).toHaveLength(4);
  });

  it("rows orientation drops hidden category COLUMNS, keeping the header column", () => {
    const grid = {
      display: [["Sales", "Q1", "Q2", "Q3"], ["", "1", "2", "3"]],
      numbers: [[undefined, undefined, undefined, undefined], [null, 1, 2, 3]],
    };
    const out = withoutHiddenLines(grid, { rows: new Set(), cols: new Set([0, 2]) }, "rows", true);
    expect(out.display).toEqual([["Sales", "Q1", "Q3"], ["", "1", "3"]]);
    expect(out.numbers[1]).toEqual([null, 1, 3]);
  });

  it("hiddenLinesInRange turns sheet rows into range offsets, ignoring rows outside", () => {
    const lines = hiddenLinesInRange({ startRow: 10, endRow: 12, startCol: 0, endCol: 1 }, [3, 11, 99], [1]);
    expect([...lines.rows]).toEqual([1]);
    expect([...lines.cols]).toEqual([1]);
  });
});

describe("hiddenLinesWatch", () => {
  const ref = { sheetIndex: 0, startRow: 1, endRow: 5, startCol: 0, endCol: 1 };

  it("reports a chart once when its hidden rows move, and not again for the same answer", async () => {
    rememberHiddenSignature("c1", ref, { rows: new Set([2]), cols: new Set() });
    const source = { rows: vi.fn(async () => [3, 4]), cols: vi.fn(async () => []) };
    expect(await changedHiddenLines(source)).toEqual(["c1"]);
    expect(await changedHiddenLines(source)).toEqual([]);
  });

  it("asks each sheet ONCE however many charts read it, and ignores rows outside a range", async () => {
    rememberHiddenSignature("c1", ref, { rows: new Set(), cols: new Set() });
    rememberHiddenSignature("c2", { ...ref, startRow: 50, endRow: 60 }, { rows: new Set(), cols: new Set() });
    const source = { rows: vi.fn(async () => [3]), cols: vi.fn(async () => []) };
    expect(await changedHiddenLines(source)).toEqual(["c1"]);
    expect(source.rows).toHaveBeenCalledTimes(1);
  });

  describe("installed", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("a burst of repaint requests is one check, and a moved row re-reads that chart", async () => {
      rememberHiddenSignature("c1", ref, { rows: new Set(), cols: new Set() });
      const source = { rows: vi.fn(async () => [3]), cols: vi.fn(async () => []) };
      const onChanged = vi.fn();
      const off = installHiddenLinesWatch(onChanged, source);
      for (let i = 0; i < 5; i++) window.dispatchEvent(new CustomEvent("app:grid-refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
      await vi.advanceTimersByTimeAsync(HIDDEN_LINES_CHECK_DELAY_MS + 5);
      expect(source.rows).toHaveBeenCalledTimes(1);
      expect(onChanged).toHaveBeenCalledWith(["c1"]);
      off();
      window.dispatchEvent(new CustomEvent("app:grid-refresh"));
      await vi.advanceTimersByTimeAsync(HIDDEN_LINES_CHECK_DELAY_MS + 5);
      expect(source.rows).toHaveBeenCalledTimes(1);
    });
  });
});
