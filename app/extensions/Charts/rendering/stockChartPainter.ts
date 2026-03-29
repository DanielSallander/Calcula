//! FILENAME: app/extensions/Charts/rendering/stockChartPainter.ts
// PURPOSE: Pure Canvas 2D stock chart drawing (Candlestick / OHLC bars).
// CONTEXT: Requires 4 data series mapped to Open, High, Low, Close.
//          Each category represents one time period (day, hour, etc.).

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, StockMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { createLinearScale, createBandScale, createScaleFromSpec } from "./scales";
import {
  computeCartesianLayout,
  drawChartBackground,
  drawPlotBackground,
  drawHorizontalGridLines,
  drawCartesianAxes,
  drawTitle,
  drawLegend,
} from "./chartPainterUtils";

// ============================================================================
// Layout
// ============================================================================

export function computeStockLayout(
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

export function paintStockChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as StockMarkOptions;
  const style = opts.style ?? "candlestick";
  const upColor = opts.upColor ?? "#4CAF50";
  const downColor = opts.downColor ?? "#E53935";
  const bodyWidthRatio = opts.bodyWidth ?? 0.6;
  const wickWidth = opts.wickWidth ?? 1;
  const [oIdx, hIdx, lIdx, cIdx] = opts.ohlcIndices ?? [0, 1, 2, 3];

  // Need at least 4 series for OHLC
  if (data.series.length < 4) {
    drawChartBackground(ctx, layout, theme);
    // Draw informative message
    ctx.fillStyle = "#999";
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "Stock chart requires 4 series: Open, High, Low, Close",
      layout.width / 2,
      layout.height / 2,
    );
    return;
  }

  const openValues = data.series[oIdx]?.values ?? [];
  const highValues = data.series[hIdx]?.values ?? [];
  const lowValues = data.series[lIdx]?.values ?? [];
  const closeValues = data.series[cIdx]?.values ?? [];

  const n = data.categories.length;
  if (n === 0) {
    drawChartBackground(ctx, layout, theme);
    return;
  }

  // Compute Y domain from High/Low extremes
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const lo = lowValues[i] ?? 0;
    const hi = highValues[i] ?? 0;
    yMin = Math.min(yMin, lo);
    yMax = Math.max(yMax, hi);
  }
  if (!isFinite(yMin)) yMin = 0;
  if (!isFinite(yMax)) yMax = 1;

  // Add padding
  const padding = (yMax - yMin) * 0.05;
  yMin = spec.yAxis.min ?? (yMin - padding);
  yMax = spec.yAxis.max ?? (yMax + padding);

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createBandScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.2,
  );

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  // 2. Plot background
  drawPlotBackground(ctx, plotArea, theme);

  // 3. Grid lines
  if (spec.yAxis.gridLines) {
    drawHorizontalGridLines(ctx, yScale, plotArea, theme);
  }

  // 4. Axes
  drawCartesianAxes(ctx, xScale, yScale, plotArea, spec, theme);

  // 5. Draw candles/OHLC bars
  for (let i = 0; i < n; i++) {
    const open = openValues[i] ?? 0;
    const high = highValues[i] ?? 0;
    const low = lowValues[i] ?? 0;
    const close = closeValues[i] ?? 0;

    const isUp = close >= open;
    const color = isUp ? upColor : downColor;

    const bandCenter = xScale.scaleIndex(i) + xScale.bandwidth / 2;
    const bodyWidth = xScale.bandwidth * bodyWidthRatio;
    const bodyLeft = bandCenter - bodyWidth / 2;

    const yOpen = yScale.scale(open);
    const yClose = yScale.scale(close);
    const yHigh = yScale.scale(high);
    const yLow = yScale.scale(low);

    const bodyTop = Math.min(yOpen, yClose);
    const bodyBottom = Math.max(yOpen, yClose);
    const bodyHeight = Math.max(bodyBottom - bodyTop, 1); // min 1px

    if (style === "candlestick") {
      // Wick (high-low line)
      ctx.strokeStyle = color;
      ctx.lineWidth = wickWidth;
      ctx.beginPath();
      ctx.moveTo(bandCenter, yHigh);
      ctx.lineTo(bandCenter, yLow);
      ctx.stroke();

      // Body (open-close rect)
      ctx.fillStyle = isUp ? color : color;
      ctx.fillRect(bodyLeft, bodyTop, bodyWidth, bodyHeight);

      // Body border for hollow up candles (optional: filled by default)
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(bodyLeft, bodyTop, bodyWidth, bodyHeight);
    } else {
      // OHLC bars
      ctx.strokeStyle = color;
      ctx.lineWidth = wickWidth;

      // Vertical line (high-low)
      ctx.beginPath();
      ctx.moveTo(bandCenter, yHigh);
      ctx.lineTo(bandCenter, yLow);
      ctx.stroke();

      // Left tick (open)
      const tickLen = bodyWidth / 2;
      ctx.beginPath();
      ctx.moveTo(bandCenter - tickLen, yOpen);
      ctx.lineTo(bandCenter, yOpen);
      ctx.stroke();

      // Right tick (close)
      ctx.beginPath();
      ctx.moveTo(bandCenter, yClose);
      ctx.lineTo(bandCenter + tickLen, yClose);
      ctx.stroke();
    }
  }

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
// Hit Geometry
// ============================================================================

export function computeStockBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): BarRect[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as StockMarkOptions;
  const bodyWidthRatio = opts.bodyWidth ?? 0.6;
  const [oIdx, hIdx, lIdx, cIdx] = opts.ohlcIndices ?? [0, 1, 2, 3];
  const rects: BarRect[] = [];

  if (data.series.length < 4) return rects;

  const highValues = data.series[hIdx]?.values ?? [];
  const lowValues = data.series[lIdx]?.values ?? [];
  const closeValues = data.series[cIdx]?.values ?? [];
  const n = data.categories.length;
  if (n === 0) return rects;

  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    yMin = Math.min(yMin, lowValues[i] ?? 0);
    yMax = Math.max(yMax, highValues[i] ?? 0);
  }
  if (!isFinite(yMin)) yMin = 0;
  if (!isFinite(yMax)) yMax = 1;

  const padding = (yMax - yMin) * 0.05;
  yMin = spec.yAxis.min ?? (yMin - padding);
  yMax = spec.yAxis.max ?? (yMax + padding);

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createBandScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.2,
  );

  for (let i = 0; i < n; i++) {
    const high = highValues[i] ?? 0;
    const low = lowValues[i] ?? 0;
    const close = closeValues[i] ?? 0;

    const bandCenter = xScale.scaleIndex(i) + xScale.bandwidth / 2;
    const bodyWidth = xScale.bandwidth * bodyWidthRatio;
    const bodyLeft = bandCenter - bodyWidth / 2;

    const yHigh = yScale.scale(high);
    const yLow = yScale.scale(low);

    rects.push({
      seriesIndex: 0,
      categoryIndex: i,
      x: bodyLeft,
      y: Math.min(yHigh, yLow),
      width: bodyWidth,
      height: Math.abs(yLow - yHigh),
      value: close,
      seriesName: "Close",
      categoryName: data.categories[i] ?? `Period ${i + 1}`,
    });
  }

  return rects;
}
