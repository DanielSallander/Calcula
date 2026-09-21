//! FILENAME: app/extensions/Charts/handlers/__tests__/chartPlotAreaLegendMenu.test.tsx
// PURPOSE: "Hide Legend Entry" as the reader actually reaches it — the row in
//          the chart context menu, rendered, clicked, and checked for what it
//          wrote and where it left the selection.
// CONTEXT: GAP 2's whole point is that `LegendSpec.hiddenEntries` had no
//          writer, so the finest act available on one legend row was hiding the
//          WHOLE legend. A pure test of the patch proves the resolver; it does
//          not prove that a reader can ask for it, that the row is offered only
//          where it means something, or that it moves the selection off the row
//          it just made disappear.
//
//          The menu is rendered against DOUBLES for everything outside it, the
//          same way ChartContextMenu.test.tsx does, so each case states one
//          chart spec and one recorded right-click and nothing else can reach
//          the result. `../selectionHandler` is deliberately NOT doubled: where
//          the selection lands is half of what is under test here, and a
//          doubled ladder would only prove that a spy was called.

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
  getCachedChartData: vi.fn(),
  showDialog: vi.fn(),
  emitAppEvent: vi.fn(),
}));

// `@api` carries BOTH the menu's `showDialog` and the four task-pane/panel
// functions the real selection handler calls when a chart is selected.
vi.mock("@api", () => ({
  showDialog: h.showDialog,
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));
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
  getCachedChartData: h.getCachedChartData,
}));
// The real manifest drags the whole dialog/panel tree in; the selection handler
// only needs the Design panel definition to exist when a chart is selected.
vi.mock("../../manifest", () => ({
  CHART_DIALOG_ID: "chart:createDialog",
  CHART_DESIGN_TAB_ID: "chart-design",
  buildChartDesignPanelDefinition: () => ({ id: "chart-design", sections: [] }),
}));

import { ChartContextMenu } from "../../components/ChartContextMenu";
import { setChartRightClickTarget, type ChartRightClickTarget } from "@api/chartData";
import { resetChartContextMenuContributions } from "@api/chartContextMenu";
import {
  getSubSelection,
  resetSelectionHandlerState,
  selectChart,
  setSubSelection,
} from "../selectionHandler";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const CHART_ID = "chart-1";

function baseSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
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
      { name: "Margin", sourceIndex: 3, color: null },
    ],
    xAxis: {},
    yAxis: {},
    legend: { visible: true, position: "right" },
    palette: "default",
    ...overrides,
  } as ChartSpec;
}

/** A right-click on the legend row that stands for series `seriesIndex`. */
function onLegendEntry(seriesIndex: number): ChartRightClickTarget {
  return {
    chartId: CHART_ID,
    element: "legendEntry",
    seriesIndex,
    seriesName: baseSpec().series[seriesIndex]?.name,
  };
}

/** The legend rows as the layout measured them, in paint order. */
function measuredRows(indices: number[]): unknown {
  return {
    layout: {
      elements: {
        legendItems: indices.map((seriesIndex) => ({
          seriesIndex,
          rect: { x: 0, y: seriesIndex * 20, width: 80, height: 18 },
        })),
      },
    },
  };
}

// ----------------------------------------------------------------------------
// Rendering harness
// ----------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null = null;

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(ChartContextMenu, {
        onClose: () => undefined,
        data: { chartId: CHART_ID, screenX: 10, screenY: 10 },
      }),
    );
  });
}

function itemIds(): string[] {
  return [...container.querySelectorAll("[data-chart-menu-item]")].map(
    (el) => el.getAttribute("data-chart-menu-item")!,
  );
}

