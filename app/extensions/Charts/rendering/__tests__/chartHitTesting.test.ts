//! FILENAME: app/extensions/Charts/rendering/__tests__/chartHitTesting.test.ts
// PURPOSE: Tests for chart hit-testing logic (data points, areas, axes).
// CONTEXT: Asserts on `element` — Excel's ElementID — rather than on the legacy
//          `type` mirror. The mirror has its own small block at the bottom,
//          because while chartRenderer still reads it, a projection that drifts
//          from the element it mirrors would break hover silently.

import { describe, it, expect } from "vitest";
import {
  hitTestGeometry,
  hitTestBarChart,
  hitTestPoints,
  hitTestSlices,
  hitTestDatum,
  chartElementOf,
  isDatumHit,
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

  it("returns a datum hit when the point is inside a bar", () => {
    const rects = [makeBarRect({ x: 100, y: 50, width: 40, height: 200 })];
    const result = hitTestBarChart(120, 150, rects, layout);
    expect(result.element).toBe("datum");
    expect(result.seriesIndex).toBe(0);
    expect(result.pointIndex).toBe(0);
    expect(result.value).toBe(500);
  });

  it("returns plotArea when point is in plot area but not on a bar", () => {
    const rects = [makeBarRect({ x: 100, y: 50, width: 40, height: 200 })];
    expect(hitTestBarChart(300, 200, rects, layout).element).toBe("plotArea");
  });

  it("returns chartArea — not nothing — for a pixel inside the object that matched nothing", () => {
    // (5, 5) is the top-left margin: above the plot area and left of it, so it
    // is neither axis band. It used to answer "none", which is how the top and
    // right margins became dead pixels.
    const rects = [makeBarRect()];
    expect(hitTestBarChart(5, 5, rects, layout).element).toBe("chartArea");
  });

  it("returns none only for a pixel OUTSIDE the chart object", () => {
    expect(hitTestBarChart(-1, 200, [], layout).element).toBe("none");
    expect(hitTestBarChart(300, 401, [], layout).element).toBe("none");
  });

  it("returns last drawn bar when bars overlap (reverse order test)", () => {
    const rects = [
      makeBarRect({ seriesIndex: 0, x: 100, y: 50, width: 50, height: 200, seriesName: "A" }),
      makeBarRect({ seriesIndex: 1, x: 120, y: 80, width: 50, height: 170, seriesName: "B" }),
    ];
    const result = hitTestBarChart(130, 150, rects, layout);
    expect(result.element).toBe("datum");
    expect(result.seriesIndex).toBe(1);
  });

  it("returns a datum hit at a bar edge (boundary check)", () => {
    const rects = [makeBarRect({ x: 100, y: 50, width: 40, height: 200 })];
    expect(hitTestBarChart(100, 50, rects, layout).element).toBe("datum");
    expect(hitTestBarChart(140, 250, rects, layout).element).toBe("datum");
  });

  it("returns plotArea when no bars exist and point is in plot area", () => {
    expect(hitTestBarChart(200, 200, [], layout).element).toBe("plotArea");
  });
});

// ============================================================================
// hitTestPoints
// ============================================================================

describe("hitTestPoints", () => {
  const layout = makeLayout();

  it("returns a datum hit when within marker radius", () => {
    const markers = [makePointMarker({ cx: 150, cy: 100, radius: 4 })];
    const result = hitTestPoints(152, 100, markers, layout);
    expect(result.element).toBe("datum");
    expect(result.seriesIndex).toBe(0);
    expect(result.value).toBe(500);
  });

  it("returns a datum hit within bonus radius (3px extra)", () => {
    const markers = [makePointMarker({ cx: 150, cy: 100, radius: 4 })];
    // Distance = 7, which is within 4 + 3 = 7
    expect(hitTestPoints(157, 100, markers, layout).element).toBe("datum");
  });

  it("returns plotArea when beyond hit radius", () => {
    const markers = [makePointMarker({ cx: 150, cy: 100, radius: 4 })];
    // Distance = 10, which is beyond 4 + 3 = 7
    expect(hitTestPoints(160, 100, markers, layout).element).toBe("plotArea");
  });

  it("returns last point when multiple overlap", () => {
    const markers = [
      makePointMarker({ seriesIndex: 0, cx: 150, cy: 100 }),
      makePointMarker({ seriesIndex: 1, cx: 152, cy: 101 }),
    ];
    const result = hitTestPoints(151, 100, markers, layout);
    expect(result.element).toBe("datum");
    expect(result.seriesIndex).toBe(1);
  });
});

