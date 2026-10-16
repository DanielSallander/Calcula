//! FILENAME: app/extensions/Charts/rendering/visuals/gaugePainter.ts
// PURPOSE: The Gauge visual (Power BI's radial gauge): a 180-degree arc, the
//          part from the minimum to the value shaded, a needle at the TARGET,
//          the value in the middle, the minimum and maximum at the ends.
// CONTEXT: Funnel-template painter, registered from chartDispatch.
//
//          DATA (Power BI's four wells). The VALUE is series 0, made one number
//          by `markOptions.aggregate` (as a Card does). Minimum, maximum and
//          target each come from a fixed option first, then from a series
//          (target: series 1 by default when there are two or more), then from
//          Power BI's defaults: minimum 0 and maximum DOUBLE the value, so the
//          value sits half way. See {@link resolveGaugeScale}.
//
//          ITS DATUM is (0, 0), "the gauge's value", for per-point formatting
//          and the hit rect (the arc's bounding box).
//
//          COLOUR. The track is a soft grey, the progress takes the value
//          series' colour (palette colour 0 by default — the one accent), the
//          needle is the theme's strong text colour. The one-accent rule of the
//          icon set (ICONS.md) is followed by the visual too.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, GaugeMarkOptions } from "../../types";
import type { ChartRenderTheme } from "../chartTheme";
import { getSeriesColor } from "../chartTheme";
import { resolveDatumStyle } from "../../lib/dataPointOverrides";
import { aggregateSeries, formatVisualNumber, formatVisualValue, visualFormatFor } from "./visualValues";
import { computeVisualLayout, drawVisualFrame, fitFontSize } from "./visualLayout";

/** The unfilled track. Categorical colour data, so it lives in this module. */
export const GAUGE_TRACK_COLOR = "#E1E1E1";

/** Thickness of the arc as a share of its radius. */
const THICKNESS = 0.32;

export function computeGaugeLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  return computeVisualLayout(width, height, spec, data, theme);
}

/**
 * Minimum, maximum and target for a value: fixed options win, then the series
 * that feed them, then Power BI's defaults (min 0, max twice the value; a zero
 * value gets 0..1, a negative one swings below zero: min twice the value, max
 * 0). A DEFAULT end is also widened to take the target in (to 1.1x the target):
 * the needle is clamped to the arc, so a target past a default maximum was
 * drawn pinned at the end while its label read the real number. A fixed end
 * (an option or a series) is the author's and is never moved. A degenerate
 * range (max not above min) is widened by one so the arc always has a
 * direction.
 */
export function resolveGaugeScale(
  value: number,
  opts: Pick<GaugeMarkOptions, "min" | "max" | "target">,
  minSeries: number | null,
  maxSeries: number | null,
  targetSeries: number | null,
): { min: number; max: number; target: number | null } {
  const fin = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  const target = fin(opts.target) ? opts.target : fin(targetSeries) ? targetSeries : null;
  const fixedMin = fin(opts.min) || fin(minSeries);
  const fixedMax = fin(opts.max) || fin(maxSeries);
  let min = fin(opts.min) ? opts.min : fin(minSeries) ? minSeries : value < 0 ? 2 * value : 0;
  let max = fin(opts.max) ? opts.max : fin(maxSeries) ? maxSeries : value > 0 ? 2 * value : value < 0 ? 0 : min + 1;
  if (target !== null) {
    if (!fixedMax && target > max) max = target > 0 ? target * 1.1 : target + Math.abs(target) * 0.1;
    if (!fixedMin && target < min) min = target < 0 ? target * 1.1 : target - Math.abs(target) * 0.1;
  }
  if (!(max > min)) {
    if (fixedMax) min = max - 1;
    else max = min + 1;
  }
  return { min, max, target };
}

/** The value of series `index` (one number), or null when there is no such series. */
function seriesNumber(data: ParsedChartData, index: number | undefined, opts: GaugeMarkOptions): number | null {
  if (index === undefined || index < 0 || index >= data.series.length) return null;
  return aggregateSeries(data, index, opts.aggregate ?? "auto").value;
}

interface GaugeGeometry {
  cx: number;
  cy: number;
  outer: number;
  inner: number;
}

/** Centre and radii: the half-disc fits the plot with room for the end labels. */
function gaugeGeometry(layout: ChartLayout, theme: ChartRenderTheme): GaugeGeometry {
  const { plotArea } = layout;
  const labelRoom = theme.labelFontSize + 8;
  const outer = Math.max(8, Math.min(plotArea.width / 2 - 8, plotArea.height - labelRoom - 8));
  const cx = plotArea.x + plotArea.width / 2;
  const cy = plotArea.y + (plotArea.height - labelRoom + outer) / 2;
  return { cx, cy, outer, inner: outer * (1 - THICKNESS) };
}

