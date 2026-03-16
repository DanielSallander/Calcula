//! FILENAME: app/extensions/Charts/rendering/scatterChartPainter.ts
// PURPOSE: Pure Canvas 2D scatter chart drawing.
// CONTEXT: Two numeric axes (both LinearScale). Each series plots (category-index, value) pairs.
//          Supports multiple point shapes: circle, square, diamond, triangle.

import type { ChartSpec, ParsedChartData, ChartLayout, PointMarker, ScatterMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { createLinearScale, createPointScale } from "./scales";
import {
  computeCartesianLayout,
  drawChartBackground,
  drawPlotBackground,
  drawHorizontalGridLines,
  drawTitle,
  drawLegend,
  formatTickValue,
} from "./chartPainterUtils";

// ============================================================================
// Layout
// ============================================================================

export function computeScatterLayout(
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

export function paintScatterChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as ScatterMarkOptions;
  const pointSize = opts.pointSize ?? 5;
  const pointShape = opts.pointShape ?? "circle";

  // Compute scales
  const allValues = data.series.flatMap((s) => s.values);
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;

  const yMin = spec.yAxis.min ?? dataMin;
  const yMax = spec.yAxis.max ?? dataMax;

  const yScale = createLinearScale(
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createPointScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
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
  drawScatterAxes(ctx, xScale, yScale, plotArea, spec, theme);

  // 5. Points
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    const color = getSeriesColor(spec.palette, si, series.color);
    ctx.fillStyle = color;

    for (let ci = 0; ci < data.categories.length; ci++) {
      const x = xScale.scaleIndex(ci);
      const y = yScale.scale(series.values[ci] ?? 0);
      drawPoint(ctx, x, y, pointSize, pointShape);
    }
  }

  ctx.restore();

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
// Point Drawing
// ============================================================================

function drawPoint(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  shape: string,
): void {
  ctx.beginPath();
  switch (shape) {
    case "square":
      ctx.rect(x - size, y - size, size * 2, size * 2);
      break;
    case "diamond":
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
      ctx.closePath();
      break;
    case "triangle":
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y + size);
      ctx.lineTo(x - size, y + size);
      ctx.closePath();
      break;
    default: // circle
      ctx.arc(x, y, size, 0, Math.PI * 2);
      break;
  }
  ctx.fill();
}

// ============================================================================
// Axes
// ============================================================================

function drawScatterAxes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  xScale: ReturnType<typeof createPointScale>,
  yScale: ReturnType<typeof createLinearScale>,
  plotArea: { x: number; y: number; width: number; height: number },
  spec: ChartSpec,
  theme: ChartRenderTheme,
): void {
  ctx.strokeStyle = theme.axisColor;
  ctx.lineWidth = 1;

  const xAxisY = plotArea.y + plotArea.height;

  // X axis line
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
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let ci = 0; ci < xScale.domain.length; ci++) {
      const x = xScale.scaleIndex(ci);
      ctx.fillText(xScale.domain[ci], x, xAxisY + 4);
    }
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

  // Axis titles
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

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeScatterPointMarkers(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): PointMarker[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as ScatterMarkOptions;
  const pointSize = opts.pointSize ?? 5;
  const markers: PointMarker[] = [];

  const allValues = data.series.flatMap((s) => s.values);
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;

  const yMin = spec.yAxis.min ?? dataMin;
  const yMax = spec.yAxis.max ?? dataMax;

  const yScale = createLinearScale(
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createPointScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
  );

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    for (let ci = 0; ci < data.categories.length; ci++) {
      const value = series.values[ci] ?? 0;
      markers.push({
        seriesIndex: si,
        categoryIndex: ci,
        cx: xScale.scaleIndex(ci),
        cy: yScale.scale(value),
        radius: pointSize,
        value,
        seriesName: series.name,
        categoryName: data.categories[ci],
      });
    }
  }

  return markers;
}
