//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualGeometry.test.ts
// PURPOSE: The canvas pivot box's geometry provider (M8 part C): preview
//          patches the LIVE frame only; commit saves the frame (whole px) and
//          has landed when it resolves; a refused save drops the live frame --
//          the box is back on the backend's frame -- and the commit REJECTS for
//          the seam to report; `flush` waits for a frame save in flight (the
//          box's own drag), so a canvas group drag commits its one undo step
//          after it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getGridRegions, setGridRegions } from "@api/gridOverlays";
import type { PivotRegionData } from "../../types";
import { effectiveFrame, publishPivotRegions, resetPivotVisualRegionState } from "../pivotVisualRegions";
import {
  createPivotVisualGeometryProvider,
  settlePivotFrameSaves,
  trackPivotFrameSave,
} from "../pivotVisualGeometry";

const canvasPivot: PivotRegionData = {
  pivotId: "p1",
  name: "PivotTable1",
  startRow: 0,
  startCol: 1024,
  endRow: 49,
  endCol: 1026,
  isEmpty: false,
  canvasFrame: { x: 64, y: 48, width: 300, height: 200, frozenHeaders: false },
};

beforeEach(() => {
  setGridRegions([]);
  resetPivotVisualRegionState();
  publishPivotRegions([canvasPivot]);
});

const visual = () => getGridRegions().find((r) => r.type === "pivot-visual")!;

describe("the pivot box geometry provider", () => {
  it("preview moves the box and saves nothing", () => {
    const save = vi.fn(async () => {});
    createPivotVisualGeometryProvider(save).preview!([{ region: visual(), x: 100, y: 90, width: 300, height: 200 }]);
    expect(visual().floating).toEqual({ x: 100, y: 90, width: 300, height: 200 });
    expect(save).not.toHaveBeenCalled();
  });

  it("commit saves the frame (whole px) and the box stays there", async () => {
    const save = vi.fn(async () => {});
    await createPivotVisualGeometryProvider(save).commit([
      { region: visual(), x: 100.4, y: 90.6, width: 320, height: 210 },
    ]);
    expect(save).toHaveBeenCalledWith("p1", expect.objectContaining({ x: 100, y: 91, width: 320, height: 210 }));
    expect(effectiveFrame("p1")).toMatchObject({ x: 100, y: 91 });
  });

  it("a REFUSED save puts the box back on the backend's frame and rejects", async () => {
    const save = vi.fn(async () => {
      throw new Error("The sheet is protected.");
    });
    await expect(
      createPivotVisualGeometryProvider(save).commit([{ region: visual(), x: 400, y: 400, width: 300, height: 200 }]),
    ).rejects.toThrow("The sheet is protected.");
    expect(effectiveFrame("p1")).toMatchObject({ x: 64, y: 48 });
    expect(visual().floating).toMatchObject({ x: 64, y: 48 });
  });

  it("flush waits for a frame save in flight (the box's own drag)", async () => {
    let release!: () => void;
    let landed = false;
    void trackPivotFrameSave(
      new Promise<void>((r) => {
        release = r;
      }).then(() => {
        landed = true;
      }),
    );
    const flushed = createPivotVisualGeometryProvider(vi.fn()).flush!();
    await Promise.resolve();
    expect(landed).toBe(false);
    release();
    await flushed;
    expect(landed).toBe(true);
    await settlePivotFrameSaves();
  });
});