/** Angle on the half circle for a value: PI at the minimum, 2 PI at the maximum. */
function angleOf(v: number, min: number, max: number): number {
  const t = Math.min(1, Math.max(0, (v - min) / (max - min)));
  return Math.PI + t * Math.PI;
}

/** A ring segment from angle a0 to a1 (outer edge forward, inner edge back). */
function ringPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  g: GaugeGeometry,
  a0: number,
  a1: number,
): void {
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.outer, a0, a1);
  ctx.arc(g.cx, g.cy, g.inner, a1, a0, true);
  ctx.closePath();
}

export function paintGaugeChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const opts = (spec.markOptions ?? {}) as GaugeMarkOptions;
  drawVisualFrame(ctx, spec, layout, theme);
  if (data.series.length === 0) return;

  const shown = aggregateSeries(data, 0, opts.aggregate ?? "auto");
  const value = shown.value ?? 0;
  const targetIndex = opts.targetSeriesIndex ?? (data.series.length >= 2 ? 1 : -1);
  const scale = resolveGaugeScale(
    value,
    opts,
    seriesNumber(data, opts.minSeriesIndex, opts),
    seriesNumber(data, opts.maxSeriesIndex, opts),
    seriesNumber(data, targetIndex, opts),
  );
  const g = gaugeGeometry(layout, theme);

  // 1. Track.
  ctx.fillStyle = opts.trackColor ?? GAUGE_TRACK_COLOR;
  ringPath(ctx, g, Math.PI, 2 * Math.PI);
  ctx.fill();

  // 2. Progress, minimum -> value, in the value's colour.
  const style = resolveDatumStyle(spec, data, 0, 0, {
    fill: getSeriesColor(spec.palette, 0, data.series[0].color),
  });
  const end = angleOf(value, scale.min, scale.max);
  if (end > Math.PI) {
    if (style.opacity != null) {
      ctx.save();
      ctx.globalAlpha = style.opacity;
    }
    ctx.fillStyle = style.fill;
    ringPath(ctx, g, Math.PI, end);
    ctx.fill();
    if (style.borderColor != null && (style.borderWidth ?? 1) > 0) {
      ctx.strokeStyle = style.borderColor;
      ctx.lineWidth = style.borderWidth ?? 1;
      ctx.stroke();
    }
    if (style.opacity != null) ctx.restore();
  }

  // 3. Target needle: a line ACROSS the track at the target's angle.
  const fmt = visualFormatFor(spec, opts, data.series[0]?.name);
  // The target, minimum and maximum are written in the VALUE's format (its
  // currency, its percent sign), as Power BI writes them.
  const scaleFmt = { ...fmt, formatSource: shown.text ?? shown.formatSource ?? null };
  if (scale.target !== null) {
    const a = angleOf(scale.target, scale.min, scale.max);
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    ctx.strokeStyle = opts.targetColor ?? theme.titleColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(g.cx + ux * (g.inner - 6), g.cy + uy * (g.inner - 6));
    ctx.lineTo(g.cx + ux * (g.outer + 6), g.cy + uy * (g.outer + 6));
    ctx.stroke();
    if (opts.showTargetLabel !== false) {
      ctx.fillStyle = theme.axisLabelColor;
      ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
      ctx.textAlign = ux >= 0 ? "left" : "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(formatVisualNumber(scale.target, scaleFmt), g.cx + ux * (g.outer + 10), g.cy + uy * (g.outer + 10));
    }
  }

  // 4. The callout, in the bowl of the arc.
  const callout = formatVisualValue(shown, fmt);
  // fitFontSize leaves ctx.font at the size that fits the bowl.
  fitFontSize(ctx, callout, g.inner * 1.6, Math.max(12, Math.min(40, g.inner * 0.45)), 10, "600", theme.fontFamily);
  ctx.fillStyle = theme.titleColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(callout, g.cx, g.cy - 2);

  // 5. Minimum and maximum at the ends.
  if (opts.showMinMax !== false) {
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    ctx.fillText(formatVisualNumber(scale.min, scaleFmt), g.cx - (g.outer + g.inner) / 2, g.cy + 4);
    ctx.fillText(formatVisualNumber(scale.max, scaleFmt), g.cx + (g.outer + g.inner) / 2, g.cy + 4);
  }
}

export function computeGaugeBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): BarRect[] {
  if (data.series.length === 0) return [];
  const opts = (spec.markOptions ?? {}) as GaugeMarkOptions;
  const g = gaugeGeometry(layout, theme);
  const shown = aggregateSeries(data, 0, opts.aggregate ?? "auto");
  return [{
    seriesIndex: 0,
    categoryIndex: 0,
    x: g.cx - g.outer,
    y: g.cy - g.outer,
    width: g.outer * 2,
    height: g.outer,
    value: shown.value ?? 0,
    seriesName: data.series[0].name,
    categoryName: data.categories[0] ?? data.series[0].name,
  }];
}
