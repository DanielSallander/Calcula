//! FILENAME: app/extensions/Charts/components/pane/__tests__/ChartRangeDataTab.test.tsx
// PURPOSE: The object pane's range Data tab (WP-C S9c) writes the chart's data
//          as ONE `updateChartSpec` in ONE undo step "Edit chart data", with
//          the store's debounced `update_chart` landed INSIDE the transaction
//          (review R1-4 / R2-7) -- and writes nothing when the range is
//          unchanged, refused, or the page is read-only.
// CONTEXT: The real tab, the real range rules (useRangeSource), the real chart
//          store and the real undo transaction; the backend (the chart channel
//          and the undo begin/commit) is doubled into ONE ordered log. Series
//          detection reads cells, so it is doubled too.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const log: string[] = [];
const h = vi.hoisted(() => ({
  autoDetectSeries: vi.fn(async (..._args: unknown[]) => ({
    categoryIndex: 0,
    series: [
      { name: "North", sourceIndex: 1, color: null },
      { name: "South", sourceIndex: 2, color: null },
    ],
    orientation: "columns",
  })),
  sheets: [
    { index: 0, name: "Sheet1", sheetId: "id-0", visibility: "visible" },
    { index: 1, name: "Sheet2", sheetId: "id-1", visibility: "visible" },
    { index: 2, name: "Page", sheetId: "id-2", visibility: "visible", kind: "canvas" },
    { index: 3, name: "Old", visibility: "visible" },
  ],
}));

vi.mock("../../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../src/core/lib/tauri-api")>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
  getSheets: vi.fn(async () => ({ sheets: h.sheets, activeIndex: 2 })),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: () => Promise.resolve() }));
vi.mock("../../../lib/chartDataReader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/chartDataReader")>()),
  autoDetectSeries: (...args: unknown[]) => h.autoDetectSeries(...args),
}));

import { setGridRegions } from "@api/gridOverlays";
import type { ObjectPaneTabContext } from "@api/objectPane";
import { getChartById, loadChartsFromBackend, resetChartStore, syncChartRegions } from "../../../lib/chartStore";
import { chartsBackend } from "../../../lib/chartsBackend";
import { CHART_DATA_UNDO_LABEL } from "../../../lib/chartDataCommit";
import { CANVAS_NEEDS_SHEET_MESSAGE } from "../../../lib/chartRangeBinding";
import { ChartRangeDataTab } from "../ChartRangeDataTab";
import type { ChartSpec } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function baseSpec(data: unknown): ChartSpec {
  return {
    mark: "bar",
    data,
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Revenue", sourceIndex: 1, color: null }],
    title: "Sales",
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
  } as unknown as ChartSpec;
}

const invokeBackend = vi.fn();
let host: HTMLDivElement;
let root: Root;

