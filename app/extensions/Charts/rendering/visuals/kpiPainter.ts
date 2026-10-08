//! FILENAME: app/extensions/Charts/rendering/visuals/kpiPainter.ts
// PURPOSE: The KPI visual (Power BI's KPI): the indicator for the LATEST
//          trend-axis period in large type, a status icon, a trend area behind
//          it, and the goal with the distance to it.
// CONTEXT: Funnel-template painter, registered from chartDispatch.
//
//          DATA (Power BI's three wells): categories are the TREND AXIS, which
//          must already be sorted ascending (Power BI's KPI has no sort either);
//          series 0 is the INDICATOR; series 1, when there is one, is the GOAL
//          per period. `markOptions.goal` stands in when the data has no goal
//          series. The visual reads the LAST period.
//
//          STATUS. Good when the indicator is on the right side of the goal for
//          `direction` (higher is better by default, lower is better flips it),
//          bad on the wrong side, neutral when there is no goal. The status
//          colours the trend area and the distance; the indicator itself stays
//          the theme's text colour with a status badge beside it, as Power BI
//          draws it (a check when good, "!" when bad).
//
//          COLOUR IS STATUS, NOT SERIES: a KPI paints no series colour, so it is
//          listed in SERIES_COLOUR_BLIND_MARKS and the Format pane says so.
//
//          PER-POINT FORMATTING reaches the trend: an overridden period gets a
//          marker in its colour on the trend line (the trend has no markers
//          otherwise — the area/marker rule `markerReachesDatum` uses), and an
//          override on the LATEST period also colours the indicator.

import type { ChartSpec, ParsedChartData, ChartLayout, PointMarker, KpiMarkOptions, KpiDirection } from "../../types";
import type { ChartRenderTheme } from "../chartTheme";
import { resolveDatumStyle } from "../../lib/dataPointOverrides";
import { truncateText } from "../chartPainterUtils";
import { BLANK_TEXT, datumText, datumValue, formatVisualNumber, formatVisualValue } from "./visualValues";
import { computeVisualLayout, drawVisualFrame, fitFontSize } from "./visualLayout";

/** Status colours. Categorical colour DATA, so it lives here and not in chrome. */
export const KPI_DEFAULT_COLORS = Object.freeze({
  good: "#2E9E4F",
  bad: "#D13438",
  neutral: "#8A8886",
});

export type KpiStatus = "good" | "bad" | "neutral";

/** Good / bad / neutral for an indicator against a goal (see the module header). */
export function kpiStatus(value: number | null, goal: number | null, direction: KpiDirection): KpiStatus {
  if (value === null || goal === null || !Number.isFinite(value) || !Number.isFinite(goal)) return "neutral";
  const diff = value - goal;
  if (direction === "lowerIsBetter") return diff <= 0 ? "good" : "bad";
  return diff >= 0 ? "good" : "bad";
}

export function computeKpiLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  return computeVisualLayout(width, height, spec, data, theme);
}

/** The KPI's reading of the data: latest indicator, its goal, the status. */
interface KpiReading {
  latest: number;
  value: number | null;
  goal: number | null;
  status: KpiStatus;
}

function readKpi(data: ParsedChartData, opts: KpiMarkOptions): KpiReading {
  const values = data.series[0]?.values ?? [];
  const latest = values.length - 1;
  // A BLANK latest actual (a month that has a goal but no figures yet) is no
  // value -- neutral, "(Blank)" -- never a 0 that is 100% off its goal.
  const value = latest >= 0 ? datumValue(data, 0, latest).value : null;
  let goal: number | null = null;
  if (data.series.length > 1 && latest >= 0) goal = datumValue(data, 1, latest).value;
  if (goal === null && typeof opts.goal === "number" && Number.isFinite(opts.goal)) goal = opts.goal;
  return { latest, value, goal, status: kpiStatus(value, goal, opts.direction ?? "higherIsBetter") };
}

/** Where the trend sits: the lower part of the plot, under the indicator. */
function trendBand(layout: ChartLayout): { x: number; y: number; width: number; height: number } {
  const { plotArea } = layout;
  const h = plotArea.height * 0.42;
  return { x: plotArea.x, y: plotArea.y + plotArea.height - h, width: plotArea.width, height: h };
}

/** One point per period on the trend (empty when there is no indicator). */
function trendPoints(data: ParsedChartData, layout: ChartLayout): Array<{ x: number; y: number }> {
  const values = data.series[0]?.values ?? [];
  const n = values.length;
  if (n === 0) return [];
  const band = trendBand(layout);
  const finite = values.filter((v) => Number.isFinite(v));
  const lo = finite.length ? Math.min(...finite) : 0;
  const hi = finite.length ? Math.max(...finite) : 1;
  const span = hi - lo || 1;
  return values.map((v, i) => ({
    x: n === 1 ? band.x + band.width / 2 : band.x + (i / (n - 1)) * band.width,
    // A little head-room so the highest point is not on the band's edge.
    y: band.y + band.height - ((Number.isFinite(v) ? v - lo : 0) / span) * band.height * 0.85,
  }));
}

