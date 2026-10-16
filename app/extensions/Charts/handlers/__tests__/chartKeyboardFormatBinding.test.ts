//! FILENAME: app/extensions/Charts/handlers/__tests__/chartKeyboardFormatBinding.test.ts
// PURPOSE: Ctrl+1 — Excel's universal "format this" — on a selected chart
//          opens the ONE object pane on its Format tab (WP-C D-PANE), with the
//          chart's ladder rung published FIRST so the "Chart elements" card
//          shows the element the reader picked; and the cells keep Ctrl+1 the
//          rest of the time. Exercised through the REAL keybinding dispatcher
//          and the REAL object-pane extension (its binding, command and host).
// CONTEXT: The chart used to own its own Ctrl+1 binding
//          (`ext.charts.formatSelection`, guarded by "a chart is selected").
//          Two guarded bindings for one key is two owners of one gesture; the
//          object pane's binding (`ext.objectPane.format`: an object with a
//          pane is the primary selection and the grid has the keyboard) now
//          answers for EVERY family, and the chart takes part through its pane
//          provider's `beforeShowFormat`, which the host calls on every door
//          that lands on Format. So:
//            - the Charts source declares no Ctrl+1 binding at all;
//            - Ctrl+1 on a selected chart = the object pane on Format, the rung
//              published before the pane says it opened;
//            - no chart selected = Format Cells, untouched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas", sheetContext: { activeSheetIndex: 0 } }),
}));

import { CommandRegistry } from "@api/commands";
import { getAllKeybindings, handleGlobalKeyDown, registerKeybinding } from "@api/keybindings";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  OBJECT_PANE_FORMAT_TAB,
  getObjectPaneState,
  onObjectPaneStateChanged,
  registerObjectPaneProvider,
  resetObjectPane,
} from "@api/objectPane";
import { resetObjectPosition } from "@api/objectPosition";
import { clearObjectSelection, resetObjectSelectionProviders, selectObject } from "@api/objectSelection";
import type { ExtensionContext } from "@api/contract";
import ObjectPaneExtension from "../../../BuiltIn/ObjectPane/index";
import { resetPaneState } from "../../../BuiltIn/ObjectPane/lib/paneState";
import { resetTabMemory } from "../../../BuiltIn/ObjectPane/lib/tabMemory";
import {
  floatingRegion,
  installFakeTaskPanes,
  installSelectionFamily,
} from "../../../BuiltIn/ObjectPane/__tests__/harness";
import { createChartObjectPaneProvider, openChartFormatPane } from "../../lib/chartObjectPane";
import type { ChartDefinition } from "../../types";

const CELLS_COMMAND = "core.format.cells";

function chartRegion(regionId: string, chartId: string, x = 40): GridRegion {
  const r = floatingRegion(regionId, "chart", x);
  return { ...r, data: { chartId, name: `Chart ${chartId}` } };
}

const CHART_A = chartRegion("chart-a", "a");
const CHART_B = chartRegion("chart-b", "b", 400);

function chartDef(chartId: string): ChartDefinition {
  return {
    chartId,
    name: `Chart ${chartId}`,
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    spec: {
      mark: "bar",
      data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [],
      title: null,
      xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
      yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
      legend: { visible: false, position: "bottom" },
      palette: "default",
    },
  };
}

let ranCells = 0;
let order: string[] = [];
const publish = vi.fn(() => {
  order.push("publish");
});
const cleanups: Array<() => void> = [];

function ctrl1(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true });
}

function context(): ExtensionContext {
  return {
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
      has: (id: string) => CommandRegistry.has(id),
    },
  } as unknown as ExtensionContext;
}

