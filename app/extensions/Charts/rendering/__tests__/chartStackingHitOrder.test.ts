//! FILENAME: app/extensions/Charts/rendering/__tests__/chartStackingHitOrder.test.ts
// PURPOSE: Charts' own "which chart is under the pointer" lookup
//          (`findChartAtCanvasPos`, used by the right-click menu) walks Core's
//          ONE hit order (M8): of two overlapping charts, the one painted on
//          top answers -- by publication order without a stacking order, by z
//          with one.
// CONTEXT: The renderer's viewport cache starts at a 50 x 24 gutter with no
//          scroll until the first paint, which is the basis used here.

import { describe, it, expect, afterEach } from "vitest";
import { registerRegionStacking, setGridRegions, type GridRegion } from "@api/gridOverlays";
import { findChartAtCanvasPos } from "../chartRenderer";

function chart(chartId: string, x: number, y: number): GridRegion {
  return {
    id: `chart-${chartId}`,
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x, y, width: 200, height: 150 },
    data: { chartId, name: chartId },
  };
}

// c1 at sheet (0,0), c2 at sheet (100,100): they overlap in [100..200] x [100..150].
const OVERLAP = { x: 50 + 150, y: 24 + 120 };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("findChartAtCanvasPos walks the ONE hit order", () => {
  it("without z: the chart published last (Core's press order)", () => {
    setGridRegions([chart("c1", 0, 0), chart("c2", 100, 100)]);
    expect(findChartAtCanvasPos(OVERLAP.x, OVERLAP.y)).toBe("c2");
    setGridRegions([chart("c2", 100, 100), chart("c1", 0, 0)]);
    expect(findChartAtCanvasPos(OVERLAP.x, OVERLAP.y)).toBe("c1");
  });

  it("with z: the chart placed on top, whatever the publication order", () => {
    cleanups.push(registerRegionStacking((r) => ({ "chart-c1": 1, "chart-c2": 0 })[r.id]));
    setGridRegions([chart("c1", 0, 0), chart("c2", 100, 100)]);
    expect(findChartAtCanvasPos(OVERLAP.x, OVERLAP.y)).toBe("c1");
    setGridRegions([chart("c2", 100, 100), chart("c1", 0, 0)]);
    expect(findChartAtCanvasPos(OVERLAP.x, OVERLAP.y)).toBe("c1");
  });
});
