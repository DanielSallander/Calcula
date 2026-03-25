//! FILENAME: app/extensions/Charts/rendering/trendlinePainter.ts
// PURPOSE: Renders trendlines (regression curves, moving averages) on chart plots.
// CONTEXT: Called after the main chart paint pass but before layers.
//          Uses pre-computed trendline data from trendlineComputation.ts.

import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  TrendlineSpec,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { computeTrendline } from "../lib/trendlineComputation";
import { createPointScale, createScaleFromSpec } from "./scales";

// ============================================================================
// Public API
// ============================================================================

/**
 * Paint all trendlines for a chart.
 * Should be called after the main chart is painted but while still clipped to plotArea.
 */
export function paintTrendlines(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  if (!spec.trendlines || spec.trendlines.length === 0) return;

  const { plotArea } = layout;

  // Compute scales (same as line/bar chart)
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

  const xScale = createPointScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
  );

  // Clip to plot area
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  for (const trendline of spec.trendlines) {
    const result = computeTrendline(data, trendline);
    if (!result || result.points.length < 2) continue;

    // Determine color
    const seriesIndex = trendline.seriesIndex ?? 0;
    const seriesColor = getSeriesColor(spec.palette, seriesIndex, data.series[seriesIndex]?.color ?? null);
    const color = trendline.color ?? darkenColor(seriesColor, 0.3);

    const lineWidth = trendline.lineWidth ?? 2;
    const strokeDash = trendline.strokeDash ?? [6, 3];

    // Map points to pixel coordinates
    const pixelPoints = result.points.map((p) => ({
      x: xScale.scaleIndex(p.ci),
      y: yScale.scale(p.value),
    }));

    // Draw the trendline
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(strokeDash);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(pixelPoints[0].x, pixelPoints[0].y);
    for (let i = 1; i < pixelPoints.length; i++) {
      ctx.lineTo(pixelPoints[i].x, pixelPoints[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw equation / R-squared labels
    if (trendline.showEquation || trendline.showRSquared) {
      const labels: string[] = [];
      if (trendline.showEquation) labels.push(result.equation);
      if (trendline.showRSquared && isFinite(result.rSquared)) {
        labels.push(`R\u00B2 = ${result.rSquared.toFixed(4)}`);
      }

      // Position label near end of trendline
      const lastPt = pixelPoints[pixelPoints.length - 1];
      const labelX = lastPt.x;
      const labelY = lastPt.y - 8;

      ctx.font = `${theme.labelFontSize - 1}px ${theme.fontFamily}`;
      ctx.fillStyle = color;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";

      for (let i = 0; i < labels.length; i++) {
        ctx.fillText(labels[i], labelX, labelY - i * (theme.labelFontSize + 1));
      }
    }
  }

  ctx.restore();
}

// ============================================================================
// Helpers
// ============================================================================

/** Darken a hex color by a given amount (0-1). */
function darkenColor(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const dr = Math.round(r * (1 - amount));
  const dg = Math.round(g * (1 - amount));
  const db = Math.round(b * (1 - amount));

  return `#${dr.toString(16).padStart(2, "0")}${dg.toString(16).padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
}
