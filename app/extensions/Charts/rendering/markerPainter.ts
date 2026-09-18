//! FILENAME: app/extensions/Charts/rendering/markerPainter.ts
// PURPOSE: Paint a `marker` layer — a ring or an emphasis KEPT from an insight
//          overlay as a persisted annotation on one datum.
// CONTEXT: "Keep in chart" (docs/design/insight-overlays.md §4.6, §4.8a) turns
//          a transient cue into a layer in the spec, so it persists, exports
//          and travels with the file. The layer is anchored the way `text` is
//          — a series by NAME and a category index — and painted through the
//          same scales the built-in marks use (`createBandScale` for bars,
//          `createPointScale` for lines, `buildChromeYScale` for the value
//          axis), so it sits where the bar it marks sits. The older `rule`
//          and `text` painters divide the plot width by the category count
//          instead, which is why they drift a few pixels off the bars; this
//          painter does not inherit that.
//
//          A datum that no longer exists (the series was renamed, the index
//          is past the end) paints nothing. A kept marker that has gone stale
//          is a spec entry the user can see and delete in the editor; it is
//          not silently moved onto another bar.

import { DEFAULT_OVERLAY_STYLE } from "@api/insightStyle";
import type { ChartSpec, ChartLayout, LayerSpec, MarkerMarkOptions, ParsedChartData } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { buildChromeYScale } from "./chartPainterUtils";
import { pathRect } from "./cuePainter";
import { createBandScale, createPointScale } from "./scales";

const BAND_MARKS = new Set(["bar", "combo", "waterfall", "histogram", "boxPlot", "stock", "pareto"]);
const POINT_MARKS = new Set(["line", "area", "scatter", "bubble"]);
const BAR_PADDING = 0.3;
const RING_PAD = 4;
/** The neutral cue colour, for a kept mark whose layer declares none. */
const DEFAULT_MARKER_COLOR = DEFAULT_OVERLAY_STYLE.polarity.neutral.color;

/**
 * The pixel box a marker sits around, or null when the datum cannot be placed.
 *
 * `shape` is how the overlay would have drawn it: a bar is a rectangle and gets
 * a box, a line or scatter point is round and gets a circle. It travels with
 * the box so the kept mark matches the cue the reader kept.
 */
export function markerBox(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  opts: MarkerMarkOptions,
): { cx: number; cy: number; rx: number; ry: number; shape: "box" | "round" } | null {
  const si = data.series.findIndex((s) => s.name === opts.series);
  if (si < 0) return null;
  const value = data.series[si].values[opts.x];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const { plotArea } = layout;
  const yScale = buildChromeYScale(spec, data, [plotArea.y + plotArea.height, plotArea.y]);
  const cy = yScale.scale(value);
  const zero = yScale.scale(0);

  if (BAND_MARKS.has(spec.mark)) {
    const xScale = createBandScale(data.categories, [plotArea.x, plotArea.x + plotArea.width], BAR_PADDING);
    const n = data.series.length;
    const barWidth = Math.max((xScale.bandwidth - 2 * (n - 1)) / n, 2);
    const x0 = xScale.scaleIndex(opts.x) + si * (barWidth + 2);
    const top = Math.min(cy, zero);
    const bottom = Math.max(cy, zero);
    return { cx: x0 + barWidth / 2, cy: (top + bottom) / 2, rx: barWidth / 2 + RING_PAD, ry: (bottom - top) / 2 + RING_PAD, shape: "box" };
  }
  if (POINT_MARKS.has(spec.mark)) {
    const xScale = createPointScale(data.categories, [plotArea.x, plotArea.x + plotArea.width]);
    const r = 4 + RING_PAD + 2;
    return { cx: xScale.scaleIndex(opts.x), cy, rx: r, ry: r, shape: "round" };
  }
  return null;
}

export function paintMarkerMark(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  layer: LayerSpec,
  parentSpec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): void {
  const opts = layer.markOptions as MarkerMarkOptions | undefined;
  if (!opts || typeof opts.series !== "string" || typeof opts.x !== "number") return;
  const box = markerBox(data, parentSpec, layout, opts);
  if (!box) return;

  ctx.save();
  if (layer.opacity !== undefined) ctx.globalAlpha = layer.opacity;
  ctx.strokeStyle = opts.color ?? DEFAULT_MARKER_COLOR;
  ctx.lineWidth = opts.shape === "emphasis" ? 3 : 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  if (box.shape === "box") {
    pathRect(ctx, box.cx - box.rx, box.cy - box.ry, box.cx + box.rx, box.cy + box.ry);
  } else {
    ctx.ellipse(box.cx, box.cy, box.rx, box.ry, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
  if (opts.label) {
    ctx.fillStyle = opts.color ?? DEFAULT_MARKER_COLOR;
    ctx.font = "11px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(opts.label, box.cx, box.cy - box.ry - 4);
  }
  ctx.restore();
}
