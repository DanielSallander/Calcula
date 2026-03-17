//! FILENAME: app/extensions/Charts/rendering/funnelChartPainter.ts
// PURPOSE: Pure Canvas 2D funnel chart drawing.
// CONTEXT: Progressively narrowing horizontal sections. Uses first series' values.
//          Width of each section is proportional to its value.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, FunnelMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
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

export function computeFunnelLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  // Reuse radial layout (no axes needed)
  return computeRadialLayout(width, height, spec, data, theme);
}

// ============================================================================
// Main Paint Function
// ============================================================================

export function paintFunnelChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as FunnelMarkOptions;
  const neckWidthRatio = opts.neckWidthRatio ?? 0.3;
  const showLabels = opts.showLabels ?? true;
  const labelFormat = opts.labelFormat ?? "both";
  const sectionGap = opts.sectionGap ?? 2;

  // Use first series' values
  const values = data.series.length > 0 ? data.series[0].values : [];
  const n = values.length;
  if (n === 0) {
    drawChartBackground(ctx, layout, theme);
    return;
  }

  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  const maxVal = Math.max(...values, 1);

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  // Compute section geometry
  // Each section is a trapezoid: top width proportional to its value,
  // bottom width proportional to the next section's value (or neck ratio * max)
  const totalHeight = plotArea.height;
  const sectionHeight = (totalHeight - sectionGap * (n - 1)) / n;
  const maxWidth = plotArea.width * 0.9; // leave some margin
  const minWidth = maxWidth * neckWidthRatio;
  const cx = plotArea.x + plotArea.width / 2;

  // Width for each section: linear interpolation between max (first) and min (last)
  // based on relative value
  const widths: number[] = values.map((v) => {
    const ratio = Math.max(0, v) / maxVal;
    return minWidth + (maxWidth - minWidth) * ratio;
  });

  // 2. Draw sections
  for (let i = 0; i < n; i++) {
    const topWidth = widths[i];
    const bottomWidth = i < n - 1 ? widths[i + 1] : topWidth * neckWidthRatio;
    const y = plotArea.y + i * (sectionHeight + sectionGap);

    const topLeft = cx - topWidth / 2;
    const topRight = cx + topWidth / 2;
    const bottomLeft = cx - bottomWidth / 2;
    const bottomRight = cx + bottomWidth / 2;

    const color = getSeriesColor(spec.palette, i, null);

    ctx.beginPath();
    ctx.moveTo(topLeft, y);
    ctx.lineTo(topRight, y);
    ctx.lineTo(bottomRight, y + sectionHeight);
    ctx.lineTo(bottomLeft, y + sectionHeight);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Subtle stroke for definition
    ctx.strokeStyle = "rgba(0,0,0,0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 3. Labels
    if (showLabels) {
      const value = values[i] ?? 0;
      const percent = total > 0 ? (Math.max(0, value) / total) * 100 : 0;
      const category = i < data.categories.length ? data.categories[i] : `Section ${i + 1}`;

      let labelText: string;
      if (labelFormat === "value") {
        labelText = `${category}: ${formatTickValue(value)}`;
      } else if (labelFormat === "percent") {
        labelText = `${category}: ${percent.toFixed(1)}%`;
      } else {
        labelText = `${category}: ${formatTickValue(value)} (${percent.toFixed(1)}%)`;
      }

      // Use white text on dark backgrounds, dark on light
      const brightness = getBrightness(color);
      ctx.fillStyle = brightness > 150 ? "#333333" : "#ffffff";
      ctx.font = `600 ${theme.labelFontSize}px ${theme.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.fillText(labelText, cx, y + sectionHeight / 2);
    }
  }

  // 4. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 5. Legend (using category names)
  if (spec.legend.visible && data.categories.length > 0) {
    drawRadialLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeFunnelBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): BarRect[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as FunnelMarkOptions;
  const neckWidthRatio = opts.neckWidthRatio ?? 0.3;
  const sectionGap = opts.sectionGap ?? 2;
  const rects: BarRect[] = [];

  const values = data.series.length > 0 ? data.series[0].values : [];
  const n = values.length;
  if (n === 0) return rects;

  const maxVal = Math.max(...values, 1);
  const sectionHeight = (plotArea.height - sectionGap * (n - 1)) / n;
  const maxWidth = plotArea.width * 0.9;
  const minWidth = maxWidth * neckWidthRatio;
  const cx = plotArea.x + plotArea.width / 2;

  const widths: number[] = values.map((v) => {
    const ratio = Math.max(0, v) / maxVal;
    return minWidth + (maxWidth - minWidth) * ratio;
  });

  for (let i = 0; i < n; i++) {
    const topWidth = widths[i];
    const y = plotArea.y + i * (sectionHeight + sectionGap);

    rects.push({
      seriesIndex: i,
      categoryIndex: i,
      x: cx - topWidth / 2,
      y,
      width: topWidth,
      height: sectionHeight,
      value: values[i] ?? 0,
      seriesName: i < data.categories.length ? data.categories[i] : `Section ${i + 1}`,
      categoryName: i < data.categories.length ? data.categories[i] : `Section ${i + 1}`,
    });
  }

  return rects;
}

// ============================================================================
// Helpers
// ============================================================================

function getBrightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}
