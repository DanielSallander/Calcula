//! FILENAME: app/extensions/Charts/rendering/__tests__/chartHitTesting.test.ts
// PURPOSE: Tests for chart hit-testing logic (bars, points, slices, axes).

import { describe, it, expect } from "vitest";
import {
  hitTestGeometry,
  hitTestBarChart,
  hitTestPoints,
  hitTestSlices,
} from "../chartHitTesting";
import type { BarRect, PointMarker, SliceArc, ChartLayout, HitGeometry } from "../../types";

// ============================================================================
// Test Helpers
// ============================================================================

function makeLayout(overrides: Partial<ChartLayout> = {}): ChartLayout {
  return {
    width: 600,
    height: 400,
    plotArea: { x: 50, y: 20, width: 500, height: 340 },
    margin: { top: 20, right: 30, bottom: 40, left: 50 },
    ...overrides,
  };
}

function makeBarRect(overrides: Partial<BarRect> = {}): BarRect {
  return {
    seriesIndex: 0,
    categoryIndex: 0,
    x: 100,
    y: 50,
    width: 40,
    height: 200,
    value: 500,
    seriesName: "Sales",
    categoryName: "Jan",
    ...overrides,
  };
}

function makePointMarker(overrides: Partial<PointMarker> = {}): PointMarker {
  return {
    seriesIndex: 0,
    categoryIndex: 0,
    cx: 150,
    cy: 100,
    radius: 4,
    value: 500,
    seriesName: "Sales",
    categoryName: "Jan",
    ...overrides,
  };
}

function makeSliceArc(overrides: Partial<SliceArc> = {}): SliceArc {
  return {
    seriesIndex: 0,
    startAngle: 0,
    endAngle: Math.PI / 2,
    innerRadius: 0,
    outerRadius: 100,
    centerX: 300,
    centerY: 200,
    value: 25,
    label: "Category A",
    percent: 25,
    ...overrides,
  };
}

// ============================================================================
// hitTestBarChart
// ============================================================================

describe("hitTestBarChart", () => {
  const layout = makeLayout();

  it("returns bar hit when point is inside a bar", () => {
    const rects = [makeBarRect({ x: 100, y: 50, width: 40, height: 200 })];
    const result = hitTestBarChart(120, 150, rects, layout);
    expect(result.type).toBe("bar");
    if (result.type === "bar") {
      expect(result.seriesIndex).toBe(0);
      expect(result.categoryIndex).toBe(0);
      expect(result.value).toBe(500);
    }
  });

  it("returns plotArea when point is in plot area but not on a bar", () => {
    const rects = [makeBarRect({ x: 100, y: 50, width: 40, height: 200 })];
    const result = hitTestBarChart(300, 200, rects, layout);
    expect(result.type).toBe("plotArea");
  });

  it("returns none when point is outside plot area and bars", () => {
    const rects = [makeBarRect()];
    const result = hitTestBarChart(5, 5, rects, layout);
    expect(result.type).toBe("none");
  });

  it("returns last drawn bar when bars overlap (reverse order test)", () => {
    const rects = [
      makeBarRect({ seriesIndex: 0, x: 100, y: 50, width: 50, height: 200, seriesName: "A" }),
      makeBarRect({ seriesIndex: 1, x: 120, y: 80, width: 50, height: 170, seriesName: "B" }),
    ];
    // Point at (130, 150) is in both bars; last bar (index 1) should win
    const result = hitTestBarChart(130, 150, rects, layout);
    expect(result.type).toBe("bar");
    if (result.type === "bar") {
      expect(result.seriesIndex).toBe(1);
    }
  });

  it("returns bar hit at bar edge (boundary check)", () => {
    const rects = [makeBarRect({ x: 100, y: 50, width: 40, height: 200 })];
    // Exactly on left edge
    const result = hitTestBarChart(100, 50, rects, layout);
    expect(result.type).toBe("bar");
    // Exactly on right edge
    const result2 = hitTestBarChart(140, 250, rects, layout);
    expect(result2.type).toBe("bar");
  });

  it("returns plotArea when no bars exist and point is in plot area", () => {
    const result = hitTestBarChart(200, 200, [], layout);
    expect(result.type).toBe("plotArea");
  });
});

// ============================================================================
// hitTestPoints
// ============================================================================

describe("hitTestPoints", () => {
  const layout = makeLayout();

  it("returns point hit when within marker radius", () => {
    const markers = [makePointMarker({ cx: 150, cy: 100, radius: 4 })];
    const result = hitTestPoints(152, 100, markers, layout);
    expect(result.type).toBe("point");
    if (result.type === "point") {
      expect(result.seriesIndex).toBe(0);
      expect(result.value).toBe(500);
    }
  });

  it("returns point hit within bonus radius (3px extra)", () => {
    const markers = [makePointMarker({ cx: 150, cy: 100, radius: 4 })];
    // Distance = 7, which is within 4 + 3 = 7
    const result = hitTestPoints(157, 100, markers, layout);
    expect(result.type).toBe("point");
  });

  it("returns plotArea when beyond hit radius", () => {
    const markers = [makePointMarker({ cx: 150, cy: 100, radius: 4 })];
    // Distance = 10, which is beyond 4 + 3 = 7
    const result = hitTestPoints(160, 100, markers, layout);
    expect(result.type).toBe("plotArea");
  });

  it("returns last point when multiple overlap", () => {
    const markers = [
      makePointMarker({ seriesIndex: 0, cx: 150, cy: 100 }),
      makePointMarker({ seriesIndex: 1, cx: 152, cy: 101 }),
    ];
    const result = hitTestPoints(151, 100, markers, layout);
    expect(result.type).toBe("point");
    if (result.type === "point") {
      expect(result.seriesIndex).toBe(1);
    }
  });
});

