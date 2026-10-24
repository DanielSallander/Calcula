//! FILENAME: app/extensions/Charts/components/__tests__/ChartContextMenuDrillThrough.test.tsx
// PURPOSE: The chart context menu's two drill-through rows
//          (docs/design/model-drillthrough.md 2.9): the RUN row "Drill through:
//          <category>[, <series>]" -- first among the element verbs on a datum
//          or legend entry of a design-query chart with a definition, naming
//          the POINT under the pointer, disabled with the reason when the datum
//          has no identity -- and the AUTHORING row "Drill-through behavior..."
//          between "Edit data..." and "Edit Script...", which reads "View
//          drill-through..." and opens read-only on a subscribed sheet or page.
// CONTEXT: The harness is ChartContextMenu.test.tsx's: everything outside the
//          menu is doubled, each test states one chart spec and one recorded
//          right-click. The shared runner is doubled so the test is about what
//          the menu HANDS it (the runner's own tests pin the rest).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { ChartSpec } from "../../types";

const h = vi.hoisted(() => ({
  getChartById: vi.fn(),
  updateChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
  invalidateChartCache: vi.fn(),
  showDialog: vi.fn(),
  emitAppEvent: vi.fn(),
  runDrillThrough: vi.fn(),
  invoke: vi.fn(),
  isSheetSubscribed: vi.fn(),
  getLayoutSurface: vi.fn(),
}));

vi.mock("@api", () => ({ showDialog: h.showDialog }));
vi.mock("@api/events", () => ({
  emitAppEvent: h.emitAppEvent,
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
}));
vi.mock("../../lib/chartStore", () => ({
  getChartById: h.getChartById,
  updateChartSpec: h.updateChartSpec,
  syncChartRegions: h.syncChartRegions,
}));
vi.mock("../../rendering/chartRenderer", () => ({
  invalidateChartCache: h.invalidateChartCache,
}));
vi.mock("../../manifest", () => ({ CHART_DIALOG_ID: "chart:createDialog" }));
vi.mock("../../lib/chartsBackend", () => ({ chartsBackend: { invoke: h.invoke } }));
vi.mock("../../../_shared/drillThrough/runDrillThrough", () => ({
  runDrillThrough: h.runDrillThrough,
}));
vi.mock("@api/collaboration", () => ({ isSheetSubscribed: h.isSheetSubscribed }));
vi.mock("@api/layoutSurface", () => ({ getLayoutSurface: h.getLayoutSurface }));
vi.mock("@api/reportPages", () => {
  const snapshot = {
    pages: [{ index: 2, sheetId: "sheet-2", name: "Page 1" }],
    sheetIdByIndex: new Map([
      [0, "sheet-0"],
      [2, "sheet-2"],
    ]),
    activeIndex: 0,
    version: 1,
  };
  return {
    getReportPagesSnapshot: () => snapshot,
    sheetIdAt: (s: { sheetIdByIndex: Map<number, string> }, i: number | undefined) =>
      typeof i === "number" ? s.sheetIdByIndex.get(i) ?? null : null,
  };
});

import { ChartContextMenu, chartDrillReadOnly, drillThroughRowLabel, subjectFor } from "../ChartContextMenu";
import { setChartRightClickTarget, type ChartRightClickTarget } from "@api/chartData";
import { resetChartContextMenuContributions } from "@api/chartContextMenu";
import { TRANSFORMED_SOURCE_REASON } from "../../lib/chartModelVisuals";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const DEFINITION = {
  dslText: "ROWS: Product.Name\nVALUES: [Revenue]",
  presentation: { kind: "table" as const },
  name: "Product detail",
};

