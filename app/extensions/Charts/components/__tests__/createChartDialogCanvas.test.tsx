//! FILENAME: app/extensions/Charts/components/__tests__/createChartDialogCanvas.test.tsx
// PURPOSE: M4 (canvas sheets) -- the Insert Chart dialog, rendered:
//            - a typed "Sheet2!A1:B5" binds the chart's data to Sheet2 (index
//              AND id), not to the sheet the dialog was opened on;
//            - on a canvas nothing is auto-detected from the "selection", a
//              range without a sheet is refused inline, and a range naming a
//              worksheet is accepted;
//            - an opener-supplied `placement` is where the chart goes.
//          The tabs are stubbed; the Data tab stub records the props the
//          dialog hands it (the range text, its setter, the inline refusal).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  gridState: { selection: null as unknown, surface: "grid" as "grid" | "canvas", sheetContext: undefined as unknown },
  dataTabProps: null as null | {
    sourceRange: string;
    onSourceRangeChange: (v: string) => void;
    sourceRangeError?: string | null;
  },
  createChart: vi.fn((..._args: unknown[]) => ({ chartId: "c1", name: "Chart 1" })),
  autoDetectSeries: vi.fn(async () => ({ categoryIndex: 0, series: [{ name: "Sales", sourceIndex: 1, color: null }] })),
}));

vi.mock("@api", () => ({
  detectDataRegion: vi.fn(async () => null),
  useGridState: () => h.gridState,
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  getSheets: vi.fn(async () => ({
    sheets: [
      { index: 0, name: "Sheet1", sheetId: "id-0", visibility: "visible" },
      { index: 1, name: "Sheet2", sheetId: "id-1", visibility: "visible" },
      { index: 2, name: "Page", sheetId: "id-2", visibility: "visible", kind: "canvas" },
    ],
    activeIndex: h.gridState.surface === "canvas" ? 2 : 0,
  })),
}));
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn(), AppEvents: { GRID_REFRESH: "grid:refresh" } }));
vi.mock("../../lib/chartsBackend", () => ({ chartsBackend: { invoke: vi.fn(async () => []) } }));
vi.mock("../../lib/chartStore", () => ({
  createChart: (...args: unknown[]) => h.createChart(...args),
  getChartById: vi.fn(() => null),
  replaceChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
}));
vi.mock("../../rendering/chartRenderer", () => ({ invalidateChartCache: vi.fn() }));
vi.mock("../../lib/chartDataReader", () => ({
  autoDetectSeries: (...args: unknown[]) => h.autoDetectSeries(...(args as [])),
  readChartDataResolved: vi.fn(async (spec: unknown) => ({
    spec,
    data: { categories: ["Jan"], series: [{ name: "Sales", values: [1], color: null }] },
    diagnostics: [],
  })),
}));
vi.mock("../../lib/pivotChartDataReader", () => ({ autoDetectPivotSeries: vi.fn(async () => ({ series: [], title: null })) }));
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
  DataTab: (props: NonNullable<typeof h.dataTabProps>) => {
    h.dataTabProps = props;
    return <div data-testid="stub-data-tab" />;
  },
}));
vi.mock("../tabs/DesignTab", () => ({ DesignTab: () => <div /> }));
vi.mock("../tabs/SpecTab", () => ({ SpecTab: () => <div /> }));
vi.mock("../ChartPreview", () => ({ ChartPreview: () => <canvas /> }));
vi.mock("../DataInspectorWindow", () => ({ DataInspectorWindow: () => null }));

import { CreateChartDialog, readDialogPlacement } from "../CreateChartDialog";
import { CANVAS_NEEDS_SHEET_MESSAGE, canvasSourceMessage } from "../../lib/chartRangeBinding";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.gridState = { selection: null, surface: "grid", sheetContext: undefined };
  h.dataTabProps = null;
  h.createChart.mockClear();
  h.autoDetectSeries.mockClear();
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

async function open(data?: Record<string, unknown>): Promise<void> {
  act(() => {
    root.render(<CreateChartDialog isOpen onClose={() => {}} data={data} />);
  });
  await flush();
}

async function typeRange(text: string): Promise<void> {
  act(() => h.dataTabProps!.onSourceRangeChange(text));
  await flush();
}

