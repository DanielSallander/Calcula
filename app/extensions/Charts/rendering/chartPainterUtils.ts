//! FILENAME: app/extensions/Charts/rendering/chartPainterUtils.ts
// PURPOSE: Shared drawing utilities used by all chart painters.
// CONTEXT: Extracted from barChartPainter to avoid duplication across chart types.
//          Includes title, legend, axis, grid line, and geometry helpers.

import type { ChartSpec, ParsedChartData, ChartLayout } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { seriesPaletteIndex } from "../lib/encodingResolver";
import type { LinearScale, BandScale } from "./scales";
import { createScaleFromSpec, createPointScale, createBandScale } from "./scales";
import { applyFillStyle } from "./gradientFill";
import { timeTicks } from "../lib/chartFieldTypes";

// ============================================================================
// Layout Computation (shared for cartesian charts)
// ============================================================================

/**
 * Compute the layout (margins and plot area) for a cartesian chart.
 * Margins accommodate title, axis labels, and legend.
 */
export function computeCartesianLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  let top = 12;
  let right = 16;
  let bottom = 12;
  let left = 16;

  // Title
  if (spec.title) {
    top += theme.titleFontSize + 8;
  }

  // Y-axis labels (estimate max label width from actual data values)
  if (spec.yAxis.showLabels) {
    const allValues = data.series.flatMap((s) => s.values);
    const maxVal = Math.max(...allValues, 0);
    const minVal = Math.min(...allValues, 0);
    const maxLabel = formatTickValue(maxVal);
    const minLabel = formatTickValue(minVal);
    const longestLabel = maxLabel.length >= minLabel.length ? maxLabel : minLabel;
    // Approximate width: ~7px per character at typical label font size
    left += Math.max(longestLabel.length * 7, 20) + 4;
  }
  if (spec.yAxis.title) {
    left += theme.axisTitleFontSize + 6;
  }

  // X-axis labels
  if (spec.xAxis.showLabels) {
    if (spec.xAxis.labelAngle === 0) {
      bottom += theme.labelFontSize + 8;
    } else if (spec.xAxis.labelAngle === 45) {
      bottom += 30;
    } else {
      // 90 degrees
      const maxLen = Math.max(...data.categories.map((c) => c.length), 3);
      bottom += Math.min(maxLen * 5, 60);
    }
  }
  if (spec.xAxis.title) {
    bottom += theme.axisTitleFontSize + 6;
  }

  // Legend
  if (spec.legend.visible && data.series.length > 0) {
    if (spec.legend.position === "bottom") {
      bottom += theme.legendFontSize + 16;
    } else if (spec.legend.position === "top") {
      top += theme.legendFontSize + 16;
    } else if (spec.legend.position === "right") {
      const maxNameLen = Math.max(...data.series.map((s) => s.name.length), 3);
      right += Math.min(maxNameLen * 6, 100) + 24;
    } else {
      const maxNameLen = Math.max(...data.series.map((s) => s.name.length), 3);
      left += Math.min(maxNameLen * 6, 100) + 24;
    }
  }

  const plotArea = {
    x: left,
    y: top,
    width: Math.max(width - left - right, 10),
    height: Math.max(height - top - bottom, 10),
  };

  return { width, height, margin: { top, right, bottom, left }, plotArea };
}

/**
 * Compute the layout for a radial (pie/donut) chart.
 * No axes — just title, legend, and a centered circular plot area.
 */
export function computeRadialLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  let top = 12;
  let right = 16;
  let bottom = 12;
  let left = 16;

  // Title
  if (spec.title) {
    top += theme.titleFontSize + 8;
  }

  // Legend
  if (spec.legend.visible && data.series.length > 0) {
    if (spec.legend.position === "bottom") {
      bottom += theme.legendFontSize + 16;
    } else if (spec.legend.position === "top") {
      top += theme.legendFontSize + 16;
    } else if (spec.legend.position === "right") {
      const maxNameLen = Math.max(...data.categories.map((c) => c.length), 3);
      right += Math.min(maxNameLen * 6, 100) + 24;
    } else {
      const maxNameLen = Math.max(...data.categories.map((c) => c.length), 3);
      left += Math.min(maxNameLen * 6, 100) + 24;
    }
  }

  const plotArea = {
    x: left,
    y: top,
    width: Math.max(width - left - right, 10),
    height: Math.max(height - top - bottom, 10),
  };

  return { width, height, margin: { top, right, bottom, left }, plotArea };
}

