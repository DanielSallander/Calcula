//! FILENAME: app/extensions/Charts/rendering/bubbleChartPainter.ts
// PURPOSE: Pure Canvas 2D bubble chart drawing.
// CONTEXT: Scatter chart where a third series determines bubble size.
//          First series = Y values, second (or specified) = size values.

import type { ChartSpec, ParsedChartData, ChartLayout, PointMarker, BubbleMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { resolvePointColor, resolvePointOpacity } from "../lib/encodingResolver";
import { createLinearScale, createPointScale, createScaleFromSpec } from "./scales";
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

export function computeBubbleLayout(
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

export function paintBubbleChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as BubbleMarkOptions;
  const minBubble = opts.minBubbleSize ?? 4;
  const maxBubble = opts.maxBubbleSize ?? 30;
  const bubbleOpacity = opts.bubbleOpacity ?? 0.7;

  // Determine size series: default to last series, or use specified index
  const sizeSeriesIdx = opts.sizeSeriesIndex ?? (data.series.length > 1 ? data.series.length - 1 : -1);
  const valueSeries = data.series.filter((_, i) => i !== sizeSeriesIdx);
  const sizeSeries = sizeSeriesIdx >= 0 && sizeSeriesIdx < data.series.length
    ? data.series[sizeSeriesIdx]
    : null;

  // Compute Y scale from value series
  const allValues = valueSeries.flatMap((s) => s.values);
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;

  const yMin = spec.yAxis.min ?? dataMin;
  const yMax = spec.yAxis.max ?? dataMax;

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createPointScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
  );

  // Compute size scale
  const sizeValues = sizeSeries ? sizeSeries.values : [];
  const sizeMin = sizeValues.length > 0 ? Math.min(...sizeValues.filter((v) => v > 0)) : 1;
  const sizeMax = sizeValues.length > 0 ? Math.max(...sizeValues) : 1;
  const sizeRange = sizeMax - sizeMin || 1;

  function getBubbleRadius(ci: number): number {
    if (!sizeSeries) return (minBubble + maxBubble) / 2;
    const val = sizeSeries.values[ci] ?? 0;
    const norm = (Math.max(0, val) - sizeMin) / sizeRange;
    return minBubble + norm * (maxBubble - minBubble);
  }

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  // 2. Plot area background
  drawPlotBackground(ctx, plotArea, theme);

  // 3. Grid lines
  if (spec.yAxis.gridLines) {
    drawHorizontalGridLines(ctx, yScale, plotArea, theme);
  }

  // 4. Axes
  drawBubbleAxes(ctx, xScale, yScale, plotArea, spec, theme);

  // 5. Bubbles
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  for (let si = 0; si < valueSeries.length; si++) {
    const series = valueSeries[si];
    const origIdx = data.series.indexOf(series);
    const encoding = spec.series[origIdx]?.encoding;

    for (let ci = 0; ci < data.categories.length; ci++) {
      const value = series.values[ci] ?? 0;
      const category = data.categories[ci] ?? "";
      const color = resolvePointColor(encoding, spec.palette, origIdx, series.color, value, category);
      const pointOpacity = resolvePointOpacity(encoding, value, category) ?? bubbleOpacity;

      const x = xScale.scaleIndex(ci);
      const y = yScale.scale(value);
      const r = getBubbleRadius(ci);

      ctx.globalAlpha = pointOpacity;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // 6. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 7. Legend
  if (spec.legend.visible && valueSeries.length > 1) {
    drawLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Axes
// ============================================================================

function drawBubbleAxes(
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

export function computeBubblePointMarkers(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): PointMarker[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as BubbleMarkOptions;
  const minBubble = opts.minBubbleSize ?? 4;
  const maxBubble = opts.maxBubbleSize ?? 30;
  const markers: PointMarker[] = [];

  const sizeSeriesIdx = opts.sizeSeriesIndex ?? (data.series.length > 1 ? data.series.length - 1 : -1);
  const valueSeries = data.series.filter((_, i) => i !== sizeSeriesIdx);
  const sizeSeries = sizeSeriesIdx >= 0 && sizeSeriesIdx < data.series.length
    ? data.series[sizeSeriesIdx]
    : null;

  const allValues = valueSeries.flatMap((s) => s.values);
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;

  const yMin = spec.yAxis.min ?? dataMin;
  const yMax = spec.yAxis.max ?? dataMax;

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createPointScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
  );

  const sizeValues = sizeSeries ? sizeSeries.values : [];
  const sizeMin = sizeValues.length > 0 ? Math.min(...sizeValues.filter((v) => v > 0)) : 1;
  const sizeMax = sizeValues.length > 0 ? Math.max(...sizeValues) : 1;
  const sizeRange = sizeMax - sizeMin || 1;

  for (let si = 0; si < valueSeries.length; si++) {
    const series = valueSeries[si];
    for (let ci = 0; ci < data.categories.length; ci++) {
      const value = series.values[ci] ?? 0;
      let bubbleR = (minBubble + maxBubble) / 2;
      if (sizeSeries) {
        const sv = sizeSeries.values[ci] ?? 0;
        const norm = (Math.max(0, sv) - sizeMin) / sizeRange;
        bubbleR = minBubble + norm * (maxBubble - minBubble);
      }
      markers.push({
        seriesIndex: si,
        categoryIndex: ci,
        cx: xScale.scaleIndex(ci),
        cy: yScale.scale(value),
        radius: bubbleR,
        value,
        seriesName: series.name,
        categoryName: data.categories[ci],
      });
    }
  }

  return markers;
}