async function clickInsert(): Promise<void> {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Insert Chart");
  if (!btn) throw new Error("no Insert Chart button");
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
}

describe("a typed sheet prefix binds the data to that sheet", () => {
  it("on a worksheet, 'Sheet2!A1:B5' stores Sheet2's index and id (not the current sheet's)", async () => {
    await open();
    await typeRange("Sheet2!A1:B5");
    expect(h.dataTabProps!.sourceRangeError ?? null).toBeNull();
    await clickInsert();
    expect(h.createChart).toHaveBeenCalledTimes(1);
    const [spec, placement] = h.createChart.mock.calls[0] as [{ data: unknown }, { sheetIndex: number }];
    expect(spec.data).toEqual({ sheetIndex: 1, sheetId: "id-1", startRow: 0, startCol: 0, endRow: 4, endCol: 1 });
    // The chart itself goes on the sheet the dialog is on.
    expect(placement.sheetIndex).toBe(0);
  });

  it("on a worksheet, an unprefixed range is the current sheet, as before", async () => {
    await open();
    await typeRange("A1:B5");
    await clickInsert();
    const [spec] = h.createChart.mock.calls[0] as [{ data: { sheetIndex: number } }];
    expect(spec.data.sheetIndex).toBe(0);
  });
});

describe("on a canvas", () => {
  beforeEach(() => {
    h.gridState = {
      selection: { startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
      surface: "canvas",
      sheetContext: { activeSheetIndex: 2, activeSheetName: "Page" },
    };
  });

  it("does not turn the 'selection' into a range", async () => {
    await open();
    expect(h.dataTabProps!.sourceRange).toBe("");
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
  });

  it("refuses a range without a sheet, inline, and does not create", async () => {
    await open();
    await typeRange("A1:B5");
    expect(h.dataTabProps!.sourceRangeError).toBe(CANVAS_NEEDS_SHEET_MESSAGE);
    await clickInsert();
    expect(h.createChart).not.toHaveBeenCalled();
    expect(container.textContent).toContain(CANVAS_NEEDS_SHEET_MESSAGE);
  });

  it("refuses a range that names a canvas", async () => {
    await open();
    await typeRange("Page!A1:B5");
    expect(h.dataTabProps!.sourceRangeError).toBe(canvasSourceMessage("Page"));
  });

  it("accepts 'Sheet1!A1:B5' and places the chart where the opener said", async () => {
    await open({ placement: { sheetIndex: 2, x: 320, y: 144, width: 480, height: 270 } });
    await typeRange("Sheet1!A1:B5");
    expect(h.dataTabProps!.sourceRangeError ?? null).toBeNull();
    await clickInsert();
    const [spec, placement] = h.createChart.mock.calls[0] as [{ data: unknown }, Record<string, number>];
    expect(spec.data).toEqual({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 4, endCol: 1 });
    expect(placement).toEqual({ sheetIndex: 2, x: 320, y: 144, width: 480, height: 270 });
  });
});

describe("suppressAutoRange on a worksheet", () => {
  it("leaves the range empty even with a selection", async () => {
    h.gridState = { selection: { startRow: 0, startCol: 0, endRow: 3, endCol: 2 }, surface: "grid", sheetContext: undefined };
    await open({ suppressAutoRange: true });
    expect(h.dataTabProps!.sourceRange).toBe("");
  });
});

describe("readDialogPlacement", () => {
  it("accepts a complete finite rectangle only", () => {
    expect(readDialogPlacement({ sheetIndex: 1, x: 0, y: 0, width: 10, height: 10 })).toEqual({
      sheetIndex: 1, x: 0, y: 0, width: 10, height: 10,
    });
    expect(readDialogPlacement({ sheetIndex: 1, x: 0, y: 0, width: 10 })).toBeNull();
    expect(readDialogPlacement({ sheetIndex: 1, x: NaN, y: 0, width: 10, height: 10 })).toBeNull();
    expect(readDialogPlacement({ sheetIndex: 1, x: 0, y: 0, width: 0, height: 10 })).toBeNull();
    expect(readDialogPlacement(undefined)).toBeNull();
  });
});
