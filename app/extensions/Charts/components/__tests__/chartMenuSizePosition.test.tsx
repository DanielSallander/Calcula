//! FILENAME: app/extensions/Charts/components/__tests__/chartMenuSizePosition.test.tsx
// PURPOSE: A chart's right-click menu carries "Size and Position..." (BUG-0258
//          design phase 5b) -- the no-drag route every object menu offers --
//          among its object-level rows, and choosing it closes the menu and
//          opens the dialog for THIS chart's published region
//          (@api/objectPosition's opener). With no dialog installed, or the
//          chart not published, the row is omitted (this menu greys nothing).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  getChartById: vi.fn(),
  closes: 0,
}));

vi.mock("@api", () => ({ showDialog: vi.fn() }));
vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
}));
vi.mock("../../lib/chartStore", () => ({
  getChartById: h.getChartById,
  updateChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
}));
vi.mock("../../rendering/chartRenderer", () => ({
  invalidateChartCache: vi.fn(),
}));
vi.mock("../../manifest", () => ({ CHART_DIALOG_ID: "chart:createDialog" }));

import { ChartContextMenu } from "../ChartContextMenu";
import { setChartRightClickTarget } from "@api/chartData";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "@api/objectGeometry";
import { SIZE_AND_POSITION_LABEL, registerSizeAndPositionOpener, resetObjectPosition } from "@api/objectPosition";

const REGION: GridRegion = {
  id: "chart-chart-1",
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: { chartId: "chart-1" },
  floating: { x: 100, y: 100, width: 400, height: 260 },
};
const OTHER: GridRegion = { ...REGION, id: "chart-chart-2", data: { chartId: "chart-2" } };

let container: HTMLDivElement;
let root: Root;
const cleanups: Array<() => void> = [];

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(ChartContextMenu, {
        onClose: () => {
          h.closes++;
        },
        data: { chartId: "chart-1", screenX: 10, screenY: 10 },
      }),
    );
  });
}

const itemIds = () => [...container.querySelectorAll("[data-chart-menu-item]")].map((el) => el.getAttribute("data-chart-menu-item")!);

beforeEach(() => {
  h.closes = 0;
  h.getChartById.mockReturnValue({
    chartId: "chart-1",
    name: "Chart 1",
    sheetIndex: 0,
    spec: {
      mark: "bar",
      title: "Revenue",
      data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Revenue", sourceIndex: 1, color: null }],
      xAxis: {},
      yAxis: {},
      legend: { visible: true, position: "right" },
      palette: "default",
    },
  });
  setChartRightClickTarget(null);
  resetObjectPosition();
  resetObjectGeometryProviders();
  cleanups.push(registerObjectGeometryProvider({ types: ["chart"], commit: async () => {} }));
  setGridRegions([OTHER, REGION]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("the chart menu's Size and Position...", () => {
  it("is an object-level row, before Edit Script, and opens the dialog for THIS chart's region (menu closed first)", async () => {
    const opened: string[] = [];
    cleanups.push(
      registerSizeAndPositionOpener((r) => {
        opened.push(`${r.id}@close${h.closes}`);
      }),
    );
    await render();
    const ids = itemIds();
    expect(ids.indexOf("sizeAndPosition")).toBe(ids.indexOf("editScript") - 1);
    const row = container.querySelector('[data-chart-menu-item="sizeAndPosition"]')!;
    expect(row.textContent).toBe(SIZE_AND_POSITION_LABEL);
    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual([`${REGION.id}@close1`]);
  });

  it("no dialog installed, or the chart not published: no row", async () => {
    await render();
    expect(itemIds()).not.toContain("sizeAndPosition");
    await act(async () => root.unmount());
    root = createRoot(container);
    cleanups.push(registerSizeAndPositionOpener(() => {}));
    setGridRegions([OTHER]);
    await render();
    expect(itemIds()).not.toContain("sizeAndPosition");
  });
});
