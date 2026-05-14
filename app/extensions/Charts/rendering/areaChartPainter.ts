//! FILENAME: app/extensions/Charts/rendering/areaChartPainter.ts
// PURPOSE: Pure Canvas 2D area chart drawing.
// CONTEXT: Like line chart but fills area below each line. Supports stacked areas.

import type { ChartSpec, ParsedChartData, ChartLayout, PointMarker, AreaMarkOptions, StackMode } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { applyFillStyle } from "./gradientFill";
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

export function computeAreaLayout(
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

export function paintAreaChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as AreaMarkOptions;
  const interpolation = opts.interpolation ?? "linear";
  const lineWidth = opts.lineWidth ?? 2;
  const fillOpacity = opts.fillOpacity ?? 0.3;
  const showMarkers = opts.showMarkers ?? false;
  const markerRadius = opts.markerRadius ?? 4;
  // Support both old boolean `stacked` and new `stackMode`
  const stackMode: StackMode = opts.stackMode ?? (opts.stacked ? "stacked" : "none");
  const stacked = stackMode !== "none";
  const isPercent = stackMode === "percentStacked";

  // Compute scales
  let allValues: number[];
  if (isPercent) {
    allValues = [0, 100];
  } else if (stacked) {
    // For stacked areas, the Y domain must cover stacked totals
    const stackedTotals: number[] = [];
    for (let ci = 0; ci < data.categories.length; ci++) {
      let sum = 0;
      for (let si = 0; si < data.series.length; si++) {
        sum += data.series[si].values[ci] ?? 0;
      }
      stackedTotals.push(sum);
    }
    allValues = stackedTotals;
    // Include 0 as minimum baseline for stacked charts
    allValues.push(0);
  } else {
    allValues = data.series.flatMap((s) => s.values);
  }

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

  // Compute the baseline Y pixel position (y=0, clamped to plot area)
  const baselineY = Math.min(
    Math.max(yScale.scale(0), plotArea.y),
    plotArea.y + plotArea.height,
  );

  // Pre-compute all series points (and stacked baselines)
  const seriesPoints: Array<Array<{ x: number; y: number }>> = [];
  // For stacked mode, track cumulative values per category
  const cumulativeValues: number[] = new Array(data.categories.length).fill(0);

  // Pre-compute category totals for percent stacking
  const categoryTotals: number[] = [];
  if (isPercent) {
    for (let ci = 0; ci < data.categories.length; ci++) {
      let total = 0;
      for (let si = 0; si < data.series.length; si++) {
        total += Math.abs(data.series[si].values[ci] ?? 0);
      }
      categoryTotals.push(total);
    }
  }

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    const points: Array<{ x: number; y: number }> = [];

    for (let ci = 0; ci < data.categories.length; ci++) {
      let rawValue = series.values[ci] ?? 0;
      const x = xScale.scaleIndex(ci);

      if (isPercent && categoryTotals[ci] > 0) {
        rawValue = (rawValue / categoryTotals[ci]) * 100;
      }

      if (stacked) {
        cumulativeValues[ci] += rawValue;
        const y = yScale.scale(cumulativeValues[ci]);
        points.push({ x, y });
      } else {
        const y = yScale.scale(rawValue);
        points.push({ x, y });
      }
    }

    seriesPoints.push(points);
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
  drawAreaAxes(ctx, xScale, yScale, plotArea, spec, theme);

  // 5. Areas and lines (clip to plot area)
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  // 5a. Draw filled areas FIRST (back to front = last series first for non-stacked,
  //     first series first for stacked so later series stack on top)
  if (stacked) {
    // Stacked: draw from last series to first (topmost area first, so it gets
    // painted behind the lower ones)
    for (let si = data.series.length - 1; si >= 0; si--) {
      const points = seriesPoints[si];
      if (points.length === 0) continue;

      const color = getSeriesColor(spec.palette, si, data.series[si].color);

      // Compute the bottom edge of this area (previous series top, or baseline)
      const bottomPoints: Array<{ x: number; y: number }> = [];
      if (si > 0) {
        // Bottom is the top of the previous stacked series
        const prevPoints = seriesPoints[si - 1];
        for (let ci = 0; ci < data.categories.length; ci++) {
          bottomPoints.push({ x: prevPoints[ci].x, y: prevPoints[ci].y });
        }
      } else {
        // Bottom is the baseline
        for (let ci = 0; ci < data.categories.length; ci++) {
          bottomPoints.push({ x: points[ci].x, y: baselineY });
        }
      }

      ctx.globalAlpha = fillOpacity;
      const areaGradient = (spec.markOptions as AreaMarkOptions | undefined)?.fill;
      applyFillStyle(ctx, color, areaGradient, plotArea.x, plotArea.y, plotArea.width, plotArea.height);
      ctx.beginPath();

      // Trace top edge (left to right)
      if (interpolation === "smooth" && points.length > 2) {
        traceSmoothPath(ctx, points);
      } else if (interpolation === "step") {
        traceStepPath(ctx, points);
      } else {
        traceLinearPath(ctx, points);
      }

      // Trace bottom edge (right to left)
      const reversedBottom = [...bottomPoints].reverse();
      if (si > 0 && interpolation === "smooth" && reversedBottom.length > 2) {
        // Continue path by tracing the previous series line in reverse
        lineSmoothPath(ctx, reversedBottom);
      } else if (si > 0 && interpolation === "step") {
        lineStepPath(ctx, reversedBottom);
      } else {
        lineLinearPath(ctx, reversedBottom);
      }

      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }
  } else {
    // Non-stacked: draw from last series to first (back to front)
    for (let si = data.series.length - 1; si >= 0; si--) {
      const points = seriesPoints[si];
      if (points.length === 0) continue;

      const color = getSeriesColor(spec.palette, si, data.series[si].color);

      ctx.globalAlpha = fillOpacity;
      ctx.fillStyle = color;
      ctx.beginPath();

      // Trace top edge (left to right)
      if (interpolation === "smooth" && points.length > 2) {
        traceSmoothPath(ctx, points);
      } else if (interpolation === "step") {
        traceStepPath(ctx, points);
      } else {
        traceLinearPath(ctx, points);
      }

      // Close down to baseline and back
      ctx.lineTo(points[points.length - 1].x, baselineY);
      ctx.lineTo(points[0].x, baselineY);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }
  }

  // 5b. Draw lines on top (front to back order = series 0 first)
  for (let si = 0; si < data.series.length; si++) {
    const points = seriesPoints[si];
    if (points.length === 0) continue;

    const color = getSeriesColor(spec.palette, si, data.series[si].color);

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash([]);

    ctx.beginPath();
    if (interpolation === "smooth" && points.length > 2) {
      traceSmoothPath(ctx, points);
    } else if (interpolation === "step") {
      traceStepPath(ctx, points);
    } else {
      traceLinearPath(ctx, points);
    }
    ctx.stroke();

    // Draw markers
    if (showMarkers) {
      ctx.fillStyle = color;
      for (const pt of points) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, markerRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      // White inner circle for hollow marker look
      ctx.fillStyle = "#ffffff";
      for (const pt of points) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, markerRadius * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 5d. Drop lines (vertical lines from data points to X axis)
  const areaOpts = (spec.markOptions ?? {}) as import("../types").AreaMarkOptions;
  if (areaOpts.showDropLines) {
    const dropColor = areaOpts.dropLineColor ?? null;
    const axisY = plotArea.y + plotArea.height;

    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;

    for (let si = 0; si < data.series.length; si++) {
      const color = dropColor ?? getSeriesColor(spec.palette, si, data.series[si].color);
      ctx.strokeStyle = color;
      ctx.globalAlpha = dropColor ? 1 : 0.4;
      ctx.beginPath();
      for (const pt of seriesPoints[si]) {
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x, axisY);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
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
// Path Tracing Helpers
// ============================================================================

/** Trace a linear path starting with moveTo. */
function traceLinearPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
}

/** Continue a linear path with lineTo (no moveTo). */
function lineLinearPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  for (let i = 0; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
}

/** Trace a smooth (cardinal spline) path starting with moveTo. */
function traceSmoothPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  const tension = 0.5;
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6 * tension;
    const cp1y = p1.y + (p2.y - p0.y) / 6 * tension;
    const cp2x = p2.x - (p3.x - p1.x) / 6 * tension;
    const cp2y = p2.y - (p3.y - p1.y) / 6 * tension;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

/** Continue a smooth (cardinal spline) path with lineTo/bezierCurveTo (no moveTo). */
function lineSmoothPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  const tension = 0.5;
  ctx.lineTo(points[0].x, points[0].y);

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6 * tension;
    const cp1y = p1.y + (p2.y - p0.y) / 6 * tension;
    const cp2x = p2.x - (p3.x - p1.x) / 6 * tension;
    const cp2y = p2.y - (p3.y - p1.y) / 6 * tension;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

/** Trace a step path starting with moveTo. */
function traceStepPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const midX = (points[i - 1].x + points[i].x) / 2;
    ctx.lineTo(midX, points[i - 1].y);
    ctx.lineTo(midX, points[i].y);
    ctx.lineTo(points[i].x, points[i].y);
  }
}

/** Continue a step path with lineTo (no moveTo). */
function lineStepPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      ctx.lineTo(points[0].x, points[0].y);
      continue;
    }
    const midX = (points[i - 1].x + points[i].x) / 2;
    ctx.lineTo(midX, points[i - 1].y);
    ctx.lineTo(midX, points[i].y);
    ctx.lineTo(points[i].x, points[i].y);
  }
}

