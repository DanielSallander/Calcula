//! FILENAME: app/extensions/Charts/lib/__tests__/chartStorePersistFailure.test.ts
// PURPOSE: CI-15 — a chart write the backend REFUSES must not be kept in memory.
//          Every write out of chartStore used to end in `.catch(() => {})`: the
//          in-memory chart kept the edit, the canvas painted it, nothing was
//          shown, and on reload the work was gone. The live trigger is sheet
//          protection's `editObjects` gate (app/src-tauri/src/chart_commands.rs),
//          which refuses save_chart / update_chart / delete_chart alike.
//
//          The contract proved here, for each of the three paths:
//            (i)  EXACTLY ONE user-visible message per batch, naming the chart;
//            (ii) the in-memory spec rolled back to the last persisted value.
//
// THE DIALOG DOUBLE RETURNS A PROMISE. CLAUDE.md records a synchronous boolean
// double as the thing that let the broken-guard defect pass review six times, so
// `alertAsync` is mocked as `() => Promise<void>` and one test proves the store
// genuinely AWAITS it (the flush does not resolve while the box is up).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const alertAsync = vi.fn<(message: string, options?: unknown) => Promise<void>>(
  () => Promise.resolve(),
);
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => alertAsync(m, o) }));

import {
  createChart,
  deleteChart,
  getAllCharts,
  getChartById,
  canUndoDeleteChart,
  loadChartsFromBackend,
  updateChartSpec,
  moveChart,
  flushPendingChartSaves,
  resetChartStore,
} from "../chartStore";
import { chartsBackend } from "../chartsBackend";
import type { ChartSpec } from "../../types";

const invokeBackend = vi.fn();

const baseSpec: ChartSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: "Persisted",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
} as unknown as ChartSpec;

/** The shape `get_charts` returns. */
const entry = (chartId: string, name: string, spec: unknown = baseSpec) => ({
  id: chartId,
  sheetIndex: 0,
  specJson: JSON.stringify({
    chartId,
    name,
    sheetIndex: 0,
    x: 10,
    y: 20,
    width: 400,
    height: 300,
    spec,
  }),
});

/** What the Rust gate actually says when `editObjects` is off. */
const PROTECTED = "Sheet is protected: edit objects is not allowed";

/** Resolve after every pending microtask AND the macrotask queue. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  resetChartStore();
  invokeBackend.mockReset();
  alertAsync.mockReset();
  alertAsync.mockImplementation(() => Promise.resolve());
  chartsBackend.set(invokeBackend);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

/** Load two charts so the store has a confirmed-persisted baseline. */
async function loadTwo(): Promise<void> {
  invokeBackend.mockResolvedValueOnce([entry("c1", "Revenue by Region"), entry("c2", "Units Sold")]);
  await loadChartsFromBackend();
  invokeBackend.mockReset();
}

// ===========================================================================
// 1. THE UPDATE PATH — flushDirtyCharts
// ===========================================================================

