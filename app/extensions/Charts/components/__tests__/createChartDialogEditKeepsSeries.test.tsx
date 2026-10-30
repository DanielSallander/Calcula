//! FILENAME: app/extensions/Charts/components/__tests__/createChartDialogEditKeepsSeries.test.tsx
// PURPOSE: BUG-0481 -- Edit Chart (the dialog opened with `editChartId`, e.g.
//          the context menu's "Select Data...") keeps the chart's STORED series
//          and category. Opening it used to re-run series detection over the
//          stored range (the open effect seeds the range field, and the range
//          binding changing ran the detection effect), so a series the reader
//          had unchecked came back checked and "Update Chart" wrote it.
//          Detection still runs when the READER changes the range, the header
//          row or the orientation.
// CONTEXT: The same harness as createChartDialogPreset.test.tsx (the real
//          dialog and the real range-source hook, the DataTab stubbed so the
//          test reads what the dialog hands it).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface StubDataTabProps {
  sourceRange: string;
  onSourceRangeChange: (v: string) => void;
  hasHeaders: boolean;
  onHasHeadersChange: (v: boolean) => void;
  orientation: "columns" | "rows";
  onOrientationChange: (v: "columns" | "rows") => void;
  categoryIndex: number;
  series: Array<{ name: string; sourceIndex: number; color: string | null }>;
}

const SALES = { name: "Sales", sourceIndex: 1, color: null };
const COST = { name: "Cost", sourceIndex: 2, color: null };

const h = vi.hoisted(() => ({
  gridState: {
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } as unknown,
    surface: "grid" as "grid" | "canvas",
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" } as unknown,
  },
  dataTabProps: null as null | StubDataTabProps,
  charts: new Map<string, unknown>(),
  replaceChartSpec: vi.fn(),
  createChart: vi.fn((..._args: unknown[]) => ({ chartId: "new", name: "Chart 1" })),
  autoDetectPivotSeries: vi.fn(async (..._args: unknown[]) => ({
    series: [
      { name: "Sum of Sales", sourceIndex: 0, color: null },
      { name: "Sum of Cost", sourceIndex: 1, color: null },
    ],
    title: "PivotTable1",
  })),
  autoDetectSeries: vi.fn(async (..._args: unknown[]) => ({
    categoryIndex: 0,
    series: [
      { name: "Sales", sourceIndex: 1, color: null },
      { name: "Cost", sourceIndex: 2, color: null },
    ],
  })),
}));

vi.mock("@api", () => ({
  detectDataRegion: vi.fn(async () => null),
  useGridState: () => h.gridState,
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  getSheets: vi.fn(async () => ({
    sheets: [
      { index: 0, name: "Sheet1", sheetId: "id-0", visibility: "visible" },
      { index: 1, name: "Sheet2", sheetId: "id-1", visibility: "visible" },
    ],
    activeIndex: 0,
  })),
}));
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn(), AppEvents: { GRID_REFRESH: "grid:refresh" } }));
vi.mock("../../lib/chartsBackend", () => ({ chartsBackend: { invoke: vi.fn(async () => []) } }));
vi.mock("../../lib/chartStore", () => ({
  createChart: (...args: unknown[]) => h.createChart(...args),
  getChartById: (id: string) => h.charts.get(id) ?? null,
  replaceChartSpec: (...args: unknown[]) => h.replaceChartSpec(...args),
  syncChartRegions: vi.fn(),
}));
vi.mock("../../rendering/chartRenderer", () => ({ invalidateChartCache: vi.fn() }));
vi.mock("../../lib/chartDataReader", () => ({
  autoDetectSeries: (...args: unknown[]) => h.autoDetectSeries(...args),
  readChartDataResolved: vi.fn(async (spec: unknown) => ({
    spec,
    data: { categories: ["x"], series: [{ name: "S", values: [1], color: null }] },
    diagnostics: [],
  })),
}));
vi.mock("../../lib/dataSourceResolver", () => ({ resolveDataSource: vi.fn() }));
vi.mock("../../lib/pivotChartDataReader", () => ({
  autoDetectPivotSeries: (...args: unknown[]) => h.autoDetectPivotSeries(...args),
}));
vi.mock("../../lib/chartSpecDefaults", () => ({ buildDefaultSpec: vi.fn() }));
vi.mock("../../lib/chartEvents", () => ({ ChartEvents: { CHART_CREATED: "chart:created", CHART_UPDATED: "chart:updated" } }));
vi.mock("../../lib/crossWindowEvents", () => ({
  onSpecChanged: vi.fn(async () => () => {}),
  emitSpecUpdated: vi.fn(),
  emitPreviewDataUpdated: vi.fn(),
  onChartSpecEditorClosed: vi.fn(async () => () => {}),
}));
vi.mock("../../lib/openSpecEditorWindow", () => ({ isSpecEditorWindowOpen: vi.fn(() => false), closeSpecEditorWindow: vi.fn() }));
vi.mock("../tabs/DataTab", () => ({
  DataTab: (props: StubDataTabProps) => {
    h.dataTabProps = props;
    return <div data-testid="stub-data-tab" />;
  },
}));
vi.mock("../tabs/DesignTab", () => ({ DesignTab: () => <div /> }));
vi.mock("../tabs/SpecTab", () => ({ SpecTab: () => <div /> }));
vi.mock("../ChartPreview", () => ({ ChartPreview: () => <canvas /> }));
vi.mock("../DataInspectorWindow", () => ({ DataInspectorWindow: () => null }));

