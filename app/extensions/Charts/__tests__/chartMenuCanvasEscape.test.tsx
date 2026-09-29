//! FILENAME: app/extensions/Charts/__tests__/chartMenuCanvasEscape.test.tsx
// PURPOSE: On a CANVAS, Escape with a chart's or an axis's right-click menu
//          open closes THE MENU -- the canvas's Escape binding does not take
//          the key to deselect the chart behind it (BUG-0196, chart part).
// CONTEXT: The canvas binding (CanvasSheet lib/objectCycling.ts, "Escape
//          clears the selection set") runs in the dispatcher's window-CAPTURE
//          listener and stops the key on a match; both menus listen on
//          `document` (capture), later on the same path, so they never heard
//          it: Escape deselected the chart and left its menu open, offering
//          actions for an object that was no longer selected. The binding asks
//          the object's family first (`objectOwnsKey`); Charts now answers
//          "mine" for Escape while one of its menus is open -- the Floating
//          Range's worked example (FloatingRange/lib/frObjectSelection.ts).
//          Driven through the real dispatcher, the real canvas binding, the
//          real chart selection provider and the real menu components.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas" }),
}));

const h = vi.hoisted(() => ({
  getChartById: vi.fn(),
}));

vi.mock("../lib/chartStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chartStore")>()),
  getChartById: h.getChartById,
  updateChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
}));
vi.mock("../rendering/chartRenderer", () => ({
  invalidateChartCache: vi.fn(),
}));

import { initKeybindings } from "@api/keybindings";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { resetObjectSelectionProviders, registerObjectSelectionProvider } from "@api/objectSelection";
import { installCanvasObjectKeyboard } from "../../CanvasSheet/lib/objectCycling";
import { ChartContextMenu } from "../components/ChartContextMenu";
import { AxisContextMenu } from "../components/AxisContextMenu";
import { createChartObjectSelectionProvider } from "../lib/chartObjectSelection";
import { isChartMenuOpen } from "../lib/chartMenuState";
import {
  getCurrentChartId,
  resetSelectionHandlerState,
  selectChart,
} from "../handlers/selectionHandler";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The shell's order: the dispatcher's window-capture listener first.
initKeybindings();

const CHART_ID = "chart-canvas-menu";
const REGION: GridRegion = {
  id: `chart-${CHART_ID}`,
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 100, y: 100, width: 400, height: 300 },
  data: { chartId: CHART_ID, name: "Costs" },
};

function spec() {
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
  };
}

let host: HTMLDivElement;
let root: Root;
let gridContainer: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn>;
const cleanups: (() => void)[] = [];

async function openChartMenu(): Promise<void> {
  await act(async () => {
    root.render(
      <ChartContextMenu
        onClose={onClose as unknown as () => void}
        data={{ chartId: CHART_ID, screenX: 10, screenY: 10 }}
      />,
    );
  });
}

async function openAxisMenu(): Promise<void> {
  await act(async () => {
    root.render(
      <AxisContextMenu
        onClose={onClose as unknown as () => void}
        data={{ chartId: CHART_ID, axisType: "y", screenX: 10, screenY: 10 }}
      />,
    );
  });
}

function escape(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  gridContainer.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  h.getChartById.mockReset();
  h.getChartById.mockReturnValue({
    chartId: CHART_ID,
    name: "Costs",
    sheetIndex: 0,
    x: 100,
    y: 100,
    width: 400,
    height: 300,
    spec: spec(),
  });
  setGridRegions([REGION]);
  cleanups.push(
    registerObjectSelectionProvider(
      createChartObjectSelectionProvider({
        emitSelection: () => {},
        invalidateChart: () => {},
        refresh: () => {},
      }),
    ),
  );
  cleanups.push(...installCanvasObjectKeyboard("calcula.canvas-sheet"));
  onClose = vi.fn();
  // The right-press leaves the keyboard on the grid's container.
  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  gridContainer.tabIndex = 0;
  document.body.appendChild(gridContainer);
  gridContainer.focus();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // The right-click selected the chart (chart level).
  selectChart(CHART_ID);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  gridContainer.remove();
  while (cleanups.length > 0) cleanups.pop()!();
  setGridRegions([]);
  resetSelectionHandlerState();
});

describe("Escape on a canvas with a chart menu open", () => {
  it("the chart menu: Escape closes it and the chart stays selected", async () => {
    await openChartMenu();
    expect(isChartMenuOpen()).toBe(true);
    await act(async () => {
      escape();
    });
    expect(onClose, "the menu never heard Escape: the canvas binding stopped it first").toHaveBeenCalledTimes(1);
    expect(getCurrentChartId(), "Escape deselected the chart behind the open menu").toBe(CHART_ID);
  });

  it("the axis menu: Escape closes it and the chart stays selected", async () => {
    await openAxisMenu();
    expect(isChartMenuOpen()).toBe(true);
    await act(async () => {
      escape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getCurrentChartId()).toBe(CHART_ID);
  });

  it("the menu consumes the Escape it closes on (nothing behind it hears it)", async () => {
    await openChartMenu();
    let bubbled = false;
    const onBubble = (): void => {
      bubbled = true;
    };
    gridContainer.addEventListener("keydown", onBubble);
    try {
      await act(async () => {
        escape();
      });
    } finally {
      gridContainer.removeEventListener("keydown", onBubble);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bubbled, "the grid container still heard the menu's Escape").toBe(false);
  });

  it("control: with no menu open, Escape on the canvas deselects the chart (the binding applies)", async () => {
    expect(isChartMenuOpen()).toBe(false);
    const e = escape();
    expect(getCurrentChartId()).toBeNull();
    expect(e.defaultPrevented).toBe(true);
  });

  it("control: once the menu has closed, the next Escape is the canvas's again", async () => {
    await openChartMenu();
    await act(async () => root.render(<></>));
    expect(isChartMenuOpen()).toBe(false);
    escape();
    expect(getCurrentChartId()).toBeNull();
  });
});

describe("Charts' own element walk stands down while a menu is open", () => {
  it("handleChartNavKey returns on Escape with a chart menu open, BEFORE it can deselect or step up", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8");
    const at = src.indexOf("const handleChartNavKey = (e: KeyboardEvent) => {");
    expect(at, "the chart element-walk listener is gone").toBeGreaterThan(-1);
    const head = src.slice(at, src.indexOf('if (e.key === "Escape") {', at));
    expect(head).toMatch(/if \(e\.key === "Escape" && isChartMenuOpen\(\)\) return;/);
  });
});
