//! FILENAME: app/extensions/Charts/rendering/radarChartPainter.ts
// PURPOSE: Pure Canvas 2D radar (spider) chart drawing.
// CONTEXT: Polar grid with connected point polygons per series.
//          Each category maps to an axis radiating from center.

import type { ChartSpec, ParsedChartData, ChartLayout, PointMarker, RadarMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import {
  computeRadialLayout,
  drawChartBackground,
  drawTitle,
  drawLegend,
} from "./chartPainterUtils";

// ============================================================================
// Layout
// ============================================================================

export function computeRadarLayout(
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

export function paintRadarChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as RadarMarkOptions;
  const showFill = opts.showFill ?? true;
  const fillOpacity = opts.fillOpacity ?? 0.2;
  const lineWidth = opts.lineWidth ?? 2;
  const showMarkers = opts.showMarkers ?? true;
  const markerRadius = opts.markerRadius ?? 4;

  const n = data.categories.length;
  if (n < 3) {
    drawChartBackground(ctx, layout, theme);
    ctx.fillStyle = "#999";
    ctx.font = `12px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Radar chart needs at least 3 categories", layout.width / 2, layout.height / 2);
    return;
  }

  // Compute center and radius
  const cx = plotArea.x + plotArea.width / 2;
  const cy = plotArea.y + plotArea.height / 2;
  const radius = Math.min(plotArea.width, plotArea.height) / 2 - 20; // leave room for labels

  // Find global max for normalization
  const allValues = data.series.flatMap((s) => s.values);
  const dataMax = Math.max(...allValues, 1);
  const maxVal = spec.yAxis.max ?? dataMax;

  // Angle per category (starting at -90deg = top)
  const angleStep = (Math.PI * 2) / n;

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  // 2. Draw grid rings (concentric polygons)
  const ringCount = 4;
  for (let ring = 1; ring <= ringCount; ring++) {
    const r = (radius / ringCount) * ring;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const angle = -Math.PI / 2 + angleStep * (i % n);
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = theme.gridLineColor;
    ctx.lineWidth = theme.gridLineWidth;
    ctx.stroke();
  }

  // 3. Draw axis lines from center to each vertex
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + angleStep * i;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    ctx.strokeStyle = theme.gridLineColor;
    ctx.lineWidth = theme.gridLineWidth;
    ctx.stroke();
  }

  // 4. Draw category labels at each vertex
  ctx.fillStyle = theme.axisLabelColor;
  ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + angleStep * i;
    const labelR = radius + 12;
    const lx = cx + Math.cos(angle) * labelR;
    const ly = cy + Math.sin(angle) * labelR;

    // Determine text alignment based on angle
    if (Math.abs(angle + Math.PI / 2) < 0.1) {
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
    } else if (Math.abs(angle - Math.PI / 2) < 0.1) {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
    } else if (Math.cos(angle) > 0) {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
    } else {
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
    }
    ctx.fillText(data.categories[i], lx, ly);
  }

  // 5. Draw value labels on first axis
  ctx.fillStyle = theme.axisLabelColor;
  ctx.font = `${theme.labelFontSize - 1}px ${theme.fontFamily}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let ring = 1; ring <= ringCount; ring++) {
    const val = (maxVal / ringCount) * ring;
    const r = (radius / ringCount) * ring;
    const y = cy - r;
    ctx.fillText(formatSimple(val), cx - 4, y);
  }

  // 6. Draw series polygons
  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    const color = getSeriesColor(spec.palette, si, series.color);

    // Compute polygon vertices
    const points: Array<{ x: number; y: number }> = [];
    for (let ci = 0; ci < n; ci++) {
      const val = Math.max(0, series.values[ci] ?? 0);
      const norm = Math.min(val / maxVal, 1);
      const r = norm * radius;
      const angle = -Math.PI / 2 + angleStep * ci;
      points.push({
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
      });
    }

    // Fill polygon
    if (showFill) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const p = points[i % n];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.globalAlpha = fillOpacity;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Stroke polygon
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const p = points[i % n];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Markers
    if (showMarkers) {
      ctx.fillStyle = color;
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, markerRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 7. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 8. Legend
  if (spec.legend.visible && data.series.length > 0) {
    drawLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeRadarPointMarkers(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): PointMarker[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as RadarMarkOptions;
  const markerRadius = opts.markerRadius ?? 4;
  const markers: PointMarker[] = [];

  const n = data.categories.length;
  if (n < 3) return markers;

  const cx = plotArea.x + plotArea.width / 2;
  const cy = plotArea.y + plotArea.height / 2;
  const radius = Math.min(plotArea.width, plotArea.height) / 2 - 20;

  const allValues = data.series.flatMap((s) => s.values);
  const dataMax = Math.max(...allValues, 1);
  const maxVal = spec.yAxis.max ?? dataMax;
  const angleStep = (Math.PI * 2) / n;

  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    for (let ci = 0; ci < n; ci++) {
      const val = Math.max(0, series.values[ci] ?? 0);
      const norm = Math.min(val / maxVal, 1);
      const r = norm * radius;
      const angle = -Math.PI / 2 + angleStep * ci;
      markers.push({
        seriesIndex: si,
        categoryIndex: ci,
        cx: cx + Math.cos(angle) * r,
        cy: cy + Math.sin(angle) * r,
        radius: markerRadius,
        value: val,
        seriesName: series.name,
        categoryName: data.categories[ci],
      });
    }
  }

  return markers;
}

// ============================================================================
// Helpers
// ============================================================================

function formatSimple(value: number): string {
  if (Math.abs(value) >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
  if (Math.abs(value) >= 1_000) return (value / 1_000).toFixed(1) + "K";
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(1);
}
