//! FILENAME: app/extensions/Charts/rendering/waterfallChartPainter.ts
// PURPOSE: Pure Canvas 2D waterfall chart drawing.
// CONTEXT: Shows running totals with increase (green), decrease (red), and total (blue) bars.
//          Each bar starts where the previous one ended. Connector lines link bars.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, WaterfallMarkOptions } from "../types";
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

// Default waterfall colors
const DEFAULT_INCREASE_COLOR = "#4CAF50";
const DEFAULT_DECREASE_COLOR = "#E53935";
const DEFAULT_TOTAL_COLOR = "#5C6BC0";

// ============================================================================
// Layout
// ============================================================================

export function computeWaterfallLayout(
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

export function paintWaterfallChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as WaterfallMarkOptions;
  const showConnectors = opts.showConnectors ?? true;
  const increaseColor = opts.increaseColor ?? DEFAULT_INCREASE_COLOR;
  const decreaseColor = opts.decreaseColor ?? DEFAULT_DECREASE_COLOR;
  const totalColor = opts.totalColor ?? DEFAULT_TOTAL_COLOR;
  const totalIndices = new Set(opts.totalIndices ?? []);

  // Use first series only
  const series = data.series[0];
  if (!series) return;

  // Compute running totals and value range
  const { bars, minVal, maxVal } = computeWaterfallBars(series.values, data.categories, totalIndices);

  const yMin = spec.yAxis.min ?? Math.min(0, minVal);
  const yMax = spec.yAxis.max ?? maxVal;

  const yScale = createLinearScale(
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
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

  // 5. Bars and connectors
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  const barWidth = xScale.bandwidth * 0.7;
  const barOffset = (xScale.bandwidth - barWidth) / 2;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const x = xScale.scaleIndex(i) + barOffset;
    const topY = yScale.scale(Math.max(bar.start, bar.end));
    const bottomY = yScale.scale(Math.min(bar.start, bar.end));
    const barHeight = Math.max(bottomY - topY, 1);

    // Choose color
    let color: string;
    if (bar.type === "total") {
      color = totalColor;
    } else if (bar.type === "increase") {
      color = increaseColor;
    } else {
      color = decreaseColor;
    }

    ctx.fillStyle = color;
    if (theme.barBorderRadius > 0 && barHeight > theme.barBorderRadius * 2) {
      drawRoundedRect(ctx, x, topY, barWidth, barHeight, theme.barBorderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(x, topY, barWidth, barHeight);
    }

    // Connector line to next bar
    if (showConnectors && i < bars.length - 1) {
      const nextBar = bars[i + 1];
      const connectorY = yScale.scale(bar.end);
      const nextX = xScale.scaleIndex(i + 1) + barOffset;

      ctx.strokeStyle = "#999999";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x + barWidth, connectorY);
      ctx.lineTo(nextX, connectorY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  ctx.restore();

  // 6. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 7. Legend (show increase/decrease/total)
  if (spec.legend.visible) {
    drawWaterfallLegend(ctx, spec, layout, theme, increaseColor, decreaseColor, totalColor, totalIndices.size > 0);
  }
}

// ============================================================================
// Waterfall Bar Computation
// ============================================================================

interface WaterfallBar {
  start: number;
  end: number;
  value: number;
  type: "increase" | "decrease" | "total";
  category: string;
}

function computeWaterfallBars(
  values: number[],
  categories: string[],
  totalIndices: Set<number>,
): { bars: WaterfallBar[]; minVal: number; maxVal: number } {
  const bars: WaterfallBar[] = [];
  let runningTotal = 0;
  let minVal = 0;
  let maxVal = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0;

    if (totalIndices.has(i)) {
      // Total bar: show running total from 0
      bars.push({
        start: 0,
        end: runningTotal,
        value: runningTotal,
        type: "total",
        category: categories[i],
      });
    } else {
      const start = runningTotal;
      runningTotal += value;
      bars.push({
        start,
        end: runningTotal,
        value,
        type: value >= 0 ? "increase" : "decrease",
        category: categories[i],
      });
    }

    minVal = Math.min(minVal, runningTotal, 0);
    maxVal = Math.max(maxVal, runningTotal);
  }

  return { bars, minVal, maxVal };
}

// ============================================================================
// Custom Legend
// ============================================================================

function drawWaterfallLegend(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
  increaseColor: string,
  decreaseColor: string,
  totalColor: string,
  hasTotals: boolean,
): void {
  const items: Array<{ name: string; color: string }> = [
    { name: "Increase", color: increaseColor },
    { name: "Decrease", color: decreaseColor },
  ];
  if (hasTotals) {
    items.push({ name: "Total", color: totalColor });
  }

  ctx.font = `${theme.legendFontSize}px ${theme.fontFamily}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const swatchSize = 10;
  const gap = 16;
  const padding = 4;

  let totalWidth = 0;
  const measured = items.map((item) => {
    const textWidth = ctx.measureText(item.name).width;
    const itemWidth = swatchSize + padding + textWidth;
    totalWidth += itemWidth;
    return { ...item, width: itemWidth };
  });
  totalWidth += gap * (measured.length - 1);

  const y = layout.height - theme.legendFontSize - 4;
  let x = (layout.width - totalWidth) / 2;

  for (const item of measured) {
    ctx.fillStyle = item.color;
    ctx.fillRect(x, y - swatchSize / 2, swatchSize, swatchSize);
    ctx.fillStyle = theme.legendTextColor;
    ctx.fillText(item.name, x + swatchSize + padding, y);
    x += item.width + gap;
  }
}

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeWaterfallBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): BarRect[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as WaterfallMarkOptions;
  const totalIndices = new Set(opts.totalIndices ?? []);
  const rects: BarRect[] = [];

  const series = data.series[0];
  if (!series) return rects;

  const { bars, minVal, maxVal } = computeWaterfallBars(series.values, data.categories, totalIndices);

  const yMin = spec.yAxis.min ?? Math.min(0, minVal);
  const yMax = spec.yAxis.max ?? maxVal;

  const yScale = createLinearScale(
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createBandScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.3,
  );

  const barWidth = xScale.bandwidth * 0.7;
  const barOffset = (xScale.bandwidth - barWidth) / 2;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const x = xScale.scaleIndex(i) + barOffset;
    const topY = yScale.scale(Math.max(bar.start, bar.end));
    const bottomY = yScale.scale(Math.min(bar.start, bar.end));
    const barHeight = Math.max(bottomY - topY, 1);

    rects.push({
      seriesIndex: 0,
      categoryIndex: i,
      x,
      y: topY,
      width: barWidth,
      height: barHeight,
      value: bar.value,
      seriesName: bar.type,
      categoryName: bar.category,
    });
  }

  return rects;
}