describe("CI-15 update path: a refused update_chart is rolled back and reported", () => {
  it("reverts the spec to the last persisted value and tells the user once", async () => {
    await loadTwo();
    invokeBackend.mockRejectedValue(PROTECTED);

    updateChartSpec("c1", { title: "Edited in memory" } as Partial<ChartSpec>);
    expect(getChartById("c1")?.spec.title).toBe("Edited in memory");

    await flushPendingChartSaves();

    // (ii) rolled back
    expect(getChartById("c1")?.spec.title).toBe("Persisted");
    // (i) exactly one message, naming the chart and the reason
    expect(alertAsync).toHaveBeenCalledTimes(1);
    const message = alertAsync.mock.calls[0][0];
    expect(message).toContain("Revenue by Region");
    expect(message).toContain(PROTECTED);
    expect(message).toContain("last saved version");
    // ...and logged for debugging, with the id
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain("c1");
  });

  it("names WHAT was lost rather than reverting in silence", async () => {
    await loadTwo();
    invokeBackend.mockRejectedValue(PROTECTED);

    moveChart("c1", 500, 600);
    updateChartSpec("c1", { title: "New title" } as Partial<ChartSpec>);
    await flushPendingChartSaves();

    const message = alertAsync.mock.calls[0][0];
    expect(message).toContain("position");
    expect(message).toContain("chart settings");
    // And the geometry really did go back.
    expect(getChartById("c1")?.x).toBe(10);
    expect(getChartById("c1")?.y).toBe(20);
  });

  it("two charts refused in ONE flush produce ONE message listing both", async () => {
    await loadTwo();
    invokeBackend.mockRejectedValue(PROTECTED);

    updateChartSpec("c1", { title: "A" } as Partial<ChartSpec>);
    updateChartSpec("c2", { title: "B" } as Partial<ChartSpec>);
    await flushPendingChartSaves();

    expect(alertAsync).toHaveBeenCalledTimes(1);
    const message = alertAsync.mock.calls[0][0];
    expect(message).toContain("Revenue by Region");
    expect(message).toContain("Units Sold");
    expect(message).toContain("2 chart changes");
    expect(getChartById("c1")?.spec.title).toBe("Persisted");
    expect(getChartById("c2")?.spec.title).toBe("Persisted");
  });

  it("a SUCCESSFUL update keeps the edit and shows nothing (positive control)", async () => {
    await loadTwo();
    invokeBackend.mockResolvedValue(undefined);

    updateChartSpec("c1", { title: "Kept" } as Partial<ChartSpec>);
    await flushPendingChartSaves();

    expect(getChartById("c1")?.spec.title).toBe("Kept");
    expect(alertAsync).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("the store AWAITS the dialog — a Promise double, never a synchronous boolean", async () => {
    await loadTwo();
    invokeBackend.mockRejectedValue(PROTECTED);

    let releaseDialog!: () => void;
    alertAsync.mockImplementation(
      () => new Promise<void>((resolve) => { releaseDialog = resolve; }),
    );

    updateChartSpec("c1", { title: "X" } as Partial<ChartSpec>);
    let flushed = false;
    const pending = flushPendingChartSaves().then(() => { flushed = true; });

    await settle();
    expect(alertAsync).toHaveBeenCalledTimes(1);
    // Still open: the store did not run on past a message the user has not read.
    expect(flushed).toBe(false);

    releaseDialog();
    await pending;
    expect(flushed).toBe(true);
  });
});

// ===========================================================================
// 2. THE CREATE PATH — save_chart
// ===========================================================================

describe("CI-15 create path: a refused save_chart removes the phantom chart", () => {
  it("takes the never-persisted chart back out of the store and reports it", async () => {
    invokeBackend.mockRejectedValue(PROTECTED);

    const chart = createChart(structuredClone(baseSpec), {
      sheetIndex: 0,
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      name: "Protected Chart",
    });
    // Synchronously it is there (the API is synchronous by contract)...
    expect(getChartById(chart.chartId)).not.toBeNull();

    await settle();

    // (ii) ...and once the backend refuses, it is gone rather than painted.
    expect(getChartById(chart.chartId)).toBeNull();
    expect(getAllCharts()).toHaveLength(0);
    // (i) exactly one message, naming the chart
    expect(alertAsync).toHaveBeenCalledTimes(1);
    const message = alertAsync.mock.calls[0][0];
    expect(message).toContain("Protected Chart");
    expect(message).toContain("removed from the sheet");
    expect(message).toContain(PROTECTED);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("a SUCCESSFUL create keeps the chart and shows nothing (positive control)", async () => {
    invokeBackend.mockResolvedValue(undefined);

    const chart = createChart(structuredClone(baseSpec), {
      sheetIndex: 0,
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      name: "Fine",
    });
    await settle();

    expect(getChartById(chart.chartId)).not.toBeNull();
    expect(alertAsync).not.toHaveBeenCalled();
  });

  it("a created-then-edited chart whose CREATE was refused does not double-report", async () => {
    invokeBackend.mockRejectedValue(PROTECTED);
    const chart = createChart(structuredClone(baseSpec), {
      sheetIndex: 0, x: 0, y: 0, width: 400, height: 300, name: "Doomed",
    });
    updateChartSpec(chart.chartId, { title: "Edited" } as Partial<ChartSpec>);

    await settle();
    await flushPendingChartSaves();

    // The create failure removed it, so the flush finds nothing to push.
    expect(getAllCharts()).toHaveLength(0);
    expect(alertAsync).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3. THE DELETE PATH — delete_chart
// ===========================================================================

describe("CI-15 delete path: a refused delete_chart puts the chart back", () => {
  it("restores the chart, clears the phantom undo entry, and reports once", async () => {
    await loadTwo();
    invokeBackend.mockRejectedValue(PROTECTED);

    deleteChart("c1");
    expect(getChartById("c1")).toBeNull();

    await settle();

    // (ii) the backend still HAS it, so the store must too — in its old slot.
    expect(getChartById("c1")).not.toBeNull();
    expect(getAllCharts().map((c) => c.chartId)).toEqual(["c1", "c2"]);
    expect(getChartById("c1")?.spec.title).toBe("Persisted");
    // Undo must not offer to restore a chart that was never removed.
    expect(canUndoDeleteChart()).toBe(false);
    // (i) one message, naming the chart
    expect(alertAsync).toHaveBeenCalledTimes(1);
    const message = alertAsync.mock.calls[0][0];
    expect(message).toContain("Revenue by Region");
    expect(message).toContain("put back");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("a SUCCESSFUL delete removes the chart and shows nothing (positive control)", async () => {
    await loadTwo();
    invokeBackend.mockResolvedValue(undefined);

    deleteChart("c1");
    await settle();

    expect(getChartById("c1")).toBeNull();
    expect(canUndoDeleteChart()).toBe(true);
    expect(alertAsync).not.toHaveBeenCalled();
  });
});
