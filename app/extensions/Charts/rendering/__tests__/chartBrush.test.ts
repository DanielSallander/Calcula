//! FILENAME: app/extensions/Charts/rendering/__tests__/chartBrush.test.ts
// PURPOSE: C5 S6 (interval/brush) additive half — hitTestRect maps a brush
//          rectangle to the datum set it covers. The drag GESTURE is Core-owned
//          and deferred; this pure mapping is testable + ready now.

import { describe, it, expect } from "vitest";
import { hitTestRect } from "../chartHitTesting";
import type { HitGeometry } from "../../types";

const bars: HitGeometry = {
  type: "bars",
  rects: [
    { x: 0, y: 80, width: 20, height: 20, seriesIndex: 0, categoryIndex: 0, value: 1, seriesName: "S", categoryName: "Jan" },
    { x: 30, y: 40, width: 20, height: 60, seriesIndex: 0, categoryIndex: 1, value: 6, seriesName: "S", categoryName: "Feb" },
    { x: 60, y: 10, width: 20, height: 90, seriesIndex: 0, categoryIndex: 2, value: 9, seriesName: "S", categoryName: "Mar" },
  ],
};

describe("hitTestRect (brush -> datum set)", () => {
  it("returns bars whose box intersects the brush rectangle", () => {
    const hits = hitTestRect({ x: 25, y: 0, width: 40, height: 100 }, bars); // covers Feb + Mar's left edge
    expect(hits.map((h) => h.categoryName)).toEqual(["Feb", "Mar"]);
  });

  it("returns nothing for a rect that misses every bar", () => {
    expect(hitTestRect({ x: 200, y: 200, width: 10, height: 10 }, bars)).toEqual([]);
  });

  it("normalizes a backwards-dragged rect (negative width/height)", () => {
    const hits = hitTestRect({ x: 65, y: 100, width: -65, height: -100 }, bars); // drag up-left across all
    expect(hits.map((h) => h.categoryName)).toEqual(["Jan", "Feb", "Mar"]);
  });

  const points: HitGeometry = {
    type: "points",
    markers: [
      { cx: 10, cy: 10, radius: 4, seriesIndex: 0, categoryIndex: 0, value: 1, seriesName: "S", categoryName: "A" },
      { cx: 50, cy: 50, radius: 4, seriesIndex: 0, categoryIndex: 1, value: 2, seriesName: "S", categoryName: "B" },
    ],
  };

  it("includes markers a brush rect covers (disc vs rect)", () => {
    const hits = hitTestRect({ x: 0, y: 0, width: 20, height: 20 }, points);
    expect(hits.map((h) => h.categoryName)).toEqual(["A"]);
  });

  it("a zero-size brush (plain click) selects the marker under or near the point", () => {
    expect(hitTestRect({ x: 10, y: 10, width: 0, height: 0 }, points).map((h) => h.categoryName)).toEqual(["A"]); // on centre
    expect(hitTestRect({ x: 12, y: 12, width: 0, height: 0 }, points).map((h) => h.categoryName)).toEqual(["A"]); // within radius+bonus
    expect(hitTestRect({ x: 30, y: 30, width: 0, height: 0 }, points)).toEqual([]); // between points -> none
  });

  it("does not brush radial slices in v1", () => {
    const slices: HitGeometry = {
      type: "slices",
      arcs: [{ centerX: 50, centerY: 50, innerRadius: 0, outerRadius: 40, startAngle: 0, endAngle: 1, seriesIndex: 0, value: 1, label: "X" }],
    };
    expect(hitTestRect({ x: 0, y: 0, width: 100, height: 100 }, slices)).toEqual([]);
  });
});
