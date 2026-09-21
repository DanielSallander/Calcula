//! FILENAME: app/extensions/Charts/rendering/histogramChartPainter.ts
// PURPOSE: Pure Canvas 2D histogram chart drawing.
// CONTEXT: Auto-bins numeric data from the first series into equal-width bins
//          and draws frequency bars. Categories are ignored; values are binned.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, HistogramMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { resolveDatumStyle } from "../lib/dataPointOverrides";
import { applyFillStyle } from "./gradientFill";
import { strokeDatumBorderRect } from "./barChartPainter";
import { createLinearScale, createBandScale, createScaleFromSpec } from "./scales";
import {
  computeCartesianLayout,
  drawChartBackground,
  drawPlotBackground,
  drawHorizontalGridLines,
  drawTitle,
  drawLegend,
  drawRoundedRect,
  recordChartElementRect,
  formatTickValue,
} from "./chartPainterUtils";

// ============================================================================
// Binning
// ============================================================================

export interface HistogramBin {
  label: string;
  count: number;
  low: number;
  high: number;
}

export function computeBins(values: number[], binCount: number): HistogramBin[] {
  if (values.length === 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const binWidth = range / binCount;

  const bins: HistogramBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const low = min + i * binWidth;
    const high = min + (i + 1) * binWidth;
    bins.push({
      label: `${formatTickValue(low)}-${formatTickValue(high)}`,
      count: 0,
      low,
      high,
    });
  }

  // Assign values to bins
  for (const v of values) {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= binCount) idx = binCount - 1; // Include max in last bin
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }

  return bins;
}

// ============================================================================
// Layout
// ============================================================================

export function computeHistogramLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  // Build synthetic data for layout computation
  const syntheticData = histogramResolveView(data, spec);
  return computeCartesianLayout(width, height, spec, syntheticData, theme);
}

/**
 * The data a histogram RESOLVES PER-POINT OVERRIDES AGAINST (and lays out
 * against): one "Frequency" series over the BIN labels. The raw rows are not
 * datums here, so both the painter and the write path have to speak bins —
 * exported so the identity key stamped on an override names a bin rather than
 * a source row that no bar stands for.
 */
export function histogramResolveView(data: ParsedChartData, spec: ChartSpec): ParsedChartData {
  const opts = (spec.markOptions ?? {}) as HistogramMarkOptions;
  const binCount = opts.binCount ?? 10;

  // Collect all values from all series
  const allValues = data.series.flatMap((s) => s.values);
  const bins = computeBins(allValues, binCount);

  return {
    categories: bins.map((b) => b.label),
    series: [{ name: "Frequency", values: bins.map((b) => b.count), color: null }],
  };
}

// ============================================================================
// Main Paint Function
// ============================================================================

