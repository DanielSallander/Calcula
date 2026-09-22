//! FILENAME: app/extensions/Charts/rendering/errorBarPainter.ts
// PURPOSE: Renders error bars on bar, line, and scatter charts.
// CONTEXT: Called after the main series is painted. Draws vertical (or horizontal
//          for horizontal bar charts) error bar lines with T-shaped caps.

import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  ChartElementRect,
  HitGeometry,
  ErrorBarOptions,
  BarMarkOptions,
  LineMarkOptions,
  ScatterMarkOptions,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { recordErrorBarRects } from "./chartPainterUtils";

// ============================================================================
// Public API
// ============================================================================

/**
 * Paint error bars for the given chart.
 * Requires pre-computed hit geometry to locate data point positions.
 *
 * SELECTABILITY: every drawn bar's tight box (stem plus caps) is recorded onto
 * `layout.elements.errorBars` together with the SERIES it belongs to. Excel's
 * error bars are a per-series object with no per-point member — you cannot
 * select the error bar on March alone — so many rects share one identity and
 * the hit answers the series with no point index. That asymmetry is deliberate
 * and is the reason this records a flat list rather than a per-point map.
 */
export function paintErrorBars(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
  geometry: HitGeometry,
): void {
  const errorBarOpts = getErrorBarOptions(spec);
  if (!errorBarOpts || !errorBarOpts.enabled) return;

  const recorded: Array<{ seriesIndex: number; rect: ChartElementRect }> = [];
  const color = errorBarOpts.color ?? "#333333";
  const lineWidth = errorBarOpts.lineWidth ?? 1.5;
  const capWidth = 6; // half-width of T-cap in pixels

  // WHICH SERIES GET BARS AT ALL. Absent / null is every series, which is what
  // every spec written before `seriesFilter` existed means, so an old chart is
  // unchanged. A filter that lists nothing draws nothing — an EMPTY array is a
  // deliberate "none left", reached by removing the last series' bars, and
  // collapsing it back to "all" would make the last Delete undo the previous
  // ones.
  const showsSeries = (seriesIndex: number): boolean =>
    errorBarOpts.seriesFilter == null || errorBarOpts.seriesFilter.includes(seriesIndex);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.setLineDash([]);

  // Clip to plot area
  const { plotArea } = layout;
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  if (geometry.type === "bars") {
    const isHorizontal = spec.mark === "horizontalBar";
    for (const rect of geometry.rects) {
      if (!showsSeries(rect.seriesIndex)) continue;
      const seriesValues = data.series[rect.seriesIndex]?.values;
      if (!seriesValues) continue;

      const { plus, minus } = computeErrorExtent(
        rect.value,
        seriesValues,
        errorBarOpts,
      );

      if (isHorizontal) {
        // Horizontal bar: error bars extend left/right
        const cy = rect.y + rect.height / 2;
        // For horizontal bars, the bar extends from an origin to rect.x + rect.width
        // The data point is at the end of the bar
        const dataX = rect.value >= 0
          ? rect.x + rect.width
          : rect.x;

        // We need pixel-per-unit. Approximate from bar geometry.
        const pxPerUnit = rect.width / Math.abs(rect.value || 1);

        const plusPx = plus * pxPerUnit;
        const minusPx = minus * pxPerUnit;

        const xPlus = dataX + (rect.value >= 0 ? plusPx : -plusPx);
        const xMinus = dataX - (rect.value >= 0 ? minusPx : -minusPx);

        drawHorizontalErrorBar(ctx, cy, xMinus, xPlus, capWidth, errorBarOpts.direction);
        recorded.push({
          seriesIndex: rect.seriesIndex,
          rect: horizontalErrorBarBounds(cy, xMinus, xPlus, capWidth),
        });
      } else {
        // Vertical bar: error bars extend up/down from the top of the bar
        const cx = rect.x + rect.width / 2;
        // For positive values, top of bar is rect.y; for negative, bottom is rect.y + rect.height
        const dataY = rect.value >= 0 ? rect.y : rect.y + rect.height;

        // Approximate pixel-per-unit from bar height
        const pxPerUnit = rect.height / Math.abs(rect.value || 1);

        const plusPx = plus * pxPerUnit;
        const minusPx = minus * pxPerUnit;

        // Y axis is inverted: up = smaller Y
        const yPlus = dataY - plusPx;
        const yMinus = dataY + minusPx;

        drawVerticalErrorBar(ctx, cx, yMinus, yPlus, capWidth, errorBarOpts.direction);
        recorded.push({
          seriesIndex: rect.seriesIndex,
          rect: verticalErrorBarBounds(cx, yMinus, yPlus, capWidth),
        });
      }
    }
  } else if (geometry.type === "points") {
    for (const marker of geometry.markers) {
      if (!showsSeries(marker.seriesIndex)) continue;
      const seriesValues = data.series[marker.seriesIndex]?.values;
      if (!seriesValues) continue;

      const { plus, minus } = computeErrorExtent(
        marker.value,
        seriesValues,
        errorBarOpts,
      );

      // For point-based charts, we need to compute pixel extent.
      // Estimate from plot area height and data range.
      const allValues = data.series.flatMap((s) => s.values);
      const dataMin = Math.min(...allValues, 0);
      const dataMax = Math.max(...allValues, 0);
      const dataRange = dataMax - dataMin || 1;
      const pxPerUnit = plotArea.height / dataRange;

      const yPlus = marker.cy - plus * pxPerUnit;
      const yMinus = marker.cy + minus * pxPerUnit;

      drawVerticalErrorBar(ctx, marker.cx, yMinus, yPlus, capWidth, errorBarOpts.direction);
      recorded.push({
        seriesIndex: marker.seriesIndex,
        rect: verticalErrorBarBounds(marker.cx, yMinus, yPlus, capWidth),
      });
    }
  }

  ctx.restore();

  // One write-back with the complete list, after every bar is drawn — CLIPPED
  // to the plot area, because the paint above was.
  //
  // A +25% bar on a value of 60 against an auto scale whose maximum IS 60 has
  // its cap at 75, which is ABOVE the plot: the canvas clip swallowed the part
  // that does not fit, but the recorded rect kept a NEGATIVE y. A click aimed at
  // that rect lands above the chart's own rectangle, which is a click on the
  // GRID — so it deselects the chart, and the error bars read as "not
  // selectable". A rect that survives no clipping at all describes nothing the
  // reader can see, so it is dropped rather than recorded.
  recordErrorBarRects(layout, clipRectsToPlot(recorded, plotArea));
}

