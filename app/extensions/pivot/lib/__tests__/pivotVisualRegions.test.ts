//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualRegions.test.ts
// PURPOSE: Region sync for canvas pivots (M6).
//          - a canvas pivot (one with a canvasFrame) publishes ONE floating
//            `pivot-visual` region carrying its frame, and NO cell-anchored
//            `pivot` region -- a cell region on a canvas is not painted, but its
//            bottom-right resize handle would stay live somewhere on the page;
//          - a worksheet pivot publishes exactly the region it always did;
//          - a dragged frame is live until its save returns, a failed save
//            reverts it, and a region fetch that started before a save cannot
//            snap the box back to its pre-save frame;
//          - WP-C: the frame store owns the box's visual CONTAINER too -- each
//            region carries it resolved, a format commit lands like a geometry
//            commit, and a later drag carries it (review R1-7).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getGridRegions, setGridRegions } from "@api/gridOverlays";
import { setDesignMode } from "@api/designMode";
import type { PivotRegionData } from "../../types";
import {
  partitionPivotRegions,
  publishPivotRegions,
  setLiveFrame,
  commitLiveFrame,
  effectiveFrame,
  currentFrameGeneration,
  resetPivotVisualRegionState,
  commitFrameContainer,
  setPreviewContainer,
  storedFrameContainer,
  PIVOT_VISUAL_REGION_TYPE,
} from "../pivotVisualRegions";

const sheetPivot: PivotRegionData = {
  pivotId: "grid-1",
  name: "PivotTable1",
  startRow: 2,
  startCol: 3,
  endRow: 20,
  endCol: 6,
  isEmpty: false,
};

const canvasPivot: PivotRegionData = {
  pivotId: "canvas-1",
  name: "PivotTable2",
  startRow: 0,
  startCol: 1024,
  endRow: 49,
  endCol: 1026,
  isEmpty: false,
  canvasFrame: { x: 64, y: 48, width: 300, height: 200, frozenHeaders: true },
};

beforeEach(() => {
  setGridRegions([]);
  resetPivotVisualRegionState();
});

describe("partitionPivotRegions", () => {
  it("a canvas pivot becomes one floating pivot-visual region with its frame, and no pivot cell region", () => {
    const { cell, visual } = partitionPivotRegions([canvasPivot]);
    expect(cell).toEqual([]);
    expect(visual).toHaveLength(1);
    expect(visual[0]).toMatchObject({
      id: "pivot-visual-canvas-1",
      type: PIVOT_VISUAL_REGION_TYPE,
      floating: { x: 64, y: 48, width: 300, height: 200 },
      // The hidden-grid anchor stays on the region: view cell -> grid cell.
      startRow: 0,
      startCol: 1024,
      data: { pivotId: "canvas-1", name: "PivotTable2", isEmpty: false, frozenHeaders: true },
    });
  });

  it("a worksheet pivot is published exactly as before", () => {
    const { cell, visual } = partitionPivotRegions([sheetPivot]);
    expect(visual).toEqual([]);
    expect(cell).toEqual([
      {
        id: "pivot-grid-1",
        type: "pivot",
        startRow: 2,
        startCol: 3,
        endRow: 20,
        endCol: 6,
        data: { isEmpty: false, pivotId: "grid-1", name: "PivotTable1" },
      },
    ]);
  });

  it("a box's cells are content (D-CELLS), so it moves by Core's hover grip -- and by its whole body only in Design Mode", () => {
    setDesignMode(false);
    expect(partitionPivotRegions([canvasPivot]).visual[0].data).toMatchObject({ grip: "hover", bodyGrab: false });
    setDesignMode(true);
    try {
      expect(partitionPivotRegions([canvasPivot]).visual[0].data).toMatchObject({ grip: "hover", bodyGrab: true });
    } finally {
      setDesignMode(false);
    }
    // A worksheet pivot's cell region carries neither.
    const cellData = partitionPivotRegions([sheetPivot]).cell[0].data;
    expect(cellData?.grip).toBeUndefined();
    expect(cellData?.bodyGrab).toBeUndefined();
  });

  it("frozenHeaders is only on when the frame says so", () => {
    const loose = { ...canvasPivot, canvasFrame: { x: 0, y: 0, width: 10, height: 10 } };
    expect(partitionPivotRegions([loose]).visual[0].data?.frozenHeaders).toBe(false);
  });
});

