//! FILENAME: app/extensions/Charts/rendering/dataLabelPainter.ts
// PURPOSE: Shared utility to draw data labels on any chart type.
// CONTEXT: Called after the primary chart marks are painted. Reads label positions
//          from HitGeometry (bars, points, slices) and renders formatted text.

import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  HitGeometry,
  BarRect,
  PointMarker,
  SliceArc,
  DataLabelSpec,
  DataLabelContent,
  DataLabelPosition,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { formatTickValue } from "./chartPainterUtils";

// ============================================================================
// Public API
// ============================================================================

/**
 * Draw data labels on the chart using pre-computed hit geometry.
 * Should be called after the primary marks are painted.
 */
export function paintDataLabels(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
  geometry: HitGeometry,
): void {
  const dl = spec.dataLabels;
  if (!dl || !dl.enabled) return;

  const fontSize = dl.fontSize ?? 10;
  const separator = dl.separator ?? " - ";
  const contentFields = dl.content ?? ["value"];
  const position = dl.position ?? "auto";
  const bgColor = dl.backgroundColor ?? null;
  const minValue = dl.minValue ?? null;
  const seriesFilter = dl.seriesFilter ?? null;

  ctx.save();
  ctx.font = `${fontSize}px ${theme.fontFamily}`;
  ctx.textAlign = "center";

  switch (geometry.type) {
    case "bars":
      drawBarLabels(ctx, geometry.rects, data, spec, dl, contentFields, position, fontSize, separator, bgColor, minValue, seriesFilter, layout);
      break;
    case "points":
      drawPointLabels(ctx, geometry.markers, data, spec, dl, contentFields, position, fontSize, separator, bgColor, minValue, seriesFilter, layout);
      break;
    case "slices":
      drawSliceLabels(ctx, geometry.arcs, data, spec, dl, contentFields, fontSize, separator, bgColor, minValue);
      break;
    case "composite":
      for (const group of geometry.groups) {
        paintDataLabels(ctx, data, spec, layout, theme, group);
      }
      break;
  }

  ctx.restore();
}

// ============================================================================
// Bar Labels
// ============================================================================

function drawBarLabels(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  rects: BarRect[],
  data: ParsedChartData,
  spec: ChartSpec,
  dl: DataLabelSpec,
  contentFields: DataLabelContent[],
  position: DataLabelPosition,
  fontSize: number,
  separator: string,
  bgColor: string | null,
  minValue: number | null,
  seriesFilter: number[] | null,
  layout: ChartLayout,
): void {
  const { plotArea } = layout;

  for (const rect of rects) {
    if (seriesFilter && !seriesFilter.includes(rect.seriesIndex)) continue;
    if (minValue != null && Math.abs(rect.value) < minValue) continue;

    const text = formatLabelText(contentFields, rect.value, rect.categoryName, rect.seriesName, data, separator, dl.format);
    if (!text) continue;

    // Determine position
    let x = rect.x + rect.width / 2;
    let y: number;
    const pos = position === "auto" ? "above" : position;

    switch (pos) {
      case "inside":
      case "center":
        y = rect.y + rect.height / 2;
        break;
      case "below":
        y = rect.y + rect.height + fontSize + 2;
        break;
      case "above":
      default:
        y = rect.y - 4;
        break;
    }

    // Clamp to plot area
    y = Math.max(plotArea.y + fontSize, Math.min(y, plotArea.y + plotArea.height - 2));

    const color = dl.color ?? ((pos === "inside" || pos === "center") ? "#ffffff" : "#333333");
    drawLabelText(ctx, text, x, y, color, fontSize, bgColor);
  }
}

// ============================================================================
// Point Labels (line, area, scatter)
// ============================================================================

