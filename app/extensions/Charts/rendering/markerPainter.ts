//! FILENAME: app/extensions/Charts/rendering/markerPainter.ts
// PURPOSE: Two things, both about the small shapes drawn ON a datum:
//          (1) the `marker` LAYER — a ring or an emphasis KEPT from an insight
//              overlay as a persisted annotation on one datum;
//          (2) the shared DATUM MARKER primitive — the one place that turns a
//              resolved per-point style (markerStyle / markerSize / markerFill /
//              markerBorderColor / markerBorderWidth, see
//              lib/dataPointOverrides.ts `resolveDatumStyle`) into canvas calls
//              for line, area, scatter, radar and bubble. Those five painters
//              all drew hard-coded circles before; formatting a SINGLE point on
//              a line or scatter chart is exactly what Excel's Format Data Point
//              does, so the shape table lives here once instead of five times.
//          It also holds the axis-element rect write-backs those five painters
//          need, because each one draws its own axis titles inline rather than
//          going through `drawCartesianAxes` (which keeps its equivalents
//          private). A drift test pins the two against each other — see
//          __tests__/points-elementRects.test.ts.
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
import type {
  ChartSpec,
  ChartLayout,
  LayerSpec,
  MarkerMarkOptions,
  MarkerStyle,
  ParsedChartData,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { buildChromeYScale, recordChartElementRect } from "./chartPainterUtils";
import { pathRect } from "./cuePainter";
import { createBandScale, createPointScale } from "./scales";

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

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

// ============================================================================
// Shared datum marker — the per-point shape on a line/area/scatter/radar point
// ============================================================================

/** The inner disc that gives a line/area marker its hollow look. */
const HOLLOW_CORE_COLOR = "#ffffff";
/** Inner disc radius as a fraction of the marker radius. */
const HOLLOW_CORE_RATIO = 0.5;
/** Stroke width a stroke-only marker ("cross") uses when none is given. */
const DEFAULT_CROSS_WIDTH = 2;
/** Inner radius of the 5-point "star" marker, as a fraction of its size. */
const STAR_INNER_RATIO = 0.5;

/** Everything {@link paintDatumMarker} needs, already decided by the caller. */
export interface DatumMarkerPaint {
  /** Shape to draw. `"none"` paints nothing at all — that is the point of it. */
  shape: MarkerStyle;
  /** Radius (circle/star) or half-extent (square/diamond/triangle/cross), px. */
  size: number;
  /** Fill color for the fillable shapes; the stroke color for `"cross"`. */
  fill: string;
  /** Border color. Any border setting makes the marker stroke its own outline. */
  borderColor?: string | null;
  /** Border width in px. */
  borderWidth?: number | null;
  /** Alpha for this one marker; `null`/omitted leaves `globalAlpha` alone. */
  opacity?: number | null;
  /**
   * Paint a white inner disc at half the radius — the hollow look the line and
   * area painters have always had. Applies to `"circle"` only: a white disc
   * inside a diamond or a triangle is not a hollow marker, it is a blob.
   */
  hollow?: boolean;
}

/**
 * Trace ONE marker shape into the current path. Exported for the hit-testing
 * and preview code that wants the same geometry without the paint.
 *
 * An unknown shape falls through to a circle, matching the `default:` arm the
 * scatter painter has always had for an unrecognised `pointShape`.
 */
export function traceMarkerPath(ctx: AnyCtx, shape: MarkerStyle, x: number, y: number, size: number): void {
  switch (shape) {
    case "square":
      ctx.rect(x - size, y - size, size * 2, size * 2);
      break;
    case "diamond":
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
      ctx.closePath();
      break;
    case "triangle":
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y + size);
      ctx.lineTo(x - size, y + size);
      ctx.closePath();
      break;
    case "star": {
      // Five-point star: alternate outer and inner vertices, starting at the
      // top so it reads upright at any size.
      const inner = size * STAR_INNER_RATIO;
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? size : inner;
        const angle = -Math.PI / 2 + (Math.PI / 5) * i;
        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case "cross":
      ctx.moveTo(x - size, y - size);
      ctx.lineTo(x + size, y + size);
      ctx.moveTo(x + size, y - size);
      ctx.lineTo(x - size, y + size);
      break;
    default: // "circle", and anything unrecognised
      ctx.arc(x, y, size, 0, Math.PI * 2);
      break;
  }
}

/**
 * Paint one datum's marker. This is the ONLY place the five point-based
 * painters turn a resolved per-point style into canvas calls, so "change the
 * colour of only this point" behaves the same on a line, an area, a scatter, a
 * radar and a bubble.
 *
 * With no per-point override in play the caller passes its own series defaults
 * and the emitted call stream is the one those painters emitted before this
 * existed (fill, path, fill, then the hollow core) — there is a test for that.
 */
export function paintDatumMarker(ctx: AnyCtx, x: number, y: number, m: DatumMarkerPaint): void {
  if (m.shape === "none") return;
  if (!(m.size > 0)) return;

  const alpha = m.opacity;
  if (alpha != null) ctx.globalAlpha = alpha;

  if (m.shape === "cross") {
    // Stroke-only: there is no interior to fill, so the datum's colour becomes
    // the ink unless a border colour says otherwise.
    strokeOutline(ctx, m.borderColor ?? m.fill, m.borderWidth ?? DEFAULT_CROSS_WIDTH, () => {
      ctx.beginPath();
      traceMarkerPath(ctx, "cross", x, y, m.size);
      ctx.stroke();
    });
  } else {
    ctx.fillStyle = m.fill;
    ctx.beginPath();
    traceMarkerPath(ctx, m.shape, x, y, m.size);
    ctx.fill();

    if (m.borderColor != null || m.borderWidth != null) {
      // Same path, so no beginPath here — just outline what was filled.
      strokeOutline(ctx, m.borderColor ?? m.fill, m.borderWidth ?? 1, () => ctx.stroke());
    }

    if (m.hollow && m.shape === "circle") {
      ctx.fillStyle = HOLLOW_CORE_COLOR;
      ctx.beginPath();
      ctx.arc(x, y, m.size * HOLLOW_CORE_RATIO, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (alpha != null) ctx.globalAlpha = 1;
}

/**
 * Stroke with a given colour and width and PUT THE CONTEXT BACK.
 *
 * One bordered datum must not change how the next thing painted looks: these
 * painters loop over hundreds of points inside one `ctx.save()`, and several of
 * them (the radar polygons, the line strokes, the drop lines) rely on the
 * ambient `strokeStyle`/`lineWidth` between datums. Leaking one point's border
 * width onto the rest of the chart is exactly the "format ONE point" defect in
 * reverse — a test in points-perPointOverrides.test.ts caught it.
 */
function strokeOutline(ctx: AnyCtx, color: string, width: number, stroke: () => void): void {
  const prevStyle = ctx.strokeStyle;
  const prevWidth = ctx.lineWidth;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  stroke();
  ctx.strokeStyle = prevStyle;
  ctx.lineWidth = prevWidth;
}

// ============================================================================
// Axis element rects for the painters that draw their own axes
// ============================================================================

/**
 * The x coordinate a rotated y-axis title is translated to. The same 14px
 * `chartPainterUtils` uses; `points-elementRects.test.ts` diffs the rects these
 * helpers produce against the ones `drawCartesianAxes` writes back, so the two
 * cannot quietly disagree about where an axis title is.
 */
export const Y_AXIS_TITLE_X = 14;
/** Gap between the widest y tick label's right edge and the axis line. */
const Y_LABEL_GUTTER = 6;
/** Distance from the plot's bottom edge to the x-axis title baseline. */
const X_TITLE_DROP_WITH_LABELS = 30;
const X_TITLE_DROP_BARE = 16;

interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The baseline the x-axis title is painted on. A "bottom" baseline, so the
 * title's box ENDS here.
 */
export function xAxisTitleBaselineY(plotArea: PlotRect, showLabels: boolean): number {
  return plotArea.y + plotArea.height + (showLabels ? X_TITLE_DROP_WITH_LABELS : X_TITLE_DROP_BARE);
}

/**
 * Write back the x-axis title's MEASURED box. `titleWidth` must have been
 * measured with the axis-title font still active — measuring after a
 * `ctx.restore()` puts the previous font back and makes the rect fiction.
 */
export function recordXAxisTitleRect(
  layout: ChartLayout,
  plotArea: PlotRect,
  titleWidth: number,
  baselineY: number,
  axisTitleFontSize: number,
): void {
  recordChartElementRect(layout, "xAxisTitle", {
    x: plotArea.x + plotArea.width / 2 - titleWidth / 2,
    y: baselineY - axisTitleFontSize,
    width: titleWidth,
    height: axisTitleFontSize,
  });
}

/**
 * Write back the y-axis title's MEASURED box. Painted rotated -90deg about
 * ({@link Y_AXIS_TITLE_X}, the plot's vertical centre) with a "top" baseline, so
 * the glyph run is a TALL box one font-size wide and `titleWidth` tall.
 */
export function recordYAxisTitleRect(
  layout: ChartLayout,
  plotArea: PlotRect,
  titleWidth: number,
  axisTitleFontSize: number,
): void {
  recordChartElementRect(layout, "yAxisTitle", {
    x: Y_AXIS_TITLE_X,
    y: plotArea.y + plotArea.height / 2 - titleWidth / 2,
    width: axisTitleFontSize,
    height: titleWidth,
  });
}

/**
 * Write back the MEASURED y tick-label band. Labels are right-aligned at
 * `plotArea.x - 6`, so the band runs from the widest label's left edge to the
 * axis line.
 */
export function recordYLabelBandRect(
  layout: ChartLayout,
  plotArea: PlotRect,
  widestLabelWidth: number,
): void {
  const bandWidth = widestLabelWidth + Y_LABEL_GUTTER;
  recordChartElementRect(layout, "yAxisBand", {
    x: plotArea.x - bandWidth,
    y: plotArea.y,
    width: bandWidth,
    height: plotArea.height,
  });
}
