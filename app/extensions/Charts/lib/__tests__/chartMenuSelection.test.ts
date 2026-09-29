//! FILENAME: app/extensions/Charts/lib/__tests__/chartMenuSelection.test.ts
// PURPOSE: The chart menu's Duplicate / Copy / Paste act on the WHOLE canvas
//          object selection (W25), so the RIGHT-CLICK that opens the menu must
//          leave that selection as the user means it:
//            - on a chart OUTSIDE the selection: the chart becomes THE
//              selection -- a shape selected before must not ride along into
//              the chart's Duplicate;
//            - on a chart the selection SET holds (a second chart): every
//              member stays selected and the clicked chart becomes Charts'
//              current one -- Charts' own `selectChart` used to REPLACE its
//              one chart and drop the first chart out of the multi-selection.
//          And the rows exist on a canvas only.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let surface: "canvas" | "grid" = "canvas";
vi.mock("../../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ surface, sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

import { registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  getSelectedObjectRegions,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
} from "@api/objectSelection";
import { putOnObjectClipboard, resetObjectClipboard } from "@api/objectClipboard";
import { createChartObjectSelectionProvider } from "../chartObjectSelection";
import { chartObjectClipboardRows, selectChartForCanvasMenu } from "../chartMenuSelection";
import { getCurrentChartId, resetSelectionHandlerState } from "../../handlers/selectionHandler";

function chart(id: string, x: number): GridRegion {
  return {
    id: `chart-${id}`, type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
    floating: { x, y: 0, width: 100, height: 100 }, data: { chartId: id, name: id },
  };
}
const c1 = chart("c1", 0);
const c2 = chart("c2", 200);
const k1: GridRegion = {
  id: "k1", type: "floating-control", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
  floating: { x: 400, y: 0, width: 50, height: 20 },
};
let shapeSelected = false;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  surface = "canvas";
  shapeSelected = false;
  resetObjectClipboard();
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "floating-control", render: () => {}, priority: 20 }),
    registerObjectSelectionProvider(
      createChartObjectSelectionProvider({ emitSelection: () => {}, invalidateChart: () => {}, refresh: () => {} }),
    ),
    registerObjectSelectionProvider({
      types: ["floating-control"],
      isSelected: () => shapeSelected,
      select: () => {
        shapeSelected = true;
      },
      deselectAll: () => {
        shapeSelected = false;
      },
    }),
  );
  setGridRegions([c1, c2, k1]);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetObjectClipboard();
  setGridRegions([]);
});

describe("a right-click on a chart, on a canvas", () => {
  it("on a chart OUTSIDE the selection: the chart becomes THE selection (the shape is dropped)", () => {
    setObjectSelectionSet([k1], k1);
    expect(selectChartForCanvasMenu("c1")).toBe(true);
    expect(getCurrentChartId()).toBe("c1");
    expect(shapeSelected, "the shape stayed selected and would be duplicated with the chart").toBe(false);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["chart-c1"]);
  });

  it("on a SET-HELD chart: every member stays selected and the clicked chart becomes Charts' current one", () => {
    setObjectSelectionSet([c1, c2, k1], c1);
    expect(getCurrentChartId()).toBe("c1");
    selectChartForCanvasMenu("c2");
    expect(getCurrentChartId()).toBe("c2");
    expect(
      getSelectedObjectRegions().map((r) => r.id).sort(),
      "the right-click dropped a member out of the multi-selection",
    ).toEqual(["chart-c1", "chart-c2", "k1"]);
  });

  it("control: on a WORKSHEET it does nothing (Charts' own select runs)", () => {
    surface = "grid";
    setObjectSelectionSet([k1], k1);
    expect(selectChartForCanvasMenu("c1")).toBe(false);
    expect(shapeSelected).toBe(true);
  });
});

describe("the chart menu's object rows", () => {
  it("are Duplicate and Copy on a canvas, plus Paste while the object clipboard holds something", () => {
    expect(chartObjectClipboardRows().map((r) => r.id)).toEqual(["duplicateObjects", "copyObjects"]);
    putOnObjectClipboard("chart", [{}]);
    expect(chartObjectClipboardRows().map((r) => r.id)).toEqual(["duplicateObjects", "copyObjects", "pasteObjects"]);
  });

  it("control: none on a worksheet", () => {
    surface = "grid";
    putOnObjectClipboard("chart", [{}]);
    expect(chartObjectClipboardRows()).toEqual([]);
  });
});
