//! FILENAME: app/extensions/Charts/lib/__tests__/chartDataReaderSourceSheet.test.ts
// PURPOSE: M4 (canvas sheets) -- the chart reader reads the data's OWN sheet.
//          Every read used to go through getViewportCells, which has no sheet
//          argument, so a chart placed on a canvas read the canvas's (empty)
//          grid. Now every read is `getRangeCellsTyped(..., sheetIndex)` with
//          the RESOLVED index (sheet id first). Pinned:
//            - a chart placed on sheet 2 (the active canvas) sourced from sheet
//              0's id reads sheet 0, and parses the same display strings the
//              old read did;
//            - a moved source sheet is followed by id;
//            - a deleted source sheet is an error, and nothing is read;
//            - a range over the backend's 100,000-cell cap is read in bands;
//            - series auto-detection and lookup tables read their own sheet.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getSheets: vi.fn(),
  getRangeCellsTyped: vi.fn(),
}));

vi.mock("@api/lib", () => ({
  getSheets: h.getSheets,
  getRangeCellsTyped: h.getRangeCellsTyped,
}));
vi.mock("@api", () => ({
  getSheets: h.getSheets,
  getNamedRange: vi.fn(async () => null),
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  isSandboxTransformMounted: () => false,
  runSandboxTransform: vi.fn(),
}));
// The ACTIVE sheet is the canvas (index 2) the chart sits on.
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 2, activeSheetName: "Page" } }),
}));

import {
  readChartDataResolved,
  readRangeDisplayGrid,
  autoDetectSeries,
  TYPED_RANGE_READ_CAP,
} from "../chartDataReader";
import { SOURCE_SHEET_MISSING_MESSAGE } from "../dataSourceResolver";
import { resetSheetIdCacheForTests } from "../sheetIdMap";
import type { ChartSpec, DataRangeRef } from "../../types";

type Cell = { row: number; col: number; value: unknown; display: string; formula: null; type: string };
const cell = (row: number, col: number, display: string): Cell => ({
  row,
  col,
  value: display,
  display,
  formula: null,
  type: "text",
});

/** Sheet 0 holds the data; sheets 1 and 2 (the canvas) hold nothing. */
const SHEET0: Cell[] = [
  cell(0, 0, "Month"), cell(0, 1, "Sales"),
  cell(1, 0, "Jan"), cell(1, 1, "10"),
  cell(2, 0, "Feb"), cell(2, 1, "1,234"),
  // row 3 absent: the typed read is SPARSE
];

function sheetsAre(list: Array<{ index: number; name: string; sheetId: string; kind?: string }>): void {
  h.getSheets.mockImplementation(async () => ({
    sheets: list.map((s) => ({ visibility: "visible", ...s })),
    activeIndex: 2,
  }));
}

