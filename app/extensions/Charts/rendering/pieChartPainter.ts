//! FILENAME: app/extensions/Charts/rendering/pieChartPainter.ts
// PURPOSE: Pure Canvas 2D pie and donut chart drawing.
// CONTEXT: Radial chart using arc slices. innerRadius=0 for pie, >0 for donut.

import type { ChartSpec, ParsedChartData, ChartLayout, SliceArc, PieMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { valuesToAngles } from "./scales";
import {
  computeRadialLayout,
  drawChartBackground,
  drawTitle,
  drawRadialLegend,
  formatTickValue,
} from "./chartPainterUtils";

// ============================================================================
// Layout
// ============================================================================

/**
 * Compute the layout for a pie or donut chart.
 */
export function computePieLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  return computeRadialLayout(width, height, spec, data, theme);
}

// ============================================================================
// Main Paint Function
// ============================================================================

/**
 * Paint a pie or donut chart onto a Canvas 2D context.
 * Assumes the context is already sized and scaled (including DPR).
 */
export function paintPieChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const pieOpts = (spec.markOptions ?? {}) as PieMarkOptions;

  // Resolve inner radius ratio: 0 for pie, 0.5 for donut (unless overridden)
  const innerRadiusRatio = resolveInnerRadiusRatio(spec.mark, pieOpts);

  // Compute center and radius from the plot area
  const centerX = plotArea.x + plotArea.width / 2;
  const centerY = plotArea.y + plotArea.height / 2;
  const outerRadius = Math.min(plotArea.width, plotArea.height) / 2;
  const innerRadius = outerRadius * innerRadiusRatio;

  // Use the first series' values (pie/donut is single-series by design)
  const values = data.series.length > 0 ? data.series[0].values : [];
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);

  // Compute angles for each slice
  const startAngleDeg = pieOpts.startAngle ?? 0;
  const padAngleDeg = pieOpts.padAngle ?? 1;
  const angles = valuesToAngles(values, startAngleDeg, padAngleDeg);

  // Determine label settings
  const showLabels = pieOpts.showLabels ?? true;
  const labelFormat = pieOpts.labelFormat ?? "percent";

  // 1. Background (full chart)
  drawChartBackground(ctx, layout, theme);

  // 2. Draw slices
  for (let i = 0; i < angles.length; i++) {
    const { startAngle, endAngle } = angles[i];
    if (startAngle === endAngle) continue;

    const color = getSeriesColor(spec.palette, i, null);

    ctx.beginPath();
    ctx.arc(centerX, centerY, outerRadius, startAngle, endAngle);
    if (innerRadius > 0) {
      ctx.arc(centerX, centerY, innerRadius, endAngle, startAngle, true);
    } else {
      ctx.lineTo(centerX, centerY);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // 3. Draw slice labels
  if (showLabels && total > 0) {
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Compute the label radius at ~70% between inner and outer radius
    const labelRadius = innerRadius + (outerRadius - innerRadius) * 0.7;

    for (let i = 0; i < angles.length; i++) {
      const { startAngle, endAngle } = angles[i];
      if (startAngle === endAngle) continue;

      const value = values[i];
      const percent = (Math.max(0, value) / total) * 100;

      // Skip labels for very small slices (less than 3%)
      if (percent < 3) continue;

      const midAngle = (startAngle + endAngle) / 2;
      const lx = centerX + Math.cos(midAngle) * labelRadius;
      const ly = centerY + Math.sin(midAngle) * labelRadius;

      let labelText: string;
      if (labelFormat === "value") {
        labelText = formatTickValue(value);
      } else if (labelFormat === "both") {
        labelText = `${formatTickValue(value)} (${percent.toFixed(1)}%)`;
      } else {
        // "percent"
        labelText = `${percent.toFixed(1)}%`;
      }

      // Draw a shadow outline for readability against colored slices
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 3;
      ctx.strokeText(labelText, lx, ly);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(labelText, lx, ly);
    }
  }

  // 4. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 5. Legend (using category names, not series names)
  if (spec.legend.visible && data.categories.length > 0) {
    drawRadialLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Slice Arc Computation (for hit-testing)
// ============================================================================

/**
 * Compute the geometry of every pie/donut slice.
 * Returns the same geometry that paintPieChart() renders, but as data.
 * Used by hit-testing and selection highlight rendering.
 */
export function computePieSliceArcs(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): SliceArc[] {
  const { plotArea } = layout;
  const pieOpts = (spec.markOptions ?? {}) as PieMarkOptions;
  const arcs: SliceArc[] = [];

  // Resolve inner radius ratio
  const innerRadiusRatio = resolveInnerRadiusRatio(spec.mark, pieOpts);

  // Compute center and radii
  const centerX = plotArea.x + plotArea.width / 2;
  const centerY = plotArea.y + plotArea.height / 2;
  const outerRadius = Math.min(plotArea.width, plotArea.height) / 2;
  const innerRadius = outerRadius * innerRadiusRatio;

  // Use the first series' values
  const values = data.series.length > 0 ? data.series[0].values : [];
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);

  if (total === 0) return arcs;

  // Compute angles
  const startAngleDeg = pieOpts.startAngle ?? 0;
  const padAngleDeg = pieOpts.padAngle ?? 1;
  const angles = valuesToAngles(values, startAngleDeg, padAngleDeg);

  for (let i = 0; i < angles.length; i++) {
    const { startAngle, endAngle } = angles[i];
    const value = values[i] ?? 0;
    const percent = (Math.max(0, value) / total) * 100;
    const label = i < data.categories.length ? data.categories[i] : `Slice ${i + 1}`;

    arcs.push({
      seriesIndex: i,
      startAngle,
      endAngle,
      innerRadius,
      outerRadius,
      centerX,
      centerY,
      value,
      label,
      percent,
    });
  }

  return arcs;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the inner radius ratio based on chart mark type and user options.
 * - "pie" always forces 0 (full pie, no hole).
 * - "donut" defaults to 0.5 unless the user specified a custom ratio.
 */
function resolveInnerRadiusRatio(
  mark: string,
  opts: PieMarkOptions,
): number {
  if (mark === "pie") {
    return 0;
  }
  // "donut" or any other radial type
  return opts.innerRadiusRatio ?? 0.5;
}