// ============================================================================
// hitTestSlices
// ============================================================================

describe("hitTestSlices", () => {
  const layout = makeLayout();

  it("returns slice hit when point is within arc", () => {
    // Slice from 0 to PI/2 (first quadrant), outer radius 100, center at (300, 200)
    const arcs = [makeSliceArc()];
    // Point at (350, 230) is in first quadrant, ~50px from center
    const result = hitTestSlices(350, 230, arcs, layout);
    expect(result.type).toBe("slice");
    if (result.type === "slice") {
      expect(result.seriesIndex).toBe(0);
    }
  });

  it("returns none when point is outside outer radius", () => {
    const arcs = [makeSliceArc({ outerRadius: 100 })];
    // Point far from center
    const result = hitTestSlices(500, 400, arcs, layout);
    expect(result.type).toBe("none");
  });

  it("returns none when point is inside inner radius (donut hole)", () => {
    const arcs = [makeSliceArc({ innerRadius: 50, outerRadius: 100 })];
    // Point at center
    const result = hitTestSlices(300, 200, arcs, layout);
    expect(result.type).toBe("none");
  });

  it("returns none for empty arcs array", () => {
    const result = hitTestSlices(300, 200, [], layout);
    expect(result.type).toBe("none");
  });

  it("returns none when angle is outside slice arc", () => {
    // Slice covers only first quadrant (0 to PI/2)
    const arcs = [makeSliceArc({ startAngle: 0, endAngle: Math.PI / 2 })];
    // Point at (250, 150) is in second quadrant (negative x from center, negative y)
    // That's angle ~PI + atan(50/50) which is outside [0, PI/2]
    const result = hitTestSlices(250, 150, arcs, layout);
    expect(result.type).toBe("none");
  });

  it("detects correct slice among multiple", () => {
    const arcs = [
      makeSliceArc({ seriesIndex: 0, startAngle: 0, endAngle: Math.PI, label: "A" }),
      makeSliceArc({ seriesIndex: 1, startAngle: Math.PI, endAngle: Math.PI * 2, label: "B" }),
    ];
    // Point upper-left of center: angle ~3.93 rad, in (PI, 2*PI) range => second arc
    const result = hitTestSlices(250, 150, arcs, layout);
    expect(result.type).toBe("slice");
    if (result.type === "slice") {
      expect(result.seriesIndex).toBe(1);
    }
  });
});

// ============================================================================
// hitTestGeometry (dispatch)
// ============================================================================

describe("hitTestGeometry", () => {
  const layout = makeLayout();

  it("dispatches to bars handler for bars geometry", () => {
    const geometry: HitGeometry = {
      type: "bars",
      rects: [makeBarRect({ x: 100, y: 50, width: 40, height: 200 })],
    };
    const result = hitTestGeometry(120, 150, geometry, layout);
    expect(result.type).toBe("bar");
  });

  it("dispatches to points handler for points geometry", () => {
    const geometry: HitGeometry = {
      type: "points",
      markers: [makePointMarker({ cx: 150, cy: 100, radius: 4 })],
    };
    const result = hitTestGeometry(150, 100, geometry, layout);
    expect(result.type).toBe("point");
  });

  it("dispatches to slices handler for slices geometry", () => {
    const geometry: HitGeometry = {
      type: "slices",
      arcs: [makeSliceArc()],
    };
    const result = hitTestGeometry(350, 230, geometry, layout);
    expect(result.type).toBe("slice");
  });

  it("dispatches to composite handler and returns first data hit", () => {
    const geometry: HitGeometry = {
      type: "composite",
      groups: [
        { type: "bars", rects: [] },
        { type: "points", markers: [makePointMarker({ cx: 150, cy: 100 })] },
      ],
    };
    const result = hitTestGeometry(150, 100, geometry, layout);
    expect(result.type).toBe("point");
  });

  it("returns plotArea for composite with no data hits but in plot area", () => {
    const geometry: HitGeometry = {
      type: "composite",
      groups: [
        { type: "bars", rects: [] },
        { type: "points", markers: [] },
      ],
    };
    const result = hitTestGeometry(200, 200, geometry, layout);
    expect(result.type).toBe("plotArea");
  });

  it("detects x-axis region hit", () => {
    const geometry: HitGeometry = { type: "bars", rects: [] };
    // Below plot area, within horizontal bounds
    const result = hitTestGeometry(200, 370, geometry, layout);
    expect(result.type).toBe("axis");
    if (result.type === "axis") {
      expect(result.axisType).toBe("x");
    }
  });

  it("detects y-axis region hit", () => {
    const geometry: HitGeometry = { type: "bars", rects: [] };
    // Left of plot area, within vertical bounds
    const result = hitTestGeometry(30, 200, geometry, layout);
    expect(result.type).toBe("axis");
    if (result.type === "axis") {
      expect(result.axisType).toBe("y");
    }
  });
});
