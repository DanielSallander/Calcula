//! FILENAME: app/extensions/Slicer/__tests__/slicerPointModeHit.test.ts
// PURPOSE: open-items 2.af row 5 (S5). While a formula is picking a reference
//          on a sheet OTHER than its own (a floating-grid edit parked on a
//          worksheet, or a Core cross-sheet edit), no object is painted or
//          hit-tested (`getLiveGridRegions` is empty) -- but the Slicer's and
//          the Timeline's own pointer lookups fell back to their STORES,
//          filtered by the active sheet, which is then the sheet being SHOWN.
//          A right-click where that sheet's own (unpainted) slicer or timeline
//          sits opened its menu. Both lookups now answer nothing then.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ foreign: false }));

const snapshot = {
  surface: "grid" as "canvas" | "grid",
  displayHeadings: true,
  zoom: 1,
  config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
  viewport: { scrollX: 0, scrollY: 0 },
  // The sheet being SHOWN (the edit belongs to another one).
  sheetContext: { activeSheetIndex: 1 },
};

vi.mock("@api/grid", async () => {
  const header = await vi.importActual<typeof import("../../../src/core/lib/gridRenderer/layout/headerVisibility")>(
    "../../../src/core/lib/gridRenderer/layout/headerVisibility",
  );
  return {
    getGridStateSnapshot: () => snapshot,
    resolveHeaderSizes: header.resolveHeaderSizes,
    paintedDisplayHeadings: header.paintedDisplayHeadings,
  };
});
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPointModeOnForeignSheet: () => h.foreign,
}));

// The SHOWN sheet's own slicer and timeline (sheet 1), at sheet 200,100.
const SLICER = { id: "s1", name: "Region", sheetIndex: 1, x: 200, y: 100, width: 180, height: 240 };
const TIMELINE = { id: "t1", name: "Date", sheetIndex: 1, x: 200, y: 100, width: 300, height: 120 };
vi.mock("../lib/slicerStore", () => ({
  getAllSlicers: () => [SLICER],
  getSlicerById: (id: string) => (id === SLICER.id ? SLICER : undefined),
}));
vi.mock("../../TimelineSlicer/lib/timelineSlicerStore", () => ({
  getAllTimelines: () => [TIMELINE],
  getTimelineById: (id: string) => (id === TIMELINE.id ? TIMELINE : undefined),
}));
vi.mock("../manifest", () => ({
  SLICER_OPTIONS_TAB_ID: "slicer-options",
  SlicerOptionsPanelDefinition: { id: "slicer-options" },
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
}));

import { setGridRegions } from "@api/gridOverlays";
import { slicerAtCanvasPoint } from "../lib/slicerCanvasGeometry";
import { timelineAtCanvasPoint } from "../../TimelineSlicer/lib/timelineCanvasGeometry";

// Inside both objects: gutter 50 + 260, gutter 24 + 150.
const X = 310;
const Y = 174;

beforeEach(() => {
  h.foreign = false;
  // The store keeps publishing the EDIT's sheet's regions; none of them is
  // under this point (and none is live while pointing on a foreign sheet).
  setGridRegions([]);
});

describe("while a formula points on a foreign sheet", () => {
  it("a right-click where the shown sheet's own (unpainted) SLICER sits finds nothing", () => {
    h.foreign = true;
    expect(slicerAtCanvasPoint(X, Y), "the lookup answered an unpainted slicer").toBeNull();
  });

  it("... nor its own (unpainted) TIMELINE", () => {
    h.foreign = true;
    expect(timelineAtCanvasPoint(X, Y), "the lookup answered an unpainted timeline").toBeNull();
  });

  it("control: outside point mode, the same point is the slicer and the timeline (store fallback)", () => {
    expect(slicerAtCanvasPoint(X, Y)?.id).toBe("s1");
    expect(timelineAtCanvasPoint(X, Y)?.id).toBe("t1");
  });
});