// ============================================================================
// Axes (adapted for PointScale)
// ============================================================================

function drawAreaAxes(
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

    for (let ci = 0; ci < xScale.domain.length; ci++) {
      const category = xScale.domain[ci];
      const x = xScale.scaleIndex(ci);
      const y = xAxisY + 4;

      ctx.save();
      if (spec.xAxis.labelAngle === 0) {
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(category, x, y);
      } else if (spec.xAxis.labelAngle === 45) {
        ctx.translate(x, y);
        ctx.rotate(-Math.PI / 4);
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText(category, 0, 0);
      } else {
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

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeAreaPointMarkers(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): PointMarker[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as AreaMarkOptions;
  const markerRadius = opts.markerRadius ?? 4;
  const stackMode: StackMode = opts.stackMode ?? (opts.stacked ? "stacked" : "none");
  const stacked = stackMode !== "none";
  const isPercent = stackMode === "percentStacked";
  const markers: PointMarker[] = [];

  // Compute Y scale
  let allValues: number[];
  if (isPercent) {
    allValues = [0, 100];
  } else if (stacked) {
    const stackedTotals: number[] = [];
    for (let ci = 0; ci < data.categories.length; ci++) {
      let sum = 0;
      for (let si = 0; si < data.series.length; si++) {
        sum += data.series[si].values[ci] ?? 0;
      }
      stackedTotals.push(sum);
    }
    allValues = stackedTotals;
    allValues.push(0);
  } else {
    allValues = data.series.flatMap((s) => s.values);
  }

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

  // Pre-compute category totals for percent stacking
  const categoryTotals: number[] = [];
  if (isPercent) {
    for (let ci = 0; ci < data.categories.length; ci++) {
      let total = 0;
      for (let si = 0; si < data.series.length; si++) {
        total += Math.abs(data.series[si].values[ci] ?? 0);
      }
      categoryTotals.push(total);
    }
  }

  // Track cumulative values for stacked mode
  const cumulativeValues: number[] = new Array(data.categories.length).fill(0);

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    for (let ci = 0; ci < data.categories.length; ci++) {
      let rawValue = series.values[ci] ?? 0;
      const originalValue = rawValue;

      if (isPercent && categoryTotals[ci] > 0) {
        rawValue = (rawValue / categoryTotals[ci]) * 100;
      }

      let displayValue: number;
      if (stacked) {
        cumulativeValues[ci] += rawValue;
        displayValue = cumulativeValues[ci];
      } else {
        displayValue = rawValue;
      }

      markers.push({
        seriesIndex: si,
        categoryIndex: ci,
        cx: xScale.scaleIndex(ci),
        cy: yScale.scale(displayValue),
        radius: markerRadius,
        value: originalValue,
        seriesName: series.name,
        categoryName: data.categories[ci],
      });
    }
  }

  return markers;
}
