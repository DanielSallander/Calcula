//! FILENAME: app/extensions/Charts/rendering/chartPainterUtils.ts
// PURPOSE: Shared drawing utilities used by all chart painters.
// CONTEXT: Extracted from barChartPainter to avoid duplication across chart types.
//          Includes title, legend, axis, grid line, and geometry helpers.

import type { ChartSpec, ParsedChartData, ChartLayout } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import type { LinearScale, BandScale } from "./scales";

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
      color: getSeriesColor(spec.palette, i, s.color),
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

    for (let ci = 0; ci < xScale.domain.length; ci++) {
      const category = xScale.domain[ci];
      const x = xScale.scaleIndex(ci) + xScale.bandwidth / 2;
      const y = xAxisY + 4;

      ctx.save();
      if (angle === 0) {
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const maxWidth = xScale.bandwidth - 4;
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

function getDisplayUnitFactor(unit: import("../types").DisplayUnit | undefined): number {
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

function getDisplayUnitLabel(unit: import("../types").DisplayUnit): string {
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

function formatTickValueWithFormat(value: number, format: string): string {
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

    for (let ci = 0; ci < yScale.domain.length; ci++) {
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
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, layout.width, layout.height);
}

export function drawPlotBackground(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  plotArea: { x: number; y: number; width: number; height: number },
  theme: ChartRenderTheme,
): void {
  ctx.fillStyle = theme.plotBackground;
  ctx.fillRect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
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

export function formatTickValue(value: number): string {
  if (Math.abs(value) >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
  if (Math.abs(value) >= 1_000) return (value / 1_000).toFixed(1) + "K";
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(1);
}
