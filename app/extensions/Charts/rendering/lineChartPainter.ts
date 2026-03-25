//! FILENAME: app/extensions/Charts/rendering/lineChartPainter.ts
// PURPOSE: Pure Canvas 2D line chart drawing.
// CONTEXT: Draws lines connecting data points with optional markers.
//          Supports linear, smooth (cardinal spline), and step interpolation.

import type { ChartSpec, ParsedChartData, ChartLayout, PointMarker, LineMarkOptions, StackMode } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { createLinearScale, createPointScale, createScaleFromSpec } from "./scales";
import {
  computeCartesianLayout,
  drawChartBackground,
  drawPlotBackground,
  drawHorizontalGridLines,
  drawCartesianAxes,
  drawTitle,
  drawLegend,
  formatTickValue,
} from "./chartPainterUtils";

// ============================================================================
// Layout
// ============================================================================

export function computeLineLayout(
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

export function paintLineChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as LineMarkOptions;
  const interpolation = opts.interpolation ?? "linear";
  const lineWidth = opts.lineWidth ?? 2;
  const showMarkers = opts.showMarkers ?? true;
  const markerRadius = opts.markerRadius ?? 4;
  const stackMode: StackMode = opts.stackMode ?? "none";
  const isStacked = stackMode !== "none";
  const isPercent = stackMode === "percentStacked";

  // Compute scales
  const { yMin, yMax } = computeLineYDomain(data, spec, stackMode);

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
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

  // 4. Axes (reuse cartesian axes with a band scale wrapper)
  drawLineAxes(ctx, xScale, yScale, plotArea, spec, theme);

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

  // Pre-compute all series points (with stacking)
  const cumulativeValues: number[] = new Array(data.categories.length).fill(0);
  const allSeriesPoints: Array<Array<{ x: number; y: number }>> = [];

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    const points: Array<{ x: number; y: number }> = [];

    for (let ci = 0; ci < data.categories.length; ci++) {
      let value = series.values[ci] ?? 0;
      const x = xScale.scaleIndex(ci);

      if (isPercent && categoryTotals[ci] > 0) {
        value = (value / categoryTotals[ci]) * 100;
      }

      if (isStacked) {
        cumulativeValues[ci] += value;
        points.push({ x, y: yScale.scale(cumulativeValues[ci]) });
      } else {
        points.push({ x, y: yScale.scale(value) });
      }
    }

    allSeriesPoints.push(points);
  }

  // 5. Lines
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    const color = getSeriesColor(spec.palette, si, series.color);
    const points = allSeriesPoints[si];

    if (points.length === 0) continue;

    // Draw line
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash([]);

    ctx.beginPath();
    if (interpolation === "smooth" && points.length > 2) {
      drawSmoothLine(ctx, points);
    } else if (interpolation === "step") {
      drawStepLine(ctx, points);
    } else {
      drawLinearLine(ctx, points);
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
// Y Domain Computation (for stacking support)
// ============================================================================

function computeLineYDomain(
  data: ParsedChartData,
  spec: ChartSpec,
  stackMode: StackMode,
): { yMin: number; yMax: number } {
  if (stackMode === "percentStacked") {
    return { yMin: spec.yAxis.min ?? 0, yMax: spec.yAxis.max ?? 100 };
  }
  if (stackMode === "stacked") {
    let maxPos = 0;
    let minNeg = 0;
    for (let ci = 0; ci < data.categories.length; ci++) {
      let posSum = 0;
      let negSum = 0;
      for (let si = 0; si < data.series.length; si++) {
        const v = data.series[si].values[ci] ?? 0;
        if (v >= 0) posSum += v;
        else negSum += v;
      }
      maxPos = Math.max(maxPos, posSum);
      minNeg = Math.min(minNeg, negSum);
    }
    return { yMin: spec.yAxis.min ?? minNeg, yMax: spec.yAxis.max ?? maxPos };
  }
  const allValues = data.series.flatMap((s) => s.values);
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;
  return { yMin: spec.yAxis.min ?? dataMin, yMax: spec.yAxis.max ?? dataMax };
}

// ============================================================================
// Line Drawing Helpers
// ============================================================================

function drawLinearLine(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
}

function drawSmoothLine(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  // Cardinal spline through all points (tension = 0.5)
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

function drawStepLine(
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

// ============================================================================
// Axes (adapted for PointScale)
// ============================================================================

function drawLineAxes(
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

export function computeLinePointMarkers(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): PointMarker[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as LineMarkOptions;
  const markerRadius = opts.markerRadius ?? 4;
  const stackMode: StackMode = opts.stackMode ?? "none";
  const isStacked = stackMode !== "none";
  const isPercent = stackMode === "percentStacked";
  const markers: PointMarker[] = [];

  const { yMin, yMax } = computeLineYDomain(data, spec, stackMode);

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

  const cumulativeValues: number[] = new Array(data.categories.length).fill(0);

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    for (let ci = 0; ci < data.categories.length; ci++) {
      let value = series.values[ci] ?? 0;
      const originalValue = value;

      if (isPercent && categoryTotals[ci] > 0) {
        value = (value / categoryTotals[ci]) * 100;
      }

      let displayValue: number;
      if (isStacked) {
        cumulativeValues[ci] += value;
        displayValue = cumulativeValues[ci];
      } else {
        displayValue = value;
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
