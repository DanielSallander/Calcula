//! FILENAME: app/extensions/Charts/rendering/chartHitTesting.ts
// PURPOSE: Hit-testing for chart sub-elements (bars, plot area, etc.).
// CONTEXT: Given a point in chart-local coordinates and pre-computed bar rects,
//          determines which chart element the point falls on. Used for tooltips
//          and hierarchical selection.

import type { BarRect, ChartHitResult } from "../types";
import type { BarChartLayout } from "./barChartPainter";

/**
 * Hit-test a point against the bars and structural areas of a bar chart.
 * Coordinates are in chart-local pixel space (0,0 = top-left of chart).
 *
 * Tests bars in reverse order so that bars drawn later (on top) win.
 */
export function hitTestBarChart(
  localX: number,
  localY: number,
  barRects: BarRect[],
  layout: BarChartLayout,
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

  // Check if within plot area
  const pa = layout.plotArea;
  if (
    localX >= pa.x &&
    localX <= pa.x + pa.width &&
    localY >= pa.y &&
    localY <= pa.y + pa.height
  ) {
    return { type: "plotArea" };
  }

  return { type: "none" };
}
