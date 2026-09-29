//! FILENAME: app/extensions/Charts/lib/__tests__/chartParamCanvasSheet.test.ts
// PURPOSE: A chart parameter bound to a cell reads -- and writes back -- that
//          cell on the sheet the CHART reads its cells from, not on the active
//          sheet (open-items 2.af, "A chart parameter bound to a cell reads the
//          active sheet").
// CONTEXT: `cellRef` / `writeTo` are unqualified single cells ("=B1"). The
//          reader resolved them against the ACTIVE sheet, which is the sheet a
//          chart is showing on -- so a chart on a CANVAS (which has no cells)
//          kept its literal default forever, and its write-back was refused
//          with a message. The rule now, the one an unqualified `=A1` title
//          already follows (dataSourceResolver `specReferenceSheet`):
//            - on a WORKSHEET, the chart's own sheet (unchanged in practice:
//              it is the sheet you are looking at);
//            - on a CANVAS, the sheet the chart's DATA comes from;
//            - on a canvas whose data has no sheet (a pivot / model query),
//              there is no cell: the default is kept and a write-back is
//              refused with a sentence that says so.
//          The scoped cell-change invalidation keys the param cell on that
//          same sheet, so an edit there repaints the canvas chart.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Sheet = { index: number; name: string; sheetId: string; kind?: "worksheet" | "canvas"; visibility: "visible" };

const h = vi.hoisted(() => ({
  sheets: [] as Sheet[],
  activeIndex: 1,
  cells: new Map<string, string>(),
  getRangeCellsTyped: vi.fn(),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellOnSheets: vi.fn(async (sheets: number[]) => sheets),
  updateCellsBatch: vi.fn(async () => []),
  alertAsync: vi.fn<(m: string, o?: unknown) => Promise<void>>(() => Promise.resolve()),
  charts: new Map<string, { chartId: string; sheetIndex: number; spec: unknown }>(),
}));

vi.mock("../chartStore", () => ({
  getChartById: (id: string) => h.charts.get(id),
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSheets: async () => ({ sheets: h.sheets, activeIndex: h.activeIndex }),
  getActiveSheet: async () => h.activeIndex,
  getRangeCellsTyped: (...a: unknown[]) => h.getRangeCellsTyped(...a),
  updateCell: (...a: unknown[]) => (h.updateCell as (...x: unknown[]) => unknown)(...a),
  updateCellOnSheets: (...a: unknown[]) => (h.updateCellOnSheets as (...x: unknown[]) => unknown)(...a),
  updateCellsBatch: (...a: unknown[]) => (h.updateCellsBatch as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => h.alertAsync(m, o) }));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({
    surface: h.sheets.find((s) => s.index === h.activeIndex)?.kind === "canvas" ? "canvas" : "grid",
    sheetContext: { activeSheetIndex: h.activeIndex, activeSheetName: "" },
  }),
}));

import { resolveParamCell } from "../dataSourceResolver";
import { resolveParams } from "../chartParams";
import { writeParamValueToCell } from "../chartParamWriteBack";
import { chartIntersectsChanges, paramCellSheetIndex } from "../chartInvalidation";
import { resetSheetIdCacheForTests } from "../sheetIdMap";
import type { ChartSpec } from "../../types";

const DATA = 0;
const CANVAS = 1;
const OTHER = 2;

function spec(data: ChartSpec["data"]): ChartSpec {
  return {
    mark: "bar",
    data,
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
  } as unknown as ChartSpec;
}

const RANGE = { sheetIndex: DATA, sheetId: "ws-data", startRow: 0, startCol: 0, endRow: 4, endCol: 1 };

/** A chart ON the canvas, charting a range of the Data sheet. */
const canvasChart = { sheetIndex: CANVAS, spec: spec(RANGE) };
/** A chart on a worksheet (the Other sheet) charting the Data sheet. */
const worksheetChart = { sheetIndex: OTHER, spec: spec(RANGE) };
/** A chart on the canvas whose data is a model query: no sheet at all. */
const modelChart = { sheetIndex: CANVAS, spec: spec({ type: "designQuery", query: "x" } as never) };

beforeEach(() => {
  resetSheetIdCacheForTests();
  h.sheets = [
    { index: DATA, name: "Data", sheetId: "ws-data", visibility: "visible" },
    { index: CANVAS, name: "Dashboard", sheetId: "cv-1", kind: "canvas", visibility: "visible" },
    { index: OTHER, name: "Other", sheetId: "ws-other", visibility: "visible" },
  ];
  h.activeIndex = CANVAS;
  h.cells = new Map([
    [`${DATA}:0:1`, "250"], // Data!B1
    [`${OTHER}:0:1`, "999"], // Other!B1
  ]);
  h.getRangeCellsTyped.mockReset();
  h.getRangeCellsTyped.mockImplementation(async (r: number, c: number, _r2: number, _c2: number, sheet?: number) => {
    const v = h.cells.get(`${sheet ?? h.activeIndex}:${r}:${c}`);
    return v === undefined ? [] : [{ row: r, col: c, display: v }];
  });
  h.updateCell.mockClear();
  h.updateCellOnSheets.mockClear();
  h.updateCellsBatch.mockClear();
  h.alertAsync.mockReset();
  h.alertAsync.mockImplementation(() => Promise.resolve());
});

