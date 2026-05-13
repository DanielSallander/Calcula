//! FILENAME: app/extensions/Charts/rendering/barChartPainter.ts
// PURPOSE: Pure Canvas 2D bar chart drawing. No external library.
// CONTEXT: Called by chartRenderer to paint a bar chart onto an OffscreenCanvas
//          or a preview canvas. Draws axes, grid lines, bars, title, and legend.

import type { ChartSpec, ParsedChartData, BarRect, ChartLayout, HitGeometry, BarMarkOptions, StackMode } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { resolvePointColor, resolvePointOpacity } from "../lib/encodingResolver";
import { buildOverrideMap, getOverrideFromMap } from "../lib/dataPointOverrides";
import { createLinearScale, createBandScale, createScaleFromSpec } from "./scales";
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
/** Resolve the stack mode from BarMarkOptions. */
function getBarStackMode(spec: ChartSpec): StackMode {
  const opts = (spec.markOptions ?? {}) as BarMarkOptions;
  return opts.stackMode ?? "none";
}

export function paintBarChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const stackMode = getBarStackMode(spec);
  const isStacked = stackMode !== "none";

  // Compute scales
  const { yMin, yMax } = computeBarYDomain(data, spec, stackMode);

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
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
  if (isStacked) {
    drawStackedBars(ctx, data, spec, xScale, yScale, plotArea, theme, stackMode);
  } else {
    drawBars(ctx, data, spec, xScale, yScale, plotArea, theme);
  }

  // 6. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 7. Legend
  if (spec.legend.visible && data.series.length > 0) {
    drawLegend(ctx, data, spec, layout, theme);
  }
}

/** Compute the Y domain, accounting for stacking. */
function computeBarYDomain(
  data: ParsedChartData,
  spec: ChartSpec,
  stackMode: StackMode,
): { yMin: number; yMax: number } {
  if (stackMode === "percentStacked") {
    return { yMin: spec.yAxis.min ?? 0, yMax: spec.yAxis.max ?? 100 };
  }

  if (stackMode === "stacked") {
    // Domain covers stacked totals (positive and negative separately)
    let maxPos = 0;
    let minNeg = 0;
    for (let ci = 0; ci < data.categories.length; ci++) {
      let posSum = 0;
      let negSum = 0;
      for (let si = 0; si < data.series.length; si++) {
        const v = data.series[si].values[ci] ?? 0;
        if (v >= 0) posSum += v;
        else negSum += v;
      }
      maxPos = Math.max(maxPos, posSum);
      minNeg = Math.min(minNeg, negSum);
    }
    return {
      yMin: spec.yAxis.min ?? minNeg,
      yMax: spec.yAxis.max ?? maxPos,
    };
  }

  // Grouped (non-stacked)
  const allValues = data.series.flatMap((s) => s.values);
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;
  return { yMin: spec.yAxis.min ?? dataMin, yMax: spec.yAxis.max ?? dataMax };
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
  const overrideMap = buildOverrideMap(spec.dataPointOverrides);

  for (let ci = 0; ci < data.categories.length; ci++) {
    const groupX = xScale.scaleIndex(ci);

    for (let si = 0; si < numSeries; si++) {
      const value = data.series[si].values[ci] ?? 0;
      const category = data.categories[ci] ?? "";
      const encoding = spec.series[si]?.encoding;
      let color = resolvePointColor(encoding, spec.palette, si, data.series[si].color, value, category);

      // Apply data point override
      const override = getOverrideFromMap(overrideMap, si, ci);
      if (override?.color) color = override.color;

      const barX = groupX + si * (barWidth + theme.barGap);
      const barTop = yScale.scale(value);
      const barHeight = Math.abs(zeroY - barTop);
      const barY = value >= 0 ? barTop : zeroY;

      // Clip bar to plot area
      const clippedY = Math.max(barY, plotArea.y);
      const clippedBottom = Math.min(barY + barHeight, plotArea.y + plotArea.height);
      const clippedHeight = clippedBottom - clippedY;

      if (clippedHeight <= 0) continue;

      let pointOpacity = resolvePointOpacity(encoding, value, category);
      if (override?.opacity !== undefined) pointOpacity = override.opacity;
      if (pointOpacity != null) ctx.globalAlpha = pointOpacity;
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
      if (pointOpacity != null) ctx.globalAlpha = 1;
    }
  }
}