async function click(id: string): Promise<void> {
  const el = container.querySelector(`[data-chart-menu-item="${id}"]`);
  if (!el) throw new Error(`No menu item "${id}". Present: ${itemIds().join(", ")}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChartContextMenuContributions();
  setChartRightClickTarget(null);
  resetSelectionHandlerState();
  h.getChartById.mockReturnValue({
    chartId: CHART_ID,
    name: "Chart 1",
    sheetIndex: 0,
    spec: baseSpec(),
  });
  h.getCachedChartData.mockReturnValue(measuredRows([0, 1, 2]));
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
  resetSelectionHandlerState();
});

// ============================================================================
// The row
// ============================================================================

describe('the "Hide Legend Entry" row', () => {
  it("is offered on a legend ENTRY, above the coarser Delete Legend", async () => {
    setChartRightClickTarget(onLegendEntry(1));
    await render();
    const ids = itemIds();
    expect(ids).toContain("hideLegendEntry");
    // The finer act comes first: a reader who right-clicked ONE row means that
    // row, and putting "Delete Legend" nearer the pointer is how the coarser
    // verb gets chosen by accident.
    expect(ids.indexOf("hideLegendEntry")).toBeLessThan(ids.indexOf("deleteLegend"));
  });

  it("is NOT offered on the whole legend — there is no single row to hide", async () => {
    setChartRightClickTarget({ chartId: CHART_ID, element: "legend" });
    await render();
    expect(itemIds()).not.toContain("hideLegendEntry");
    expect(itemIds()).toContain("deleteLegend");
  });

  it("is NOT offered on a row that is already hidden", async () => {
    h.getChartById.mockReturnValue({
      chartId: CHART_ID,
      name: "Chart 1",
      sheetIndex: 0,
      spec: baseSpec({ legend: { visible: true, position: "right", hiddenEntries: [1] } } as Partial<ChartSpec>),
    });
    setChartRightClickTarget(onLegendEntry(1));
    await render();
    // An always-live item that does nothing is how a reader learns to ignore a
    // menu; the resolver answers null and the row simply is not there.
    expect(itemIds()).not.toContain("hideLegendEntry");
  });

  it("is NOT offered when the legend is switched off entirely", async () => {
    h.getChartById.mockReturnValue({
      chartId: CHART_ID,
      name: "Chart 1",
      sheetIndex: 0,
      spec: baseSpec({ legend: { visible: false, position: "right" } } as Partial<ChartSpec>),
    });
    setChartRightClickTarget(onLegendEntry(1));
    await render();
    expect(itemIds()).not.toContain("hideLegendEntry");
  });
});

// ============================================================================
// What clicking it does
// ============================================================================

describe("clicking it", () => {
  it("writes ONE index and leaves the legend — and the series — alone", async () => {
    setChartRightClickTarget(onLegendEntry(1));
    setSubSelection(CHART_ID, { level: "element", elementId: "legendEntry", seriesIndex: 1 });
    await render();
    await click("hideLegendEntry");

    expect(h.updateChartSpec).toHaveBeenCalledTimes(1);
    const [id, patch] = h.updateChartSpec.mock.calls[0];
    expect(id).toBe(CHART_ID);
    expect(patch.legend.hiddenEntries).toEqual([1]);
    // NOT `visible: false` — that is "Delete Legend", the coarser act this row
    // exists to make unnecessary.
    expect(patch.legend.visible).toBe(true);
    expect(patch.series).toBeUndefined();
  });

  it("is ONE spec write, therefore one undo entry", async () => {
    // Our recorded divergence from Excel, which makes you remove the whole
    // legend and recreate it: here the removal is one ordinary spec edit.
    setChartRightClickTarget(onLegendEntry(0));
    await render();
    await click("hideLegendEntry");
    expect(h.updateChartSpec).toHaveBeenCalledTimes(1);
  });

  it("moves the selection to the NEXT surviving row, never the one it hid", async () => {
    selectChart(CHART_ID);
    setSubSelection(CHART_ID, { level: "element", elementId: "legendEntry", seriesIndex: 1 });
    setChartRightClickTarget(onLegendEntry(1));
    await render();
    await click("hideLegendEntry");

    expect(getSubSelection()).toEqual({
      level: "element",
      elementId: "legendEntry",
      seriesIndex: 2,
    });
  });

  it("falls back to the chart when the last row goes", async () => {
    h.getCachedChartData.mockReturnValue(measuredRows([2]));
    selectChart(CHART_ID);
    setSubSelection(CHART_ID, { level: "element", elementId: "legendEntry", seriesIndex: 2 });
    setChartRightClickTarget(onLegendEntry(2));
    await render();
    await click("hideLegendEntry");

    // With every row hidden the legend box is not laid out at all, so neither
    // an entry nor the whole legend is a rung that exists.
    expect(getSubSelection()).toEqual({ level: "chart" });
  });

  it("reads the measured rows BEFORE dropping the render cache", async () => {
    // The selection has to land on a row that exists, and the post-write layout
    // does not exist yet — so the order matters, and reversing it would put the
    // selection on whatever a freshly invalidated cache happened to answer.
    const order: string[] = [];
    h.getCachedChartData.mockImplementation(() => {
      order.push("read");
      return measuredRows([0, 1, 2]);
    });
    h.invalidateChartCache.mockImplementation(() => {
      order.push("invalidate");
    });
    selectChart(CHART_ID);
    setChartRightClickTarget(onLegendEntry(0));
    await render();
    await click("hideLegendEntry");

    expect(order[0]).toBe("read");
    expect(order).toContain("invalidate");
    expect(order.indexOf("read")).toBeLessThan(order.indexOf("invalidate"));
  });
});