describe("reading a param cell", () => {
  it("a chart on a CANVAS reads the cell on its DATA sheet", async () => {
    expect(await resolveParamCell("=B1", canvasChart), "the canvas chart kept its literal default").toBe("250");
  });

  it("a chart on a worksheet reads its OWN sheet, whichever sheet is active", async () => {
    h.activeIndex = DATA;
    expect(await resolveParamCell("=B1", worksheetChart)).toBe("999");
  });

  it("a canvas chart whose data has no sheet reads nothing (the default is kept)", async () => {
    expect(await resolveParamCell("=B1", modelChart)).toBeNull();
  });

  it("control: with no chart named, the ACTIVE sheet (the historical rule)", async () => {
    h.activeIndex = OTHER;
    expect(await resolveParamCell("=B1")).toBe("999");
  });

  it("control: a range or a sheet-qualified ref is still refused (S7c)", async () => {
    expect(await resolveParamCell("=B1:C2", canvasChart)).toBeNull();
    expect(await resolveParamCell("=Data!B1", canvasChart)).toBeNull();
  });
});

describe("the chart read resolves its params on the chart's sheet", () => {
  it("resolveParams for a PLACED chart on a canvas reads the param cell on its data sheet", async () => {
    const s = { ...spec(RANGE), params: [{ name: "Threshold", cellRef: "=B1", value: 7 }] } as ChartSpec;
    h.charts.set("c-canvas", { chartId: "c-canvas", sheetIndex: CANVAS, spec: s });
    const map = await resolveParams(s, "c-canvas");
    expect(map.get("Threshold"), "the canvas chart kept its literal default").toBe(250);
  });

  it("control: with no placed chart, the active sheet (the canvas: nothing there, the default)", async () => {
    const s = { ...spec(RANGE), params: [{ name: "Threshold", cellRef: "=B1", value: 7 }] } as ChartSpec;
    const map = await resolveParams(s);
    expect(map.get("Threshold")).toBe(7);
  });
});

describe("writing a param value back", () => {
  it("a chart on a CANVAS writes the cell on its DATA sheet (a background write)", async () => {
    const outcome = await writeParamValueToCell("=F1", "East", "drill", canvasChart);
    expect(outcome, "the canvas write-back is refused").toBe("written");
    expect(h.updateCellOnSheets).toHaveBeenCalledWith([DATA], 0, 5, "East");
    expect(h.alertAsync).not.toHaveBeenCalled();
  });

  it("a chart on the ACTIVE worksheet writes it exactly as before (updateCell)", async () => {
    h.activeIndex = OTHER;
    const outcome = await writeParamValueToCell("=F1", "East", "drill", worksheetChart);
    expect(outcome).toBe("written");
    expect(h.updateCell).toHaveBeenCalledWith(0, 5, "East");
    expect(h.updateCellOnSheets).not.toHaveBeenCalled();
  });

  it("a canvas chart whose data has no sheet refuses, and says there is no sheet", async () => {
    const outcome = await writeParamValueToCell("=F1", "East", "drill", modelChart);
    expect(outcome).toBe("refused");
    expect(h.updateCell).not.toHaveBeenCalled();
    expect(h.updateCellOnSheets).not.toHaveBeenCalled();
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    expect(h.alertAsync.mock.calls[0][0]).toMatch(/does not come from a sheet/);
  });
});

describe("the cell-change invalidation keys the param cell on the same sheet", () => {
  const withParam = (s: ChartSpec): ChartSpec => ({ ...s, params: [{ name: "T", cellRef: "=H9" }] } as ChartSpec);

  it("a canvas chart: an edit of H9 on its DATA sheet invalidates it", () => {
    const s = withParam(spec(RANGE));
    const change = [{ row: 8, col: 7, sheetIndex: DATA }];
    // Canvas active, source = Data, the param cell on the data sheet.
    expect(chartIntersectsChanges(s, change, CANVAS, DATA, DATA)).toBe(true);
    // The same cell on another sheet does not.
    expect(chartIntersectsChanges(s, [{ row: 8, col: 7, sheetIndex: OTHER }], CANVAS, DATA, DATA)).toBe(false);
  });

  it("unknown param sheet (a cold sheet cache): conservative -- any sheet's H9 counts", () => {
    const s = withParam(spec(RANGE));
    expect(chartIntersectsChanges(s, [{ row: 8, col: 7, sheetIndex: OTHER }], CANVAS, DATA, null)).toBe(true);
  });

  it("control: no param sheet given -- the active sheet, as before", () => {
    const s = withParam(spec(RANGE));
    expect(chartIntersectsChanges(s, [{ row: 8, col: 7, sheetIndex: DATA }], CANVAS, DATA)).toBe(false);
    expect(chartIntersectsChanges(s, [{ row: 8, col: 7 }], CANVAS, DATA)).toBe(true);
  });
});

describe("paramCellSheetIndex (the synchronous mirror of locateParamCell)", () => {
  it("worksheet host: the host; canvas host: the data sheet; unknown: null; no data sheet: none", () => {
    expect(paramCellSheetIndex(OTHER, false, DATA, true)).toBe(OTHER);
    expect(paramCellSheetIndex(CANVAS, true, DATA, true)).toBe(DATA);
    expect(paramCellSheetIndex(CANVAS, null, DATA, true)).toBeNull();
    expect(paramCellSheetIndex(CANVAS, true, null, true)).toBeNull();
    expect(paramCellSheetIndex(CANVAS, true, DATA, false)).toBe(-1);
  });
});