// ============================================================================
// Stacked Bar Drawing
// ============================================================================

function drawStackedBars(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  xScale: ReturnType<typeof createBandScale>,
  yScale: ReturnType<typeof createLinearScale>,
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
  stackMode: StackMode,
): void {
  const numSeries = data.series.length;
  if (numSeries === 0) return;

  const barWidth = xScale.bandwidth;

  for (let ci = 0; ci < data.categories.length; ci++) {
    const barX = xScale.scaleIndex(ci);

    // Compute category total for percent stacking
    let categoryTotal = 0;
    if (stackMode === "percentStacked") {
      for (let si = 0; si < numSeries; si++) {
        categoryTotal += Math.abs(data.series[si].values[ci] ?? 0);
      }
    }

    let posY = 0; // cumulative positive value
    let negY = 0; // cumulative negative value

    for (let si = 0; si < numSeries; si++) {
      let rawValue = data.series[si].values[ci] ?? 0;
      const category = data.categories[ci] ?? "";
      const encoding = spec.series[si]?.encoding;
      const color = resolvePointColor(encoding, spec.palette, si, data.series[si].color, rawValue, category);

      let value = rawValue;
      if (stackMode === "percentStacked" && categoryTotal > 0) {
        value = (rawValue / categoryTotal) * 100;
      }

      let barTop: number;
      let barBottom: number;

      if (value >= 0) {
        barBottom = posY;
        posY += value;
        barTop = posY;
      } else {
        barTop = negY;
        negY += value;
        barBottom = negY;
      }

      const yTop = yScale.scale(barTop);
      const yBottom = yScale.scale(barBottom);
      const barHeight = Math.abs(yBottom - yTop);
      const barY = Math.min(yTop, yBottom);

      // Clip to plot area
      const clippedY = Math.max(barY, plotArea.y);
      const clippedBottom = Math.min(barY + barHeight, plotArea.y + plotArea.height);
      const clippedHeight = clippedBottom - clippedY;

      if (clippedHeight <= 0) continue;

      const pointOpacity = resolvePointOpacity(encoding, rawValue, category);
      if (pointOpacity != null) ctx.globalAlpha = pointOpacity;
      ctx.fillStyle = color;

      if (theme.barBorderRadius > 0 && clippedHeight > theme.barBorderRadius * 2) {
        drawRoundedRect(ctx, barX, clippedY, barWidth, clippedHeight, theme.barBorderRadius);
        ctx.fill();
      } else {
        ctx.fillRect(barX, clippedY, barWidth, clippedHeight);
      }
      if (pointOpacity != null) ctx.globalAlpha = 1;
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
  const stackMode = getBarStackMode(spec);
  const isStacked = stackMode !== "none";

  const numSeries = data.series.length;
  if (numSeries === 0) return rects;

  const { yMin, yMax } = computeBarYDomain(data, spec, stackMode);

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createBandScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.3,
  );

  if (isStacked) {
    // Stacked geometry
    const barWidth = xScale.bandwidth;

    for (let ci = 0; ci < data.categories.length; ci++) {
      const category = data.categories[ci];
      const barX = xScale.scaleIndex(ci);

      let categoryTotal = 0;
      if (stackMode === "percentStacked") {
        for (let si = 0; si < numSeries; si++) {
          categoryTotal += Math.abs(data.series[si].values[ci] ?? 0);
        }
      }

      let posY = 0;
      let negY = 0;

      for (let si = 0; si < numSeries; si++) {
        const rawValue = data.series[si].values[ci] ?? 0;
        let value = rawValue;
        if (stackMode === "percentStacked" && categoryTotal > 0) {
          value = (rawValue / categoryTotal) * 100;
        }

        let barTop: number;
        let barBottom: number;
        if (value >= 0) {
          barBottom = posY;
          posY += value;
          barTop = posY;
        } else {
          barTop = negY;
          negY += value;
          barBottom = negY;
        }

        const yTop = yScale.scale(barTop);
        const yBottom = yScale.scale(barBottom);
        const barHeight = Math.abs(yBottom - yTop);
        const barY = Math.min(yTop, yBottom);

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
          value: rawValue,
          seriesName: data.series[si].name,
          categoryName: category,
        });
      }
    }
  } else {
    // Grouped geometry (original)
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
