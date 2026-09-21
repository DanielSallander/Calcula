//! FILENAME: app/extensions/Charts/rendering/paretoChartPainter.ts
// PURPOSE: Pure Canvas 2D Pareto chart drawing.
// CONTEXT: Combination chart: bars sorted descending by value + cumulative percentage line.
//          Left Y axis = values (bars), Right Y axis = cumulative % (line, 0-100%).
//          Bars auto-sort from largest to smallest.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, PointMarker, HitGeometry, ParetoMarkOptions, ChartElementRect } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { resolveDatumStyle } from "../lib/dataPointOverrides";
import { applyFillStyle } from "./gradientFill";
import { strokeDatumBorderRect } from "./barChartPainter";
import { createLinearScale, createBandScale, createScaleFromSpec } from "./scales";
import {
  computeCartesianLayout,
  drawChartBackground,
  drawPlotBackground,
  drawHorizontalGridLines,
  drawCartesianAxes,
  drawTitle,
  drawLegend,
  drawRoundedRect,
  reflowChartElements,
  recordLegendElementRects,
  formatTickValue,
} from "./chartPainterUtils";

// ============================================================================
// Internal: Sorted Pareto Data
// ============================================================================

interface ParetoData {
  /** Categories in descending value order. */
  categories: string[];
  /** Values in descending order. */
  values: number[];
  /** Cumulative percentages (0-100) corresponding to sorted categories. */
  cumulativePercents: number[];
  /** Total value sum. */
  total: number;
}

/** Sort data by value descending and compute cumulative percentages. */
function prepareParetoData(data: ParsedChartData): ParetoData {
  // Use first series' values
  const rawValues = data.series.length > 0 ? data.series[0].values : [];

  // Build index-value pairs and sort descending
  const pairs: Array<{ index: number; value: number }> = [];
  for (let i = 0; i < data.categories.length; i++) {
    pairs.push({ index: i, value: Math.max(0, rawValues[i] ?? 0) });
  }
  pairs.sort((a, b) => b.value - a.value);

  const total = pairs.reduce((sum, p) => sum + p.value, 0);
  const categories: string[] = [];
  const values: number[] = [];
  const cumulativePercents: number[] = [];
  let cumSum = 0;

  for (const p of pairs) {
    categories.push(data.categories[p.index] ?? `Category ${p.index + 1}`);
    values.push(p.value);
    cumSum += p.value;
    cumulativePercents.push(total > 0 ? (cumSum / total) * 100 : 0);
  }

  return { categories, values, cumulativePercents, total };
}

/**
 * The data a Pareto chart RESOLVES PER-POINT OVERRIDES AGAINST: one series,
 * categories in sorted (descending-value) order.
 *
 * Exported because BOTH ends of an override need it. The painter resolves bar
 * `i` at `(0, i)` against this view, and the write path has to stamp the
 * identity key from the SAME view — it used to read `data.categories[i]`, the
 * UNSORTED label, so clicking the tallest bar stamped the name of whichever
 * category happened to be first in the source range. `buildOverrideIndex` then
 * honoured that key faithfully and painted a DIFFERENT bar, while the pane
 * read the override back by index and showed the colour as if it had landed.
 * One builder, one answer.
 */
export function paretoResolveView(data: ParsedChartData): ParsedChartData {
  const pareto = prepareParetoData(data);
  return {
    categories: pareto.categories,
    series: [{ name: data.series.length > 0 ? data.series[0].name : "Values", values: pareto.values, color: null }],
  };
}

// ============================================================================
// Layout
// ============================================================================

export function computeParetoLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  // Use cartesian layout but add extra right margin for secondary axis
  const layout = computeCartesianLayout(width, height, spec, data, theme);

  // Add right margin for the percentage axis
  const extraRight = 50;
  layout.margin.right += extraRight;
  layout.plotArea.width = Math.max(
    layout.width - layout.margin.left - layout.margin.right,
    10,
  );

  // The margin just moved, and every element rect except chartArea/title is a
  // function of it — a right-hand legend in particular would still be anchored
  // 50px into the percentage axis. Reflow BEFORE anything paints (a reflow after
  // paint would throw away the painters' measured rects).
  reflowChartElements(layout, spec, data, theme);

  return layout;
}

