//! FILENAME: app/extensions/Charts/rendering/bubbleChartPainter.ts
// PURPOSE: Pure Canvas 2D bubble chart drawing.
// CONTEXT: Scatter chart where a third series determines bubble size.
//          First series = Y values, second (or specified) = size values.

import type { ChartSpec, ParsedChartData, ChartLayout, PointMarker, BubbleMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { resolvePointColor, resolvePointOpacity, resolveSeriesEncoding, seriesPaletteIndex } from "../lib/encodingResolver";
import { resolveDatumStyle } from "../lib/dataPointOverrides";
import {
  paintDatumMarker,
  recordXAxisTitleRect,
  recordYAxisTitleRect,
  recordYLabelBandRect,
  xAxisTitleBaselineY,
  Y_AXIS_TITLE_X,
} from "./markerPainter";
import { createLinearScale, createScaleFromSpec } from "./scales";
import {
  computeCartesianLayout,
  drawChartBackground,
  drawPlotBackground,
  drawHorizontalGridLines,
  drawTitle,
  drawLegend,
  formatTickValue,
  resolveScatterXAxis,
  type ScatterXAxis,
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

  const xAxis = resolveScatterXAxis(data, spec, plotArea);

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

  // 4. Axes (the layout is passed so the axis titles and the y-label band
  //    replace the layout's character-count estimates with measured boxes)
  drawBubbleAxes(ctx, xAxis, yScale, plotArea, spec, theme, layout);

  // 5. Bubbles
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  for (let si = 0; si < valueSeries.length; si++) {
    const series = valueSeries[si];
    const origIdx = data.series.indexOf(series);
    const encoding = resolveSeriesEncoding(spec, series.name);

    for (let ci = 0; ci < data.categories.length; ci++) {
      const value = series.values[ci] ?? 0;
      const category = data.categories[ci] ?? "";
      const sel = { seriesName: series.name, selection: data.selection };
      const color = resolvePointColor(encoding, spec.palette, seriesPaletteIndex(data, origIdx), series.color, value, category, sel);
      const pointOpacity = resolvePointOpacity(encoding, value, category, sel) ?? bubbleOpacity;

      const x = xAxis.xOf(ci);
      const y = yScale.scale(value);
      const r = getBubbleRadius(ci);

      // Per-point override. `origIdx` — NOT the loop counter — is the painter's
      // series index here: `valueSeries` has the size series filtered out of it,
      // so resolving on `si` would alias every override one series across as
      // soon as the size series is not the last one.
      const style = resolveDatumStyle(spec, data, origIdx, ci, {
        fill: color,
        opacity: pointOpacity,
        markerStyle: "circle",
      });

      // `markerSize` is deliberately NOT honoured on a bubble: the radius
      // ENCODES the size series, and letting a formatting override resize one
      // bubble would make the chart lie about its data. Shape, fill, opacity
      // and border all apply, and markerStyle "none" hides the bubble.
      paintDatumMarker(ctx, x, y, {
        shape: style.markerStyle ?? "circle",
        size: r,
        fill: style.markerFill ?? style.fill,
        borderColor: style.markerBorderColor ?? style.borderColor ?? style.markerFill ?? style.fill,
        borderWidth: style.markerBorderWidth ?? style.borderWidth ?? 1,
        opacity: style.opacity,
      });
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

/**
 * `layout` is OPTIONAL and exists only for the element-rect write-back, exactly
 * like `drawCartesianAxes`: passing it replaces the layout's estimates for the
 * axis titles and the y-label band with their measured boxes. Omitting it
 * paints identically and leaves the estimates alone.
 */
function drawBubbleAxes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  xAxis: ScatterXAxis,
  yScale: ReturnType<typeof createLinearScale>,
  plotArea: { x: number; y: number; width: number; height: number },
  spec: ChartSpec,
  theme: ChartRenderTheme,
  layout?: ChartLayout,
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

    for (const tick of xAxis.ticks) {
      ctx.fillText(tick.label, tick.x, xAxisY + 4);
    }
  }

  // Y axis labels
  let widestYLabel = 0;
  if (spec.yAxis.showLabels) {
    const ticks = yScale.ticks(5);
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (const tick of ticks) {
      const y = yScale.scale(tick);
      if (y < plotArea.y || y > plotArea.y + plotArea.height) continue;
      const label = formatTickValue(tick);
      const w = ctx.measureText(label).width;
      if (w > widestYLabel) widestYLabel = w;
      ctx.fillText(label, plotArea.x - 6, y);
    }
    if (layout) recordYLabelBandRect(layout, plotArea, widestYLabel);
  }

  // Axis titles
  if (spec.xAxis.title) {
    ctx.fillStyle = theme.axisTitleColor;
    ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const baselineY = xAxisTitleBaselineY(plotArea, spec.xAxis.showLabels);
    ctx.fillText(spec.xAxis.title, plotArea.x + plotArea.width / 2, baselineY);
    if (layout) {
      recordXAxisTitleRect(
        layout, plotArea, ctx.measureText(spec.xAxis.title).width, baselineY, theme.axisTitleFontSize,
      );
    }
  }
  if (spec.yAxis.title) {
    ctx.save();
    ctx.fillStyle = theme.axisTitleColor;
    ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
    ctx.translate(Y_AXIS_TITLE_X, plotArea.y + plotArea.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(spec.yAxis.title, 0, 0);
    // Measure BEFORE restore: restore() puts the previous font back, and a rect
    // measured under the wrong font is fiction that hit-testing would believe.
    const titleWidth = ctx.measureText(spec.yAxis.title).width;
    ctx.restore();
    if (layout) recordYAxisTitleRect(layout, plotArea, titleWidth, theme.axisTitleFontSize);
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

  const xAxis = resolveScatterXAxis(data, spec, plotArea);

  const sizeValues = sizeSeries ? sizeSeries.values : [];
  const sizeMin = sizeValues.length > 0 ? Math.min(...sizeValues.filter((v) => v > 0)) : 1;
  const sizeMax = sizeValues.length > 0 ? Math.max(...sizeValues) : 1;
  const sizeRange = sizeMax - sizeMin || 1;

  for (let si = 0; si < valueSeries.length; si++) {
    const series = valueSeries[si];
    // THE SERIES INDEX IS THE ONE IN `data.series`, NOT THE LOOP COUNTER.
    // `valueSeries` has the SIZE series filtered out, so `si` slides by one for
    // every value series after it. `paintBubbleChart` already resolves per-point
    // overrides at this same `origIdx` (and picks its palette slot from it) —
    // the fix was applied to the painter and not to the geometry, so with a
    // sizeSeriesIndex that is not the last series the hit test named series
    // `si` while the paint used `origIdx`: colouring a bubble in B recoloured
    // A, and colouring one in A wrote at the size series' address, which is
    // never painted at all.
    const origIdx = data.series.indexOf(series);
    for (let ci = 0; ci < data.categories.length; ci++) {
      const value = series.values[ci] ?? 0;
      let bubbleR = (minBubble + maxBubble) / 2;
      if (sizeSeries) {
        const sv = sizeSeries.values[ci] ?? 0;
        const norm = (Math.max(0, sv) - sizeMin) / sizeRange;
        bubbleR = minBubble + norm * (maxBubble - minBubble);
      }
      markers.push({
        seriesIndex: origIdx,
        categoryIndex: ci,
        cx: xAxis.xOf(ci),
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
