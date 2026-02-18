//! FILENAME: app/extensions/Charts/rendering/barChartPainter.ts
// PURPOSE: Pure Canvas 2D bar chart drawing. No external library.
// CONTEXT: Called by chartRenderer to paint a bar chart onto an OffscreenCanvas
//          or a preview canvas. Draws axes, grid lines, bars, title, and legend.

import type { ChartSpec, ParsedChartData, BarRect } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { createLinearScale, createBandScale } from "./scales";
import type { LinearScale, BandScale } from "./scales";

// ============================================================================
// Layout
// ============================================================================

export interface BarChartLayout {
  /** Total canvas dimensions. */
  width: number;
  height: number;
  /** Margins around the plot area. */
  margin: { top: number; right: number; bottom: number; left: number };
  /** The plot area rect (inside margins). */
  plotArea: { x: number; y: number; width: number; height: number };
}

/**
 * Compute the layout (margins and plot area) for a bar chart.
 * Margins accommodate title, axis labels, and legend.
 */
export function computeLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): BarChartLayout {
  let top = 12;
  let right = 16;
  let bottom = 12;
  let left = 16;

  // Title
  if (spec.title) {
    top += theme.titleFontSize + 8;
  }

  // Y-axis labels (estimate max label width)
  if (spec.yAxis.showLabels) {
    left += 40;
  }
  if (spec.yAxis.title) {
    left += theme.axisTitleFontSize + 6;
  }

  // X-axis labels
  if (spec.xAxis.showLabels) {
    if (spec.xAxis.labelAngle === 0) {
      bottom += theme.labelFontSize + 8;
    } else if (spec.xAxis.labelAngle === 45) {
      bottom += 30;
    } else {
      // 90 degrees
      const maxLen = Math.max(...data.categories.map((c) => c.length), 3);
      bottom += Math.min(maxLen * 5, 60);
    }
  }
  if (spec.xAxis.title) {
    bottom += theme.axisTitleFontSize + 6;
  }

  // Legend
  if (spec.legend.visible && data.series.length > 0) {
    if (spec.legend.position === "bottom") {
      bottom += theme.legendFontSize + 16;
    } else if (spec.legend.position === "top") {
      top += theme.legendFontSize + 16;
    } else if (spec.legend.position === "right") {
      const maxNameLen = Math.max(...data.series.map((s) => s.name.length), 3);
      right += Math.min(maxNameLen * 6, 100) + 24;
    } else {
      const maxNameLen = Math.max(...data.series.map((s) => s.name.length), 3);
      left += Math.min(maxNameLen * 6, 100) + 24;
    }
  }

  const plotArea = {
    x: left,
    y: top,
    width: Math.max(width - left - right, 10),
    height: Math.max(height - top - bottom, 10),
  };

  return { width, height, margin: { top, right, bottom, left }, plotArea };
}

// ============================================================================
// Main Paint Function
// ============================================================================

/**
 * Paint a bar chart onto a Canvas 2D context.
 * Assumes the context is already sized and scaled (including DPR).
 */
export function paintBarChart(
  ctx: CanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: BarChartLayout,
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
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, layout.width, layout.height);

  // 2. Plot area background
  ctx.fillStyle = theme.plotBackground;
  ctx.fillRect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);

  // 3. Grid lines
  if (spec.yAxis.gridLines) {
    drawGridLines(ctx, yScale, plotArea, theme);
  }

  // 4. Axes
  drawAxes(ctx, xScale, yScale, plotArea, spec, theme);

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

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  yScale: LinearScale,
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
): void {
  const ticks = yScale.ticks(5);
  ctx.strokeStyle = theme.gridLineColor;
  ctx.lineWidth = theme.gridLineWidth;

  for (const tick of ticks) {
    const y = Math.round(yScale.scale(tick)) + 0.5;
    if (y < plotArea.y || y > plotArea.y + plotArea.height) continue;
    ctx.beginPath();
    ctx.moveTo(plotArea.x, y);
    ctx.lineTo(plotArea.x + plotArea.width, y);
    ctx.stroke();
  }
}

