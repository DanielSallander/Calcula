//! FILENAME: app/extensions/Charts/rendering/dataLabelPainter.ts
// PURPOSE: Shared utility to draw data labels on any chart type.
// CONTEXT: Called after the primary chart marks are painted. Reads label positions
//          from HitGeometry (bars, points, slices) and renders formatted text.

import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  ChartElementRect,
  HitGeometry,
  BarRect,
  PointMarker,
  SliceArc,
  DataLabelSpec,
  DataLabelContent,
  DataLabelPosition,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { formatTickValue, recordDataLabelRects } from "./chartPainterUtils";

// ============================================================================
// Public API
// ============================================================================

/** One painted label: the datum it belongs to and the box it occupies. */
type RecordedLabel = { seriesIndex: number; pointIndex: number; rect: ChartElementRect };

/**
 * Draw data labels on the chart using pre-computed hit geometry.
 * Should be called after the primary marks are painted.
 *
 * SELECTABILITY: every label drawn records its box onto
 * `layout.elements.dataLabels` with BOTH indices, because Excel's data label
 * is a per-point object (unlike error bars, which are per series). Composed
 * geometry recurses into its groups and the labels of every group land in ONE
 * list written back once at the end — recording per group would leave only the
 * last group's labels on the layout, and a chart whose first panel's labels
 * were unclickable is exactly the kind of "works on the example I tried" defect
 * this wave exists to remove.
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

  const recorded: RecordedLabel[] = [];
  paintDataLabelsInto(ctx, data, spec, layout, theme, geometry, recorded);
  recordDataLabelRects(layout, recorded);
}

/** The recursive half: draws, and appends what it drew to `recorded`. */
function paintDataLabelsInto(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
  geometry: HitGeometry,
  recorded: RecordedLabel[],
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
      drawBarLabels(ctx, geometry.rects, data, spec, dl, contentFields, position, fontSize, separator, bgColor, minValue, seriesFilter, layout, recorded);
      break;
    case "points":
      drawPointLabels(ctx, geometry.markers, data, spec, dl, contentFields, position, fontSize, separator, bgColor, minValue, seriesFilter, layout, recorded);
      break;
    case "slices":
      drawSliceLabels(ctx, geometry.arcs, data, spec, dl, contentFields, fontSize, separator, bgColor, minValue, recorded);
      break;
    case "composite":
      for (const group of geometry.groups) {
        paintDataLabelsInto(ctx, data, spec, layout, theme, group, recorded);
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
  recorded: RecordedLabel[],
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
    const box = drawLabelText(ctx, text, x, y, color, fontSize, bgColor);
    recorded.push({ seriesIndex: rect.seriesIndex, pointIndex: rect.categoryIndex, rect: box });
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
  recorded: RecordedLabel[],
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
    const box = drawLabelText(ctx, text, x, y, color, fontSize, bgColor);
    recorded.push({ seriesIndex: marker.seriesIndex, pointIndex: marker.categoryIndex, rect: box });
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
  recorded: RecordedLabel[],
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
    const box = drawLabelText(ctx, text, x, y, color, fontSize, bgColor);
    ctx.restore();
    // A radial mark's series axis and category axis are the SAME axis, so both
    // indices are the arc's own — the convention `hitTestSliceArcs` already
    // answers for the slice itself.
    recorded.push({ seriesIndex: arc.seriesIndex, pointIndex: arc.seriesIndex, rect: box });
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

/**
 * Draw one label and RETURN the box it occupies on screen — the padded plate
 * when it has a background, the tight glyph box otherwise. The return value is
 * what gets recorded for hit-testing, so the clickable area is by construction
 * the area the reader can see, rather than a second guess at it.
 */
function drawLabelText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  fontSize: number,
  bgColor: string | null,
): ChartElementRect {
  ctx.textBaseline = "middle";

  const textWidth = ctx.measureText(text).width;
  const pad = bgColor ? 3 : 0;
  const w = textWidth + pad * 2;
  const h = fontSize + pad * 2;
  // Anchoring follows textAlign, which the slice path flips per label.
  const bx = ctx.textAlign === "center" ? x - w / 2 :
             ctx.textAlign === "right" ? x - w : x;
  const box: ChartElementRect = { x: bx, y: y - h / 2, width: w, height: h };

  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(box.x, box.y, box.width, box.height);
  }

  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  return box;
}