async function load(spec: ChartSpec, sheetIndex = 2): Promise<void> {
  invokeBackend.mockReset();
  invokeBackend.mockResolvedValueOnce([
    {
      id: "c1",
      sheetIndex,
      specJson: JSON.stringify({ chartId: "c1", name: "Chart 1", sheetIndex, x: 10, y: 20, width: 400, height: 300, spec }),
    },
  ]);
  await loadChartsFromBackend({ stampSheetIds: false });
  invokeBackend.mockReset();
  invokeBackend.mockImplementation((cmd: string) => {
    log.push(cmd);
    return new Promise((resolve) => setTimeout(() => resolve(undefined), 0));
  });
  log.length = 0;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(readOnly = false): Promise<void> {
  const ctx: ObjectPaneTabContext = {
    region: { id: "chart-c1", type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    readOnly,
    readOnlyReason: readOnly ? "This page is subscribed." : null,
    activeTabId: "data",
  };
  await act(async () => {
    root.render(React.createElement(ChartRangeDataTab, { ctx, chartId: "c1", getChart: getChartById }));
  });
  await settle();
}

function input(): HTMLInputElement {
  return host.querySelector('[data-testid="chart-data-range-input"]') as HTMLInputElement;
}

/** Type into the range field the way React hears it. */
function type(text: string): void {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(): Promise<void> {
  act(() => {
    input().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await settle();
}

async function enter(): Promise<void> {
  act(() => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

function writes(): string[] {
  return log.filter((e) => e === "update_chart");
}

beforeEach(() => {
  log.length = 0;
  resetChartStore();
  setGridRegions([]);
  chartsBackend.set(invokeBackend);
  h.autoDetectSeries.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetChartStore();
  setGridRegions([]);
});

describe("a range typed in the pane is ONE write in ONE undo step", () => {
  it("blur commits {data, series, categoryIndex, hasHeaders, seriesOrientation}: one update_chart inside 'Edit chart data'", async () => {
    await load(baseSpec({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 9, endCol: 1 }));
    syncChartRegions();
    await mount();
    expect(input().value).toBe("Sheet1!A1:B10");

    type("Sheet1!A1:C5");
    await blur();

    // ONE write, INSIDE one labelled transaction (the debounced save flushed
    // before the commit closed it).
    expect(log).toEqual([`begin:${CHART_DATA_UNDO_LABEL}`, "update_chart", "commit"]);
    const spec = getChartById("c1")!.spec;
    expect(spec.data).toEqual({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 4, endCol: 2 });
    expect(spec.series.map((s) => s.name)).toEqual(["North", "South"]);
    expect(spec.categoryIndex).toBe(0);
    expect(spec.hasHeaders).toBe(true);
    expect(spec.seriesOrientation).toBe("columns");
  });

  it("Enter commits, and the blur that follows writes nothing more", async () => {
    await load(baseSpec("Sheet1!A1:B10"));
    await mount();
    type("Sheet1!A1:C5");
    await enter();
    await blur();
    expect(writes()).toHaveLength(1);
    expect(log.filter((e) => e.startsWith("begin:"))).toHaveLength(1);
  });

  it("an unchanged range writes nothing and opens no transaction", async () => {
    await load(baseSpec({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 9, endCol: 1 }));
    await mount();
    await blur();
    expect(log).toEqual([]);
  });

  it("on a canvas page an unprefixed range is refused inline and nothing is written", async () => {
    await load(baseSpec({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 9, endCol: 1 }));
    await mount();
    type("A1:C5");
    await blur();
    expect(log).toEqual([]);
    expect(host.querySelector('[data-testid="chart-range-error"]')?.textContent).toBe(CANVAS_NEEDS_SHEET_MESSAGE);
  });

  it("a new reference never keeps the OLD reference's sheet id (the store deep-merges objects)", async () => {
    // Stored on Sheet2 (id-1); the new range is on "Old", a sheet with no id.
    await load(baseSpec({ sheetIndex: 1, sheetId: "id-1", startRow: 0, startCol: 0, endRow: 9, endCol: 1 }));
    await mount();
    type("Old!A1:C5");
    await blur();
    expect(writes()).toHaveLength(1);
    const data = getChartById("c1")!.spec.data as { sheetIndex: number; sheetId?: string };
    expect(data.sheetIndex).toBe(3);
    expect(data.sheetId).toBeUndefined();
  });

  it("one cell: no header row, the cell is the series, nothing detected -- still one write", async () => {
    await load(baseSpec("Sheet1!A1:B10"));
    await mount();
    type("Sheet1!B2");
    await blur();
    expect(writes()).toHaveLength(1);
    const spec = getChartById("c1")!.spec;
    expect(spec.hasHeaders).toBe(false);
    expect(spec.series).toEqual([{ name: "B2", sourceIndex: 0, color: null }]);
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
  });
});

describe("the field follows the stored source until the reader types", () => {
  it("a stored change (an undo, another editor) re-seeds an untouched field, never a typed one", async () => {
    await load(baseSpec({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 9, endCol: 1 }));
    await mount();
    expect(input().value).toBe("Sheet1!A1:B10");
    const chart = getChartById("c1")!;
    act(() => {
      chart.spec = { ...chart.spec, data: { sheetIndex: 1, sheetId: "id-1", startRow: 0, startCol: 0, endRow: 2, endCol: 2 } };
      window.dispatchEvent(new Event("chart:updated"));
    });
    await settle();
    expect(input().value).toBe("Sheet2!A1:C3");

    type("Sheet1!A1:");
    act(() => {
      chart.spec = { ...chart.spec, data: { sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 1, endCol: 1 } };
      window.dispatchEvent(new Event("chart:updated"));
    });
    await settle();
    expect(input().value).toBe("Sheet1!A1:");
  });
});

describe("the other controls", () => {
  it("the header row re-detects the series and writes once", async () => {
    await load(baseSpec({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 9, endCol: 2 }));
    await mount();
    const headers = host.querySelector('[data-testid="chart-data-range-headers"]') as HTMLInputElement;
    act(() => headers.click());
    await settle();
    expect(log).toEqual([`begin:${CHART_DATA_UNDO_LABEL}`, "update_chart", "commit"]);
    expect(h.autoDetectSeries).toHaveBeenCalledWith(
      { sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 9, endCol: 2 },
      false,
    );
    expect(getChartById("c1")!.spec.hasHeaders).toBe(false);
  });

  it("a series checkbox writes the series list once", async () => {
    await load(baseSpec({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 9, endCol: 2 }));
    await mount();
    const second = host.querySelector('[data-testid="chart-data-range-series-2"]') as HTMLInputElement;
    expect(second.checked).toBe(false);
    act(() => second.click());
    await settle();
    expect(writes()).toHaveLength(1);
    expect(getChartById("c1")!.spec.series.map((s) => s.sourceIndex)).toEqual([1, 2]);
  });

  it("on a subscribed page every control is disabled and nothing writes", async () => {
    await load(baseSpec({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 9, endCol: 1 }));
    await mount(true);
    const fieldset = host.querySelector("fieldset") as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(true);
    type("Sheet1!A1:C5");
    await blur();
    expect(log).toEqual([]);
  });
});
