//! FILENAME: app/extensions/Charts/rendering/errorBarPainter.ts
// PURPOSE: Renders error bars on bar, line, and scatter charts.
// CONTEXT: Called after the main series is painted. Draws vertical (or horizontal
//          for horizontal bar charts) error bar lines with T-shaped caps.

import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  HitGeometry,
  ErrorBarOptions,
  BarMarkOptions,
  LineMarkOptions,
  ScatterMarkOptions,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";

// ============================================================================
// Public API
// ============================================================================

/**
 * Paint error bars for the given chart.
 * Requires pre-computed hit geometry to locate data point positions.
 */
export function paintErrorBars(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
  geometry: HitGeometry,
): void {
  const errorBarOpts = getErrorBarOptions(spec);
  if (!errorBarOpts || !errorBarOpts.enabled) return;

  const color = errorBarOpts.color ?? "#333333";
  const lineWidth = errorBarOpts.lineWidth ?? 1.5;
  const capWidth = 6; // half-width of T-cap in pixels

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.setLineDash([]);

  // Clip to plot area
  const { plotArea } = layout;
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  if (geometry.type === "bars") {
    const isHorizontal = spec.mark === "horizontalBar";
    for (const rect of geometry.rects) {
      const seriesValues = data.series[rect.seriesIndex]?.values;
      if (!seriesValues) continue;

      const { plus, minus } = computeErrorExtent(
        rect.value,
        seriesValues,
        errorBarOpts,
      );

      if (isHorizontal) {
        // Horizontal bar: error bars extend left/right
        const cy = rect.y + rect.height / 2;
        // For horizontal bars, the bar extends from an origin to rect.x + rect.width
        // The data point is at the end of the bar
        const dataX = rect.value >= 0
          ? rect.x + rect.width
          : rect.x;

        // We need pixel-per-unit. Approximate from bar geometry.
        const pxPerUnit = rect.width / Math.abs(rect.value || 1);

        const plusPx = plus * pxPerUnit;
        const minusPx = minus * pxPerUnit;

        const xPlus = dataX + (rect.value >= 0 ? plusPx : -plusPx);
        const xMinus = dataX - (rect.value >= 0 ? minusPx : -minusPx);

        drawHorizontalErrorBar(ctx, cy, xMinus, xPlus, capWidth, errorBarOpts.direction);
      } else {
        // Vertical bar: error bars extend up/down from the top of the bar
        const cx = rect.x + rect.width / 2;
        // For positive values, top of bar is rect.y; for negative, bottom is rect.y + rect.height
        const dataY = rect.value >= 0 ? rect.y : rect.y + rect.height;

        // Approximate pixel-per-unit from bar height
        const pxPerUnit = rect.height / Math.abs(rect.value || 1);

        const plusPx = plus * pxPerUnit;
        const minusPx = minus * pxPerUnit;

        // Y axis is inverted: up = smaller Y
        const yPlus = dataY - plusPx;
        const yMinus = dataY + minusPx;

        drawVerticalErrorBar(ctx, cx, yMinus, yPlus, capWidth, errorBarOpts.direction);
      }
    }
  } else if (geometry.type === "points") {
    for (const marker of geometry.markers) {
      const seriesValues = data.series[marker.seriesIndex]?.values;
      if (!seriesValues) continue;

      const { plus, minus } = computeErrorExtent(
        marker.value,
        seriesValues,
        errorBarOpts,
      );

      // For point-based charts, we need to compute pixel extent.
      // Estimate from plot area height and data range.
      const allValues = data.series.flatMap((s) => s.values);
      const dataMin = Math.min(...allValues, 0);
      const dataMax = Math.max(...allValues, 0);
      const dataRange = dataMax - dataMin || 1;
      const pxPerUnit = plotArea.height / dataRange;

      const yPlus = marker.cy - plus * pxPerUnit;
      const yMinus = marker.cy + minus * pxPerUnit;

      drawVerticalErrorBar(ctx, marker.cx, yMinus, yPlus, capWidth, errorBarOpts.direction);
    }
  }

  ctx.restore();
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Extract ErrorBarOptions from the spec's markOptions. */
function getErrorBarOptions(spec: ChartSpec): ErrorBarOptions | undefined {
  const opts = spec.markOptions;
  if (!opts) return undefined;

  switch (spec.mark) {
    case "bar":
    case "horizontalBar":
      return (opts as BarMarkOptions).errorBars;
    case "line":
      return (opts as LineMarkOptions).errorBars;
    case "scatter":
      return (opts as ScatterMarkOptions).errorBars;
    default:
      return undefined;
  }
}

/** Compute the error extent (plus and minus) for a data point. */
function computeErrorExtent(
  value: number,
  seriesValues: number[],
  opts: ErrorBarOptions,
): { plus: number; minus: number } {
  let extent = 0;

  switch (opts.type) {
    case "percentage": {
      const pct = (opts.value ?? 10) / 100;
      extent = Math.abs(value) * pct;
      break;
    }
    case "standardError": {
      const n = seriesValues.length;
      if (n < 2) {
        extent = 0;
        break;
      }
      const mean = seriesValues.reduce((a, b) => a + b, 0) / n;
      const variance = seriesValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
      const stddev = Math.sqrt(variance);
      extent = stddev / Math.sqrt(n);
      break;
    }
    case "standardDeviation": {
      const n = seriesValues.length;
      if (n < 2) {
        extent = 0;
        break;
      }
      const mean = seriesValues.reduce((a, b) => a + b, 0) / n;
      const variance = seriesValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
      const stddev = Math.sqrt(variance);
      const multiplier = opts.value ?? 1;
      extent = stddev * multiplier;
      break;
    }
    case "custom": {
      extent = opts.value ?? 0;
      break;
    }
  }

  const plus = opts.direction === "minus" ? 0 : extent;
  const minus = opts.direction === "plus" ? 0 : extent;

  return { plus, minus };
}

/** Draw a vertical error bar line with T-caps. */
function drawVerticalErrorBar(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cx: number,
  yBottom: number,
  yTop: number,
  capHalf: number,
  direction: "both" | "plus" | "minus",
): void {
  // Vertical stem
  ctx.beginPath();
  ctx.moveTo(cx, yBottom);
  ctx.lineTo(cx, yTop);
  ctx.stroke();

  // Top cap (plus direction)
  if (direction !== "minus") {
    ctx.beginPath();
    ctx.moveTo(cx - capHalf, yTop);
    ctx.lineTo(cx + capHalf, yTop);
    ctx.stroke();
  }

  // Bottom cap (minus direction)
  if (direction !== "plus") {
    ctx.beginPath();
    ctx.moveTo(cx - capHalf, yBottom);
    ctx.lineTo(cx + capHalf, yBottom);
    ctx.stroke();
  }
}

/** Draw a horizontal error bar line with T-caps. */
function drawHorizontalErrorBar(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cy: number,
  xLeft: number,
  xRight: number,
  capHalf: number,
  direction: "both" | "plus" | "minus",
): void {
  // Horizontal stem
  ctx.beginPath();
  ctx.moveTo(xLeft, cy);
  ctx.lineTo(xRight, cy);
  ctx.stroke();

  // Right cap (plus direction)
  if (direction !== "minus") {
    ctx.beginPath();
    ctx.moveTo(xRight, cy - capHalf);
    ctx.lineTo(xRight, cy + capHalf);
    ctx.stroke();
  }

  // Left cap (minus direction)
  if (direction !== "plus") {
    ctx.beginPath();
    ctx.moveTo(xLeft, cy - capHalf);
    ctx.lineTo(xLeft, cy + capHalf);
    ctx.stroke();
  }
}