// ============================================================================
// hitTestSlices — arc-only by contract
// ============================================================================

describe("hitTestSlices", () => {
  const layout = makeLayout();

  it("returns a datum hit when point is within arc", () => {
    const arcs = [makeSliceArc()];
    const result = hitTestSlices(350, 230, arcs, layout);
    expect(result.element).toBe("datum");
    expect(result.seriesIndex).toBe(0);
  });

  it("reports a slice's own index as BOTH series and point — a slice is its category", () => {
    const arcs = [makeSliceArc({ seriesIndex: 0, startAngle: 0, endAngle: Math.PI })];
    const result = hitTestSlices(350, 230, arcs, layout);
    expect(result.seriesIndex).toBe(0);
    expect(result.pointIndex).toBe(0);
  });

  it("returns none when point is outside outer radius", () => {
    const arcs = [makeSliceArc({ outerRadius: 100 })];
    expect(hitTestSlices(500, 400, arcs, layout).element).toBe("none");
  });

  it("returns none when point is inside inner radius (donut hole)", () => {
    const arcs = [makeSliceArc({ innerRadius: 50, outerRadius: 100 })];
    expect(hitTestSlices(300, 200, arcs, layout).element).toBe("none");
  });

  it("returns none for empty arcs array", () => {
    expect(hitTestSlices(300, 200, [], layout).element).toBe("none");
  });

  it("returns none when angle is outside slice arc", () => {
    const arcs = [makeSliceArc({ startAngle: 0, endAngle: Math.PI / 2 })];
    expect(hitTestSlices(250, 150, arcs, layout).element).toBe("none");
  });

  it("detects correct slice among multiple", () => {
    const arcs = [
      makeSliceArc({ seriesIndex: 0, startAngle: 0, endAngle: Math.PI, label: "A" }),
      makeSliceArc({ seriesIndex: 1, startAngle: Math.PI, endAngle: Math.PI * 2, label: "B" }),
    ];
    const result = hitTestSlices(250, 150, arcs, layout);
    expect(result.element).toBe("datum");
    expect(result.seriesIndex).toBe(1);
  });
});

// ============================================================================
// hitTestGeometry (dispatch)
// ============================================================================

describe("hitTestGeometry", () => {
  const layout = makeLayout();

  it("dispatches to bars", () => {
    const geometry: HitGeometry = { type: "bars", rects: [makeBarRect({ x: 100, y: 50, width: 40, height: 200 })] };
    expect(hitTestGeometry(120, 150, geometry, layout).element).toBe("datum");
  });

  it("dispatches to points", () => {
    const geometry: HitGeometry = { type: "points", markers: [makePointMarker({ cx: 150, cy: 100, radius: 4 })] };
    expect(hitTestGeometry(150, 100, geometry, layout).element).toBe("datum");
  });

  it("dispatches to slices", () => {
    const geometry: HitGeometry = { type: "slices", arcs: [makeSliceArc()] };
    expect(hitTestGeometry(350, 230, geometry, layout).element).toBe("datum");
  });

  it("gives a radial MISS the furniture answer, unlike hitTestSlices itself", () => {
    // hitTestSlices is the low-level arc tester and answers "none"; the
    // dispatch is the reader's whole question, and a click in the donut hole
    // is a click on the plot area, as it is in Excel.
    const geometry: HitGeometry = { type: "slices", arcs: [makeSliceArc({ innerRadius: 50 })] };
    expect(hitTestSlices(300, 200, geometry.type === "slices" ? geometry.arcs : [], layout).element).toBe("none");
    expect(hitTestGeometry(300, 200, geometry, layout).element).toBe("plotArea");
  });

  it("dispatches to composite and returns the first datum hit", () => {
    const geometry: HitGeometry = {
      type: "composite",
      groups: [
        { type: "bars", rects: [] },
        { type: "points", markers: [makePointMarker({ cx: 150, cy: 100 })] },
      ],
    };
    const result = hitTestGeometry(150, 100, geometry, layout);
    expect(result.element).toBe("datum");
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
    expect(hitTestGeometry(200, 200, geometry, layout).element).toBe("plotArea");
  });

  it("detects the x-axis region", () => {
    const geometry: HitGeometry = { type: "bars", rects: [] };
    const result = hitTestGeometry(200, 370, geometry, layout);
    expect(result.element).toBe("xAxis");
    expect(result.axisType).toBe("x");
  });

  it("detects the y-axis region", () => {
    const geometry: HitGeometry = { type: "bars", rects: [] };
    const result = hitTestGeometry(30, 200, geometry, layout);
    expect(result.element).toBe("yAxis");
    expect(result.axisType).toBe("y");
  });
});