/** A design-query bar chart (Region x Year) carrying a drill-through definition. */
function designQuerySpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    title: "Revenue by region",
    data: { type: "designQuery", dslText: "ROWS: Geo.Region\nCOLUMNS: Date.Year\nVALUES: [Revenue]", connectionId: "conn-1" },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    xAxis: {},
    yAxis: {},
    legend: { visible: true, position: "right" },
    palette: "default",
    drillThrough: DEFINITION,
    ...overrides,
  } as ChartSpec;
}

function rangeSpec(): ChartSpec {
  return {
    mark: "bar",
    title: "Monthly revenue",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Cost", sourceIndex: 2, color: null },
    ],
    xAxis: {},
    yAxis: {},
    legend: { visible: true, position: "right" },
    palette: "default",
  } as ChartSpec;
}

function chartWith(spec: ChartSpec, sheetIndex = 0) {
  return { chartId: "chart-1", name: "Chart 1", sheetIndex, spec };
}

const WEST_2025 = [
  { field: "Geo.Region", key: "West" },
  { field: "Date.Year", key: "2025" },
];

/** A FIRST right-click on the West / 2025 bar: the ladder is on the SERIES rung (no pointIndex); the hit named the bar. */
function westBar(over: Partial<ChartRightClickTarget> = {}): ChartRightClickTarget {
  return {
    chartId: "chart-1",
    element: "datum",
    seriesIndex: 1,
    seriesName: "2025",
    categoryName: "West",
    value: 42,
    memberPath: WEST_2025,
    memberLabels: ["West", "2025"],
    drillIdentity: "path",
    ...over,
  };
}

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null = null;
const order: string[] = [];

async function render(data?: Record<string, unknown>): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(ChartContextMenu, {
        onClose: () => order.push("close"),
        data: data ?? { chartId: "chart-1", screenX: 10, screenY: 10 },
      }),
    );
  });
}

function itemIds(): string[] {
  return [...container.querySelectorAll("[data-chart-menu-item]")].map((el) => el.getAttribute("data-chart-menu-item")!);
}

function item(id: string): HTMLElement | null {
  return container.querySelector(`[data-chart-menu-item="${id}"]`);
}