import { CreateChartDialog } from "../CreateChartDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

/** A range chart over Sheet1!A1:C5 whose reader unchecked "Cost" (only Sales plots). */
function storedChart(id: string, data: unknown = { sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 4, endCol: 2 }) {
  return {
    chartId: id,
    name: "Chart 9",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    spec: {
      mark: "bar",
      data,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [SALES],
      title: null,
      xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
      yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
      legend: { visible: true, position: "bottom" },
      palette: "default",
    },
  };
}

beforeEach(() => {
  h.dataTabProps = null;
  h.charts.clear();
  h.replaceChartSpec.mockClear();
  h.createChart.mockClear();
  h.autoDetectSeries.mockClear();
  h.autoDetectPivotSeries.mockClear();
  Reflect.set(globalThis, "ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function show(isOpen: boolean, data?: Record<string, unknown>): Promise<void> {
  act(() => {
    root.render(<CreateChartDialog isOpen={isOpen} onClose={() => {}} data={data} />);
  });
  await flush();
}

async function update(): Promise<Record<string, unknown> | null> {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Update Chart");
  if (!btn) throw new Error("no Update Chart button");
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
  const call = h.replaceChartSpec.mock.calls.at(-1);
  return call ? (call[1] as Record<string, unknown>) : null;
}

describe("Edit Chart keeps the stored series (BUG-0481)", () => {
  it("opening it shows the STORED series, detects nothing, and Update writes them back", async () => {
    h.charts.set("c9", storedChart("c9"));
    await show(true, { editChartId: "c9" });
    expect(h.dataTabProps!.sourceRange).toBe("Sheet1!A1:C5");
    expect(h.dataTabProps!.series).toEqual([SALES]);
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
    const spec = await update();
    expect(spec).toMatchObject({ series: [SALES], categoryIndex: 0 });
  });

  it("the grid selection never replaces the edited chart's range (the session's first open)", async () => {
    h.charts.set("c9", storedChart("c9"));
    h.gridState.selection = { startRow: 0, startCol: 0, endRow: 9, endCol: 3 };
    try {
      await show(true, { editChartId: "c9" });
      expect(h.dataTabProps!.sourceRange).toBe("Sheet1!A1:C5");
      expect(h.dataTabProps!.series).toEqual([SALES]);
      expect((await update())!.data).toMatchObject({ startRow: 0, startCol: 0, endRow: 4, endCol: 2 });
    } finally {
      h.gridState.selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    }
  });

  it("a stored category other than the first column survives the open", async () => {
    const chart = storedChart("c9");
    chart.spec.categoryIndex = 2;
    h.charts.set("c9", chart);
    await show(true, { editChartId: "c9" });
    expect(h.dataTabProps!.categoryIndex).toBe(2);
    expect((await update())!.categoryIndex).toBe(2);
  });

  it("a chart stored BY NAME (or as A1 text) keeps its series too", async () => {
    h.charts.set("c9", storedChart("c9", "Sheet1!A1:C5"));
    await show(true, { editChartId: "c9" });
    expect(h.dataTabProps!.series).toEqual([SALES]);
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
  });

  it("CHANGING the range re-detects (the reader asked for new data)", async () => {
    h.charts.set("c9", storedChart("c9"));
    await show(true, { editChartId: "c9" });
    act(() => h.dataTabProps!.onSourceRangeChange("Sheet1!A1:C6"));
    await flush();
    expect(h.autoDetectSeries).toHaveBeenCalledTimes(1);
    expect(h.dataTabProps!.series).toEqual([SALES, COST]);
  });

  it("switching the header row or the orientation re-detects", async () => {
    h.charts.set("c9", storedChart("c9"));
    await show(true, { editChartId: "c9" });
    act(() => h.dataTabProps!.onHasHeadersChange(false));
    await flush();
    expect(h.autoDetectSeries).toHaveBeenCalledTimes(1);
    expect(h.autoDetectSeries).toHaveBeenLastCalledWith(expect.objectContaining({ startRow: 0, endRow: 4 }), false);

    await show(false);
    h.autoDetectSeries.mockClear();
    await show(true, { editChartId: "c9" });
    expect(h.dataTabProps!.series).toEqual([SALES]);
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
    act(() => h.dataTabProps!.onOrientationChange("rows"));
    await flush();
    expect(h.autoDetectSeries).toHaveBeenCalledTimes(1);
  });

  it("a reopen after the reader changed the range in the last open holds again", async () => {
    h.charts.set("c9", storedChart("c9"));
    await show(true, { editChartId: "c9" });
    act(() => h.dataTabProps!.onSourceRangeChange("Sheet1!A1:C6"));
    await flush();
    await show(false);
    h.autoDetectSeries.mockClear();
    await show(true, { editChartId: "c9" });
    expect(h.dataTabProps!.sourceRange).toBe("Sheet1!A1:C5");
    expect(h.dataTabProps!.series).toEqual([SALES]);
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
  });

  it("a NEW chart still detects its series", async () => {
    await show(true, {});
    act(() => h.dataTabProps!.onSourceRangeChange("Sheet1!A1:C5"));
    await flush();
    expect(h.autoDetectSeries).toHaveBeenCalled();
    expect(h.dataTabProps!.series).toEqual([SALES, COST]);
  });
});

describe("Edit Chart keeps a PivotChart's stored series and title (BUG-0481, the pivot doors)", () => {
  /** A PivotChart the reader retitled and recoloured, plotting one of the pivot's two value fields. */
  function storedPivotChart(id: string) {
    const chart = storedChart(id, { type: "pivot", pivotId: "pv1" });
    chart.spec.title = "Q3 revenue" as unknown as null;
    chart.spec.series = [{ name: "Sum of Sales", sourceIndex: 0, color: "#ff0000" }] as unknown as (typeof chart.spec.series);
    chart.spec.legend = { visible: false, position: "bottom" };
    return chart;
  }

  it("every PivotChart edit door (pivotId + editChartId) keeps them, and Update writes them back", async () => {
    h.charts.set("p9", storedPivotChart("p9"));
    await show(true, { editChartId: "p9", pivotId: "pv1", initialTab: "data" });
    const spec = await update();
    expect(spec).toMatchObject({
      data: { type: "pivot", pivotId: "pv1" },
      title: "Q3 revenue",
      series: [{ name: "Sum of Sales", sourceIndex: 0, color: "#ff0000" }],
      legend: { visible: false, position: "bottom" },
    });
    expect(h.autoDetectPivotSeries).not.toHaveBeenCalled();
  });

  it("a NEW PivotChart still takes its series and title from the pivot", async () => {
    await show(true, { pivotId: "pv1" });
    expect(h.autoDetectPivotSeries).toHaveBeenCalledWith("pv1");
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Insert Chart");
    if (!btn) throw new Error("no Insert Chart button");
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    const spec = h.createChart.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
    expect(spec).toMatchObject({
      title: "PivotTable1",
      series: [
        { name: "Sum of Sales", sourceIndex: 0, color: null },
        { name: "Sum of Cost", sourceIndex: 1, color: null },
      ],
    });
  });
});
