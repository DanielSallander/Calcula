//! FILENAME: app/extensions/Charts/rendering/boxPlotChartPainter.ts
// PURPOSE: Pure Canvas 2D box & whisker (box plot) chart drawing.
// CONTEXT: Shows distribution statistics: min, Q1, median, Q3, max for each category.
//          Each series provides a set of values per category; stats are computed from
//          the raw values. If only one series exists, each category is a single box.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, BoxPlotMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
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
// Statistics Helpers
// ============================================================================

interface BoxStats {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  outliers: number[];
}

/** Compute quartile statistics from a sorted array of numbers. */
function computeBoxStats(values: number[]): BoxStats {
  const sorted = [...values].filter((v) => !isNaN(v)).sort((a, b) => a - b);
  const n = sorted.length;

  if (n === 0) {
    return { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, outliers: [] };
  }
  if (n === 1) {
    const v = sorted[0];
    return { min: v, q1: v, median: v, q3: v, max: v, mean: v, outliers: [] };
  }

  const median = quantile(sorted, 0.5);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;

  // Whiskers extend to the most extreme data points within the fences
  let whiskerMin = q1;
  let whiskerMax = q3;
  const outliers: number[] = [];

  for (const v of sorted) {
    if (v < lowerFence || v > upperFence) {
      outliers.push(v);
    } else {
      if (v < whiskerMin) whiskerMin = v;
      if (v > whiskerMax) whiskerMax = v;
    }
  }

  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;

  return { min: whiskerMin, q1, median, q3, max: whiskerMax, mean, outliers };
}

/** Linear interpolation quantile. */
function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// ============================================================================
// Layout
// ============================================================================

