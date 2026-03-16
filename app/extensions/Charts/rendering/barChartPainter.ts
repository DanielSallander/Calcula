//! FILENAME: app/extensions/Charts/rendering/barChartPainter.ts
// PURPOSE: Pure Canvas 2D bar chart drawing. No external library.
// CONTEXT: Called by chartRenderer to paint a bar chart onto an OffscreenCanvas
//          or a preview canvas. Draws axes, grid lines, bars, title, and legend.

import type { ChartSpec, ParsedChartData, BarRect, ChartLayout, HitGeometry } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { createLinearScale, createBandScale } from "./scales";
import {
  computeCartesianLayout,
  drawChartBackground,
  drawPlotBackground,
  drawHorizontalGridLines,
  drawCartesianAxes,
  drawTitle,
  drawLegend,
  drawRoundedRect,
} from "./chartPainterUtils";

// Re-export for backwards compatibility and formatTickValue for tooltip
export type BarChartLayout = ChartLayout;
export { formatTickValue } from "./chartPainterUtils";

// ============================================================================
// Layout
// ============================================================================

/**
 * Compute the layout for a bar chart.
 */
export function computeLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  return computeCartesianLayout(width, height, spec, data, theme);
}

// ============================================================================
// Main Paint Function
// ============================================================================

/**
 * Paint a bar chart onto a Canvas 2D context.
 * Assumes the context is already sized and scaled (including DPR).
 */
export function paintBarChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;

  // Compute scales
  const allValues = data.series.flatMap((s) => s.values);
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;

  const yMin = spec.yAxis.min ?? dataMin;
  const yMax = spec.yAxis.max ?? dataMax;

  const yScale = createLinearScale(
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y], // inverted: larger values go up
  );

  const xScale = createBandScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.3,
  );

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  // 2. Plot area background
  drawPlotBackground(ctx, plotArea, theme);

  // 3. Grid lines
  if (spec.yAxis.gridLines) {
    drawHorizontalGridLines(ctx, yScale, plotArea, theme);
  }

  // 4. Axes
  drawCartesianAxes(ctx, xScale, yScale, plotArea, spec, theme);

  // 5. Bars
  drawBars(ctx, data, spec, xScale, yScale, plotArea, theme);

  // 6. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 7. Legend
  if (spec.legend.visible && data.series.length > 1) {
    drawLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Drawing Helpers
// ============================================================================

function drawBars(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  xScale: ReturnType<typeof createBandScale>,
  yScale: ReturnType<typeof createLinearScale>,
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
): void {
  const numSeries = data.series.length;
  if (numSeries === 0) return;

  const groupWidth = xScale.bandwidth;
  const barWidth = Math.max(
    (groupWidth - theme.barGap * (numSeries - 1)) / numSeries,
    2,
  );
  const zeroY = yScale.scale(0);

  for (let ci = 0; ci < data.categories.length; ci++) {
    const groupX = xScale.scaleIndex(ci);

    for (let si = 0; si < numSeries; si++) {
      const value = data.series[si].values[ci] ?? 0;
      const color = getSeriesColor(spec.palette, si, data.series[si].color);

      const barX = groupX + si * (barWidth + theme.barGap);
      const barTop = yScale.scale(value);
      const barHeight = Math.abs(zeroY - barTop);
      const barY = value >= 0 ? barTop : zeroY;

      // Clip bar to plot area
      const clippedY = Math.max(barY, plotArea.y);
      const clippedBottom = Math.min(barY + barHeight, plotArea.y + plotArea.height);
      const clippedHeight = clippedBottom - clippedY;

      if (clippedHeight <= 0) continue;

      ctx.fillStyle = color;

      if (theme.barBorderRadius > 0 && clippedHeight > theme.barBorderRadius * 2) {
        drawRoundedRect(
          ctx,
          barX,
          clippedY,
          barWidth,
          clippedHeight,
          theme.barBorderRadius,
        );
        ctx.fill();
      } else {
        ctx.fillRect(barX, clippedY, barWidth, clippedHeight);
      }
    }
  }
}

// ============================================================================
// Bar Geometry (for hit-testing)
// ============================================================================

/**
 * Compute the bounding rectangles of all bars, clipped to the plot area.
 * Returns the same geometry that drawBars() renders, but as data instead of pixels.
 * Used by hit-testing and selection highlight rendering.
 */
export function computeBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): BarRect[] {
  const { plotArea } = layout;
  const rects: BarRect[] = [];

  const numSeries = data.series.length;
  if (numSeries === 0) return rects;

  const allValues = data.series.flatMap((s) => s.values);
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;

  const yMin = spec.yAxis.min ?? dataMin;
  const yMax = spec.yAxis.max ?? dataMax;

  const yScale = createLinearScale(
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createBandScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.3,
  );

  const groupWidth = xScale.bandwidth;
  const barWidth = Math.max(
    (groupWidth - theme.barGap * (numSeries - 1)) / numSeries,
    2,
  );
  const zeroY = yScale.scale(0);

  for (let ci = 0; ci < data.categories.length; ci++) {
    const category = data.categories[ci];
    const groupX = xScale.scaleIndex(ci);

    for (let si = 0; si < numSeries; si++) {
      const value = data.series[si].values[ci] ?? 0;
      const barX = groupX + si * (barWidth + theme.barGap);
      const barTop = yScale.scale(value);
      const barHeight = Math.abs(zeroY - barTop);
      const barY = value >= 0 ? barTop : zeroY;

      // Clip bar to plot area (same as drawBars)
      const clippedY = Math.max(barY, plotArea.y);
      const clippedBottom = Math.min(barY + barHeight, plotArea.y + plotArea.height);
      const clippedHeight = clippedBottom - clippedY;

      if (clippedHeight <= 0) continue;

      rects.push({
        seriesIndex: si,
        categoryIndex: ci,
        x: barX,
        y: clippedY,
        width: barWidth,
        height: clippedHeight,
        value,
        seriesName: data.series[si].name,
        categoryName: category,
      });
    }
  }

  return rects;
}

/**
 * Compute hit geometry for a bar chart.
 */
export function computeBarHitGeometry(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): HitGeometry {
  return { type: "bars", rects: computeBarRects(data, spec, layout, theme) };
}
