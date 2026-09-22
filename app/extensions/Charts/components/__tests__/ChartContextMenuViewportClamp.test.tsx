//! FILENAME: app/extensions/Charts/components/__tests__/ChartContextMenuViewportClamp.test.tsx
// PURPOSE: The chart context menu's LAST row must be inside the viewport.
// CONTEXT: The menu clamped its `top` from an ESTIMATE — `40 + (rows +
//          contributions + 1) * 26`. Over a data table (the lowest object on a
//          chart) at the journey's default placement in a 1280x800 window the
//          estimate came up short, and the row that falls off is always the last
//          one, which is always "Format <element>...". Playwright reported
//          "element is visible, enabled and stable" and then "element is outside
//          of the viewport" on every retry for thirty seconds.
//
//          The fix measures the rendered box in a layout effect. jsdom does no
//          layout, so `getBoundingClientRect` is stubbed here: this test is
//          about the CLAMP ARITHMETIC reading a measurement rather than a
//          guess, which is exactly the part jsdom can answer.

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

import { ChartContextMenu } from "../ChartContextMenu";
import { setChartRightClickTarget } from "@api/chartData";
import { resetChartContextMenuContributions } from "@api/chartContextMenu";

/** The window the live journey runs in. */
const VIEWPORT_H = 800;
const VIEWPORT_W = 1280;

/** A menu TALLER than the estimate `40 + rows * 26` produces. */
const MEASURED_H = 340;
const MEASURED_W = 220;

function spec(): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Cost", sourceIndex: 1, color: null }],
    title: "Costs",
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    dataTable: { enabled: true },
  } as unknown as ChartSpec;
}

let container: HTMLDivElement;
let root: Root | null = null;
let originalRect: () => DOMRect;

beforeEach(() => {
  resetChartContextMenuContributions();
  h.getChartById.mockReset();
  h.getChartById.mockReturnValue({
    chartId: "chart-1", name: "Costs", sheetIndex: 0,
    x: 0, y: 0, width: 400, height: 300, spec: spec(),
  });
  setChartRightClickTarget({
    chartId: "chart-1",
    element: "dataTable",
  } as never);
  (window as unknown as { innerHeight: number }).innerHeight = VIEWPORT_H;
  (window as unknown as { innerWidth: number }).innerWidth = VIEWPORT_W;

  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0, y: 0, width: MEASURED_W, height: MEASURED_H,
      top: 0, right: MEASURED_W, bottom: MEASURED_H, left: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
});

async function renderAt(screenX: number, screenY: number): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(ChartContextMenu, {
        onClose: () => {},
        data: { chartId: "chart-1", screenX, screenY },
      }),
    );
  });
  const menu = container.querySelector("[data-chart-context-menu]") as HTMLElement | null;
  expect(menu, "the menu did not render").not.toBeNull();
  return menu!;
}

describe("the chart context menu fits the viewport", () => {
  it("clamps from the MEASURED height, so the last row is on screen", async () => {
    const menu = await renderAt(400, 600);
    const top = parseFloat(menu.style.top);
    expect(top + MEASURED_H).toBeLessThanOrEqual(VIEWPORT_H);
    expect(top).toBe(VIEWPORT_H - MEASURED_H);
  });

  it("NEGATIVE CONTROL: the row-count estimate would have overflowed", async () => {
    // The estimate this replaced: 40 + (rows + contributions + 1) * 26. Whatever
    // the exact row count is, it has to come to LESS than the measured height
    // for this fixture — otherwise the test above is not testing the fix.
    const menu = await renderAt(400, 600);
    const rows = menu.querySelectorAll("[data-chart-menu-item]").length;
    const estimate = 40 + (rows + 1) * 26;
    expect(estimate).toBeLessThan(MEASURED_H);
    // ...and with the estimate the menu's bottom edge would have been off-screen.
    const estimatedTop = Math.max(0, Math.min(600, VIEWPORT_H - estimate));
    expect(estimatedTop + MEASURED_H).toBeGreaterThan(VIEWPORT_H);
  });

  it("clamps the LEFT edge from the measured width too", async () => {
    const menu = await renderAt(VIEWPORT_W - 20, 100);
    expect(parseFloat(menu.style.left)).toBe(VIEWPORT_W - MEASURED_W);
  });

  it("leaves a menu that already fits exactly where it was asked for", async () => {
    const menu = await renderAt(100, 120);
    expect(parseFloat(menu.style.top)).toBe(120);
    expect(parseFloat(menu.style.left)).toBe(100);
  });

  it("never pushes the menu off the TOP to make it fit", async () => {
    // A menu taller than the whole window: the clamp must bottom out at 0
    // rather than going negative, so the first rows stay reachable.
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return {
        x: 0, y: 0, width: MEASURED_W, height: VIEWPORT_H + 200,
        top: 0, right: MEASURED_W, bottom: VIEWPORT_H + 200, left: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
    const menu = await renderAt(400, 600);
    expect(parseFloat(menu.style.top)).toBe(0);
  });
});