export function computeBoxPlotLayout(
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

export function paintBoxPlotChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as BoxPlotMarkOptions;
  const boxWidthRatio = opts.boxWidth ?? 0.5;
  const showOutliers = opts.showOutliers ?? true;
  const outlierRadius = opts.outlierRadius ?? 3;
  const medianColor = opts.medianColor ?? null;
  const medianLineWidth = opts.medianLineWidth ?? 2;
  const whiskerLineWidth = opts.whiskerLineWidth ?? 1;
  const showMean = opts.showMean ?? false;

  if (data.series.length === 0 || data.categories.length === 0) {
    drawChartBackground(ctx, layout, theme);
    return;
  }

  // For box plot, each category gets one box per series.
  // The values for the box are gathered from the series' values at that category index.
  // However, with typical spreadsheet data, each series has one value per category.
  // A more useful interpretation: if there's one series, each category's "distribution"
  // is just that single value (degenerate). If there are multiple series, we treat each
  // category's box as computed from all series values at that index.
  // This matches Excel's behavior: multiple series = multiple data points per category.

  const statsPerCategory: BoxStats[] = [];
  for (let ci = 0; ci < data.categories.length; ci++) {
    const values: number[] = [];
    for (let si = 0; si < data.series.length; si++) {
      const v = data.series[si].values[ci];
      if (v != null && !isNaN(v)) values.push(v);
    }
    statsPerCategory.push(computeBoxStats(values));
  }

  // Compute Y domain from all stats
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of statsPerCategory) {
    const allVals = [s.min, s.max, ...s.outliers];
    for (const v of allVals) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (!isFinite(yMin)) yMin = 0;
  if (!isFinite(yMax)) yMax = 1;

  yMin = spec.yAxis.min ?? yMin;
  yMax = spec.yAxis.max ?? yMax;

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

  // 5. Draw boxes
  for (let ci = 0; ci < data.categories.length; ci++) {
    const stats = statsPerCategory[ci];
    const bandX = xScale.scaleIndex(ci);
    const bandW = xScale.bandwidth;
    const boxW = bandW * boxWidthRatio;
    const boxX = bandX + (bandW - boxW) / 2;
    const centerX = bandX + bandW / 2;

    const color = getSeriesColor(spec.palette, ci, null);

    const yQ1 = yScale.scale(stats.q1);
    const yQ3 = yScale.scale(stats.q3);
    const yMedian = yScale.scale(stats.median);
    const yMin = yScale.scale(stats.min);
    const yMax = yScale.scale(stats.max);
    const yMean = yScale.scale(stats.mean);

    // Box (Q1 to Q3)
    const boxTop = Math.min(yQ1, yQ3);
    const boxHeight = Math.abs(yQ1 - yQ3);

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(boxX, boxTop, boxW, boxHeight);
    ctx.globalAlpha = 1;

    // Box border
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX, boxTop, boxW, boxHeight);

    // Median line
    ctx.beginPath();
    ctx.moveTo(boxX, yMedian);
    ctx.lineTo(boxX + boxW, yMedian);
    ctx.strokeStyle = medianColor ?? "#ffffff";
    ctx.lineWidth = medianLineWidth;
    ctx.stroke();

    // Upper whisker (Q3 to max)
    ctx.beginPath();
    ctx.moveTo(centerX, Math.min(yQ1, yQ3)); // top of box
    ctx.lineTo(centerX, yMax);
    ctx.strokeStyle = color;
    ctx.lineWidth = whiskerLineWidth;
    ctx.stroke();

    // Upper whisker cap
    const capW = boxW * 0.4;
    ctx.beginPath();
    ctx.moveTo(centerX - capW / 2, yMax);
    ctx.lineTo(centerX + capW / 2, yMax);
    ctx.stroke();

    // Lower whisker (Q1 to min)
    ctx.beginPath();
    ctx.moveTo(centerX, Math.max(yQ1, yQ3)); // bottom of box
    ctx.lineTo(centerX, yMin);
    ctx.stroke();

    // Lower whisker cap
    ctx.beginPath();
    ctx.moveTo(centerX - capW / 2, yMin);
    ctx.lineTo(centerX + capW / 2, yMin);
    ctx.stroke();

    // Mean marker (diamond)
    if (showMean) {
      const size = 4;
      ctx.beginPath();
      ctx.moveTo(centerX, yMean - size);
      ctx.lineTo(centerX + size, yMean);
      ctx.lineTo(centerX, yMean + size);
      ctx.lineTo(centerX - size, yMean);
      ctx.closePath();
      ctx.fillStyle = medianColor ?? "#333333";
      ctx.fill();
    }

    // Outliers
    if (showOutliers && stats.outliers.length > 0) {
      ctx.fillStyle = color;
      for (const ov of stats.outliers) {
        const oy = yScale.scale(ov);
        ctx.beginPath();
        ctx.arc(centerX, oy, outlierRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 6. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 7. Legend
  if (spec.legend.visible && data.categories.length > 1) {
    drawLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeBoxPlotBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): BarRect[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as BoxPlotMarkOptions;
  const boxWidthRatio = opts.boxWidth ?? 0.5;
  const rects: BarRect[] = [];

  if (data.series.length === 0 || data.categories.length === 0) return rects;

  const statsPerCategory: BoxStats[] = [];
  for (let ci = 0; ci < data.categories.length; ci++) {
    const values: number[] = [];
    for (let si = 0; si < data.series.length; si++) {
      const v = data.series[si].values[ci];
      if (v != null && !isNaN(v)) values.push(v);
    }
    statsPerCategory.push(computeBoxStats(values));
  }

  let yMinVal = Infinity;
  let yMaxVal = -Infinity;
  for (const s of statsPerCategory) {
    const allVals = [s.min, s.max, ...s.outliers];
    for (const v of allVals) {
      if (v < yMinVal) yMinVal = v;
      if (v > yMaxVal) yMaxVal = v;
    }
  }
  if (!isFinite(yMinVal)) yMinVal = 0;
  if (!isFinite(yMaxVal)) yMaxVal = 1;

  yMinVal = spec.yAxis.min ?? yMinVal;
  yMaxVal = spec.yAxis.max ?? yMaxVal;

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [yMinVal, yMaxVal],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createBandScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.3,
  );

  for (let ci = 0; ci < data.categories.length; ci++) {
    const stats = statsPerCategory[ci];
    const bandX = xScale.scaleIndex(ci);
    const bandW = xScale.bandwidth;
    const boxW = bandW * boxWidthRatio;
    const boxX = bandX + (bandW - boxW) / 2;

    const yQ1 = yScale.scale(stats.q1);
    const yQ3 = yScale.scale(stats.q3);
    const boxTop = Math.min(yQ1, yQ3);
    const boxHeight = Math.abs(yQ1 - yQ3);

    rects.push({
      seriesIndex: 0,
      categoryIndex: ci,
      x: boxX,
      y: boxTop,
      width: boxW,
      height: Math.max(boxHeight, 2),
      value: stats.median,
      seriesName: "Box Plot",
      categoryName: data.categories[ci] ?? `Category ${ci + 1}`,
    });
  }

  return rects;
}