beforeEach(async () => {
  document.body.innerHTML = "";
  ranCells = 0;
  order = [];
  publish.mockClear();
  resetObjectPane();
  resetObjectSelectionProviders();
  resetObjectPosition();
  resetPaneState();
  resetTabMemory(true);
  installFakeTaskPanes();
  cleanups.push(installSelectionFamily("chart").cleanup);
  setGridRegions([CHART_A, CHART_B]);
  cleanups.push(
    registerObjectPaneProvider(
      createChartObjectPaneProvider({
        getChart: (id) => (id === "a" || id === "b" ? chartDef(id) : null),
        publishSelection: publish,
        openDataEditor: () => {},
      }),
    ),
  );
  cleanups.push(onObjectPaneStateChanged((s) => order.push(s.open ? `open:${s.regionId}:${s.tabId}` : "closed")));

  CommandRegistry.register(CELLS_COMMAND, () => {
    ranCells += 1;
  });
  cleanups.push(() => CommandRegistry.unregister(CELLS_COMMAND));
  // The built-in, registered FIRST, exactly as the shell does at startup.
  cleanups.push(
    registerKeybinding({
      id: "test.core.formatCells",
      combo: "Ctrl+1",
      commandId: CELLS_COMMAND,
      label: "Format Cells",
      category: "Formatting",
      source: "built-in",
    }),
  );

  await ObjectPaneExtension.activate(context());
  cleanups.push(() => void ObjectPaneExtension.deactivate?.());

  const grid = document.createElement("div");
  grid.setAttribute("data-focus-container", "spreadsheet");
  const surface = document.createElement("div");
  surface.tabIndex = 0;
  grid.appendChild(surface);
  document.body.appendChild(grid);
  surface.focus();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
  document.body.innerHTML = "";
});

/** Charts/index.ts with its comments stripped (a comment naming the old binding is history, not code). */
function chartsIndexCode(): string {
  const src = fs.readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("Ctrl+1 on a chart is the object pane's", () => {
  it("the Charts extension declares NO Ctrl+1 binding of its own", () => {
    const code = chartsIndexCode();
    expect(code).not.toContain("ext.charts.formatSelection");
    expect(code).not.toMatch(/combo:\s*["']Ctrl\+1["']/);
    // Non-vacuity: the extractor really reads code (the chart still registers
    // its "format the selection" COMMAND).
    expect(code).toContain("CommandRegistry.register(CHART_FORMAT_PANE_COMMAND");
    expect(getAllKeybindings().some((b) => b.id === "ext.charts.formatSelection")).toBe(false);
  });

  it("with a chart selected, opens the object pane on Format -- the rung published FIRST", () => {
    selectObject(CHART_A);
    expect(handleGlobalKeyDown(ctrl1())).toBe(true);
    expect(ranCells).toBe(0);
    const s = getObjectPaneState();
    expect(s).toMatchObject({ open: true, regionId: CHART_A.id, regionType: "chart", tabId: OBJECT_PANE_FORMAT_TAB });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(order.indexOf("publish")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("publish")).toBeLessThan(order.indexOf(`open:${CHART_A.id}:${OBJECT_PANE_FORMAT_TAB}`));
  });

  it("with no object selected, Format Cells keeps the key and nothing is published", () => {
    clearObjectSelection();
    expect(handleGlobalKeyDown(ctrl1())).toBe(true);
    expect(ranCells).toBe(1);
    expect(getObjectPaneState().open).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("follows the selection as it changes, without re-registering anything", () => {
    clearObjectSelection();
    handleGlobalKeyDown(ctrl1());
    expect(ranCells).toBe(1);
    selectObject(CHART_B);
    handleGlobalKeyDown(ctrl1());
    expect(getObjectPaneState().regionId).toBe(CHART_B.id);
    expect(ranCells).toBe(1);
  });
});

describe("the chart's own format door (double-click, \"Format <element>...\", the redirectors)", () => {
  it("publishes the rung, then opens the pane on Format for THAT chart, even when another is primary", () => {
    selectObject(CHART_A);
    order = [];
    expect(openChartFormatPane(publish, "b")).toBe(true);
    expect(order[0]).toBe("publish");
    expect(getObjectPaneState()).toMatchObject({ open: true, regionId: CHART_B.id, tabId: OBJECT_PANE_FORMAT_TAB });
  });

  it("without a chart id it opens on the primary object", () => {
    selectObject(CHART_A);
    expect(openChartFormatPane(publish, null)).toBe(true);
    expect(getObjectPaneState().regionId).toBe(CHART_A.id);
  });
});
