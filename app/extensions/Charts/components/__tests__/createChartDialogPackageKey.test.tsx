//! FILENAME: app/extensions/Charts/components/__tests__/createChartDialogPackageKey.test.tsx
// PURPOSE: The Insert / Edit Chart dialog and the two things a drill chart and
//          an Insert Chart chart must share:
//            - EDIT MODE KEEPS the application connection's stable key
//              (`data.packageDataSourceId`) while the connection is unchanged
//              and DROPS it when the reader picks another connection. The
//              dialog REPLACES the whole spec, so it used to strip a key Rust
//              had stamped -- and a subscriber's design-query chart then lost
//              its model on the next open, when its connection uuid was
//              re-minted (review: no-writer-of-package-key). A key kept across
//              a connection change would instead re-bind the chart to its OLD
//              application connection (stale-package-key-reverts-repoint).
//            - A NEW chart starts from the same furniture as Charts' default
//              skeleton (lib/chartSpecDefaults.ts `defaultChartSkeleton`), the
//              one the drill-through's result chart is built from through the
//              @api seam: the dialog seeds its own state, so this file is what
//              holds the two together (review F3: Insert Chart and drill charts
//              must not drift).
// CONTEXT: The tabs are stubbed; the Data tab stub records the props the dialog
//          hands it (the range text, the connection and their setters). The
//          chart store is doubled so each test reads what the dialog wrote.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  gridState: { selection: null as unknown, surface: "grid" as "grid" | "canvas", sheetContext: undefined as unknown },
  dataTabProps: null as null | {
    sourceRange: string;
    onSourceRangeChange: (v: string) => void;
    connectionId: string;
    onConnectionIdChange: (v: string) => void;
    sourceMode: string;
  },
  createChart: vi.fn((..._args: unknown[]) => ({ chartId: "c-new", name: "Chart 2" })),
  replaceChartSpec: vi.fn(),
  getChartById: vi.fn((_id: string): unknown => null),
  autoDetectSeries: vi.fn(async () => ({ categoryIndex: 0, series: [{ name: "Sales", sourceIndex: 1, color: null }] })),
}));