function drawAxes(
  ctx: CanvasRenderingContext2D,
  xScale: BandScale,
  yScale: LinearScale,
  plotArea: { x: number; y: number; width: number; height: number },
  spec: ChartSpec,
  theme: ChartRenderTheme,
): void {
  ctx.strokeStyle = theme.axisColor;
  ctx.lineWidth = 1;

  // X axis line
  const xAxisY = plotArea.y + plotArea.height;
  ctx.beginPath();
  ctx.moveTo(plotArea.x, xAxisY + 0.5);
  ctx.lineTo(plotArea.x + plotArea.width, xAxisY + 0.5);
  ctx.stroke();

  // Y axis line
  ctx.beginPath();
  ctx.moveTo(plotArea.x - 0.5, plotArea.y);
  ctx.lineTo(plotArea.x - 0.5, xAxisY);
  ctx.stroke();

  // X axis labels
  if (spec.xAxis.showLabels) {
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;

    for (const category of xScale.domain) {
      const x = xScale.scale(category) + xScale.bandwidth / 2;
      const y = xAxisY + 4;

      ctx.save();
      if (spec.xAxis.labelAngle === 0) {
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        // Truncate long labels
        const maxWidth = xScale.bandwidth - 4;
        const label = truncateText(ctx, category, maxWidth);
        ctx.fillText(label, x, y);
      } else if (spec.xAxis.labelAngle === 45) {
        ctx.translate(x, y);
        ctx.rotate(-Math.PI / 4);
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText(category, 0, 0);
      } else {
        // 90 degrees
        ctx.translate(x, y);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(category, 0, 0);
      }
      ctx.restore();
    }
  }

  // X axis title
  if (spec.xAxis.title) {
    ctx.fillStyle = theme.axisTitleColor;
    ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      spec.xAxis.title,
      plotArea.x + plotArea.width / 2,
      plotArea.y + plotArea.height + (spec.xAxis.showLabels ? 30 : 16),
    );
  }

  // Y axis labels
  if (spec.yAxis.showLabels) {
    const ticks = yScale.ticks(5);
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (const tick of ticks) {
      const y = yScale.scale(tick);
      if (y < plotArea.y || y > plotArea.y + plotArea.height) continue;
      ctx.fillText(formatTickValue(tick), plotArea.x - 6, y);
    }
  }

  // Y axis title
  if (spec.yAxis.title) {
    ctx.save();
    ctx.fillStyle = theme.axisTitleColor;
    ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
    ctx.translate(14, plotArea.y + plotArea.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(spec.yAxis.title, 0, 0);
    ctx.restore();
  }
}

function drawBars(
  ctx: CanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  xScale: BandScale,
  yScale: LinearScale,
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
    const category = data.categories[ci];
    const groupX = xScale.scale(category);

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
  layout: BarChartLayout,
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
    const groupX = xScale.scale(category);

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

// ============================================================================
// Drawing Helpers
// ============================================================================

function drawTitle(
  ctx: CanvasRenderingContext2D,
  title: string,
  layout: BarChartLayout,
  theme: ChartRenderTheme,
): void {
  ctx.fillStyle = theme.titleColor;
  ctx.font = `600 ${theme.titleFontSize}px ${theme.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(title, layout.width / 2, 10);
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: BarChartLayout,
  theme: ChartRenderTheme,
): void {
  ctx.font = `${theme.legendFontSize}px ${theme.fontFamily}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const swatchSize = 10;
  const gap = 16;
  const padding = 4;

  if (spec.legend.position === "bottom" || spec.legend.position === "top") {
    // Horizontal legend centered below/above the plot
    let totalWidth = 0;
    const items: Array<{ name: string; color: string; width: number }> = [];
    for (let i = 0; i < data.series.length; i++) {
      const name = data.series[i].name;
      const color = getSeriesColor(spec.palette, i, data.series[i].color);
      const textWidth = ctx.measureText(name).width;
      const itemWidth = swatchSize + padding + textWidth;
      items.push({ name, color, width: itemWidth });
      totalWidth += itemWidth;
    }
    totalWidth += gap * (items.length - 1);

    const y = spec.legend.position === "bottom"
      ? layout.height - theme.legendFontSize - 4
      : layout.margin.top - theme.legendFontSize - 12;

    let x = (layout.width - totalWidth) / 2;

    for (const item of items) {
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y - swatchSize / 2, swatchSize, swatchSize);
      ctx.fillStyle = theme.legendTextColor;
      ctx.fillText(item.name, x + swatchSize + padding, y);
      x += item.width + gap;
    }
  } else {
    // Vertical legend on the right or left
    const x = spec.legend.position === "right"
      ? layout.plotArea.x + layout.plotArea.width + 16
      : 8;
    let y = layout.plotArea.y + 4;

    for (let i = 0; i < data.series.length; i++) {
      const name = data.series[i].name;
      const color = getSeriesColor(spec.palette, i, data.series[i].color);

      ctx.fillStyle = color;
      ctx.fillRect(x, y - swatchSize / 2, swatchSize, swatchSize);
      ctx.fillStyle = theme.legendTextColor;
      ctx.fillText(name, x + swatchSize + padding, y);
      y += theme.legendFontSize + 6;
    }
  }
}

// ============================================================================
// Utility
// ============================================================================

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated + "...").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "...";
}

export function formatTickValue(value: number): string {
  if (Math.abs(value) >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
  if (Math.abs(value) >= 1_000) return (value / 1_000).toFixed(1) + "K";
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(1);
}
