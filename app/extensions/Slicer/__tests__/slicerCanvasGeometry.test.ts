//! FILENAME: app/extensions/Slicer/__tests__/slicerCanvasGeometry.test.ts
// PURPOSE: The Slicer's own pointer lookups (right-click menu, wheel, item
//          click) find a slicer where it is PAINTED and only when it is the
//          TOPMOST object there (M8).
// CONTEXT: Both halves were broken the same way elsewhere first: the gutters
//          (BUG-0139 in Core's mouse layer, M7 in FloatingRange) -- a canvas
//          never shows headings but the stored config still says 50 x 24 here
//          -- and the family-only walk, which let a slicer covered by a chart
//          answer a right-click through it (and, because the Slicer's menu
//          listener stops immediate propagation, starve the chart's own menu).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const snapshot = {
  surface: "canvas" as "canvas" | "grid",
  displayHeadings: true,
  zoom: 1,
  config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
  viewport: { scrollX: 0, scrollY: 0 },
  sheetContext: { activeSheetIndex: 0 },
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

const SLICER = { id: "s1", name: "Region", sheetIndex: 0, x: 200, y: 100, width: 180, height: 240 };
vi.mock("../lib/slicerStore", () => ({
  getAllSlicers: () => [SLICER],
  getSlicerById: (id: string) => (id === SLICER.id ? SLICER : undefined),
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

import { registerRegionStacking, setGridRegions, type GridRegion } from "@api/gridOverlays";
import { slicerAtCanvasPoint, slicerCanvasBounds } from "../lib/slicerCanvasGeometry";

const slicerRegion: GridRegion = {
  id: "slicer-s1",
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: SLICER.x, y: SLICER.y, width: SLICER.width, height: SLICER.height },
  data: { slicerId: "s1" },
};
/** A chart covering the slicer's top-left quarter (sheet 150..300 x 50..200). */
const chartRegion: GridRegion = {
  id: "chart-c1",
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 150, y: 50, width: 150, height: 150 },
  data: { chartId: "c1" },
};

const cleanups: Array<() => void> = [];
beforeEach(() => {
  snapshot.surface = "canvas";
  snapshot.displayHeadings = true;
  snapshot.viewport = { scrollX: 0, scrollY: 0 };
  setGridRegions([slicerRegion]);
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("the PAINTED gutters", () => {
  it("on a canvas the slicer starts at its sheet position, whatever the stored config says", () => {
    expect(slicerCanvasBounds(SLICER)).toEqual({ x: 200, y: 100, width: 180, height: 240 });
    expect(slicerAtCanvasPoint(203, 103)?.id).toBe("s1");
    // Inside the OLD (raw-config) box only: one gutter past the painted corner.
    expect(slicerAtCanvasPoint(200 + 180 + 20, 100 + 240 + 10)).toBeNull();
  });

  it("on a worksheet with headings it offsets by the configured gutters", () => {
    snapshot.surface = "grid";
    expect(slicerCanvasBounds(SLICER)).toMatchObject({ x: 250, y: 124 });
    expect(slicerAtCanvasPoint(203, 103)).toBeNull();
    expect(slicerAtCanvasPoint(253, 127)?.id).toBe("s1");
  });

  it("on a worksheet with View > Headings off it offsets by nothing", () => {
    snapshot.surface = "grid";
    snapshot.displayHeadings = false;
    expect(slicerCanvasBounds(SLICER)).toMatchObject({ x: 200, y: 100 });
  });
});

describe("the TOPMOST object decides", () => {
  const IN_OVERLAP = { x: 250, y: 150 };
  const SLICER_ONLY = { x: 350, y: 300 };

  it("a slicer covered by another object refuses the point", () => {
    setGridRegions([slicerRegion, chartRegion]); // the chart published last = on top
    expect(slicerAtCanvasPoint(IN_OVERLAP.x, IN_OVERLAP.y)).toBeNull();
    // Where nothing covers it, it still answers.
    expect(slicerAtCanvasPoint(SLICER_ONLY.x, SLICER_ONLY.y)?.id).toBe("s1");
  });

  it("POSITIVE CONTROL: the same chart UNDER the slicer leaves the slicer answering", () => {
    setGridRegions([chartRegion, slicerRegion]);
    expect(slicerAtCanvasPoint(IN_OVERLAP.x, IN_OVERLAP.y)?.id).toBe("s1");
  });

  it("with a stacking order the saved z decides, not the publication order", () => {
    cleanups.push(registerRegionStacking((r) => ({ "chart-c1": 0, "slicer-s1": 1 })[r.id]));
    setGridRegions([slicerRegion, chartRegion]);
    expect(slicerAtCanvasPoint(IN_OVERLAP.x, IN_OVERLAP.y)?.id).toBe("s1");
  });
});
