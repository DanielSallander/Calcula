//! FILENAME: app/extensions/Charts/rendering/horizontalBarChartPainter.ts
// PURPOSE: Pure Canvas 2D horizontal bar chart drawing.
// CONTEXT: Like bar chart but categories on Y axis, values on X axis.

import type { ChartSpec, ParsedChartData, BarRect, ChartLayout, HitGeometry } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { resolvePointColor, resolvePointOpacity } from "../lib/encodingResolver";
import { createLinearScale, createBandScale, createScaleFromSpec } from "./scales";
import {
  computeCartesianLayout,
  drawChartBackground,
  drawPlotBackground,
  drawVerticalGridLines,
  drawHorizontalAxes,
  drawTitle,
  drawLegend,
  drawRoundedRect,
} from "./chartPainterUtils";

// Re-export for backwards compatibility and formatTickValue for tooltip
export type HorizontalBarChartLayout = ChartLayout;
export { formatTickValue } from "./chartPainterUtils";

// ============================================================================
// Layout
// ============================================================================

/**
 * Compute the layout for a horizontal bar chart.
 * Adds extra left margin to accommodate category labels on the Y axis.
 */
export function computeHorizontalBarLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  const layout = computeCartesianLayout(width, height, spec, data, theme);

  // Horizontal bar charts need extra left margin for category labels.
  // The standard layout estimates ~40px for numeric Y-axis labels, but
  // category labels are typically longer text strings.
  const extraLeft = 60;
  const currentLeft = layout.margin.left;
  const newLeft = currentLeft + extraLeft;

  return {
    width: layout.width,
    height: layout.height,
    margin: {
      top: layout.margin.top,
      right: layout.margin.right,
      bottom: layout.margin.bottom,
      left: newLeft,
    },
    plotArea: {
      x: newLeft,
      y: layout.plotArea.y,
      width: Math.max(layout.plotArea.width - extraLeft, 10),
      height: layout.plotArea.height,
    },
  };
}

// ============================================================================
// Main Paint Function
// ============================================================================

/**
 * Paint a horizontal bar chart onto a Canvas 2D context.
 * Assumes the context is already sized and scaled (including DPR).
 */
export function paintHorizontalBarChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;

  // Compute scales
  // X axis = value axis (linear), Y axis = category axis (band)
  const allValues = data.series.flatMap((s) => s.values);
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;

  const xMin = spec.xAxis.min ?? dataMin;
  const xMax = spec.xAxis.max ?? dataMax;

  const xScale = createScaleFromSpec(
    spec.xAxis.scale,
    [xMin, xMax],
    [plotArea.x, plotArea.x + plotArea.width], // left to right
  );

  const yScale = createBandScale(
    data.categories,
    [plotArea.y, plotArea.y + plotArea.height],
    0.3,
  );

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  // 2. Plot area background
  drawPlotBackground(ctx, plotArea, theme);

  // 3. Grid lines (vertical, for value axis on X)
  if (spec.xAxis.gridLines) {
    drawVerticalGridLines(ctx, xScale, plotArea, theme);
  }

  // 4. Axes (categories on Y, values on X)
  drawHorizontalAxes(ctx, xScale, yScale, plotArea, spec, theme);

  // 5. Bars
  drawHorizontalBars(ctx, data, spec, xScale, yScale, plotArea, theme);

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

function drawHorizontalBars(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  xScale: ReturnType<typeof createLinearScale>,
  yScale: ReturnType<typeof createBandScale>,
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
): void {
  const numSeries = data.series.length;
  if (numSeries === 0) return;

  const groupHeight = yScale.bandwidth;
  const barHeight = Math.max(
    (groupHeight - theme.barGap * (numSeries - 1)) / numSeries,
    2,
  );
  const zeroX = xScale.scale(0);

  for (let ci = 0; ci < data.categories.length; ci++) {
    const groupY = yScale.scaleIndex(ci);

    for (let si = 0; si < numSeries; si++) {
      const value = data.series[si].values[ci] ?? 0;
      const category = data.categories[ci] ?? "";
      const encoding = spec.series[si]?.encoding;
      const color = resolvePointColor(encoding, spec.palette, si, data.series[si].color, value, category);

      const barY = groupY + si * (barHeight + theme.barGap);
      const barEnd = xScale.scale(value);
      const barWidth = Math.abs(barEnd - zeroX);
      const barX = value >= 0 ? zeroX : barEnd;

      // Clip bar to plot area
      const clippedX = Math.max(barX, plotArea.x);
      const clippedRight = Math.min(barX + barWidth, plotArea.x + plotArea.width);
      const clippedWidth = clippedRight - clippedX;

      if (clippedWidth <= 0) continue;

      const pointOpacity = resolvePointOpacity(encoding, value, category);
      if (pointOpacity != null) ctx.globalAlpha = pointOpacity;
      ctx.fillStyle = color;

      if (theme.barBorderRadius > 0 && clippedWidth > theme.barBorderRadius * 2) {
        drawRoundedRect(
          ctx,
          clippedX,
          barY,
          clippedWidth,
          barHeight,
          theme.barBorderRadius,
        );
        ctx.fill();
      } else {
        ctx.fillRect(clippedX, barY, clippedWidth, barHeight);
      }
      if (pointOpacity != null) ctx.globalAlpha = 1;
    }
  }
}

// ============================================================================
// Bar Geometry (for hit-testing)
// ============================================================================

/**
 * Compute the bounding rectangles of all horizontal bars, clipped to the plot area.
 * Returns the same geometry that drawHorizontalBars() renders, but as data instead of pixels.
 * Used by hit-testing and selection highlight rendering.
 */
export function computeHorizontalBarRects(
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

  const xMin = spec.xAxis.min ?? dataMin;
  const xMax = spec.xAxis.max ?? dataMax;

  const xScale = createScaleFromSpec(
    spec.xAxis.scale,
    [xMin, xMax],
    [plotArea.x, plotArea.x + plotArea.width],
  );

  const yScale = createBandScale(
    data.categories,
    [plotArea.y, plotArea.y + plotArea.height],
    0.3,
  );

  const groupHeight = yScale.bandwidth;
  const barHeight = Math.max(
    (groupHeight - theme.barGap * (numSeries - 1)) / numSeries,
    2,
  );
  const zeroX = xScale.scale(0);

  for (let ci = 0; ci < data.categories.length; ci++) {
    const category = data.categories[ci];
    const groupY = yScale.scaleIndex(ci);

    for (let si = 0; si < numSeries; si++) {
      const value = data.series[si].values[ci] ?? 0;
      const barY = groupY + si * (barHeight + theme.barGap);
      const barEnd = xScale.scale(value);
      const barWidth = Math.abs(barEnd - zeroX);
      const barX = value >= 0 ? zeroX : barEnd;

      // Clip bar to plot area (same as drawHorizontalBars)
      const clippedX = Math.max(barX, plotArea.x);
      const clippedRight = Math.min(barX + barWidth, plotArea.x + plotArea.width);
      const clippedWidth = clippedRight - clippedX;

      if (clippedWidth <= 0) continue;

      rects.push({
        seriesIndex: si,
        categoryIndex: ci,
        x: clippedX,
        y: barY,
        width: clippedWidth,
        height: barHeight,
        value,
        seriesName: data.series[si].name,
        categoryName: category,
      });
    }
  }

  return rects;
}

/**
 * Compute hit geometry for a horizontal bar chart.
 */
export function computeHorizontalBarHitGeometry(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): HitGeometry {
  return { type: "bars", rects: computeHorizontalBarRects(data, spec, layout, theme) };
}