vi.mock("@api", () => ({
  detectDataRegion: vi.fn(async () => null),
  useGridState: () => h.gridState,
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  getSheets: vi.fn(async () => ({
    sheets: [
      { index: 0, name: "Sheet1", sheetId: "id-0", visibility: "visible" },
      { index: 1, name: "Page", sheetId: "id-1", visibility: "visible", kind: "canvas" },
    ],
    activeIndex: 0,
  })),
}));
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn(), AppEvents: { GRID_REFRESH: "grid:refresh" } }));
vi.mock("../../lib/chartsBackend", () => ({ chartsBackend: { invoke: vi.fn(async () => []) } }));
vi.mock("../../lib/chartStore", () => ({
  createChart: (...args: unknown[]) => h.createChart(...args),
  getChartById: (id: string) => h.getChartById(id),
  replaceChartSpec: (...args: unknown[]) => h.replaceChartSpec(...args),
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

import { CreateChartDialog } from "../CreateChartDialog";
import { buildDesignQueryChartSpec, defaultChartSkeleton } from "../../lib/chartSpecDefaults";
import type { ChartDefinition, ChartSpec, DesignQueryDataSource } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

const DSL = "ROWS: Geo.Region\nVALUES: [Revenue]";

/** A subscriber's design-query chart: bound to this session's uuid, carrying the stable key Rust stamped. */
function keyedChart(): ChartDefinition {
  const spec = buildDesignQueryChartSpec({ dslText: DSL, connectionId: "conn-1", mark: "bar", title: "Revenue" });
  (spec.data as DesignQueryDataSource).packageDataSourceId = "ds-A";
  return { chartId: "c1", name: "Chart 1", sheetIndex: 0, x: 0, y: 0, width: 400, height: 300, spec };
}

beforeEach(() => {
  h.gridState = { selection: null, surface: "grid", sheetContext: undefined };
  h.dataTabProps = null;
  h.createChart.mockClear();
  h.replaceChartSpec.mockClear();
  h.getChartById.mockReset();
  h.getChartById.mockImplementation(() => null);
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

async function clickButton(text: string): Promise<void> {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`no "${text}" button`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
}

function replacedSpec(): ChartSpec {
  expect(h.replaceChartSpec).toHaveBeenCalledTimes(1);
  const [chartId, spec] = h.replaceChartSpec.mock.calls[0] as [string, ChartSpec];
  expect(chartId).toBe("c1");
  return spec;
}

describe("Edit Chart on a design-query chart: the application connection's stable key", () => {
  beforeEach(() => {
    h.getChartById.mockImplementation((id: string) => (id === "c1" ? keyedChart() : null));
  });

  it("is KEPT when the connection is unchanged (the full replace no longer strips it)", async () => {
    await open({ editChartId: "c1" });
    expect(h.dataTabProps!.sourceMode).toBe("designQuery");
    expect(h.dataTabProps!.connectionId).toBe("conn-1");
    await clickButton("Update Chart");

    const data = replacedSpec().data as DesignQueryDataSource;
    expect(data).toEqual({ type: "designQuery", dslText: DSL, connectionId: "conn-1", packageDataSourceId: "ds-A" });
  });

  it("is DROPPED when the reader picks another connection (a stale key would re-bind the chart to the old one)", async () => {
    await open({ editChartId: "c1" });
    act(() => h.dataTabProps!.onConnectionIdChange("conn-local"));
    await flush();
    await clickButton("Update Chart");

    const data = replacedSpec().data as DesignQueryDataSource;
    expect(data.connectionId).toBe("conn-local");
    expect(data.packageDataSourceId).toBeUndefined();
    // Nothing of it reaches the saved JSON either.
    expect(JSON.parse(JSON.stringify(data))).toEqual({ type: "designQuery", dslText: DSL, connectionId: "conn-local" });
  });

  it("is KEPT again when the reader switches away and back to the chart's own connection", async () => {
    await open({ editChartId: "c1" });
    act(() => h.dataTabProps!.onConnectionIdChange("conn-local"));
    await flush();
    act(() => h.dataTabProps!.onConnectionIdChange("conn-1"));
    await flush();
    await clickButton("Update Chart");

    expect((replacedSpec().data as DesignQueryDataSource).packageDataSourceId).toBe("ds-A");
  });
});

describe("a NEW chart starts from Charts' default skeleton (the one a drill chart is built from)", () => {
  async function insertRangeChart(data?: Record<string, unknown>): Promise<ChartSpec> {
    await open(data);
    act(() => h.dataTabProps!.onSourceRangeChange("Sheet1!A1:B5"));
    await flush();
    await clickButton("Insert Chart");
    expect(h.createChart).toHaveBeenCalledTimes(1);
    return (h.createChart.mock.calls[0] as [ChartSpec])[0];
  }

  it("a column chart: the title, axes, legend and palette are the skeleton's", async () => {
    const spec = await insertRangeChart();
    const skeleton = defaultChartSkeleton("bar");
    expect(spec.mark).toBe("bar");
    expect(spec.title).toEqual(skeleton.title);
    expect(spec.xAxis).toEqual(skeleton.xAxis);
    expect(spec.yAxis).toEqual(skeleton.yAxis);
    expect(spec.legend).toEqual(skeleton.legend);
    expect(spec.palette).toEqual(skeleton.palette);
    // A new chart carries no key: Rust stamps it at save.
    expect(spec.data).not.toHaveProperty("packageDataSourceId");
  });

  it("a Card tile: the legend starts OFF, as the skeleton's does for a title-only mark", async () => {
    const spec = await insertRangeChart({ initialMark: "card" });
    expect(spec.mark).toBe("card");
    expect(spec.legend).toEqual(defaultChartSkeleton("card").legend);
    expect(spec.legend.visible).toBe(false);
  });
});
