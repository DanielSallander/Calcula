//! FILENAME: app/extensions/Charts/rendering/chartHitTesting.ts
// PURPOSE: Hit-testing for chart sub-elements (bars, points, slices, etc.).
// CONTEXT: Given a point in chart-local coordinates and pre-computed geometry,
//          determines which chart element the point falls on. Used for tooltips
//          and hierarchical selection.

import type { BarRect, PointMarker, SliceArc, HitGeometry, ChartHitResult, ChartLayout } from "../types";

// ============================================================================
// Unified Hit-Test Dispatch
// ============================================================================

/**
 * Hit-test a point against any chart type's geometry.
 * Dispatches to the appropriate type-specific hit-tester.
 */
export function hitTestGeometry(
  localX: number,
  localY: number,
  geometry: HitGeometry,
  layout: ChartLayout,
): ChartHitResult {
  switch (geometry.type) {
    case "bars":
      return hitTestBarChart(localX, localY, geometry.rects, layout);
    case "points":
      return hitTestPoints(localX, localY, geometry.markers, layout);
    case "slices":
      return hitTestSlices(localX, localY, geometry.arcs, layout);
    case "composite":
      // Test each sub-group; return first data hit
      for (const group of geometry.groups) {
        const result = hitTestGeometry(localX, localY, group, layout);
        if (result.type !== "none" && result.type !== "plotArea") return result;
      }
      return hitTestPlotArea(localX, localY, layout);
  }
}

// ============================================================================
// Bar Chart Hit-Testing
// ============================================================================

/**
 * Hit-test a point against bars and structural areas of a bar chart.
 * Tests bars in reverse order so that bars drawn later (on top) win.
 */
export function hitTestBarChart(
  localX: number,
  localY: number,
  barRects: BarRect[],
  layout: ChartLayout,
): ChartHitResult {
  // Test bars in reverse order (last drawn = topmost)
  for (let i = barRects.length - 1; i >= 0; i--) {
    const bar = barRects[i];
    if (
      localX >= bar.x &&
      localX <= bar.x + bar.width &&
      localY >= bar.y &&
      localY <= bar.y + bar.height
    ) {
      return {
        type: "bar",
        seriesIndex: bar.seriesIndex,
        categoryIndex: bar.categoryIndex,
        value: bar.value,
        seriesName: bar.seriesName,
        categoryName: bar.categoryName,
      };
    }
  }

  return hitTestPlotArea(localX, localY, layout);
}

// ============================================================================
// Point Hit-Testing (line, area, scatter)
// ============================================================================

/**
 * Hit-test a point against point markers (line/area/scatter charts).
 * Uses a generous hit radius for easier interaction.
 */
export function hitTestPoints(
  localX: number,
  localY: number,
  markers: PointMarker[],
  layout: ChartLayout,
): ChartHitResult {
  const hitRadiusBonus = 3; // Extra pixels beyond marker radius for easier hitting

  // Test in reverse order (last drawn = topmost)
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i];
    const dx = localX - marker.cx;
    const dy = localY - marker.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= marker.radius + hitRadiusBonus) {
      return {
        type: "point",
        seriesIndex: marker.seriesIndex,
        categoryIndex: marker.categoryIndex,
        value: marker.value,
        seriesName: marker.seriesName,
        categoryName: marker.categoryName,
      };
    }
  }

  return hitTestPlotArea(localX, localY, layout);
}

// ============================================================================
// Slice Hit-Testing (pie, donut)
// ============================================================================

/**
 * Hit-test a point against pie/donut slices.
 * Converts (x, y) to polar coordinates and checks angle/radius.
 */
export function hitTestSlices(
  localX: number,
  localY: number,
  arcs: SliceArc[],
  layout: ChartLayout,
): ChartHitResult {
  if (arcs.length === 0) return { type: "none" };

  const cx = arcs[0].centerX;
  const cy = arcs[0].centerY;
  const dx = localX - cx;
  const dy = localY - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let angle = Math.atan2(dy, dx);

  for (const arc of arcs) {
    if (dist < arc.innerRadius || dist > arc.outerRadius) continue;

    // Normalize angle to check if it falls within the arc
    let start = arc.startAngle;
    let end = arc.endAngle;

    // Normalize to [0, 2PI] range
    let testAngle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    start = ((start % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    end = ((end % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    let inArc: boolean;
    if (start <= end) {
      inArc = testAngle >= start && testAngle <= end;
    } else {
      // Arc wraps around 0
      inArc = testAngle >= start || testAngle <= end;
    }

    if (inArc) {
      return {
        type: "slice",
        seriesIndex: arc.seriesIndex,
        categoryIndex: arc.seriesIndex, // For slices, category = series
        value: arc.value,
        seriesName: arc.label,
        categoryName: arc.label,
      };
    }
  }

  return { type: "none" };
}

// ============================================================================
// Plot Area Hit-Testing (shared)
// ============================================================================

function hitTestPlotArea(
  localX: number,
  localY: number,
  layout: ChartLayout,
): ChartHitResult {
  const pa = layout.plotArea;
  if (
    localX >= pa.x &&
    localX <= pa.x + pa.width &&
    localY >= pa.y &&
    localY <= pa.y + pa.height
  ) {
    return { type: "plotArea" };
  }

  // Check if hovering over axis regions (margins adjacent to plot area)
  const axisResult = hitTestAxes(localX, localY, layout);
  if (axisResult.type !== "none") return axisResult;

  return { type: "none" };
}

// ============================================================================
// Axis Hit-Testing
// ============================================================================

/**
 * Hit-test the axis regions (margins adjacent to the plot area).
 * Returns an "axis" hit with axisType metadata.
 */
function hitTestAxes(
  localX: number,
  localY: number,
  layout: ChartLayout,
): ChartHitResult {
  const pa = layout.plotArea;

  // X axis region: below the plot area, within horizontal plot bounds
  if (
    localX >= pa.x &&
    localX <= pa.x + pa.width &&
    localY > pa.y + pa.height &&
    localY <= pa.y + pa.height + layout.margin.bottom
  ) {
    return { type: "axis", axisType: "x" };
  }

  // Y axis region: to the left of the plot area, within vertical plot bounds
  if (
    localX >= 0 &&
    localX < pa.x &&
    localY >= pa.y &&
    localY <= pa.y + pa.height
  ) {
    return { type: "axis", axisType: "y" };
  }

  return { type: "none" };
}
