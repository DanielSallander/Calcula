//! FILENAME: app/extensions/Charts/rendering/__tests__/chartRenderReloadWindow.test.ts
// PURPOSE: A chart render that RACED a reload of the chart store is not
//          reported as a broken chart (journey cascade-announcement-live
//          "a chart on a deleted SHEET takes its contextual tab with it").
// CONTEXT: Deleting a sheet deletes the charts on it in the backend at once,
//          but the chart store only learns of it when its reload lands. The
//          same announcement fans out to table definitions (and pivots,
//          slicers ...), whose handlers invalidate every chart and repaint --
//          so the chart that is being deleted is RENDERED from the stale
//          store. Its range is pinned to its sheet by id (canvas sheets, M4),
//          the sheet is gone, and the read throws "the chart's source sheet no
//          longer exists". That was logged as "[Charts] Failed to render chart"
//          and painted as an error card, for a chart the user had just deleted
//          on purpose. Measured live: invalidate at +4 ms, render at +5 ms,
//          the failure at +115 ms, the store reload dropping the chart at
//          +130 ms.
//
//          Driven through the real `renderChart` (the overlay entry point) and
//          the real chart store; only the data reader is doubled, so the test
//          controls WHEN the read fails relative to the store.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock("../../lib/chartDataReader", () => ({
  readChartDataResolved: (...args: unknown[]) => h.read(...args),
}));

import { renderChart, invalidateAllChartCaches } from "../chartRenderer";
import {
  beginChartStoreReload,
  getChartById,
  loadChartsFromBackend,
  resetChartStore,
  setActiveSheetIndex,
} from "../../lib/chartStore";
import { chartsBackend } from "../../lib/chartsBackend";
import { SourceSheetMissingError } from "../../lib/dataSourceResolver";
import type { OverlayRenderContext, GridRegion } from "@api/gridOverlays";
import { makeRecordingCtx } from "./dispatch-recordingCtx";

const CHART_ID = "c-on-sheet-2";

/** A chart PLACED on sheet 1 whose data is on sheet 1 too (stamped: no migration). */
function entry() {
  return {
    id: CHART_ID,
    sheetIndex: 1,
    specJson: JSON.stringify({
      chartId: CHART_ID,
      name: "CascadeOrphanChart",
      sheetIndex: 1,
      x: 400,
      y: 40,
      width: 480,
      height: 300,
      spec: {
        mark: "bar",
        data: { sheetIndex: 1, sheetId: "sheet-2-id", startRow: 0, startCol: 25, endRow: 2, endCol: 26 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Value", color: "#4472C4" }],
        title: "CascadeOrphanChart",
      },
    }),
  };
}

function overlayCtx(): OverlayRenderContext {
  const region: GridRegion = {
    id: `chart-${CHART_ID}`,
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 400, y: 40, width: 480, height: 300 },
    data: { chartId: CHART_ID, name: "CascadeOrphanChart" },
  };
  return {
    ctx: makeRecordingCtx(1600, 900).ctx,
    region,
    config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: {},
    canvasWidth: 1600,
    canvasHeight: 900,
  } as unknown as OverlayRenderContext;
}

/** A read the test fails on cue. */
function deferredRead(): { fail: (err: unknown) => Promise<void> } {
  let reject!: (err: unknown) => void;
  h.read.mockImplementationOnce(
    () =>
      new Promise((_resolve, rej) => {
        reject = rej;
      }),
  );
  return {
    fail: async (err: unknown) => {
      reject(err);
      // Let renderChartAsync's catch/finally run.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

const failedRenderLogs = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("[Charts] Failed to render chart"));

let errorSpy: ReturnType<typeof vi.spyOn>;
let backendCharts: Array<ReturnType<typeof entry>> = [];

beforeEach(async () => {
  resetChartStore();
  invalidateAllChartCaches();
  h.read.mockReset();
  backendCharts = [entry()];
  chartsBackend.set(async (cmd: string) => (cmd === "get_charts" ? backendCharts : undefined));
  await loadChartsFromBackend();
  setActiveSheetIndex(1);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  resetChartStore();
  invalidateAllChartCaches();
});

describe("a render that fails while the chart store is behind the backend", () => {
  it("POSITIVE CONTROL: with the store current, a failed read IS reported", async () => {
    const read = deferredRead();
    renderChart(overlayCtx());
    expect(h.read).toHaveBeenCalledTimes(1);
    await read.fail(new SourceSheetMissingError("sheet-2-id"));
    expect(failedRenderLogs(errorSpy)).toHaveLength(1);
  });

  it("is dropped quietly while a store reload is pending (the sheet-delete window)", async () => {
    const read = deferredRead();
    renderChart(overlayCtx());
    expect(h.read).toHaveBeenCalledTimes(1);
    // The sheet delete lands: the reload is requested, not yet run.
    const finished = beginChartStoreReload();
    await read.fail(new SourceSheetMissingError("sheet-2-id"));
    expect(failedRenderLogs(errorSpy)).toEqual([]);
    finished();
  });

  it("is dropped quietly when the reload has already replaced the chart (it went with its sheet)", async () => {
    const read = deferredRead();
    renderChart(overlayCtx());
    expect(h.read).toHaveBeenCalledTimes(1);
    // The reload completes BEFORE the stale read fails: the chart is gone.
    backendCharts = [];
    await loadChartsFromBackend();
    expect(getChartById(CHART_ID)).toBeNull();
    await read.fail(new SourceSheetMissingError("sheet-2-id"));
    expect(failedRenderLogs(errorSpy)).toEqual([]);
  });

  it("a chart the reload KEPT but whose data sheet is gone is reported by the fresh render", async () => {
    const stale = deferredRead();
    renderChart(overlayCtx());
    const finished = beginChartStoreReload();
    await stale.fail(new SourceSheetMissingError("sheet-2-id"));
    expect(failedRenderLogs(errorSpy)).toEqual([]);
    // The reload lands and keeps the chart (its data sheet was the one deleted);
    // it repaints, and that render -- from the current store -- fails and says so.
    await loadChartsFromBackend();
    finished();
    invalidateAllChartCaches();
    const fresh = deferredRead();
    renderChart(overlayCtx());
    expect(h.read).toHaveBeenCalledTimes(2);
    await fresh.fail(new SourceSheetMissingError("sheet-2-id"));
    expect(failedRenderLogs(errorSpy)).toHaveLength(1);
  });
});