/** "+10%" / "-25%": distance to goal as a share of the goal, two decimals at most. */
function distanceText(value: number, goal: number): string {
  if (goal === 0) return "";
  const pct = ((value - goal) / Math.abs(goal)) * 100;
  const body = Math.abs(pct).toFixed(2).replace(/\.?0+$/, "");
  return `${pct >= 0 ? "+" : "-"}${body}%`;
}

export function paintKpiChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const opts = (spec.markOptions ?? {}) as KpiMarkOptions;
  const { plotArea } = layout;
  const colors = {
    good: opts.goodColor ?? KPI_DEFAULT_COLORS.good,
    bad: opts.badColor ?? KPI_DEFAULT_COLORS.bad,
    neutral: opts.neutralColor ?? KPI_DEFAULT_COLORS.neutral,
  };
  const reading = readKpi(data, opts);
  const statusColor = colors[reading.status];

  drawVisualFrame(ctx, spec, layout, theme);

  // 1. The trend area, behind everything else.
  const points = trendPoints(data, layout);
  if (opts.showTrend !== false && points.length > 0) {
    const band = trendBand(layout);
    const base = band.y + band.height;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = statusColor;
    ctx.beginPath();
    ctx.moveTo(points[0].x, base);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.lineTo(points[points.length - 1].x, base);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = statusColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  // 2. Per-point formatting: a marker on every period an override reached.
  for (let ci = 0; ci < points.length; ci++) {
    const st = resolveDatumStyle(spec, data, 0, ci, { fill: statusColor });
    if (st.matchedBy === "none" || st.markerStyle === "none") continue;
    const r = st.markerSize ?? 4;
    if (st.opacity != null) {
      ctx.save();
      ctx.globalAlpha = st.opacity;
    }
    ctx.fillStyle = st.markerFill ?? st.fill;
    ctx.beginPath();
    ctx.arc(points[ci].x, points[ci].y, r, 0, Math.PI * 2);
    ctx.fill();
    if (st.opacity != null) ctx.restore();
  }

  // 3. The indicator (latest period), large, with the status badge beside it.
  const latestStyle = reading.latest >= 0
    ? resolveDatumStyle(spec, data, 0, reading.latest, { fill: theme.titleColor })
    : null;
  const valueText = reading.latest >= 0
    ? formatVisualValue(datumValue(data, 0, reading.latest), opts)
    : BLANK_TEXT;
  const top = plotArea.y + 4;
  const valueAreaH = plotArea.height - trendBand(layout).height - 8;
  const valuePx = fitFontSize(
    ctx,
    valueText,
    plotArea.width - 48,
    Math.max(24, Math.min(44, valueAreaH * 0.5)),
    12,
    "600",
    theme.fontFamily,
  );
  const cx = plotArea.x + plotArea.width / 2;
  const valueY = top + valuePx / 2;
  ctx.fillStyle = latestStyle?.fill || theme.titleColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(valueText, cx, valueY);

  if (reading.status !== "neutral") {
    const halfW = ctx.measureText(valueText).width / 2;
    drawStatusBadge(ctx, reading.status, cx + halfW + 14, valueY, Math.max(6, valuePx * 0.22), statusColor);
  }

  // 4. "Goal: 10K (+10%)" under the indicator.
  if (opts.showGoal !== false && reading.goal !== null) {
    // Written in the measure's format, as Power BI writes the goal: the goal's
    // own text, else the indicator's as an exemplar ("$12K" beside "$10K").
    const goalOwn = data.series.length > 1 ? datumText(data, 1, reading.latest) : null;
    const goalText = formatVisualNumber(reading.goal, {
      ...opts,
      sourceText: goalOwn,
      formatSource: datumText(data, 0, reading.latest),
    });
    const distance = opts.showDistance !== false && reading.value !== null ? distanceText(reading.value, reading.goal) : "";
    const line = distance ? `Goal: ${goalText} (${distance})` : `Goal: ${goalText}`;
    ctx.fillStyle = reading.status === "neutral" ? theme.axisLabelColor : statusColor;
    ctx.font = `${theme.labelFontSize + 1}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(truncateText(ctx, line, plotArea.width - 8), cx, top + valuePx + 6);
  }
}

/** Power BI's status icon: a filled disc with a check (good) or "!" (bad). */
function drawStatusBadge(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  status: KpiStatus,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1.5, r * 0.25);
  ctx.beginPath();
  if (status === "good") {
    ctx.moveTo(x - r * 0.45, y);
    ctx.lineTo(x - r * 0.1, y + r * 0.35);
    ctx.lineTo(x + r * 0.5, y - r * 0.35);
  } else {
    ctx.moveTo(x, y - r * 0.5);
    ctx.lineTo(x, y + r * 0.1);
    ctx.moveTo(x, y + r * 0.35);
    ctx.lineTo(x, y + r * 0.45);
  }
  ctx.stroke();
  ctx.restore();
}

export function computeKpiPointMarkers(
  data: ParsedChartData,
  _spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): PointMarker[] {
  const series = data.series[0];
  if (!series) return [];
  return trendPoints(data, layout).map((p, ci) => ({
    seriesIndex: 0,
    categoryIndex: ci,
    cx: p.x,
    cy: p.y,
    radius: 4,
    value: series.values[ci] ?? 0,
    seriesName: series.name,
    categoryName: data.categories[ci] ?? "",
  }));
}
