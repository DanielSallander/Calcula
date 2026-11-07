//! FILENAME: app/extensions/Charts/lib/__tests__/chartNamedSourceAskingSheet.test.ts
// PURPOSE: A chart whose data is a DEFINED NAME asks for that name from the
//          sheet the CHART is on, never from whichever sheet is active while it
//          is read (wave-3 verifier, namescalp, MAJOR). After Copy Sheet,
//          Sheet1 and 'Sheet1 (2)' each hold a sheet-scoped Sales; a chart on
//          Sheet1 plots Sheet1's Sales. Excel's chart series is a Range, and
//          Range("Sales") from Sheet1 is Sheet1's own [LIVE, lane namescalp
//          p1.ps1]. Every chart reader used to call the resolver with no sheet,
//          so the AI's series snapshot (chartDataProvider), a raster, a SERIES
//          formula and the paint itself asked from the ACTIVE sheet and drew the
//          copy's numbers while the copy was active.
//          Driven through the REAL reader, resolver and provider: only the
//          backend doors and the chart store are doubled.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getSheets: vi.fn(),
  getNamedRange: vi.fn(),
  getRangeCellsTyped: vi.fn(),
  getChartById: vi.fn(),
}));

vi.mock("@api/lib", () => ({
  getSheets: h.getSheets,
  getRangeCellsTyped: h.getRangeCellsTyped,
  getHiddenRowsInfo: vi.fn(async () => ({ effective: [] })),
  getHiddenColsInfo: vi.fn(async () => ({ effective: [] })),
}));
vi.mock("@api", () => ({
  getSheets: h.getSheets,
  getNamedRange: h.getNamedRange,
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  columnToLetter: (i: number) => String.fromCharCode(65 + i),
  isSandboxTransformMounted: () => false,
  runSandboxTransform: vi.fn(),
  emitAppEvent: vi.fn(),
  showDialog: vi.fn(),
}));
// The ACTIVE sheet is the COPY (index 1); the chart is on Sheet1 (index 0).
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 1, activeSheetName: "Sheet1 (2)" } }),
}));
vi.mock("../chartStore", () => ({
  getChartById: h.getChartById,
  getAllCharts: () => [],
}));
vi.mock("../../handlers/selectionHandler", () => ({ getCurrentChartId: () => null }));
vi.mock("../../manifest", () => ({ CHART_DIALOG_ID: "chart:createDialog" }));

import { readChartDataResolved } from "../chartDataReader";
import { chartDataProvider } from "../chartDataProvider";
import { buildSeriesFormula } from "../seriesFormula";
import { resetSheetIdCacheForTests } from "../sheetIdMap";
import { resetCache } from "@api/objectBindings/cache";
import type { ChartDefinition, ChartSpec } from "../../types";

type Cell = { row: number; col: number; value: unknown; display: string; formula: null; type: string };
const text = (row: number, col: number, v: string): Cell => ({ row, col, value: v, display: v, formula: null, type: "text" });
const num = (row: number, col: number, v: number): Cell => ({ row, col, value: v, display: String(v), formula: null, type: "number" });

/** Sheet1's Sales (A1:B3) plots 10 and 20; the copy's plots 777 and 888. */
const BY_SHEET: Record<number, Cell[]> = {
  0: [text(0, 0, "Month"), text(0, 1, "Sales"), text(1, 0, "Jan"), num(1, 1, 10), text(2, 0, "Feb"), num(2, 1, 20)],
  1: [text(0, 0, "Month"), text(0, 1, "Sales"), text(1, 0, "Jan"), num(1, 1, 777), text(2, 0, "Feb"), num(2, 1, 888)],
};

const CHART_ID = "chart-on-sheet1";

function spec(): ChartSpec {
  const axis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
  return {
    mark: "bar",
    data: "Sales",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { ...axis },
    yAxis: { ...axis },
    legend: { visible: true, position: "bottom" },
    palette: "default",
  } as ChartSpec;
}

function chart(): ChartDefinition {
  return { chartId: CHART_ID, name: "Chart 1", sheetIndex: 0, x: 0, y: 0, width: 400, height: 300, spec: spec() };
}

beforeEach(() => {
  resetSheetIdCacheForTests();
  resetCache();
  vi.clearAllMocks();
  h.getSheets.mockImplementation(async () => ({
    sheets: [
      { index: 0, name: "Sheet1", sheetId: "id-0", visibility: "visible" },
      { index: 1, name: "Sheet1 (2)", sheetId: "id-1", visibility: "visible" },
    ],
    activeIndex: 1,
  }));
  // Range("Sales") from a sheet: that sheet's own Sales. No workbook Sales.
  h.getNamedRange.mockImplementation(async (_name: string, from?: number | null) => {
    if (from === 0) return { name: "Sales", sheetIndex: 0, refersTo: "=Sheet1!$A$1:$B$3" };
    if (from === 1) return { name: "Sales", sheetIndex: 1, refersTo: "='Sheet1 (2)'!$A$1:$B$3" };
    return { name: "Sales", sheetIndex: 0, refersTo: "=Sheet1!$A$1:$B$3" };
  });
  h.getRangeCellsTyped.mockImplementation(
    async (sr: number, sc: number, er: number, ec: number, sheetIndex?: number) =>
      (BY_SHEET[sheetIndex ?? -1] ?? []).filter((c) => c.row >= sr && c.row <= er && c.col >= sc && c.col <= ec),
  );
  h.getChartById.mockImplementation((id: string) => (id === CHART_ID ? chart() : null));
});

describe("a chart's named data source is asked from the CHART'S sheet", () => {
  it("the paint reads Sheet1's Sales while the copy is active", async () => {
    const out = await readChartDataResolved(spec(), 0, CHART_ID);
    expect(out.data.series[0].values).toEqual([10, 20]);
    expect(h.getNamedRange).toHaveBeenCalledWith("Sales", 0);
    expect(h.getNamedRange).not.toHaveBeenCalledWith("Sales", 1);
  });

  it("the AI's series snapshot (chartDataProvider) reports Sheet1's numbers, typed re-read included", async () => {
    const snap = await chartDataProvider.resolveSeries(CHART_ID, 1000);
    expect(snap).not.toBeNull();
    expect(snap!.series[0].values).toEqual([10, 20]);
    for (const call of h.getRangeCellsTyped.mock.calls) expect(call[4]).toBe(0);
  });

  it("the SERIES formula names Sheet1's cells when given the chart's sheet", async () => {
    const formula = await buildSeriesFormula(spec(), 0, "Sheet1", chart().sheetIndex);
    expect(formula).toContain("$B$2:$B$3");
    expect(h.getNamedRange).toHaveBeenCalledWith("Sales", 0);
    expect(h.getNamedRange).not.toHaveBeenCalledWith("Sales", 1);
  });

  it("a preview with no placed chart still asks from the active sheet", async () => {
    const out = await readChartDataResolved(spec());
    expect(out.data.series[0].values).toEqual([777, 888]);
  });
});
