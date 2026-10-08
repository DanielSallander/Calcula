//! FILENAME: app/extensions/Charts/components/__tests__/createChartDialogTypeSwitch.test.tsx
// PURPOSE: Changing the TYPE in the Insert Chart dialog keeps only the mark
//          options the new type declares, and Insert refuses (inline) a spec
//          the schema refuses -- canvas-review visuals finding: a Stacked
//          column preset switched to Card saved `stackMode` on a card, which
//          every later script edit of that chart was then refused for.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  gridState: { selection: null as unknown, surface: "canvas" as "grid" | "canvas", sheetContext: { activeSheetIndex: 2, activeSheetName: "Page" } as unknown },
  dataTabProps: null as null | { sourceRange: string; onSourceRangeChange: (v: string) => void; sourceRangeError?: string | null },
  designTabProps: null as null | { onSpecChange: (u: Record<string, unknown>) => void },
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
vi.mock("../tabs/DesignTab", () => ({
  DesignTab: (props: NonNullable<typeof h.designTabProps>) => {
    h.designTabProps = props;
    return <div data-testid="stub-design-tab" />;
  },
}));
vi.mock("../tabs/SpecTab", () => ({ SpecTab: () => <div /> }));
vi.mock("../ChartPreview", () => ({ ChartPreview: () => <canvas /> }));
vi.mock("../DataInspectorWindow", () => ({ DataInspectorWindow: () => null }));

import { CreateChartDialog } from "../CreateChartDialog";
import { markOptionsForMark, markSwitchPatch } from "../../lib/markOptionsForMark";
import { validateChartSpec } from "../../lib/chartSpecValidate";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

const PLACEMENT = { sheetIndex: 2, x: 10, y: 10, width: 300, height: 200 };

beforeEach(() => {
  h.dataTabProps = null;
  h.designTabProps = null;
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


async function openDesignTab(): Promise<void> {
  const tab = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Design");
  if (!tab) throw new Error("no Design tab");
  act(() => tab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
}

async function pickType(mark: string): Promise<void> {
  await openDesignTab();
  act(() => h.designTabProps!.onSpecChange({ mark }));
  await flush();
}

describe("a type change keeps only the options the new type understands", () => {
  it("Stacked column -> Card drops stackMode, and the card is valid", async () => {
    await show(true, { placement: PLACEMENT, initialMark: "bar", initialMarkOptions: { stackMode: "stacked" } });
    await typeRange("Sheet1!A1:B5");
    await pickType("card");
    const spec = await insert();
    expect(spec).not.toBeNull();
    expect(spec!.mark).toBe("card");
    expect(spec!.markOptions).toBeUndefined();
    expect(validateChartSpec(spec)).toEqual([]);
  });

  it("Stacked area -> Line keeps stackMode but drops the area-only stacked flag", async () => {
    await show(true, { placement: PLACEMENT, initialMark: "area", initialMarkOptions: { stackMode: "stacked", stacked: true } });
    await typeRange("Sheet1!A1:C5");
    await pickType("line");
    const spec = await insert();
    expect(spec!.markOptions).toEqual({ stackMode: "stacked" });
  });

  it("100% column -> combo drops the 100% stack the combo cannot draw", async () => {
    await show(true, { placement: PLACEMENT, initialMark: "bar", initialMarkOptions: { stackMode: "percentStacked" } });
    await typeRange("Sheet1!A1:C5");
    await pickType("combo");
    const spec = await insert();
    expect(spec!.mark).toBe("combo");
    expect(spec!.markOptions).toBeUndefined();
  });
});

describe("Insert validates the spec", () => {
  it("a spec the schema refuses is refused inline and never created", async () => {
    await show(true, { placement: PLACEMENT, initialMark: "card", initialMarkOptions: { decimals: 99 } });
    await typeRange("Sheet1!A1:B5");
    const spec = await insert();
    expect(spec).toBeNull();
    expect(h.createChart).not.toHaveBeenCalled();
    expect(container.textContent).toContain("not valid");
    expect(container.textContent).toContain("decimals");
  });
});

describe("markOptionsForMark / markSwitchPatch (pure)", () => {
  it("drops undeclared keys and refused values, keeps declared ones", () => {
    expect(markOptionsForMark("card", { stackMode: "stacked" } as never)).toBeUndefined();
    expect(markOptionsForMark("bar", { stackMode: "stacked", displayUnits: "auto" } as never)).toEqual({ stackMode: "stacked" });
    expect(markOptionsForMark("combo", { stackMode: "percentStacked" } as never)).toBeUndefined();
    expect(markOptionsForMark("combo", { stackMode: "stacked" } as never)).toEqual({ stackMode: "stacked" });
  });

  it("a custom (un-narrowed) mark keeps its options", () => {
    expect(markOptionsForMark("myPluginMark", { anything: 1 } as never)).toEqual({ anything: 1 });
  });

  it("the band patch clears a dropped key EXPLICITLY (the store deep-merges)", () => {
    const patch = markSwitchPatch({ mark: "bar", markOptions: { stackMode: "stacked" } as never }, "card");
    expect(patch.mark).toBe("card");
    expect(Object.prototype.hasOwnProperty.call(patch.markOptions, "stackMode")).toBe(true);
    expect((patch.markOptions as Record<string, unknown>).stackMode).toBeUndefined();
  });
});