/**
 * Intersect each recorded rect with the plot area, dropping the ones that fall
 * outside it entirely. `recordErrorBarRects` then records only boxes that have
 * painted pixels in them.
 */
function clipRectsToPlot(
  recorded: Array<{ seriesIndex: number; rect: ChartElementRect }>,
  plotArea: { x: number; y: number; width: number; height: number },
): Array<{ seriesIndex: number; rect: ChartElementRect }> {
  const out: Array<{ seriesIndex: number; rect: ChartElementRect }> = [];
  const left = plotArea.x;
  const top = plotArea.y;
  const right = plotArea.x + plotArea.width;
  const bottom = plotArea.y + plotArea.height;
  for (const { seriesIndex, rect } of recorded) {
    const x0 = Math.max(rect.x, left);
    const y0 = Math.max(rect.y, top);
    const x1 = Math.min(rect.x + rect.width, right);
    const y1 = Math.min(rect.y + rect.height, bottom);
    // A zero-height stem is still a drawn CAP, so an empty intersection is only
    // one that does not overlap the plot at all.
    if (x1 < x0 || y1 < y0) continue;
    out.push({ seriesIndex, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  }
  return out;
}

/** The tight box a vertical error bar occupies: the stem's span, the caps' width. */
function verticalErrorBarBounds(
  cx: number,
  yBottom: number,
  yTop: number,
  capHalf: number,
): ChartElementRect {
  const top = Math.min(yTop, yBottom);
  return { x: cx - capHalf, y: top, width: capHalf * 2, height: Math.abs(yBottom - yTop) };
}

/** The tight box a horizontal error bar occupies. */
function horizontalErrorBarBounds(
  cy: number,
  xLeft: number,
  xRight: number,
  capHalf: number,
): ChartElementRect {
  const left = Math.min(xLeft, xRight);
  return { x: left, y: cy - capHalf, width: Math.abs(xRight - xLeft), height: capHalf * 2 };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * The marks whose `markOptions` carry an `errorBars` slot at all.
 *
 * ONE LIST, TWO DIRECTIONS. `getErrorBarOptions` reads through it and
 * {@link withErrorBarOptions} writes through it, so "which charts can have
 * error bars" is stated once. Before this, the answer was a switch in the
 * reader and three hand-written `{ markOptions: { ...spec.markOptions,
 * errorBars } }` literals in the callers (the Delete path, the Format pane's
 * ErrorBarSections, the Design tab) — and the Delete one did not even compile,
 * because spreading the `MarkOptions` UNION and adding `errorBars` produces an
 * arm for pie/funnel/treemap/sunburst that has no such property.
 */
const ERROR_BAR_MARKS = ["bar", "horizontalBar", "line", "scatter"] as const;

/** The three option shapes that declare `errorBars`. See {@link ERROR_BAR_MARKS}. */
type ErrorBarCapableOptions = BarMarkOptions | LineMarkOptions | ScatterMarkOptions;

/** Whether this mark's options can carry error bars at all. */
export function markSupportsErrorBars(mark: ChartSpec["mark"]): boolean {
  return (ERROR_BAR_MARKS as readonly string[]).includes(mark);
}

/**
 * Extract ErrorBarOptions from the spec's markOptions.
 *
 * EXPORTED because "where do this chart's error-bar options live?" is a
 * mark-dependent question with exactly one right answer, and the Delete path
 * (`furnitureDeletePatch`, components/ChartContextMenu.tsx) has to ask it too —
 * it writes a `seriesFilter` back into the same slot. A second copy of this
 * switch would drift on the first mark that grows error bars, and the symptom
 * would be a Delete that silently wrote into a branch nothing reads.
 */
export function getErrorBarOptions(spec: ChartSpec): ErrorBarOptions | undefined {
  const opts = spec.markOptions;
  if (!opts) return undefined;
  if (!markSupportsErrorBars(spec.mark)) return undefined;
  return (opts as ErrorBarCapableOptions).errorBars;
}

/**
 * The spec patch that stores `next` in this chart's error-bar slot — the WRITE
 * half of {@link getErrorBarOptions}, and the only sanctioned way to build it.
 *
 * Returns null for a mark that has no slot, which is the same answer the reader
 * gives: a caller that cannot read the options must not be able to write them
 * either. Every other property already on `markOptions` is preserved, so this
 * is a patch to the slot and not a replacement of the whole object.
 *
 * WHY IT EXISTS RATHER THAN AN INLINE LITERAL. `spec.markOptions` is a union of
 * nineteen shapes; spreading it and adding `errorBars` types the result as a
 * union with an illegal arm per shape that lacks the property, so the honest
 * spellings are either this narrowing or an `as any` at each call site. The
 * Design tab had the `as any`, the pane and the Delete path had neither, and
 * the Delete path is what failed the type check.
 */
export function withErrorBarOptions(
  spec: ChartSpec,
  next: ErrorBarOptions,
): Partial<ChartSpec> | null {
  if (!markSupportsErrorBars(spec.mark)) return null;
  const base = (spec.markOptions ?? {}) as ErrorBarCapableOptions;
  return { markOptions: { ...base, errorBars: next } };
}

/** Compute the error extent (plus and minus) for a data point. */
export function computeErrorExtent(
  value: number,
  seriesValues: number[],
  opts: ErrorBarOptions,
): { plus: number; minus: number } {
  let extent = 0;

  switch (opts.type) {
    case "percentage": {
      const pct = (opts.value ?? 10) / 100;
      extent = Math.abs(value) * pct;
      break;
    }
    case "standardError": {
      const n = seriesValues.length;
      if (n < 2) {
        extent = 0;
        break;
      }
      const mean = seriesValues.reduce((a, b) => a + b, 0) / n;
      const variance = seriesValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
      const stddev = Math.sqrt(variance);
      extent = stddev / Math.sqrt(n);
      break;
    }
    case "standardDeviation": {
      const n = seriesValues.length;
      if (n < 2) {
        extent = 0;
        break;
      }
      const mean = seriesValues.reduce((a, b) => a + b, 0) / n;
      const variance = seriesValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
      const stddev = Math.sqrt(variance);
      const multiplier = opts.value ?? 1;
      extent = stddev * multiplier;
      break;
    }
    case "custom": {
      extent = opts.value ?? 0;
      break;
    }
  }

  const plus = opts.direction === "minus" ? 0 : extent;
  const minus = opts.direction === "plus" ? 0 : extent;

  return { plus, minus };
}

/** Draw a vertical error bar line with T-caps. */
function drawVerticalErrorBar(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cx: number,
  yBottom: number,
  yTop: number,
  capHalf: number,
  direction: "both" | "plus" | "minus",
): void {
  // Vertical stem
  ctx.beginPath();
  ctx.moveTo(cx, yBottom);
  ctx.lineTo(cx, yTop);
  ctx.stroke();

  // Top cap (plus direction)
  if (direction !== "minus") {
    ctx.beginPath();
    ctx.moveTo(cx - capHalf, yTop);
    ctx.lineTo(cx + capHalf, yTop);
    ctx.stroke();
  }

  // Bottom cap (minus direction)
  if (direction !== "plus") {
    ctx.beginPath();
    ctx.moveTo(cx - capHalf, yBottom);
    ctx.lineTo(cx + capHalf, yBottom);
    ctx.stroke();
  }
}

/** Draw a horizontal error bar line with T-caps. */
function drawHorizontalErrorBar(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cy: number,
  xLeft: number,
  xRight: number,
  capHalf: number,
  direction: "both" | "plus" | "minus",
): void {
  // Horizontal stem
  ctx.beginPath();
  ctx.moveTo(xLeft, cy);
  ctx.lineTo(xRight, cy);
  ctx.stroke();

  // Right cap (plus direction)
  if (direction !== "minus") {
    ctx.beginPath();
    ctx.moveTo(xRight, cy - capHalf);
    ctx.lineTo(xRight, cy + capHalf);
    ctx.stroke();
  }

  // Left cap (minus direction)
  if (direction !== "plus") {
    ctx.beginPath();
    ctx.moveTo(xLeft, cy - capHalf);
    ctx.lineTo(xLeft, cy + capHalf);
    ctx.stroke();
  }
}