// ============================================================================
// Drawing: Title
// ============================================================================

export function drawTitle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  title: string,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  ctx.fillStyle = theme.titleColor;
  ctx.font = `600 ${theme.titleFontSize}px ${theme.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(title, layout.width / 2, 10);
}

// ============================================================================
// Drawing: Legend
// ============================================================================

/**
 * Draw a legend for cartesian charts (uses series names).
 */
export function drawLegend(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  drawLegendItems(
    ctx,
    data.series.map((s, i) => ({
      name: s.name,
      color: getSeriesColor(spec.palette, seriesPaletteIndex(data, i), s.color),
    })),
    spec,
    layout,
    theme,
  );
}

/**
 * Draw a legend for radial charts (uses category names as labels).
 */
export function drawRadialLegend(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  drawLegendItems(
    ctx,
    data.categories.map((name, i) => ({
      name,
      color: getSeriesColor(spec.palette, i, null),
    })),
    spec,
    layout,
    theme,
  );
}

function drawLegendItems(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  items: Array<{ name: string; color: string }>,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  if (items.length === 0) return;

  ctx.font = `${theme.legendFontSize}px ${theme.fontFamily}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const swatchSize = 10;
  const gap = 16;
  const padding = 4;

  if (spec.legend.position === "bottom" || spec.legend.position === "top") {
    // Horizontal legend centered below/above the plot
    let totalWidth = 0;
    const measured: Array<{ name: string; color: string; width: number }> = [];
    for (const item of items) {
      const textWidth = ctx.measureText(item.name).width;
      const itemWidth = swatchSize + padding + textWidth;
      measured.push({ ...item, width: itemWidth });
      totalWidth += itemWidth;
    }
    totalWidth += gap * (measured.length - 1);

    const y = spec.legend.position === "bottom"
      ? layout.height - theme.legendFontSize - 4
      : layout.margin.top - theme.legendFontSize - 12;

    let x = (layout.width - totalWidth) / 2;

    for (const item of measured) {
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y - swatchSize / 2, swatchSize, swatchSize);
      ctx.fillStyle = theme.legendTextColor;
      ctx.fillText(item.name, x + swatchSize + padding, y);
      x += item.width + gap;
    }
  } else {
    // Vertical legend on the right or left
    const x = spec.legend.position === "right"
      ? layout.plotArea.x + layout.plotArea.width + 16
      : 8;
    let y = layout.plotArea.y + 4;

    for (const item of items) {
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y - swatchSize / 2, swatchSize, swatchSize);
      ctx.fillStyle = theme.legendTextColor;
      ctx.fillText(item.name, x + swatchSize + padding, y);
      y += theme.legendFontSize + 6;
    }
  }
}

// ============================================================================
// Drawing: Axes (for cartesian charts)
// ============================================================================