function drawPointLabels(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  markers: PointMarker[],
  data: ParsedChartData,
  spec: ChartSpec,
  dl: DataLabelSpec,
  contentFields: DataLabelContent[],
  position: DataLabelPosition,
  fontSize: number,
  separator: string,
  bgColor: string | null,
  minValue: number | null,
  seriesFilter: number[] | null,
  layout: ChartLayout,
): void {
  const { plotArea } = layout;

  for (const marker of markers) {
    if (seriesFilter && !seriesFilter.includes(marker.seriesIndex)) continue;
    if (minValue != null && Math.abs(marker.value) < minValue) continue;

    const text = formatLabelText(contentFields, marker.value, marker.categoryName, marker.seriesName, data, separator, dl.format);
    if (!text) continue;

    let x = marker.cx;
    let y: number;
    const pos = position === "auto" ? "above" : position;

    switch (pos) {
      case "below":
        y = marker.cy + marker.radius + fontSize + 2;
        break;
      case "center":
      case "inside":
        y = marker.cy;
        break;
      case "above":
      default:
        y = marker.cy - marker.radius - 4;
        break;
    }

    y = Math.max(plotArea.y + fontSize, Math.min(y, plotArea.y + plotArea.height - 2));

    const color = dl.color ?? "#333333";
    drawLabelText(ctx, text, x, y, color, fontSize, bgColor);
  }
}

// ============================================================================
// Slice Labels (pie, donut)
// ============================================================================

function drawSliceLabels(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  arcs: SliceArc[],
  data: ParsedChartData,
  spec: ChartSpec,
  dl: DataLabelSpec,
  contentFields: DataLabelContent[],
  fontSize: number,
  separator: string,
  bgColor: string | null,
  minValue: number | null,
): void {
  for (const arc of arcs) {
    if (minValue != null && Math.abs(arc.value) < minValue) continue;

    const text = formatLabelText(contentFields, arc.value, arc.label, "", data, separator, dl.format, arc.percent);
    if (!text) continue;

    // Position label at midpoint of arc, outside the slice
    const midAngle = (arc.startAngle + arc.endAngle) / 2;
    const labelRadius = arc.outerRadius + 16;
    const x = arc.centerX + Math.cos(midAngle) * labelRadius;
    const y = arc.centerY + Math.sin(midAngle) * labelRadius;

    const color = dl.color ?? "#333333";

    ctx.save();
    ctx.textAlign = Math.cos(midAngle) >= 0 ? "left" : "right";
    drawLabelText(ctx, text, x, y, color, fontSize, bgColor);
    ctx.restore();
  }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatLabelText(
  contentFields: DataLabelContent[],
  value: number,
  categoryName: string,
  seriesName: string,
  data: ParsedChartData,
  separator: string,
  format?: string,
  percent?: number,
): string {
  const parts: string[] = [];

  for (const field of contentFields) {
    switch (field) {
      case "value":
        parts.push(format ? formatWithPattern(value, format) : formatTickValue(value));
        break;
      case "category":
        parts.push(categoryName);
        break;
      case "seriesName":
        parts.push(seriesName);
        break;
      case "percent":
        if (percent != null) {
          parts.push(`${percent.toFixed(1)}%`);
        } else {
          // Calculate percent from total of all series values
          const total = data.series.reduce((sum, s) => sum + s.values.reduce((a, b) => a + b, 0), 0);
          const pct = total > 0 ? (value / total) * 100 : 0;
          parts.push(`${pct.toFixed(1)}%`);
        }
        break;
    }
  }

  return parts.join(separator);
}

function formatWithPattern(value: number, pattern: string): string {
  // Simple format patterns: "$,.2f", ",.0f", ".1%", etc.
  if (pattern.endsWith("%")) {
    const decimals = parseInt(pattern.match(/\.(\d+)/)?.[1] ?? "1", 10);
    return (value * 100).toFixed(decimals) + "%";
  }

  const hasComma = pattern.includes(",");
  const decimalsMatch = pattern.match(/\.(\d+)/);
  const decimals = decimalsMatch ? parseInt(decimalsMatch[1], 10) : 0;
  const prefix = pattern.startsWith("$") ? "$" : "";

  let formatted = value.toFixed(decimals);
  if (hasComma) {
    const [intPart, decPart] = formatted.split(".");
    const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    formatted = decPart ? `${withCommas}.${decPart}` : withCommas;
  }

  return prefix + formatted;
}

function drawLabelText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  fontSize: number,
  bgColor: string | null,
): void {
  ctx.textBaseline = "middle";

  if (bgColor) {
    const metrics = ctx.measureText(text);
    const pad = 3;
    const w = metrics.width + pad * 2;
    const h = fontSize + pad * 2;
    const bx = ctx.textAlign === "center" ? x - w / 2 :
               ctx.textAlign === "right" ? x - w : x;
    ctx.fillStyle = bgColor;
    ctx.fillRect(bx, y - h / 2, w, h);
  }

  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