// ============================================================================
// hitTestDatum — the datum half on its own
// ============================================================================

describe("hitTestDatum", () => {
  const layout = makeLayout();

  it("answers null (not an element) when nothing is under the pixel", () => {
    expect(hitTestDatum(300, 200, { type: "bars", rects: [] })).toBeNull();
    // ...and the dispatch above it turns that null into the furniture answer.
    expect(hitTestGeometry(300, 200, { type: "bars", rects: [] }, layout).element).toBe("plotArea");
  });

  it("walks composite groups in order", () => {
    const geometry: HitGeometry = {
      type: "composite",
      groups: [
        { type: "bars", rects: [makeBarRect({ seriesIndex: 7, x: 100, y: 50, width: 40, height: 200 })] },
        { type: "points", markers: [makePointMarker({ seriesIndex: 9, cx: 120, cy: 150 })] },
      ],
    };
    // The point sits ON the bar; the first group wins, and no panel index is
    // invented for either (composed charts are inert at the panel level).
    const hit = hitTestDatum(120, 150, geometry);
    expect(hit?.seriesIndex).toBe(7);
  });
});

// ============================================================================
// Classification helpers
// ============================================================================

describe("chartElementOf / isDatumHit", () => {
  it("reads the element straight off a modern result", () => {
    expect(chartElementOf({ element: "legendEntry", type: "none" })).toBe("legendEntry");
    expect(isDatumHit({ element: "datum", type: "bar" })).toBe(true);
    expect(isDatumHit({ element: "plotArea", type: "plotArea" })).toBe(false);
  });

  it("derives the element from the legacy mirror when a fixture carries only that", () => {
    expect(chartElementOf({ type: "bar" })).toBe("datum");
    expect(chartElementOf({ type: "point" })).toBe("datum");
    expect(chartElementOf({ type: "slice" })).toBe("datum");
    expect(chartElementOf({ type: "plotArea" })).toBe("plotArea");
    expect(chartElementOf({ type: "axis", axisType: "y" })).toBe("yAxis");
    expect(chartElementOf({ type: "axis", axisType: "x" })).toBe("xAxis");
    expect(chartElementOf({ type: "filterButton" })).toBe("filterButton");
    expect(chartElementOf(null)).toBe("none");
  });
});

// ============================================================================
// The legacy mirror — one writer, so it cannot drift
// ============================================================================

describe("legacy type mirror (read by chartRenderer until it migrates)", () => {
  const layout = makeLayout();

  it("still spells the three mark kinds apart", () => {
    expect(hitTestBarChart(120, 150, [makeBarRect()], layout).type).toBe("bar");
    expect(hitTestPoints(150, 100, [makePointMarker()], layout).type).toBe("point");
    expect(hitTestSlices(350, 230, [makeSliceArc()], layout).type).toBe("slice");
  });

  it("mirrors pointIndex onto categoryIndex", () => {
    const hit = hitTestBarChart(120, 150, [makeBarRect({ categoryIndex: 4 })], layout);
    expect(hit.pointIndex).toBe(4);
    expect(hit.categoryIndex).toBe(4);
  });

  it("projects an element the old union could not name onto 'none'", () => {
    // chartArea is new; the old code answered "none" for that pixel, so the
    // mirror keeps answering "none" and hover behaves exactly as before.
    const hit = hitTestBarChart(5, 5, [makeBarRect()], layout);
    expect(hit.element).toBe("chartArea");
    expect(hit.type).toBe("none");
  });

  it("keeps axisType beside the axis elements", () => {
    const x = hitTestGeometry(200, 370, { type: "bars", rects: [] }, layout);
    expect(x.type).toBe("axis");
    expect(x.axisType).toBe("x");
  });
});