const baseAxis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
function spec(data: DataRangeRef, over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data,
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { ...baseAxis },
    yAxis: { ...baseAxis },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

beforeEach(() => {
  resetSheetIdCacheForTests();
  h.getSheets.mockReset();
  h.getRangeCellsTyped.mockReset();
  sheetsAre([
    { index: 0, name: "Sheet1", sheetId: "id-0" },
    { index: 1, name: "Sheet2", sheetId: "id-1" },
    { index: 2, name: "Page", sheetId: "id-2", kind: "canvas" },
  ]);
  // Serve cells by SHEET, so a read of the wrong sheet comes back empty.
  h.getRangeCellsTyped.mockImplementation(
    async (sr: number, sc: number, er: number, ec: number, sheetIndex?: number) =>
      sheetIndex === 0
        ? SHEET0.filter((c) => c.row >= sr && c.row <= er && c.col >= sc && c.col <= ec)
        : [],
  );
});

describe("a chart on canvas sheet 2 whose data is on sheet 0", () => {
  const data: DataRangeRef = { sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 3, endCol: 1 };

  it("reads sheet 0 through getRangeCellsTyped -- never the active canvas", async () => {
    const out = await readChartDataResolved(spec(data));
    expect(h.getRangeCellsTyped).toHaveBeenCalledWith(0, 0, 3, 1, 0);
    for (const call of h.getRangeCellsTyped.mock.calls) {
      expect(call[4]).toBe(0);
    }
    // The same display strings the old read parsed: "1,234" -> 1234, and the
    // sparse row 3 is "" -> a "Row 4" category with value 0, as before.
    expect(out.data.categories).toEqual(["Jan", "Feb", "Row 4"]);
    expect(out.data.series[0].values).toEqual([10, 1234, 0]);
  });

  it("follows the sheet by id after it moved (stored index 0, live index 1)", async () => {
    sheetsAre([
      { index: 0, name: "Sheet2", sheetId: "id-1" },
      { index: 1, name: "Sheet1", sheetId: "id-0" },
      { index: 2, name: "Page", sheetId: "id-2", kind: "canvas" },
    ]);
    await readChartDataResolved(spec(data)).catch(() => undefined);
    expect(h.getRangeCellsTyped).toHaveBeenCalledWith(0, 0, 3, 1, 1);
  });

  it("refuses with 'source sheet no longer exists' when that sheet was deleted, reading nothing", async () => {
    sheetsAre([
      { index: 0, name: "Sheet2", sheetId: "id-1" },
      { index: 1, name: "Page", sheetId: "id-2", kind: "canvas" },
    ]);
    await expect(readChartDataResolved(spec(data))).rejects.toThrow(SOURCE_SHEET_MISSING_MESSAGE);
    expect(h.getRangeCellsTyped).not.toHaveBeenCalled();
  });

  it("an unqualified =A1 title reads the DATA sheet, not the canvas", async () => {
    const out = await readChartDataResolved(spec(data, { title: "=B1" }));
    expect(out.spec.title).toBe("Sales");
    expect(h.getRangeCellsTyped).toHaveBeenCalledWith(0, 1, 0, 1, 0);
  });
});

describe("a worksheet chart with no sheet id (legacy / script-written index)", () => {
  it("reads the sheet its index names", async () => {
    const data: DataRangeRef = { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 2, endCol: 1 };
    const out = await readChartDataResolved(spec(data));
    expect(h.getRangeCellsTyped).toHaveBeenCalledWith(0, 0, 2, 1, 0);
    expect(out.data.series[0].values).toEqual([10, 1234]);
    expect(h.getSheets).not.toHaveBeenCalled();
  });
});

describe("readRangeDisplayGrid beyond the 100,000-cell cap", () => {
  it("reads in bands of at most the cap, all from the range's own sheet", async () => {
    h.getRangeCellsTyped.mockImplementation(async () => []);
    const big: DataRangeRef = { sheetIndex: 1, startRow: 0, startCol: 0, endRow: 249_999, endCol: 1 };
    const grid = await readRangeDisplayGrid(big);
    expect(grid.length).toBe(250_000);
    const calls = h.getRangeCellsTyped.mock.calls as Array<[number, number, number, number, number]>;
    expect(calls.length).toBe(5);
    let covered = 0;
    for (const [sr, sc, er, ec, sheet] of calls) {
      const cells = (er - sr + 1) * (ec - sc + 1);
      expect(cells).toBeLessThanOrEqual(TYPED_RANGE_READ_CAP);
      expect(sheet).toBe(1);
      covered += cells;
    }
    expect(covered).toBe(500_000);
  });

  it("places sparse cells from every band at their own coordinates", async () => {
    h.getRangeCellsTyped.mockImplementation(async (sr: number, sc: number, er: number) =>
      [cell(sr, sc, `r${sr}`), cell(er, sc, `r${er}`)],
    );
    const tall: DataRangeRef = { sheetIndex: 0, startRow: 10, startCol: 3, endRow: 10 + 149_999, endCol: 3 };
    const grid = await readRangeDisplayGrid(tall);
    expect(grid[0][0]).toBe("r10");
    expect(grid[99_999][0]).toBe(`r${10 + 99_999}`);
    expect(grid[100_000][0]).toBe(`r${10 + 100_000}`);
    expect(grid[149_999][0]).toBe(`r${10 + 149_999}`);
  });
});

describe("the other reads go to the source sheet too", () => {
  it("autoDetectSeries reads the id-resolved sheet", async () => {
    const detected = await autoDetectSeries(
      { sheetIndex: 5, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 2, endCol: 1 },
      true,
    );
    expect(h.getRangeCellsTyped).toHaveBeenCalledWith(0, 0, 2, 1, 0);
    expect(detected.series.map((s) => s.name)).toEqual(["Sales"]);
  });

  it("a lookup table is read from ITS sheet, once", async () => {
    const data: DataRangeRef = { sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 2, endCol: 1 };
    const lookupFrom: DataRangeRef = { sheetIndex: 9, sheetId: "id-1", startRow: 0, startCol: 0, endRow: 2, endCol: 1 };
    await readChartDataResolved(
      spec(data, { transform: [{ type: "lookup", from: lookupFrom, fields: ["Target"] }] }),
    );
    const lookupCalls = h.getRangeCellsTyped.mock.calls.filter((c) => c[4] === 1);
    expect(lookupCalls.length).toBe(1);
  });
});