// ============================================================================
// Main Paint Function
// ============================================================================

export function paintParetoChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as ParetoMarkOptions;
  const borderRadius = opts.borderRadius ?? 2;
  const lineColor = opts.lineColor ?? "#E53935";
  const lineWidth = opts.lineWidth ?? 2;
  const showMarkers = opts.showMarkers ?? true;
  const markerRadius = opts.markerRadius ?? 4;
  const show80Line = opts.show80PercentLine ?? true;

  if (data.series.length === 0 || data.categories.length === 0) {
    drawChartBackground(ctx, layout, theme);
    return;
  }

  const pareto = prepareParetoData(data);
  if (pareto.values.length === 0) {
    drawChartBackground(ctx, layout, theme);
    return;
  }

  const barMax = spec.yAxis.max ?? pareto.values[0]; // largest value (already sorted)
  const barMin = spec.yAxis.min ?? 0;

  // Left Y scale (values)
  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [barMin, barMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  // Right Y scale (cumulative percentage, always 0-100%)
  const pctScale = createLinearScale(
    [0, 100],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  // X scale (sorted categories)
  const xScale = createBandScale(
    pareto.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.2,
  );

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  // 2. Plot area background
  drawPlotBackground(ctx, plotArea, theme);

  // 3. Grid lines (from left Y axis)
  if (spec.yAxis.gridLines) {
    drawHorizontalGridLines(ctx, yScale, plotArea, theme);
  }

  // 4. Left axis and X axis — `layout` passed for the measured rect write-back.
  drawCartesianAxes(ctx, xScale, yScale, plotArea, spec, theme, layout);

  // 5. Right axis (percentage)
  drawPercentageAxis(ctx, pctScale, plotArea, theme);

  // 6. Bars
  const zeroY = yScale.scale(0);
  const barWidth = xScale.bandwidth;

  // A Pareto chart RE-ORDERS its categories, so the painter's `i` is a SORTED
  // position and has nothing to do with data.categories[i]. Resolve overrides
  // against the sorted view: the key matches the datum by name so it survives a
  // re-sort, and the index fallback matches the sorted position — which is
  // exactly the categoryIndex computeParetoBarRects hands the hit-tester, so an
  // override written from a click on a bar resolves back to that same bar.
  // `paretoResolveView` is SHARED with the write path (`datumAddress`), because
  // a key stamped from the unsorted data names a different bar than the one
  // that was clicked.
  const paretoView = paretoResolveView(data);

  for (let i = 0; i < pareto.categories.length; i++) {
    const value = pareto.values[i];
    const barX = xScale.scaleIndex(i);
    const barTop = yScale.scale(value);
    const barHeight = Math.abs(zeroY - barTop);
    const barY = value >= 0 ? barTop : zeroY;

    const clippedY = Math.max(barY, plotArea.y);
    const clippedBottom = Math.min(barY + barHeight, plotArea.y + plotArea.height);
    const clippedHeight = clippedBottom - clippedY;
    if (clippedHeight <= 0) continue;

    const style = resolveDatumStyle(spec, paretoView, 0, i, {
      fill: getSeriesColor(spec.palette, i, null),
    });

    if (style.opacity != null) ctx.globalAlpha = style.opacity;
    applyFillStyle(ctx, style.fill, style.gradientFill ?? undefined, barX, clippedY, barWidth, clippedHeight);

    if (borderRadius > 0 && clippedHeight > borderRadius * 2) {
      drawRoundedRect(ctx, barX, clippedY, barWidth, clippedHeight, borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(barX, clippedY, barWidth, clippedHeight);
    }
    strokeDatumBorderRect(ctx, style, barX, clippedY, barWidth, clippedHeight, borderRadius);
    if (style.opacity != null) ctx.globalAlpha = 1;
  }

  // 7. 80% reference line
  if (show80Line) {
    const y80 = pctScale.scale(80);
    ctx.beginPath();
    ctx.moveTo(plotArea.x, y80);
    ctx.lineTo(plotArea.x + plotArea.width, y80);
    ctx.strokeStyle = "#999999";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    ctx.fillStyle = "#999999";
    ctx.font = `${theme.labelFontSize - 1}px ${theme.fontFamily}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("80%", plotArea.x + plotArea.width - 4, y80 - 2);
  }

  // 8. Cumulative percentage line
  ctx.beginPath();
  let firstPoint = true;

  for (let i = 0; i < pareto.categories.length; i++) {
    const bandX = xScale.scaleIndex(i);
    const px = bandX + barWidth / 2;
    const py = pctScale.scale(pareto.cumulativePercents[i]);

    if (firstPoint) {
      ctx.moveTo(px, py);
      firstPoint = false;
    } else {
      ctx.lineTo(px, py);
    }
  }

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  // 9. Line markers
  if (showMarkers) {
    for (let i = 0; i < pareto.categories.length; i++) {
      const bandX = xScale.scaleIndex(i);
      const px = bandX + barWidth / 2;
      const py = pctScale.scale(pareto.cumulativePercents[i]);

      ctx.beginPath();
      ctx.arc(px, py, markerRadius, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // 10. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 11. Legend
  if (spec.legend.visible) {
    // Custom legend: bar series name + cumulative line
    drawParetoLegend(ctx, data, spec, layout, theme, lineColor);
  }
}

// ============================================================================
// Secondary Axis (Percentage)
// ============================================================================

function drawPercentageAxis(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  pctScale: ReturnType<typeof createLinearScale>,
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
): void {
  const rightX = plotArea.x + plotArea.width;
  const ticks = pctScale.ticks(5);

  // Axis line
  ctx.beginPath();
  ctx.moveTo(rightX, plotArea.y);
  ctx.lineTo(rightX, plotArea.y + plotArea.height);
  ctx.strokeStyle = theme.axisColor;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Tick marks and labels
  ctx.fillStyle = theme.axisLabelColor;
  ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  for (const tick of ticks) {
    const y = pctScale.scale(tick);

    // Tick mark
    ctx.beginPath();
    ctx.moveTo(rightX, y);
    ctx.lineTo(rightX + 4, y);
    ctx.strokeStyle = theme.axisColor;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label
    ctx.fillText(`${Math.round(tick)}%`, rightX + 6, y);
  }
}

// ============================================================================
// Custom Pareto Legend
// ============================================================================

function drawParetoLegend(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
  lineColor: string,
): void {
  const pos = spec.legend.position;
  const fontSize = theme.legendFontSize;

  const items = [
    { name: data.series.length > 0 ? data.series[0].name : "Values", color: getSeriesColor(spec.palette, 0, null), type: "rect" as const },
    { name: "Cumulative %", color: lineColor, type: "line" as const },
  ];

  const itemGap = 20;
  const swatchSize = 10;
  const swatchGap = 5;

  ctx.font = `${fontSize}px ${theme.fontFamily}`;

  // Calculate total width
  let totalWidth = 0;
  for (const item of items) {
    totalWidth += swatchSize + swatchGap + ctx.measureText(item.name).width + itemGap;
  }
  totalWidth -= itemGap;

  let startX: number;
  let startY: number;

  if (pos === "bottom") {
    startX = layout.plotArea.x + (layout.plotArea.width - totalWidth) / 2;
    startY = layout.height - layout.margin.bottom + fontSize + 8;
  } else if (pos === "top") {
    startX = layout.plotArea.x + (layout.plotArea.width - totalWidth) / 2;
    startY = layout.margin.top - 8;
  } else {
    startX = pos === "right" ? layout.plotArea.x + layout.plotArea.width + 20 : 10;
    startY = layout.plotArea.y + 10;
  }

  let x = startX;

  // Pareto draws its OWN legend (bar series + cumulative line), so
  // drawLegendItems never runs for it and nothing recorded its rects: without
  // this write-back the legend is unhittable. Entries are indexed 0 = the bar
  // series, 1 = "Cumulative %".
  const itemHeight = Math.max(fontSize, swatchSize);
  const itemRects: Array<{ seriesIndex: number; rect: ChartElementRect }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemStartX = x;
    if (item.type === "rect") {
      ctx.fillStyle = item.color;
      ctx.fillRect(x, startY - swatchSize / 2, swatchSize, swatchSize);
    } else {
      ctx.beginPath();
      ctx.moveTo(x, startY);
      ctx.lineTo(x + swatchSize, startY);
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x + swatchSize / 2, startY, 3, 0, Math.PI * 2);
      ctx.fillStyle = item.color;
      ctx.fill();
    }

    x += swatchSize + swatchGap;
    ctx.fillStyle = theme.legendTextColor;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(item.name, x, startY);
    const textWidth = ctx.measureText(item.name).width;
    itemRects.push({
      seriesIndex: i,
      rect: {
        x: itemStartX,
        y: startY - itemHeight / 2,
        width: swatchSize + swatchGap + textWidth,
        height: itemHeight,
      },
    });
    x += textWidth + itemGap;
  }

  recordLegendElementRects(
    layout,
    { x: startX, y: startY - itemHeight / 2, width: totalWidth, height: itemHeight },
    itemRects,
  );
}

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeParetoBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): BarRect[] {
  const { plotArea } = layout;
  const rects: BarRect[] = [];

  if (data.series.length === 0 || data.categories.length === 0) return rects;

  const pareto = prepareParetoData(data);
  if (pareto.values.length === 0) return rects;

  const barMax = spec.yAxis.max ?? pareto.values[0];
  const barMin = spec.yAxis.min ?? 0;

  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [barMin, barMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const xScale = createBandScale(
    pareto.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.2,
  );

  const zeroY = yScale.scale(0);
  const barWidth = xScale.bandwidth;

  for (let i = 0; i < pareto.categories.length; i++) {
    const value = pareto.values[i];
    const barX = xScale.scaleIndex(i);
    const barTop = yScale.scale(value);
    const barHeight = Math.abs(zeroY - barTop);
    const barY = value >= 0 ? barTop : zeroY;

    const clippedY = Math.max(barY, plotArea.y);
    const clippedBottom = Math.min(barY + barHeight, plotArea.y + plotArea.height);
    const clippedHeight = clippedBottom - clippedY;
    if (clippedHeight <= 0) continue;

    rects.push({
      seriesIndex: 0,
      categoryIndex: i,
      x: barX,
      y: clippedY,
      width: barWidth,
      height: clippedHeight,
      value,
      seriesName: data.series.length > 0 ? data.series[0].name : "Values",
      categoryName: pareto.categories[i],
    });
  }

  return rects;
}

export function computeParetoHitGeometry(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): HitGeometry {
  const barRects = computeParetoBarRects(data, spec, layout, theme);

  // Also compute line point markers
  const { plotArea } = layout;
  const pareto = prepareParetoData(data);
  const markers: PointMarker[] = [];

  if (pareto.values.length > 0) {
    const pctScale = createLinearScale(
      [0, 100],
      [plotArea.y + plotArea.height, plotArea.y],
    );

    const xScale = createBandScale(
      pareto.categories,
      [plotArea.x, plotArea.x + plotArea.width],
      0.2,
    );

    const barWidth = xScale.bandwidth;
    const markerRadius = ((spec.markOptions ?? {}) as ParetoMarkOptions).markerRadius ?? 4;

    for (let i = 0; i < pareto.categories.length; i++) {
      const bandX = xScale.scaleIndex(i);
      markers.push({
        seriesIndex: 1,
        categoryIndex: i,
        cx: bandX + barWidth / 2,
        cy: pctScale.scale(pareto.cumulativePercents[i]),
        radius: markerRadius,
        value: pareto.cumulativePercents[i],
        seriesName: "Cumulative %",
        categoryName: pareto.categories[i],
      });
    }
  }

  return {
    type: "composite",
    groups: [
      { type: "bars", rects: barRects },
      { type: "points", markers },
    ],
  };
}
