//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineCanvasGeometry.test.ts
// PURPOSE: The Timeline's own pointer lookups (right-click menu, wheel, click,
//          period drag) find a timeline where it is PAINTED and only when it is
//          the TOPMOST object there (M8). The twin of the Slicer's
//          slicerCanvasGeometry.test.ts.

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

const TIMELINE = { id: "t1", name: "Date", sheetIndex: 0, x: 200, y: 100, width: 300, height: 110 };
vi.mock("../lib/timelineSlicerStore", () => ({
  getAllTimelines: () => [TIMELINE],
  getTimelineById: (id: string) => (id === TIMELINE.id ? TIMELINE : undefined),
}));

vi.mock("../manifest", () => ({
  TIMELINE_OPTIONS_TAB_ID: "timeline-options",
  TimelineOptionsPanelDefinition: { id: "timeline-options" },
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
}));

import { registerRegionStacking, setGridRegions, type GridRegion } from "@api/gridOverlays";
import { timelineAtCanvasPoint, timelineCanvasBounds } from "../lib/timelineCanvasGeometry";

const timelineRegion: GridRegion = {
  id: "timeline-slicer-t1",
  type: "timeline-slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: TIMELINE.x, y: TIMELINE.y, width: TIMELINE.width, height: TIMELINE.height },
  data: { timelineId: "t1" },
};
/** A floating range covering the timeline's left third (sheet 150..300 x 50..250). */
const frRegion: GridRegion = {
  id: "fr-a",
  type: "floating-range",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 150, y: 50, width: 150, height: 200 },
  data: { frId: "a" },
};

const cleanups: Array<() => void> = [];
beforeEach(() => {
  snapshot.surface = "canvas";
  snapshot.displayHeadings = true;
  setGridRegions([timelineRegion]);
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("the PAINTED gutters", () => {
  it("on a canvas the timeline starts at its sheet position, whatever the stored config says", () => {
    expect(timelineCanvasBounds(TIMELINE)).toEqual({ x: 200, y: 100, width: 300, height: 110 });
    expect(timelineAtCanvasPoint(203, 103)?.id).toBe("t1");
    expect(timelineAtCanvasPoint(200 + 300 + 20, 100 + 110 + 10)).toBeNull();
  });

  it("on a worksheet with headings it offsets by the configured gutters", () => {
    snapshot.surface = "grid";
    expect(timelineCanvasBounds(TIMELINE)).toMatchObject({ x: 250, y: 124 });
    expect(timelineAtCanvasPoint(203, 103)).toBeNull();
    expect(timelineAtCanvasPoint(253, 127)?.id).toBe("t1");
  });
});

describe("the TOPMOST object decides", () => {
  const IN_OVERLAP = { x: 250, y: 150 };
  const TIMELINE_ONLY = { x: 450, y: 150 };

  it("a timeline covered by another object refuses the point", () => {
    setGridRegions([timelineRegion, frRegion]);
    expect(timelineAtCanvasPoint(IN_OVERLAP.x, IN_OVERLAP.y)).toBeNull();
    expect(timelineAtCanvasPoint(TIMELINE_ONLY.x, TIMELINE_ONLY.y)?.id).toBe("t1");
  });

  it("POSITIVE CONTROL: the same range UNDER the timeline leaves it answering", () => {
    setGridRegions([frRegion, timelineRegion]);
    expect(timelineAtCanvasPoint(IN_OVERLAP.x, IN_OVERLAP.y)?.id).toBe("t1");
  });

  it("with a stacking order the saved z decides, not the publication order", () => {
    cleanups.push(registerRegionStacking((r) => ({ "fr-a": 0, "timeline-slicer-t1": 1 })[r.id]));
    setGridRegions([timelineRegion, frRegion]);
    expect(timelineAtCanvasPoint(IN_OVERLAP.x, IN_OVERLAP.y)?.id).toBe("t1");
  });
});