async function click(id: string): Promise<void> {
  const el = item(id);
  if (!el) throw new Error(`No menu item "${id}". Present: ${itemIds().join(", ")}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  resetChartContextMenuContributions();
  setChartRightClickTarget(null);
  h.getChartById.mockReturnValue(chartWith(designQuerySpec()));
  h.runDrillThrough.mockResolvedValue({ ok: true, sheetIndex: 3, sheetId: "sheet-3", sheetName: "Product detail" });
  h.isSheetSubscribed.mockReturnValue(false);
  h.getLayoutSurface.mockReturnValue(null);
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
  }
  container?.remove();
  resetChartContextMenuContributions();
  setChartRightClickTarget(null);
});

// ============================================================================
// The run row
// ============================================================================

describe("the Drill through row", () => {
  it("is FIRST among the element verbs on a datum, and names the POINT under the pointer although the rung is the series", async () => {
    setChartRightClickTarget(westBar());
    await render();

    const ids = itemIds();
    // The shared block, then the drill, then the series verbs.
    expect(ids.slice(0, 3)).toEqual(["deleteChart", "changeChartType", "selectData"]);
    expect(ids[3]).toBe("drillThrough");
    expect(ids.indexOf("drillThrough")).toBeLessThan(ids.indexOf("addDataLabels"));
    expect(item("drillThrough")?.textContent).toBe("Drill through: West, 2025");
    // The menu's own subject line still says SERIES (the ladder's rung): the
    // row states its own subject precisely because the two differ here.
    expect(container.querySelector("[data-chart-menu-subject]")?.textContent).toBe("Data Series: 2025");
    // The tooltip is the definition's name.
    expect(item("drillThrough")?.getAttribute("title")).toBe("Product detail");
    expect(item("drillThrough")?.getAttribute("aria-disabled")).toBeNull();
  });

  it("runs the shared runner with the chart's connection, the definition and the clicked members as KEY filters", async () => {
    setChartRightClickTarget(westBar());
    await render();
    await click("drillThrough");

    expect(order).toEqual(["close"]);
    expect(h.runDrillThrough).toHaveBeenCalledTimes(1);
    const [source, def, datum, io] = h.runDrillThrough.mock.calls[0];
    expect(source).toEqual({ kind: "chart", id: "chart-1", name: "Revenue by region", connectionId: "conn-1", sheetIndex: 0 });
    expect(def).toBe(DEFINITION);
    // STRICT: the chart's datum is the clicked PATH and nothing else -- no
    // `standing` (a BI pivot's own filters) and no `notices`; the page's
    // filters that reach the chart are resolved by the runner (contract C9).
    expect(datum).toStrictEqual({
      filters: [
        { field: "Geo.Region", includedKeys: ["West"], labels: ["West"] },
        { field: "Date.Year", includedKeys: ["2025"], labels: ["2025"] },
      ],
    });
    // The CALLER's bound invoker: _shared owns no backend channel.
    expect(io).toEqual({ invoke: h.invoke });
  });

  it("drills a legend entry on its series member, ahead of the legend verbs", async () => {
    setChartRightClickTarget({
      chartId: "chart-1",
      element: "legendEntry",
      seriesIndex: 1,
      seriesName: "2025",
      memberPath: [{ field: "Date.Year", key: "2025" }],
      memberLabels: ["2025"],
      drillIdentity: "path",
    });
    await render();

    const ids = itemIds();
    expect(ids.indexOf("drillThrough")).toBeLessThan(ids.indexOf("hideLegendEntry"));
    expect(item("drillThrough")?.textContent).toBe("Drill through: 2025");
    await click("drillThrough");
    expect(h.runDrillThrough.mock.calls[0][2]).toEqual({
      filters: [{ field: "Date.Year", includedKeys: ["2025"], labels: ["2025"] }],
    });
  });

  it("a measure-only datum (a Card) reads plain Drill through and runs with NO member filters", async () => {
    h.getChartById.mockReturnValue(chartWith(designQuerySpec({ mark: "card" })));
    setChartRightClickTarget(westBar({ memberPath: null, memberLabels: [], drillIdentity: "measureOnly", categoryName: "Revenue" }));
    await render();

    expect(item("drillThrough")?.textContent).toBe("Drill through");
    await click("drillThrough");
    expect(h.runDrillThrough.mock.calls[0][2]).toStrictEqual({ filters: [] });
  });

  it("a datum with NO identity is offered DISABLED with the reason, and a click runs nothing and keeps the menu open", async () => {
    setChartRightClickTarget(
      westBar({ memberPath: null, memberLabels: [], drillIdentity: "none", drillIdentityReason: TRANSFORMED_SOURCE_REASON }),
    );
    await render();

    const row = item("drillThrough");
    expect(row?.textContent).toBe("Drill through");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.getAttribute("data-chart-menu-disabled")).toBe("true");
    expect(row?.getAttribute("title")).toBe(TRANSFORMED_SOURCE_REASON);
    await click("drillThrough");
    expect(h.runDrillThrough).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("falls back to the drawn point labels when a coordinate has no label of its own", () => {
    // A two-field category: keys for both coordinates, one drawn label. The
    // row still names the point rather than going mute.
    const subject = subjectFor(
      westBar({
        memberPath: [
          { field: "Geo.Region", key: "East" },
          { field: "Product.Color", key: "Red" },
        ],
        memberLabels: [null, null],
        categoryName: "East > Red",
        seriesName: "Sales",
      }),
    );
    expect(drillThroughRowLabel(subject)).toBe("Drill through: East > Red, Sales");
  });

  it("is absent without a definition, on a chart that reads cells, and on a non-datum subject", async () => {
    h.getChartById.mockReturnValue(chartWith(designQuerySpec({ drillThrough: undefined })));
    setChartRightClickTarget(westBar());
    await render();
    expect(itemIds()).not.toContain("drillThrough");
    await act(async () => root!.unmount());
    root = null;
    container.remove();

    h.getChartById.mockReturnValue(chartWith(rangeSpec()));
    setChartRightClickTarget({ chartId: "chart-1", element: "datum", seriesIndex: 1, pointIndex: 2, seriesName: "Cost", categoryName: "Mar" });
    await render();
    expect(itemIds()).not.toContain("drillThrough");
    await act(async () => root!.unmount());
    root = null;
    container.remove();

    h.getChartById.mockReturnValue(chartWith(designQuerySpec()));
    setChartRightClickTarget({ chartId: "chart-1", element: "title" });
    await render();
    expect(itemIds()).not.toContain("drillThrough");
  });
});

// ============================================================================
// The authoring row
// ============================================================================

describe("the Drill-through behavior... row", () => {
  it("sits in the object block right before Edit Script..., on a design-query chart, and opens the dialog editable", async () => {
    setChartRightClickTarget(westBar());
    await render();

    const ids = itemIds();
    expect(ids[ids.indexOf("editScript") - 1]).toBe("drillThroughBehavior");
    expect(item("drillThroughBehavior")?.textContent).toBe("Drill-through behavior...");
    await click("drillThroughBehavior");
    expect(order).toEqual(["close"]);
    expect(h.showDialog).toHaveBeenCalledWith("chart:drillThroughBehavior", { chartId: "chart-1", readOnly: false });
  });

  it("is offered on a design-query chart that has NO definition yet (that is how one is authored), and never on a range chart", async () => {
    h.getChartById.mockReturnValue(chartWith(designQuerySpec({ drillThrough: undefined })));
    await render();
    expect(itemIds()).toContain("drillThroughBehavior");
    await act(async () => root!.unmount());
    root = null;
    container.remove();

    h.getChartById.mockReturnValue(chartWith(rangeSpec()));
    await render();
    expect(itemIds()).not.toContain("drillThroughBehavior");
  });

  it("reads View drill-through... on a SUBSCRIBED worksheet and opens the dialog read-only", async () => {
    h.isSheetSubscribed.mockImplementation((id: string) => id === "sheet-0");
    await render();

    expect(h.isSheetSubscribed).toHaveBeenCalledWith("sheet-0");
    expect(item("drillThroughBehavior")?.textContent).toBe("View drill-through...");
    await click("drillThroughBehavior");
    expect(h.showDialog).toHaveBeenCalledWith("chart:drillThroughBehavior", { chartId: "chart-1", readOnly: true });
  });

  it("is absent on a subscribed sheet when there is nothing to view", async () => {
    h.isSheetSubscribed.mockReturnValue(true);
    h.getChartById.mockReturnValue(chartWith(designQuerySpec({ drillThrough: undefined })));
    await render();
    expect(itemIds()).not.toContain("drillThroughBehavior");
  });

  it("a canvas page in consume mode (a subscribed page) is read-only through the layout surface", async () => {
    h.getLayoutSurface.mockImplementation((idx: number) => (idx === 2 ? { editable: false } : null));
    h.getChartById.mockReturnValue(chartWith(designQuerySpec(), 2));
    await render();
    expect(item("drillThroughBehavior")?.textContent).toBe("View drill-through...");
    expect(chartDrillReadOnly({ sheetIndex: 2 })).toBe(true);
    expect(chartDrillReadOnly({ sheetIndex: 0 })).toBe(false);
  });

  it("the run row stays available where the definition is read-only: running is a content action", async () => {
    h.isSheetSubscribed.mockReturnValue(true);
    setChartRightClickTarget(westBar());
    await render();
    expect(item("drillThrough")?.getAttribute("aria-disabled")).toBeNull();
    await click("drillThrough");
    expect(h.runDrillThrough).toHaveBeenCalledTimes(1);
  });
});