export function drawCartesianAxes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  xScale: BandScale,
  yScale: LinearScale,
  plotArea: { x: number; y: number; width: number; height: number },
  spec: ChartSpec,
  theme: ChartRenderTheme,
): void {
  const xAxisY = plotArea.y + plotArea.height;

  // -- Axis Lines --

  // X axis line
  if (spec.xAxis.showLine !== false) {
    ctx.strokeStyle = spec.xAxis.lineColor ?? theme.axisColor;
    ctx.lineWidth = spec.xAxis.lineWidth ?? 1;
    ctx.setLineDash(spec.xAxis.lineDash ?? []);
    ctx.beginPath();
    ctx.moveTo(plotArea.x, xAxisY + 0.5);
    ctx.lineTo(plotArea.x + plotArea.width, xAxisY + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Y axis line
  if (spec.yAxis.showLine !== false) {
    ctx.strokeStyle = spec.yAxis.lineColor ?? theme.axisColor;
    ctx.lineWidth = spec.yAxis.lineWidth ?? 1;
    ctx.setLineDash(spec.yAxis.lineDash ?? []);
    ctx.beginPath();
    ctx.moveTo(plotArea.x - 0.5, plotArea.y);
    ctx.lineTo(plotArea.x - 0.5, xAxisY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // -- Tick Marks --
  const yTicks = yScale.ticks(spec.yAxis.tickCount ?? 5);
  drawTickMarks(ctx, spec.yAxis, yTicks.map((t) => yScale.scale(t)), "y", plotArea, theme);
  drawTickMarks(
    ctx, spec.xAxis,
    xScale.domain.map((_, ci) => xScale.scaleIndex(ci) + xScale.bandwidth / 2),
    "x", plotArea, theme,
  );

  // -- Display Unit Factor --
  const displayFactor = getDisplayUnitFactor(spec.yAxis.displayUnit);

  // -- X Axis Labels --
  if (spec.xAxis.showLabels && spec.xAxis.labelPosition !== "none") {
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    const angle = spec.xAxis.labelAngle ?? 0;
    const angleRad = (angle * Math.PI) / 180;

    // Auto-thinning (Excel's "interval between labels"): when there are more
    // categories than the axis can fit, each band is a few pixels wide —
    // truncating every label to its band produced unreadable one-char stubs
    // (visually "no labels at all"). Instead draw every Nth label and let the
    // drawn ones use the freed slots.
    const pitch = xScale.domain.length > 1
      ? xScale.scaleIndex(1) - xScale.scaleIndex(0)
      : plotArea.width;
    let skip = 1;
    let maxWidth = xScale.bandwidth - 4;
    if (angle === 0) {
      const desired = Math.min(widestLabelWidth(ctx, xScale.domain), 90) + 8;
      if (pitch < desired) {
        skip = Math.ceil(desired / Math.max(pitch, 1));
        maxWidth = skip * pitch - 6;
      }
    } else {
      // Rotated labels stack along the axis — they need roughly a font-height
      // of horizontal clearance each.
      const needed = theme.labelFontSize + 4;
      if (pitch < needed) skip = Math.ceil(needed / Math.max(pitch, 1));
    }

    for (let ci = 0; ci < xScale.domain.length; ci++) {
      if (ci % skip !== 0) continue;
      const category = xScale.domain[ci];
      const x = xScale.scaleIndex(ci) + xScale.bandwidth / 2;
      const y = xAxisY + 4;

      ctx.save();
      if (angle === 0) {
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = truncateText(ctx, category, maxWidth);
        ctx.fillText(label, x, y);
      } else {
        ctx.translate(x, y);
        ctx.rotate(-angleRad);
        ctx.textAlign = Math.abs(angle) > 60 ? "right" : "right";
        ctx.textBaseline = Math.abs(angle) > 60 ? "middle" : "top";
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

  // -- Y Axis Labels --
  if (spec.yAxis.showLabels && spec.yAxis.labelPosition !== "none") {
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (const tick of yTicks) {
      const y = yScale.scale(tick);
      if (y < plotArea.y || y > plotArea.y + plotArea.height) continue;

      const displayValue = displayFactor !== 1 ? tick / displayFactor : tick;
      const label = spec.yAxis.tickFormat
        ? formatTickValueWithFormat(displayValue, spec.yAxis.tickFormat)
        : formatTickValue(displayValue);
      ctx.fillText(label, plotArea.x - 6, y);
    }
  }

  // Y axis display unit label
  if (spec.yAxis.displayUnit && spec.yAxis.displayUnit !== "none" && spec.yAxis.showDisplayUnitLabel) {
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `italic ${theme.labelFontSize - 1}px ${theme.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(getDisplayUnitLabel(spec.yAxis.displayUnit), plotArea.x + 2, plotArea.y - 2);
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
// Tick Mark Drawing
// ============================================================================

function drawTickMarks(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  axisSpec: import("../types").AxisSpec,
  positions: number[],
  axis: "x" | "y",
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
): void {
  const majorType = axisSpec.majorTickMark ?? "outside";
  if (majorType === "none") return;

  ctx.strokeStyle = axisSpec.lineColor ?? theme.axisColor;
  ctx.lineWidth = 1;
  const tickLen = 5;

  ctx.beginPath();
  for (const pos of positions) {
    if (axis === "x") {
      const y = plotArea.y + plotArea.height;
      if (majorType === "outside" || majorType === "cross") {
        ctx.moveTo(pos, y);
        ctx.lineTo(pos, y + tickLen);
      }
      if (majorType === "inside" || majorType === "cross") {
        ctx.moveTo(pos, y);
        ctx.lineTo(pos, y - tickLen);
      }
    } else {
      const x = plotArea.x;
      if (majorType === "outside" || majorType === "cross") {
        ctx.moveTo(x, pos);
        ctx.lineTo(x - tickLen, pos);
      }
      if (majorType === "inside" || majorType === "cross") {
        ctx.moveTo(x, pos);
        ctx.lineTo(x + tickLen, pos);
      }
    }
  }
  ctx.stroke();
}

// ============================================================================
// Display Unit Helpers
// ============================================================================

export function getDisplayUnitFactor(unit: import("../types").DisplayUnit | undefined): number {
  switch (unit) {
    case "hundreds": return 100;
    case "thousands": return 1_000;
    case "tenThousands": return 10_000;
    case "hundredThousands": return 100_000;
    case "millions": return 1_000_000;
    case "tenMillions": return 10_000_000;
    case "hundredMillions": return 100_000_000;
    case "billions": return 1_000_000_000;
    case "trillions": return 1_000_000_000_000;
    default: return 1;
  }
}

export function getDisplayUnitLabel(unit: import("../types").DisplayUnit): string {
  switch (unit) {
    case "hundreds": return "Hundreds";
    case "thousands": return "Thousands";
    case "tenThousands": return "Ten Thousands";
    case "hundredThousands": return "Hundred Thousands";
    case "millions": return "Millions";
    case "tenMillions": return "Ten Millions";
    case "hundredMillions": return "Hundred Millions";
    case "billions": return "Billions";
    case "trillions": return "Trillions";
    default: return "";
  }
}

export function formatTickValueWithFormat(value: number, format: string): string {
  // Support common d3-style format codes
  if (format.includes("%")) {
    const decimals = format.match(/\.(\d+)/)?.[1];
    const d = decimals ? parseInt(decimals) : 0;
    return (value * 100).toFixed(d) + "%";
  }
  if (format.startsWith("$")) {
    const decimals = format.match(/\.(\d+)/)?.[1];
    const d = decimals ? parseInt(decimals) : 0;
    const formatted = value.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    return "$" + formatted;
  }
  if (format.includes(",")) {
    const decimals = format.match(/\.(\d+)/)?.[1];
    const d = decimals ? parseInt(decimals) : 0;
    return value.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const decimals = format.match(/\.(\d+)/)?.[1];
  if (decimals) {
    return value.toFixed(parseInt(decimals));
  }
  return formatTickValue(value);
}

/**
 * Draw horizontal axes for horizontal bar chart (categories on Y, values on X).
 */
export function drawHorizontalAxes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  xScale: LinearScale,
  yScale: BandScale,
  plotArea: { x: number; y: number; width: number; height: number },
  spec: ChartSpec,
  theme: ChartRenderTheme,
): void {
  ctx.strokeStyle = theme.axisColor;
  ctx.lineWidth = 1;

  // X axis line (bottom)
  const xAxisY = plotArea.y + plotArea.height;
  ctx.beginPath();
  ctx.moveTo(plotArea.x, xAxisY + 0.5);
  ctx.lineTo(plotArea.x + plotArea.width, xAxisY + 0.5);
  ctx.stroke();

  // Y axis line (left)
  ctx.beginPath();
  ctx.moveTo(plotArea.x - 0.5, plotArea.y);
  ctx.lineTo(plotArea.x - 0.5, xAxisY);
  ctx.stroke();

  // X axis labels (values, at bottom)
  if (spec.xAxis.showLabels) {
    const ticks = xScale.ticks(5);
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (const tick of ticks) {
      const x = xScale.scale(tick);
      if (x < plotArea.x || x > plotArea.x + plotArea.width) continue;
      ctx.fillText(formatTickValue(tick), x, xAxisY + 4);
    }
  }

  // Y axis labels (categories, on left)
  if (spec.yAxis.showLabels) {
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    // Auto-thinning: with many categories the bands are shorter than a text
    // line — draw every Nth label instead of overlapping all of them.
    const pitch = yScale.domain.length > 1
      ? yScale.scaleIndex(1) - yScale.scaleIndex(0)
      : plotArea.height;
    const needed = theme.labelFontSize + 2;
    const skip = pitch < needed ? Math.ceil(needed / Math.max(pitch, 1)) : 1;

    for (let ci = 0; ci < yScale.domain.length; ci++) {
      if (ci % skip !== 0) continue;
      const category = yScale.domain[ci];
      const y = yScale.scaleIndex(ci) + yScale.bandwidth / 2;
      const label = truncateText(ctx, category, plotArea.x - 10);
      ctx.fillText(label, plotArea.x - 6, y);
    }
  }

  // Axis titles
  if (spec.xAxis.title) {
    ctx.fillStyle = theme.axisTitleColor;
    ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      spec.xAxis.title,
      plotArea.x + plotArea.width / 2,
      plotArea.y + plotArea.height + (spec.xAxis.showLabels ? 26 : 16),
    );
  }
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
// Drawing: Grid Lines
// ============================================================================

export function drawHorizontalGridLines(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  yScale: LinearScale,
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
): void {
  const ticks = yScale.ticks(5);
  ctx.strokeStyle = theme.gridLineColor;
  ctx.lineWidth = theme.gridLineWidth;

  for (const tick of ticks) {
    const y = Math.round(yScale.scale(tick)) + 0.5;
    if (y < plotArea.y || y > plotArea.y + plotArea.height) continue;
    ctx.beginPath();
    ctx.moveTo(plotArea.x, y);
    ctx.lineTo(plotArea.x + plotArea.width, y);
    ctx.stroke();
  }
}

export function drawVerticalGridLines(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  xScale: LinearScale,
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
): void {
  const ticks = xScale.ticks(5);
  ctx.strokeStyle = theme.gridLineColor;
  ctx.lineWidth = theme.gridLineWidth;

  for (const tick of ticks) {
    const x = Math.round(xScale.scale(tick)) + 0.5;
    if (x < plotArea.x || x > plotArea.x + plotArea.width) continue;
    ctx.beginPath();
    ctx.moveTo(x, plotArea.y);
    ctx.lineTo(x, plotArea.y + plotArea.height);
    ctx.stroke();
  }
}

// ============================================================================
// Drawing: Background
// ============================================================================

export function drawChartBackground(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  applyFillStyle(ctx, theme.background, theme.backgroundGradient, 0, 0, layout.width, layout.height);
  ctx.fillRect(0, 0, layout.width, layout.height);
}

export function drawPlotBackground(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
): void {
  applyFillStyle(ctx, theme.plotBackground, theme.plotBackgroundGradient, plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.fillRect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
}

// ============================================================================
// Drawing: Full Chrome (for host-drawn sandboxed marks)
// ============================================================================

/**
 * Estimate the Y domain for a cartesian chart drawn by a SANDBOXED mark whose
 * value→pixel mapping the host doesn't control. Honors an explicit `yDomain` hint
 * the mark declares, then `spec.yAxis.min/max`, else the data's grouped extent
 * (`[min(0,minVal), max(0,maxVal)]` — createScaleFromSpec injects zero for auto
 * domains, matching the built-in bar default so a naive mark's bars line up).
 */
function estimateCartesianYDomain(
  data: ParsedChartData,
  spec: ChartSpec,
  yDomain?: [number, number],
): [number, number] {
  if (yDomain && yDomain.length === 2 && Number.isFinite(yDomain[0]) && Number.isFinite(yDomain[1])) {
    return [yDomain[0], yDomain[1]];
  }
  const allValues = data.series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const dataMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const dataMax = allValues.length > 0 ? Math.max(...allValues) : 1;
  return [spec.yAxis.min ?? dataMin, spec.yAxis.max ?? dataMax];
}

/**
 * Build the Y scale for host-drawn cartesian chrome. When the mark declares a
 * `yDomain` hint (or the user pinned `yAxis.min/max`), the domain is honored
 * VERBATIM — zero-injection + nice-rounding are OFF — so the host axis ticks line
 * up with the values the worker mapped into the plot (the whole point of the hint).
 * Without an explicit domain the data extent is used with the engine's default
 * zero+nice (axis anchored at 0, rounded ticks), matching the built-in marks.
 * Exported for unit testing the alignment guarantee.
 */
export function buildChromeYScale(
  spec: ChartSpec,
  data: ParsedChartData,
  range: [number, number],
  yDomain?: [number, number],
): LinearScale {
  const [yMin, yMax] = estimateCartesianYDomain(data, spec, yDomain);
  const explicit = yDomain != null || spec.yAxis.min != null || spec.yAxis.max != null;
  // Folding the domain into the ScaleSpec makes createScaleFromSpec treat it as an
  // explicit domain (hasExplicitDomain) -> zero/nice default OFF, drawn verbatim.
  return explicit
    ? createScaleFromSpec({ ...spec.yAxis.scale, domain: [yMin, yMax] }, [yMin, yMax], range)
    : createScaleFromSpec(spec.yAxis.scale, [yMin, yMax], range);
}

/**
 * Draw the COMPLETE cartesian chrome (background, plot background, grid lines,
 * axes with ticks/labels/titles, chart title, and legend) around a plot area into
 * which a sandboxed mark's worker bitmap is later blitted. Used by the sandbox mark
 * shim so an untrusted, opaque-bitmap mark still gets a host-owned, themed frame
 * the user can trust — the worker only ever supplies the plot-area pixels.
 *
 * The X axis is the category band scale (the universal cartesian default, matching
 * the built-in bar/column marks). `yDomain` lets the mark align its data with the
 * host-drawn Y ticks; without it the data extent is used.
 */
export function drawCartesianChrome(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
  yDomain?: [number, number],
): void {
  const { plotArea } = layout;
  // Inverted range: larger values go up. Honors an explicit yDomain/min/max verbatim.
  const yScale = buildChromeYScale(spec, data, [plotArea.y + plotArea.height, plotArea.y], yDomain);
  const xScale = createBandScale(
    data.categories,
    [plotArea.x, plotArea.x + plotArea.width],
    0.3,
  );

  drawChartBackground(ctx, layout, theme);
  drawPlotBackground(ctx, plotArea, theme);
  if (spec.yAxis.gridLines) {
    drawHorizontalGridLines(ctx, yScale, plotArea, theme);
  }
  drawCartesianAxes(ctx, xScale, yScale, plotArea, spec, theme);
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }
  if (spec.legend.visible && data.series.length > 0) {
    drawLegend(ctx, data, spec, layout, theme);
  }
}

/**
 * Draw the chrome for a RADIAL sandboxed mark: background, plot background, title,
 * and a category-keyed legend. No axes (radial marks have none); the worker bitmap
 * supplies the circular plot pixels.
 */
export function drawRadialChrome(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  drawChartBackground(ctx, layout, theme);
  drawPlotBackground(ctx, layout.plotArea, theme);
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }
  if (spec.legend.visible && data.categories.length > 0) {
    drawRadialLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Utility
// ============================================================================

export function drawRoundedRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function truncateText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated + "...").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "...";
}

/**
 * Width of the widest label in the list (current ctx font). Samples at most
 * ~50 entries so huge category domains don't pay a full measure pass.
 */
export function widestLabelWidth(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  labels: string[],
): number {
  if (labels.length === 0) return 0;
  const sampleStep = Math.max(1, Math.floor(labels.length / 50));
  let widest = 0;
  for (let i = 0; i < labels.length; i += sampleStep) {
    const w = ctx.measureText(labels[i]).width;
    if (w > widest) widest = w;
  }
  return widest;
}

export function formatTickValue(value: number): string {
  if (Math.abs(value) >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
  if (Math.abs(value) >= 1_000) return (value / 1_000).toFixed(1) + "K";
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(1);
}

// ============================================================================
// Scatter / Bubble X axis (quantitative when the category column is numeric)
// ============================================================================

export interface ScatterXAxis {
  /** Map a category index to its x pixel coordinate. */
  xOf(ci: number): number;
  /** Tick marks (pixel + label) to draw along the x axis. */
  ticks: Array<{ x: number; label: string }>;
  /** True when the x axis is quantitative (value-proportional) vs evenly-spaced categories. */
  numeric: boolean;
}

/**
 * Resolve the cartesian X axis. When the data carries a typed `categoryField`,
 * the X axis is value-proportional (quantitative, honoring xAxis.scale/min/max/
 * tickFormat) or time-proportional (temporal, with calendar-aware date ticks).
 * Otherwise it falls back to evenly-spaced categories (the original behavior),
 * so charts with text categories are unaffected.
 *
 * `options.requireScale` makes the proportional axis opt-in: it is used only
 * when the user has set `xAxis.scale`. Scatter/bubble leave it off (proportional
 * is their natural default); line/area turn it on so existing category-axis
 * charts stay pixel-identical unless a value/time axis is explicitly requested.
 */
export function resolveScatterXAxis(
  data: ParsedChartData,
  spec: ChartSpec,
  plotArea: { x: number; width: number },
  options?: { requireScale?: boolean },
): ScatterXAxis {
  const range: [number, number] = [plotArea.x, plotArea.x + plotArea.width];
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  const field = data.categoryField;
  const optedIn = !options?.requireScale || spec.xAxis.scale != null;

  if (field && optedIn && field.values.length === data.categories.length && field.values.length > 0) {
    const cv = field.values;
    const xMin = spec.xAxis.min ?? Math.min(...cv);
    const xMax = spec.xAxis.max ?? Math.max(...cv);
    const tickCount = spec.xAxis.tickCount ?? 5;

    if (field.type === "temporal") {
      // Linear positioning over epoch-ms with calendar-aware date ticks.
      const span = (xMax - xMin) || 1;
      const xAt = (ms: number) => range[0] + ((ms - xMin) / span) * (range[1] - range[0]);
      const ticks = timeTicks(xMin, xMax, tickCount)
        .map((t) => ({ x: xAt(t.value), label: t.label }))
        .filter((tk) => tk.x >= lo - 0.5 && tk.x <= hi + 0.5);
      return { xOf: (ci) => xAt(cv[ci]), ticks, numeric: true };
    }

    // Quantitative: value-proportional scale (honors xAxis.scale/min/max/tickFormat).
    const scale = createScaleFromSpec(spec.xAxis.scale, [xMin, xMax], range);
    const fmt = spec.xAxis.tickFormat;
    const ticks = scale
      .ticks(tickCount)
      .map((t) => ({ x: scale.scale(t), label: fmt ? formatTickValueWithFormat(t, fmt) : formatTickValue(t) }))
      .filter((tk) => tk.x >= lo - 0.5 && tk.x <= hi + 0.5);
    return { xOf: (ci) => scale.scale(cv[ci]), ticks, numeric: true };
  }

  const point = createPointScale(data.categories, range);
  // Auto-thinning: one tick per category overlaps into an unreadable smear
  // once categories outnumber the pixels — keep every Nth tick so the drawn
  // labels get room. Width is estimated (~6.5px/char at the 11px axis font,
  // capped) since no canvas context is available here; rotated labels only
  // need about a font-height of clearance along the axis.
  const n = data.categories.length;
  const pitch = n > 1 ? Math.abs(point.scaleIndex(1) - point.scaleIndex(0)) : hi - lo;
  const angle = spec.xAxis.labelAngle ?? 0;
  let desired: number;
  if (angle === 0) {
    let maxChars = 0;
    const sampleStep = Math.max(1, Math.floor(n / 50));
    for (let i = 0; i < n; i += sampleStep) {
      if (data.categories[i].length > maxChars) maxChars = data.categories[i].length;
    }
    desired = Math.min(maxChars * 6.5, 90) + 8;
  } else {
    desired = 16;
  }
  const skip = pitch > 0 && pitch < desired ? Math.ceil(desired / pitch) : 1;
  const ticks = data.categories
    .map((c, i) => ({ x: point.scaleIndex(i), label: c }))
    .filter((_, i) => i % skip === 0);
  return { xOf: (ci) => point.scaleIndex(ci), ticks, numeric: false };
}