describe("publishPivotRegions", () => {
  it("publishes both shapes into the grid region list with ONE notification", async () => {
    const { onRegionChange } = await import("@api/gridOverlays");
    const seen = vi.fn();
    const off = onRegionChange(seen);
    publishPivotRegions([sheetPivot, canvasPivot]);
    off();

    expect(seen).toHaveBeenCalledTimes(1);
    const regions = getGridRegions();
    expect(regions.filter((r) => r.type === "pivot").map((r) => r.id)).toEqual(["pivot-grid-1"]);
    expect(regions.filter((r) => r.type === PIVOT_VISUAL_REGION_TYPE).map((r) => r.id)).toEqual([
      "pivot-visual-canvas-1",
    ]);
    // Nothing else claims the canvas pivot's cells.
    expect(regions.some((r) => r.type === "pivot" && r.data?.pivotId === "canvas-1")).toBe(false);
  });
});

describe("live frames", () => {
  function visualFloating() {
    return getGridRegions().find((r) => r.type === PIVOT_VISUAL_REGION_TYPE)?.floating;
  }

  it("a move preview re-publishes the box at the new position", () => {
    publishPivotRegions([canvasPivot]);
    setLiveFrame("canvas-1", { x: 100, y: 60 });
    expect(visualFloating()).toEqual({ x: 100, y: 60, width: 300, height: 200 });
  });

  it("a completed save keeps the frame and sends whole pixels", async () => {
    publishPivotRegions([canvasPivot]);
    setLiveFrame("canvas-1", { x: 100.4, y: 60.6, width: 320.2, height: 180 });
    const save = vi.fn(async () => undefined);
    const ok = await commitLiveFrame("canvas-1", save, vi.fn());
    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledWith({ x: 100, y: 61, width: 320, height: 180, frozenHeaders: true });
    expect(visualFloating()).toEqual({ x: 100, y: 61, width: 320, height: 180 });
  });

  it("a refused save reverts the box to the backend frame and reports it", async () => {
    publishPivotRegions([canvasPivot]);
    setLiveFrame("canvas-1", { x: 500, y: 500 });
    const onError = vi.fn();
    const ok = await commitLiveFrame("canvas-1", async () => { throw new Error("refused"); }, onError);
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(visualFloating()).toEqual({ x: 64, y: 48, width: 300, height: 200 });
  });

  it("a region fetch that started BEFORE the save cannot snap the box back", async () => {
    publishPivotRegions([canvasPivot]);
    const fetchStartedAt = currentFrameGeneration();
    setLiveFrame("canvas-1", { x: 200, y: 100 });
    await commitLiveFrame("canvas-1", async () => undefined, vi.fn());

    // The stale fetch lands, still carrying the pre-save frame.
    publishPivotRegions([canvasPivot], fetchStartedAt);
    expect(visualFloating()).toMatchObject({ x: 200, y: 100 });

    // A fetch started AFTER the save (an undo, say) is honoured.
    publishPivotRegions([canvasPivot], currentFrameGeneration());
    expect(visualFloating()).toMatchObject({ x: 64, y: 48 });
    expect(effectiveFrame("canvas-1")).toMatchObject({ x: 64, y: 48 });
  });
});

// ============================================================================
// WP-C D-FORMAT: the box's visual container rides the frame (review R1-7)
// ============================================================================

