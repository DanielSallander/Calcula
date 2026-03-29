//! FILENAME: app/extensions/Charts/rendering/treemapChartPainter.ts
// PURPOSE: Pure Canvas 2D treemap chart drawing.
// CONTEXT: Renders hierarchical data as nested rectangles using a squarified
//          treemap layout algorithm. Category labels = tile names, first series = values.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, TreemapMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import {
  computeRadialLayout,
  drawChartBackground,
  drawTitle,
  drawRadialLegend,
  drawRoundedRect,
  formatTickValue,
} from "./chartPainterUtils";

// ============================================================================
// Layout
// ============================================================================

export function computeTreemapLayout(
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

export function paintTreemapChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as TreemapMarkOptions;
  const showLabels = opts.showLabels ?? true;
  const labelFormat = opts.labelFormat ?? "both";
  const borderWidth = opts.tileBorderWidth ?? 2;
  const borderColor = opts.tileBorderColor ?? "#ffffff";
  const tileRadius = opts.tileRadius ?? 2;

  // Use first series' values
  const values = data.series.length > 0 ? data.series[0].values : [];
  const n = values.length;
  if (n === 0) {
    drawChartBackground(ctx, layout, theme);
    return;
  }

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  // 2. Compute squarified treemap layout
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total === 0) return;

  const tiles = squarify(
    values.map((v, i) => ({ index: i, value: Math.max(0, v) })),
    plotArea.x + borderWidth / 2,
    plotArea.y + borderWidth / 2,
    plotArea.width - borderWidth,
    plotArea.height - borderWidth,
    total,
  );

  // 3. Draw tiles
  for (const tile of tiles) {
    const color = getSeriesColor(spec.palette, tile.index, null);

    ctx.fillStyle = color;
    if (tileRadius > 0 && tile.w > tileRadius * 2 && tile.h > tileRadius * 2) {
      drawRoundedRect(ctx, tile.x, tile.y, tile.w, tile.h, tileRadius);
      ctx.fill();
    } else {
      ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
    }

    // Border
    if (borderWidth > 0) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderWidth;
      if (tileRadius > 0 && tile.w > tileRadius * 2 && tile.h > tileRadius * 2) {
        drawRoundedRect(ctx, tile.x, tile.y, tile.w, tile.h, tileRadius);
        ctx.stroke();
      } else {
        ctx.strokeRect(tile.x, tile.y, tile.w, tile.h);
      }
    }

    // 4. Labels
    if (showLabels && tile.w > 30 && tile.h > 20) {
      const category = tile.index < data.categories.length ? data.categories[tile.index] : `Item ${tile.index + 1}`;
      const value = values[tile.index] ?? 0;

      let labelText: string;
      if (labelFormat === "category") {
        labelText = category;
      } else if (labelFormat === "value") {
        labelText = formatTickValue(value);
      } else {
        labelText = `${category}\n${formatTickValue(value)}`;
      }

      const brightness = getBrightness(color);
      ctx.fillStyle = brightness > 150 ? "#333333" : "#ffffff";

      const lines = labelText.split("\n");
      const fontSize = Math.min(theme.labelFontSize, tile.h / (lines.length + 1));
      ctx.font = `600 ${fontSize}px ${theme.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const cx = tile.x + tile.w / 2;
      const cy = tile.y + tile.h / 2;
      const lineHeight = fontSize + 2;
      const startY = cy - ((lines.length - 1) * lineHeight) / 2;

      for (let li = 0; li < lines.length; li++) {
        const text = lines[li];
        // Truncate if wider than tile
        const maxWidth = tile.w - 8;
        if (ctx.measureText(text).width > maxWidth) {
          let truncated = text;
          while (truncated.length > 1 && ctx.measureText(truncated + "...").width > maxWidth) {
            truncated = truncated.slice(0, -1);
          }
          ctx.fillText(truncated + "...", cx, startY + li * lineHeight);
        } else {
          ctx.fillText(text, cx, startY + li * lineHeight);
        }
      }
    }
  }

  // 5. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 6. Legend
  if (spec.legend.visible && data.categories.length > 0) {
    drawRadialLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeTreemapBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): BarRect[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as TreemapMarkOptions;
  const borderWidth = opts.tileBorderWidth ?? 2;
  const rects: BarRect[] = [];

  const values = data.series.length > 0 ? data.series[0].values : [];
  const n = values.length;
  if (n === 0) return rects;

  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total === 0) return rects;

  const tiles = squarify(
    values.map((v, i) => ({ index: i, value: Math.max(0, v) })),
    plotArea.x + borderWidth / 2,
    plotArea.y + borderWidth / 2,
    plotArea.width - borderWidth,
    plotArea.height - borderWidth,
    total,
  );

  for (const tile of tiles) {
    rects.push({
      seriesIndex: tile.index,
      categoryIndex: tile.index,
      x: tile.x,
      y: tile.y,
      width: tile.w,
      height: tile.h,
      value: values[tile.index] ?? 0,
      seriesName: tile.index < data.categories.length ? data.categories[tile.index] : `Item ${tile.index + 1}`,
      categoryName: tile.index < data.categories.length ? data.categories[tile.index] : `Item ${tile.index + 1}`,
    });
  }

  return rects;
}

// ============================================================================
// Squarified Treemap Algorithm
// ============================================================================

interface TileInput {
  index: number;
  value: number;
}

interface TileRect {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified treemap layout algorithm.
 * Produces tiles with aspect ratios as close to 1:1 as possible.
 * Based on Bruls, Huizing, and van Wijk (2000).
 */
function squarify(
  items: TileInput[],
  x: number,
  y: number,
  w: number,
  h: number,
  total: number,
): TileRect[] {
  // Sort descending by value for better squarification
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const results: TileRect[] = [];

  layoutStrip(sorted, x, y, w, h, total, results);

  return results;
}

function layoutStrip(
  items: TileInput[],
  x: number,
  y: number,
  w: number,
  h: number,
  total: number,
  results: TileRect[],
): void {
  if (items.length === 0) return;
  if (items.length === 1) {
    results.push({ index: items[0].index, x, y, w, h });
    return;
  }

  if (w <= 0 || h <= 0 || total <= 0) return;

  // Determine if we split horizontally or vertically
  const isWide = w >= h;
  const side = isWide ? h : w;

  let row: TileInput[] = [];
  let rowTotal = 0;
  let bestRatio = Infinity;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const nextRowTotal = rowTotal + item.value;
    const nextRow = [...row, item];

    const ratio = worstAspectRatio(nextRow, nextRowTotal, side, total, isWide ? w : h);

    if (ratio <= bestRatio || row.length === 0) {
      row = nextRow;
      rowTotal = nextRowTotal;
      bestRatio = ratio;
    } else {
      // Layout the current row and recurse on the remainder
      const rowFraction = rowTotal / total;
      const rowSize = (isWide ? w : h) * rowFraction;

      layoutRow(row, rowTotal, total, x, y, w, h, isWide, rowSize, results);

      // Recurse on remaining items
      const remaining = items.slice(i);
      const remainingTotal = total - rowTotal;

      if (isWide) {
        layoutStrip(remaining, x + rowSize, y, w - rowSize, h, remainingTotal, results);
      } else {
        layoutStrip(remaining, x, y + rowSize, w, h - rowSize, remainingTotal, results);
      }
      return;
    }
  }

  // All items fit in one row
  const rowFraction = rowTotal / total;
  const rowSize = (isWide ? w : h) * rowFraction;
  layoutRow(row, rowTotal, total, x, y, w, h, isWide, rowSize, results);
}

function layoutRow(
  row: TileInput[],
  rowTotal: number,
  _areaTotal: number,
  x: number,
  y: number,
  _w: number,
  _h: number,
  isWide: boolean,
  rowSize: number,
  results: TileRect[],
): void {
  let offset = 0;

  for (const item of row) {
    const fraction = rowTotal > 0 ? item.value / rowTotal : 1 / row.length;
    if (isWide) {
      const tileH = (isWide ? _h : _w) * fraction;
      results.push({
        index: item.index,
        x: x,
        y: y + offset,
        w: rowSize,
        h: tileH,
      });
      offset += tileH;
    } else {
      const tileW = (isWide ? _h : _w) * fraction;
      results.push({
        index: item.index,
        x: x + offset,
        y: y,
        w: tileW,
        h: rowSize,
      });
      offset += tileW;
    }
  }
}

function worstAspectRatio(
  row: TileInput[],
  rowTotal: number,
  side: number,
  areaTotal: number,
  availableLength: number,
): number {
  if (rowTotal === 0 || areaTotal === 0 || side === 0) return Infinity;

  // The row occupies a strip of width = (rowTotal / areaTotal) * availableLength
  // Each item in the row has height proportional to its value
  const stripWidth = (rowTotal / areaTotal) * availableLength;
  if (stripWidth === 0) return Infinity;

  let worst = 0;
  for (const item of row) {
    const fraction = item.value / rowTotal;
    const itemLength = side * fraction;
    if (itemLength === 0) continue;
    const ratio = Math.max(stripWidth / itemLength, itemLength / stripWidth);
    worst = Math.max(worst, ratio);
  }

  return worst;
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