export function paintHistogramChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as HistogramMarkOptions;
  const binCount = opts.binCount ?? 10;
  const borderRadius = opts.borderRadius ?? 1;

  // Collect all values from all series and bin them
  const allValues = data.series.flatMap((s) => s.values);
  const bins = computeBins(allValues, binCount);

  if (bins.length === 0) {
    drawChartBackground(ctx, layout, theme);
    return;
  }

  const categories = bins.map((b) => b.label);
  const counts = bins.map((b) => b.count);
  const maxCount = Math.max(...counts, 1);

  // Compute scales
  const xScale = createBandScale(
    categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.05, // minimal padding for histogram (bars should be adjacent)
  );

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [0, maxCount],
    [plotArea.y + plotArea.height, plotArea.y],
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
  drawHistogramAxes(ctx, xScale, yScale, plotArea, spec, theme, layout);

  // 5. Bars
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  const color = getSeriesColor(spec.palette, 0, null);
  const baseY = plotArea.y + plotArea.height;

  // A histogram's datums are BINS, not the source rows: `data` here is the raw
  // input and its categories mean nothing to a bar. Resolve overrides against
  // the binned view instead — series 0, category = bin index, series name
  // "Frequency" — which is exactly the identity computeHistogramBarRects
  // reports, so an override written from a hit on a bar resolves back to it.
  // SHARED with the write path (`datumAddress`) so the identity key is stamped
  // from the bins too, not from the raw rows.
  const binData = histogramResolveView(data, spec);

  for (let i = 0; i < bins.length; i++) {
    const x = xScale.scaleIndex(i);
    const barW = xScale.bandwidth;
    const barH = baseY - yScale.scale(counts[i]);
    const barY = baseY - barH;

    if (barH > 0) {
      const style = resolveDatumStyle(spec, binData, 0, i, { fill: color });
      if (style.opacity != null) ctx.globalAlpha = style.opacity;
      applyFillStyle(ctx, style.fill, style.gradientFill ?? undefined, x, barY, barW, barH);
      if (borderRadius > 0 && barH > borderRadius * 2) {
        drawRoundedRect(ctx, x, barY, barW, barH, borderRadius);
        ctx.fill();
      } else {
        ctx.fillRect(x, barY, barW, barH);
      }
      strokeDatumBorderRect(ctx, style, x, barY, barW, barH, borderRadius);
      if (style.opacity != null) ctx.globalAlpha = 1;
    }
  }

  ctx.restore();

  // 6. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 7. Legend (show series names if multiple input series)
  if (spec.legend.visible && data.series.length > 0) {
    drawLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Axes
// ============================================================================

/**
 * `layout` is OPTIONAL and exists only for the element-rect write-back (the same
 * contract as `drawCartesianAxes`): when passed, the measured y tick-label band
 * replaces the layout's ~7px-per-character estimate. Omitting it paints
 * identically.
 */
function drawHistogramAxes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  xScale: ReturnType<typeof createBandScale>,
  yScale: ReturnType<typeof createLinearScale>,
  plotArea: { x: number; y: number; width: number; height: number },
  spec: ChartSpec,
  theme: ChartRenderTheme,
  layout?: ChartLayout,
): void {
  ctx.strokeStyle = theme.axisColor;
  ctx.lineWidth = 1;

  const xAxisY = plotArea.y + plotArea.height;

  // Axis lines
  ctx.beginPath();
  ctx.moveTo(plotArea.x, xAxisY + 0.5);
  ctx.lineTo(plotArea.x + plotArea.width, xAxisY + 0.5);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(plotArea.x - 0.5, plotArea.y);
  ctx.lineTo(plotArea.x - 0.5, xAxisY);
  ctx.stroke();

  // X axis labels (show every other for readability if many bins)
  if (spec.xAxis.showLabels) {
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const skip = xScale.domain.length > 15 ? Math.ceil(xScale.domain.length / 10) : 1;
    for (let ci = 0; ci < xScale.domain.length; ci++) {
      if (ci % skip !== 0 && ci !== xScale.domain.length - 1) continue;
      const x = xScale.scaleIndex(ci) + xScale.bandwidth / 2;

      ctx.save();
      ctx.translate(x, xAxisY + 4);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(xScale.domain[ci], 0, 0);
      ctx.restore();
    }
  }

  // Y axis labels
  if (spec.yAxis.showLabels) {
    const ticks = yScale.ticks(5);
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    let widestLabel = 0;
    for (const tick of ticks) {
      const y = yScale.scale(tick);
      if (y < plotArea.y || y > plotArea.y + plotArea.height) continue;
      const label = formatTickValue(tick);
      if (layout) {
        const w = ctx.measureText(label).width;
        if (w > widestLabel) widestLabel = w;
      }
      ctx.fillText(label, plotArea.x - 6, y);
    }
    if (layout) {
      // Labels are right-aligned at plotArea.x - 6, so the band runs from the
      // widest label's left edge to the axis line.
      const bandWidth = widestLabel + 6;
      recordChartElementRect(layout, "yAxisBand", {
        x: plotArea.x - bandWidth,
        y: plotArea.y,
        width: bandWidth,
        height: plotArea.height,
      });
    }
  }
}

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeHistogramBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): BarRect[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as HistogramMarkOptions;
  const binCount = opts.binCount ?? 10;
  const rects: BarRect[] = [];

  const allValues = data.series.flatMap((s) => s.values);
  const bins = computeBins(allValues, binCount);
  if (bins.length === 0) return rects;

  const categories = bins.map((b) => b.label);
  const counts = bins.map((b) => b.count);
  const maxCount = Math.max(...counts, 1);

  const xScale = createBandScale(
    categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.05,
  );

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [0, maxCount],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const baseY = plotArea.y + plotArea.height;

  for (let i = 0; i < bins.length; i++) {
    const x = xScale.scaleIndex(i);
    const barW = xScale.bandwidth;
    const barH = baseY - yScale.scale(counts[i]);
    const barY = baseY - barH;

    rects.push({
      seriesIndex: 0,
      categoryIndex: i,
      x,
      y: barY,
      width: barW,
      height: barH,
      value: counts[i],
      seriesName: "Frequency",
      categoryName: categories[i],
    });
  }

  return rects;
}
