//! FILENAME: app/extensions/Charts/rendering/scatterChartPainter.ts
// PURPOSE: Pure Canvas 2D scatter chart drawing.
// CONTEXT: Two numeric axes (both LinearScale). Each series plots (category-index, value) pairs.
//          Supports multiple point shapes: circle, square, diamond, triangle.

import type { ChartSpec, ParsedChartData, ChartLayout, PointMarker, ScatterMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { resolvePointColor, resolvePointOpacity, resolvePointSize, resolveSeriesEncoding, seriesPaletteIndex } from "../lib/encodingResolver";
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

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xAxis = resolveScatterXAxis(data, spec, plotArea);

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
  drawScatterAxes(ctx, xAxis, yScale, plotArea, spec, theme, layout);

  // 5. Points
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    const encoding = resolveSeriesEncoding(spec, data.series[si].name);

    for (let ci = 0; ci < data.categories.length; ci++) {
      const value = series.values[ci] ?? 0;
      const category = data.categories[ci] ?? "";
      const sel = { seriesName: series.name, selection: data.selection };
      const color = resolvePointColor(encoding, spec.palette, seriesPaletteIndex(data, si), series.color, value, category, sel);
      const resolvedSize = resolvePointSize(encoding, value, category, sel) ?? pointSize;
      const pointOpacity = resolvePointOpacity(encoding, value, category, sel);

      // Per-point override through the ONE shared resolver: it translates the
      // painter (si,ci) into authoring space itself and matches the datum's
      // identity key before its index.
      const style = resolveDatumStyle(spec, data, si, ci, {
        fill: color,
        opacity: pointOpacity,
        markerStyle: pointShape,
        markerSize: resolvedSize,
      });

      const x = xAxis.xOf(ci);
      const y = yScale.scale(value);
      paintDatumMarker(ctx, x, y, {
        shape: style.markerStyle ?? pointShape,
        size: style.markerSize ?? resolvedSize,
        fill: style.markerFill ?? style.fill,
        borderColor: style.markerBorderColor ?? style.borderColor,
        borderWidth: style.markerBorderWidth ?? style.borderWidth,
        opacity: style.opacity,
      });
    }
  }

  ctx.restore();

  // 6. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 7. Legend
  if (spec.legend.visible && data.series.length > 0) {
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
function drawScatterAxes(
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

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xAxis = resolveScatterXAxis(data, spec, plotArea);

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    for (let ci = 0; ci < data.categories.length; ci++) {
      const value = series.values[ci] ?? 0;
      markers.push({
        seriesIndex: si,
        categoryIndex: ci,
        cx: xAxis.xOf(ci),
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