describe("the box's container (WP-C)", () => {
  function visualRegion() {
    return getGridRegions().find((r) => r.type === PIVOT_VISUAL_REGION_TYPE) as
      | (ReturnType<typeof getGridRegions>[number] & { container?: { background: { color: string }; border: { show: boolean; color: string } } })
      | undefined;
  }

  it("every box region carries its RESOLVED container: the box's defaults (white, a 1 px #c8c8c8 border) under the stored one", () => {
    publishPivotRegions([canvasPivot]);
    expect(visualRegion()?.container?.border).toMatchObject({ show: true, color: "#c8c8c8" });
    expect(visualRegion()?.container?.background.color).toBe("#ffffff");
    publishPivotRegions([
      { ...canvasPivot, canvasFrame: { ...canvasPivot.canvasFrame!, container: { background: { color: "#FFF4E5" } } } },
    ]);
    expect(visualRegion()?.container?.background.color).toBe("#FFF4E5");
  });

  it("format, THEN move: the saved frame carries the new container -- a drag never reverts it", async () => {
    publishPivotRegions([canvasPivot]);
    const saves: unknown[] = [];
    const save = vi.fn(async (frame: unknown) => {
      saves.push(frame);
    });
    await commitFrameContainer("canvas-1", { background: { color: "#FFF4E5" } }, save);
    expect(saves[0]).toEqual({ ...canvasPivot.canvasFrame, container: { background: { color: "#FFF4E5" } } });
    expect(visualRegion()?.container?.background.color).toBe("#FFF4E5");

    // The drag that follows spreads the frame it starts from: the container comes along.
    setLiveFrame("canvas-1", { x: 120, y: 70 });
    expect(visualRegion()?.container?.background.color).toBe("#FFF4E5");
    await commitLiveFrame("canvas-1", save, vi.fn());
    expect(saves[1]).toEqual({ x: 120, y: 70, width: 300, height: 200, frozenHeaders: true, container: { background: { color: "#FFF4E5" } } });
  });

  it("a region fetch that started BEFORE the format commit does not revert it; one started after it is honoured", async () => {
    publishPivotRegions([canvasPivot]);
    const fetchStartedAt = currentFrameGeneration();
    await commitFrameContainer("canvas-1", { border: { radius: 8 } }, async () => undefined);
    publishPivotRegions([canvasPivot], fetchStartedAt);
    expect(effectiveFrame("canvas-1")?.container).toEqual({ border: { radius: 8 } });
    // An undo's refresh (started after) brings the backend's frame back.
    publishPivotRegions([canvasPivot], currentFrameGeneration());
    expect(effectiveFrame("canvas-1")?.container).toBeUndefined();
  });

  it("a commit made WHILE the box is dragged is carried by that drag's save", async () => {
    publishPivotRegions([canvasPivot]);
    setLiveFrame("canvas-1", { x: 90, y: 50 });
    await commitFrameContainer("canvas-1", { padding: { top: 6 } }, async () => undefined);
    const save = vi.fn(async () => undefined);
    await commitLiveFrame("canvas-1", save, vi.fn());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ x: 90, y: 50, container: { padding: { top: 6 } } }));
  });

  it("a refused commit changes nothing and rethrows the backend's sentence", async () => {
    publishPivotRegions([canvasPivot]);
    const before = currentFrameGeneration();
    await expect(
      commitFrameContainer("canvas-1", { background: { color: "#000000" } }, async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(currentFrameGeneration()).toBe(before);
    expect(storedFrameContainer("canvas-1")).toBeUndefined();
    expect(visualRegion()?.container?.background.color).toBe("#ffffff");
  });

  it("a PREVIEW shows a container without saving it, and ends cleanly", () => {
    publishPivotRegions([canvasPivot]);
    setPreviewContainer("canvas-1", { background: { color: "#123456" } });
    expect(visualRegion()?.container?.background.color).toBe("#123456");
    expect(storedFrameContainer("canvas-1"), "a preview is never stored").toBeUndefined();
    setPreviewContainer("canvas-1", null);
    expect(visualRegion()?.container?.background.color).toBe("#ffffff");
    expect(storedFrameContainer("no-such-pivot"), "no frame: not a box").toBeNull();
  });
});
