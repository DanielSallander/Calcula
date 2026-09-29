//! FILENAME: app/extensions/CanvasSheet/__tests__/wholeSelectionWorksheet.test.ts
// PURPOSE: The whole-selection Delete (open-items 2.af row 1) is a CANVAS rule.
//          On a WORKSHEET, a chart walked down to its TITLE with a slicer still
//          selected must keep "Delete deletes the title" -- not the whole chart
//          and the slicer with it (wave A review of V1).
// CONTEXT: A worksheet has no selection set: Core gates press parity on the
//          canvas surface (overlayMoveHandlers.ts), and Slicer and Controls
//          ignore presses on other types, so a slicer clicked before a chart
//          stays selected there. `objectSelectionSpansFamilies()` therefore
//          answers yes on a worksheet too, and Charts' and Controls' Delete
//          doors used to ask exactly that, ahead of the chart's title rung.
//          The doors now ask the seam's one rule,
//          `shouldActOnWholeObjectSelection()` (canvas AND spans). Driven with
//          the real Charts and Slicer selection providers and the real seam.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

let surface: "grid" | "canvas" = "grid";
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ surface, sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface, sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("../../Slicer/lib/slicerStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSlicerById: (id: string) => (id === "s1" ? { id: "s1", name: "Slicer_Region" } : undefined),
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  objectSelectionSpansFamilies,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  shouldActOnWholeObjectSelection,
} from "@api/objectSelection";
import { createChartObjectSelectionProvider } from "../../Charts/lib/chartObjectSelection";
import {
  getSubSelection,
  resetSelectionHandlerState,
  selectChart,
  setSubSelection,
} from "../../Charts/handlers/selectionHandler";
import { createSlicerSelectionProvider } from "../../Slicer/lib/slicerObjectSelection";
import { selectSlicer } from "../../Slicer/handlers/selectionHandler";
import { canvasDeleteApplies } from "../lib/canvasDelete";

const chartRegion: GridRegion = {
  id: "chart-c1", type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
  floating: { x: 0, y: 0, width: 100, height: 100 }, data: { chartId: "c1", name: "Sales" },
};
const slicerRegion: GridRegion = {
  id: "slicer-s1", type: "slicer", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
  floating: { x: 200, y: 0, width: 100, height: 100 }, data: { slicerId: "s1" },
};

const cleanups: Array<() => void> = [];
let gridContainer: HTMLDivElement;

beforeEach(() => {
  surface = "grid";
  resetSelectionHandlerState();
  resetObjectSelectionProviders();
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "slicer", render: () => {}, priority: 14 }),
    registerObjectSelectionProvider(
      createChartObjectSelectionProvider({
        emitSelection: vi.fn(),
        invalidateChart: vi.fn(),
        refresh: vi.fn(),
        deleteCharts: async () => [],
      }),
    ),
    registerObjectSelectionProvider(createSlicerSelectionProvider()),
  );
  setGridRegions([chartRegion, slicerRegion]);
  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  gridContainer.tabIndex = 0;
  document.body.appendChild(gridContainer);
  gridContainer.focus();
  // A worksheet: click the slicer, then the chart, then the chart's title.
  selectSlicer("s1", false);
  selectChart("c1");
  setSubSelection("c1", { level: "element", elementId: "title" } as never);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  setGridRegions([]);
  gridContainer.remove();
});

describe("the whole-selection rule is a canvas rule", () => {
  it("on a WORKSHEET a chart's title with a slicer still selected is NOT a whole-selection Delete", () => {
    expect(getSubSelection()).toMatchObject({ level: "element", elementId: "title" });
    // Precondition: both families hold a member, so the selection spans them.
    expect(objectSelectionSpansFamilies(), "precondition: chart + slicer both selected").toBe(true);
    expect(
      shouldActOnWholeObjectSelection(),
      "a worksheet Delete on the chart's TITLE was handed to the whole-selection delete",
    ).toBe(false);
    expect(canvasDeleteApplies(), "the canvas binding claimed a worksheet Delete").toBe(false);
  });

  it("on a CANVAS the same selection is one (control: the rule still fires where it belongs)", () => {
    surface = "canvas";
    expect(shouldActOnWholeObjectSelection()).toBe(true);
    expect(canvasDeleteApplies()).toBe(true);
  });
});

describe("the families' Delete doors ask the seam's canvas rule before their own rungs", () => {
  function body(src: string, from: string, to: string): string {
    const at = src.indexOf(from);
    expect(at, `missing: ${from}`).toBeGreaterThan(-1);
    const end = src.indexOf(to, at);
    expect(end, `missing: ${to}`).toBeGreaterThan(at);
    return src.slice(at, end);
  }

  it("Charts: the hand-off is gated on shouldActOnWholeObjectSelection, never the bare spans predicate", () => {
    const src = readFileSync(resolve(__dirname, "../../Charts/index.ts"), "utf8");
    const door = body(src, "const runChartDeleteAction = (): void => {", "isChartTextElement(sub.elementId)");
    expect(door).toMatch(/if \(shouldActOnWholeObjectSelection\(\)\) \{\s*void deleteSelectedObjects\(\);\s*return;/);
    expect(door).not.toContain("objectSelectionSpansFamilies()");
  });

  it("Controls: the same rule", () => {
    const src = readFileSync(resolve(__dirname, "../../Controls/index.ts"), "utf8");
    const door = body(src, "async function deleteSelectedControls(): Promise<void> {", "async function deleteControlsWithGroups");
    expect(door).toMatch(/if \(shouldActOnWholeObjectSelection\(\)\) \{\s*await deleteSelectedObjects\(\);\s*return;/);
    expect(door).not.toContain("objectSelectionSpansFamilies()");
  });
});
