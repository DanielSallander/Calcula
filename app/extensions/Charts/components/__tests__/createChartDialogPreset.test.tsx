//! FILENAME: app/extensions/Charts/components/__tests__/createChartDialogPreset.test.tsx
// PURPOSE: Contract 4.1 — the Insert Chart dialog can be OPENED WITH A TYPE:
//          `initialMark` + `initialMarkOptions` in the dialog data (the Canvas
//          tab's Visuals gallery: "Stacked bar", "Card", "Line and stacked
//          column", ...), and a Card or a Gauge can be pointed at ONE cell or
//          at a DEFINED NAME.
//          Also pinned: a new chart never inherits the previous open's type
//          (the dialog component stays mounted between opens — survey
//          charts.md §2.2 / §7.4).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  gridState: { selection: null as unknown, surface: "canvas" as "grid" | "canvas", sheetContext: { activeSheetIndex: 2, activeSheetName: "Page" } as unknown },
  dataTabProps: null as null | { sourceRange: string; onSourceRangeChange: (v: string) => void; sourceRangeError?: string | null },
  createChart: vi.fn((..._args: unknown[]) => ({ chartId: "c1", name: "Chart 1" })),
  autoDetectSeries: vi.fn(async () => ({ categoryIndex: 0, series: [{ name: "Sales", sourceIndex: 1, color: null }] })),
  resolveDataSource: vi.fn(),
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
    activeIndex: 2,
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
    data: { categories: ["x"], series: [{ name: "S", values: [1], color: null }] },
    diagnostics: [],
  })),
}));
vi.mock("../../lib/dataSourceResolver", () => ({
  resolveDataSource: (...args: unknown[]) => h.resolveDataSource(...args),
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

import { CreateChartDialog, readInitialMark, readInitialMarkOptions } from "../CreateChartDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

const PLACEMENT = { sheetIndex: 2, x: 10, y: 10, width: 300, height: 200 };

beforeEach(() => {
  h.dataTabProps = null;
  h.createChart.mockClear();
  h.autoDetectSeries.mockClear();
  h.resolveDataSource.mockReset();
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

async function typeRange(text: string): Promise<void> {
  act(() => h.dataTabProps!.onSourceRangeChange(text));
  await flush();
}

async function insert(): Promise<Record<string, unknown> | null> {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Insert Chart");
  if (!btn) throw new Error("no Insert Chart button");
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
  const call = h.createChart.mock.calls.at(-1);
  return call ? (call[0] as Record<string, unknown>) : null;
}

describe("readInitialMark / readInitialMarkOptions", () => {
  it("accepts a mark id and a plain options object, nothing else", () => {
    expect(readInitialMark("card")).toBe("card");
    expect(readInitialMark("my_mark2")).toBe("my_mark2");
    expect(readInitialMark("<script>")).toBeNull();
    expect(readInitialMark(42)).toBeNull();
    expect(readInitialMark(undefined)).toBeNull();
    expect(readInitialMarkOptions({ stackMode: "stacked" })).toEqual({ stackMode: "stacked" });
    expect(readInitialMarkOptions([1, 2])).toBeNull();
    expect(readInitialMarkOptions("stacked")).toBeNull();
    expect(readInitialMarkOptions(null)).toBeNull();
  });
});

describe("the dialog opens with the type the opener asked for", () => {
  it("Stacked bar: horizontalBar + stackMode stacked reaches the created spec", async () => {
    await show(true, { placement: PLACEMENT, suppressAutoRange: true, initialMark: "horizontalBar", initialMarkOptions: { stackMode: "stacked" } });
    await typeRange("Sheet1!A1:B5");
    const spec = await insert();
    expect(spec).toMatchObject({ mark: "horizontalBar", markOptions: { stackMode: "stacked" } });
  });

  it("Line and stacked column: combo + stackMode stacked", async () => {
    await show(true, { placement: PLACEMENT, initialMark: "combo", initialMarkOptions: { stackMode: "stacked" } });
    await typeRange("Sheet1!A1:C5");
    expect(await insert()).toMatchObject({ mark: "combo", markOptions: { stackMode: "stacked" } });
  });

  it("a title-only visual starts with its legend off (it never draws one)", async () => {
    await show(true, { placement: PLACEMENT, initialMark: "kpi" });
    await typeRange("Sheet1!A1:C5");
    const spec = await insert();
    expect(spec).toMatchObject({ mark: "kpi" });
    expect((spec!.legend as { visible: boolean }).visible).toBe(false);
  });

  it("a NEW open without a preset is a column chart again, never the previous open's type", async () => {
    await show(true, { placement: PLACEMENT, initialMark: "gauge", initialMarkOptions: { max: 10 } });
    await show(false);
    await show(true, { placement: PLACEMENT });
    await typeRange("Sheet1!A1:B5");
    const spec = await insert();
    expect(spec!.mark).toBe("bar");
    expect(spec!.markOptions).toBeUndefined();
  });
});

describe("one cell as the source (Card / Gauge)", () => {
  it("'Sheet1!B2' charts that one value: no header row, the cell is the series", async () => {
    await show(true, { placement: PLACEMENT, initialMark: "card" });
    await typeRange("Sheet1!B2");
    expect(h.dataTabProps!.sourceRangeError ?? null).toBeNull();
    const spec = await insert();
    expect(spec).toMatchObject({
      mark: "card",
      data: { sheetIndex: 0, sheetId: "id-0", startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
      hasHeaders: false,
      categoryIndex: 0,
      series: [{ name: "B2", sourceIndex: 0, color: null }],
    });
    // Series detection over a one-cell range would find no series at all.
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
  });

  it("going back from one cell to a table turns the header row back on", async () => {
    await show(true, { placement: PLACEMENT, initialMark: "card" });
    await typeRange("Sheet1!B2");
    await typeRange("Sheet1!A1:B5");
    const spec = await insert();
    expect(spec).toMatchObject({ hasHeaders: true, series: [{ name: "Sales", sourceIndex: 1 }] });
  });
});

describe("a defined name as the source", () => {
  it("'TotalSales' resolves through the workbook's names and is STORED by name", async () => {
    h.resolveDataSource.mockImplementation(async (name: unknown) => {
      expect(name).toBe("TotalSales");
      return { sheetIndex: 0, startRow: 4, startCol: 2, endRow: 4, endCol: 2 };
    });
    await show(true, { placement: PLACEMENT, initialMark: "gauge" });
    await typeRange("TotalSales");
    expect(h.dataTabProps!.sourceRangeError ?? null).toBeNull();
    const spec = await insert();
    expect(spec).toMatchObject({
      mark: "gauge",
      data: "TotalSales",
      hasHeaders: false,
      series: [{ name: "TotalSales", sourceIndex: 0, color: null }],
    });
  });

  it("a name the workbook does not define is refused inline, and nothing is created", async () => {
    h.resolveDataSource.mockImplementation(async () => {
      throw new Error('Cannot resolve data source "Nope".');
    });
    await show(true, { placement: PLACEMENT, initialMark: "card" });
    await typeRange("Nope");
    expect(h.dataTabProps!.sourceRangeError).toContain("Nope");
    await insert();
    expect(h.createChart).not.toHaveBeenCalled();
  });

  it("a name that points at a canvas sheet is refused (a canvas has no cells)", async () => {
    h.resolveDataSource.mockImplementation(async () => ({ sheetIndex: 2, startRow: 0, startCol: 0, endRow: 0, endCol: 0 }));
    await show(true, { placement: PLACEMENT, initialMark: "card" });
    await typeRange("OnThePage");
    expect(h.dataTabProps!.sourceRangeError).toMatch(/canvas/i);
    await insert();
    expect(h.createChart).not.toHaveBeenCalled();
  });

  it("a name over a TABLE (not one cell) is charted like a range: series detected, name kept", async () => {
    h.resolveDataSource.mockImplementation(async () => ({ sheetIndex: 1, startRow: 0, startCol: 0, endRow: 5, endCol: 1 }));
    await show(true, { placement: PLACEMENT, initialMark: "multiRowCard" });
    await typeRange("SalesTable");
    const spec = await insert();
    expect(spec).toMatchObject({ mark: "multiRowCard", data: "SalesTable", series: [{ name: "Sales", sourceIndex: 1 }] });
    expect(h.autoDetectSeries).toHaveBeenCalled();
  });
});
