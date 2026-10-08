//! FILENAME: app/extensions/Charts/rendering/comboChartPainter.ts
// PURPOSE: Pure Canvas 2D combo chart drawing.
// CONTEXT: Combines multiple mark types (bar, line, area) on the same plot.
//          Each series can specify its own mark type. Supports optional secondary Y axis.

import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  BarRect,
  PointMarker,
  HitGeometry,
  ComboMarkOptions,
  ComboSeriesMark,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { seriesPaletteIndex } from "../lib/encodingResolver";
import { createLinearScale, createBandScale, createPointScale, createScaleFromSpec } from "./scales";
import type { LinearScale } from "./scales";
import {
  computeCartesianLayout,
  drawChartBackground,
  drawPlotBackground,
  drawHorizontalGridLines,
  drawTitle,
  drawLegend,
  drawRoundedRect,
  formatTickValue,
  reflowChartElements,
} from "./chartPainterUtils";
import { resolveDatumStyle } from "../lib/dataPointOverrides";
import { applyFillStyle } from "./gradientFill";
// The combo mark draws its OWN axes (secondary axis, per-series scales) instead
// of calling drawCartesianAxes, so it needs that function's rect write-backs.
// They live ONCE in markerPainter, where points-elementRects.test.ts diffs them
// against drawCartesianAxes's private equivalents — combo used to hand-copy both
// the 14px title origin and the band arithmetic, which is a third source of
// truth for the same rectangle and the exact shape of "three copies had already
// drifted apart".
import {
  recordXAxisTitleRect,
  recordYAxisTitleRect,
  recordYLabelBandRect,
  xAxisTitleBaselineY,
  xLabelBandHeight,
  Y_AXIS_TITLE_X,
} from "./markerPainter";

/** Default radius of a line-series point marker. */
const COMBO_MARKER_RADIUS = 4;

// ============================================================================
// Layout
// ============================================================================

export function computeComboLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  const layout = computeCartesianLayout(width, height, spec, data, theme);
  const opts = (spec.markOptions ?? {}) as ComboMarkOptions;

  // Add space for secondary Y axis if enabled
  if (opts.secondaryYAxis) {
    const extraRight = 46;
    layout.margin.right += extraRight;
    layout.plotArea.width = Math.max(layout.plotArea.width - extraRight, 10);
    // EVERY element rect except chartArea and title is a function of the margin
    // and plot area computeCartesianLayout just handed us, and we have narrowed
    // the plot by `extraRight`. Recompute them from the NEW numbers before
    // anyone paints or hit-tests, or a legend/axis rect is stale by 46px and a
    // click lands on nothing. See ChartElementRects for the two-stage contract.
    reflowChartElements(layout, spec, data, theme);
  }

  return layout;
}

// ============================================================================
// Shared scales and bar layout (paint and hit geometry read the SAME answer)
// ============================================================================

/** The series roles, the scales and the stacking rule one combo is drawn with. */
interface ComboFrame {
  barSeries: number[];
  lineSeries: number[];
  areaSeries: number[];
  stacked: boolean;
  yScale: LinearScale;
  yScaleSecondary: LinearScale | null;
  getYScale(si: number): LinearScale;
  xBandScale: ReturnType<typeof createBandScale>;
  xPointScale: ReturnType<typeof createPointScale>;
}

/**
 * The value extent of the series on one axis. With stacked columns the bars
 * contribute their per-category STACK (positive and negative stacks apart, as
 * Excel and Power BI stack them), not each series alone: a "Line and stacked
 * column" whose axis only reached the tallest single series clipped every
 * stack off the top of the plot.
 */
function axisExtent(
  data: ParsedChartData,
  onAxis: number[],
  barSeries: ReadonlySet<number>,
  stacked: boolean,
): [number, number] {
  const values: number[] = [];
  // Every series' own values (a stacked bar's own value always lies inside its
  // stack's [negative total, positive total], so it never widens the extent).
  for (const si of onAxis) values.push(...(data.series[si]?.values ?? []));
  if (stacked) {
    const bars = onAxis.filter((si) => barSeries.has(si));
    if (bars.length > 0) {
      for (let ci = 0; ci < data.categories.length; ci++) {
        let pos = 0;
        let neg = 0;
        for (const si of bars) {
          const v = data.series[si]?.values[ci] ?? 0;
          if (v >= 0) pos += v;
          else neg += v;
        }
        values.push(pos, neg);
      }
    }
  }
  if (values.length === 0) return [0, 1];
  return [Math.min(...values), Math.max(...values)];
}

/**
 * What series `si` of `count` is drawn as when `seriesMarks` does not say.
 *
 * "Line and clustered column" (no stacking) keeps the combo's old default:
 * the first series is the column, the rest are lines. "Line and STACKED
 * column" is Power BI's other preset -- several column values stacked under
 * one line -- so with stackMode "stacked" every series but the LAST is a
 * column and the last is the line. The old default left that preset with ONE
 * column in its stack, which drew exactly the clustered picture.
 */
export function comboDefaultSeriesMark(si: number, count: number, stacked: boolean): ComboSeriesMark {
  if (stacked && count >= 2) return si < count - 1 ? "bar" : "line";
  return si === 0 ? "bar" : "line";
}

function comboFrame(data: ParsedChartData, spec: ChartSpec, layout: ChartLayout): ComboFrame {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as ComboMarkOptions;
  const seriesMarks = opts.seriesMarks ?? {};
  const secondaryAxisSeries = new Set(opts.secondaryAxisSeries ?? []);
  // Only "stacked" stacks: a percent mode is refused by the schema, and a
  // leftover one from a 100% column must not silently become something else.
  const stacked = opts.stackMode === "stacked";

  const barSeries: number[] = [];
  const lineSeries: number[] = [];
  const areaSeries: number[] = [];
  for (let si = 0; si < data.series.length; si++) {
    const mark = seriesMarks[si] ?? comboDefaultSeriesMark(si, data.series.length, stacked);
    if (mark === "bar") barSeries.push(si);
    else if (mark === "line") lineSeries.push(si);
    else areaSeries.push(si);
  }
  const barSet = new Set(barSeries);

  const primaryIndices = data.series.map((_, i) => i).filter((i) => !secondaryAxisSeries.has(i));
  const secondaryIndices = [...secondaryAxisSeries];

  const [primaryMin, primaryMax] = axisExtent(data, primaryIndices, barSet, stacked);
  const yScale = createScaleFromSpec(
    spec.yAxis.scale,
    [spec.yAxis.min ?? primaryMin, spec.yAxis.max ?? primaryMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  let yScaleSecondary: LinearScale | null = null;
  if (opts.secondaryYAxis && secondaryIndices.length > 0) {
    const [secMin, secMax] = axisExtent(data, secondaryIndices, barSet, stacked);
    const secAxis = opts.secondaryAxis;
    yScaleSecondary = createScaleFromSpec(
      secAxis?.scale,
      [secAxis?.min ?? secMin, secAxis?.max ?? secMax],
      [plotArea.y + plotArea.height, plotArea.y],
    );
  }

  const xBandScale = createBandScale(data.categories, [plotArea.x, plotArea.x + plotArea.width], 0.3);
  const xPointScale = createPointScale(data.categories, [plotArea.x, plotArea.x + plotArea.width]);

  return {
    barSeries,
    lineSeries,
    areaSeries,
    stacked,
    yScale,
    yScaleSecondary,
    getYScale: (si) => (yScaleSecondary && secondaryAxisSeries.has(si) ? yScaleSecondary : yScale),
    xBandScale,
    xPointScale,
  };
}

/**
 * Every bar of the combo, clipped to the plot, in paint order (category by
 * category, bar series in order). THE ONE BAR LAYOUT: the painter draws these
 * rectangles and the hit geometry returns them, so a click can never land on a
 * bar that was drawn somewhere else.
 *
 * Clustered: the bar series side by side in the band. Stacked: one bar width
 * per category, each series laid on the running total of the series before it
 * ON THE SAME AXIS — positive values grow up from zero, negative values hang
 * down from zero, each in their own stack.
 */
function comboBarRects(
  data: ParsedChartData,
  frame: ComboFrame,
  plotArea: ChartLayout["plotArea"],
  theme: ChartRenderTheme,
): BarRect[] {
  const { barSeries, xBandScale, stacked } = frame;
  const rects: BarRect[] = [];
  if (barSeries.length === 0) return rects;

  const groupWidth = xBandScale.bandwidth;
  const numBars = stacked ? 1 : barSeries.length;
  const barWidth = Math.max((groupWidth - theme.barGap * (numBars - 1)) / numBars, 2);

  for (let ci = 0; ci < data.categories.length; ci++) {
    const groupX = xBandScale.scaleIndex(ci);
    // Running stack per axis scale: [positive total, negative total].
    const running = new Map<LinearScale, [number, number]>();

    for (let bi = 0; bi < barSeries.length; bi++) {
      const si = barSeries[bi];
      const series = data.series[si];
      const ys = frame.getYScale(si);
      const value = series.values[ci] ?? 0;

      let from = 0;
      let to = value;
      if (stacked) {
        const totals = running.get(ys) ?? [0, 0];
        if (value >= 0) {
          from = totals[0];
          to = totals[0] + value;
          totals[0] = to;
        } else {
          from = totals[1];
          to = totals[1] + value;
          totals[1] = to;
        }
        running.set(ys, totals);
      }

      const barX = stacked ? groupX : groupX + bi * (barWidth + theme.barGap);
      const yFrom = ys.scale(from);
      const yTo = ys.scale(to);
      const barY = Math.min(yFrom, yTo);
      const barHeight = Math.abs(yFrom - yTo);

      const clippedY = Math.max(barY, plotArea.y);
      const clippedBottom = Math.min(barY + barHeight, plotArea.y + plotArea.height);
      const clippedHeight = clippedBottom - clippedY;
      if (clippedHeight <= 0) continue;

      rects.push({
        seriesIndex: si,
        categoryIndex: ci,
        x: barX,
        y: clippedY,
        width: barWidth,
        height: clippedHeight,
        value,
        seriesName: series.name,
        categoryName: data.categories[ci],
      });
    }
  }
  return rects;
}

// ============================================================================
// Main Paint Function
// ============================================================================

export function paintComboChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as ComboMarkOptions;
  const frame = comboFrame(data, spec, layout);
  const { lineSeries, areaSeries, yScale, yScaleSecondary, xBandScale, xPointScale, getYScale } = frame;

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  // 2. Plot area background
  drawPlotBackground(ctx, plotArea, theme);

  // 3. Grid lines
  if (spec.yAxis.gridLines) {
    drawHorizontalGridLines(ctx, yScale, plotArea, theme);
  }

  // 4. Axes
  drawComboAxes(ctx, xBandScale, yScale, yScaleSecondary, plotArea, spec, opts, theme, layout);

  // 5. Draw in order: areas (back), then bars, then lines (front)
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  // Areas. An area series in a combo paints ONE polygon per series and no
  // per-datum shape at all, so there is nothing here for a DataPointOverride to
  // recolour — the per-point path in this mark is the bars and the line markers
  // below. (A combo series that wants per-point formatting is authored as a bar
  // or a line series.)
  for (const si of areaSeries) {
    const series = data.series[si];
    const color = getSeriesColor(spec.palette, seriesPaletteIndex(data, si), series.color);
    const ys = getYScale(si);
    const points = data.categories.map((_cat, ci) => ({
      x: xPointScale.scaleIndex(ci),
      y: ys.scale(series.values[ci] ?? 0),
    }));

    if (points.length === 0) continue;

    const zeroY = ys.scale(0);

    // Fill area
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.moveTo(points[0].x, zeroY);
    for (const pt of points) ctx.lineTo(pt.x, pt.y);
    ctx.lineTo(points[points.length - 1].x, zeroY);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Stroke line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  // Bars — the one bar layout (comboBarRects), clustered or stacked.
  for (const bar of comboBarRects(data, frame, plotArea, theme)) {
    const si = bar.seriesIndex;
    const ci = bar.categoryIndex;
    const color = getSeriesColor(spec.palette, seriesPaletteIndex(data, si), data.series[si].color);
    const { x: barX, y: clippedY, width: barWidth, height: clippedHeight } = bar;

    // ONE shared resolver: `si`/`ci` are PAINTER-space loop counters and the
    // resolver translates to authoring space itself. Hand-rolling the
    // translation here is what aliases an override onto the wrong bar as
    // soon as a filter hides a lower-index series.
    const style = resolveDatumStyle(spec, data, si, ci, { fill: color });

    if (style.opacity != null) ctx.globalAlpha = style.opacity;
    applyFillStyle(
      ctx,
      style.fill,
      style.gradientFill ?? undefined,
      barX,
      clippedY,
      barWidth,
      clippedHeight,
    );

    const borderWidth = style.borderWidth ?? 1;
    const hasBorder = style.borderColor != null && borderWidth > 0;

    if (theme.barBorderRadius > 0 && clippedHeight > theme.barBorderRadius * 2) {
      drawRoundedRect(ctx, barX, clippedY, barWidth, clippedHeight, theme.barBorderRadius);
      ctx.fill();
      if (hasBorder) {
        ctx.strokeStyle = style.borderColor as string;
        ctx.lineWidth = borderWidth;
        // The rounded path is still current after fill(), so stroking it
        // traces exactly the shape that was filled.
        ctx.stroke();
      }
    } else {
      ctx.fillRect(barX, clippedY, barWidth, clippedHeight);
      if (hasBorder) {
        ctx.strokeStyle = style.borderColor as string;
        ctx.lineWidth = borderWidth;
        ctx.strokeRect(barX, clippedY, barWidth, clippedHeight);
      }
    }

    if (style.opacity != null) ctx.globalAlpha = 1;
  }

  // Lines
  for (const si of lineSeries) {
    const series = data.series[si];
    const color = getSeriesColor(spec.palette, seriesPaletteIndex(data, si), series.color);
    const ys = getYScale(si);
    const points = data.categories.map((_cat, ci) => ({
      x: xPointScale.scaleIndex(ci),
      y: ys.scale(series.values[ci] ?? 0),
    }));

    if (points.length === 0) continue;

    // Line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();

    // Markers. Resolved ONCE per datum and then drawn in TWO passes, exactly as
    // before: every outer disc first, every white core second. Interleaving the
    // passes would let a neighbouring point's outer disc paint over an already
    // drawn core wherever the markers overlap, so the pass structure is load
    // bearing, not stylistic.
    const markerStyles = points.map((_pt, ci) =>
      resolveDatumStyle(spec, data, si, ci, { fill: color }),
    );

    for (let ci = 0; ci < points.length; ci++) {
      const st = markerStyles[ci];
      if (st.markerStyle === "none") continue;
      const pt = points[ci];
      const r = st.markerSize ?? COMBO_MARKER_RADIUS;
      if (r <= 0) continue;
      if (st.opacity != null) ctx.globalAlpha = st.opacity;
      ctx.fillStyle = st.markerFill ?? st.fill;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
      const mbw = st.markerBorderWidth ?? 1;
      if (st.markerBorderColor != null && mbw > 0) {
        ctx.strokeStyle = st.markerBorderColor;
        ctx.lineWidth = mbw;
        ctx.stroke();
      }
      if (st.opacity != null) ctx.globalAlpha = 1;
    }

    ctx.fillStyle = "#ffffff";
    for (let ci = 0; ci < points.length; ci++) {
      const st = markerStyles[ci];
      if (st.markerStyle === "none") continue;
      const pt = points[ci];
      const r = st.markerSize ?? COMBO_MARKER_RADIUS;
      if (r <= 0) continue;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(1, r / 2), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();

  // 6. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 7. Legend
  if (spec.legend.visible && data.series.length > 0) {
    drawLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Axes
// ============================================================================

/**
 * `layout` is OPTIONAL and exists only for the element-rect write-back, matching
 * `drawCartesianAxes`: passing it replaces the layout's character-count estimates
 * for the y-label band and the y-axis title with their MEASURED boxes. Omitting
 * it paints byte-identically and leaves the estimates in place.
 */
function drawComboAxes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  xScale: ReturnType<typeof createBandScale>,
  yScale: LinearScale,
  yScaleSecondary: LinearScale | null,
  plotArea: { x: number; y: number; width: number; height: number },
  spec: ChartSpec,
  opts: ComboMarkOptions,
  theme: ChartRenderTheme,
  layout?: ChartLayout,
): void {
  ctx.strokeStyle = theme.axisColor;
  ctx.lineWidth = 1;

  const xAxisY = plotArea.y + plotArea.height;

  // X axis line
  ctx.beginPath();
  ctx.moveTo(plotArea.x, xAxisY + 0.5);
  ctx.lineTo(plotArea.x + plotArea.width, xAxisY + 0.5);
  ctx.stroke();

  // Y axis line (left)
  ctx.beginPath();
  ctx.moveTo(plotArea.x - 0.5, plotArea.y);
  ctx.lineTo(plotArea.x - 0.5, xAxisY);
  ctx.stroke();

  // Secondary Y axis line (right)
  if (yScaleSecondary) {
    ctx.beginPath();
    ctx.moveTo(plotArea.x + plotArea.width + 0.5, plotArea.y);
    ctx.lineTo(plotArea.x + plotArea.width + 0.5, xAxisY);
    ctx.stroke();
  }

  // X axis labels
  if (spec.xAxis.showLabels) {
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let ci = 0; ci < xScale.domain.length; ci++) {
      const x = xScale.scaleIndex(ci) + xScale.bandwidth / 2;
      ctx.fillText(xScale.domain[ci], x, xAxisY + 4);
    }
  }

  // Primary Y axis labels (left)
  if (spec.yAxis.showLabels) {
    const ticks = yScale.ticks(5);
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    let widestYLabel = 0;
    for (const tick of ticks) {
      const y = yScale.scale(tick);
      if (y < plotArea.y || y > plotArea.y + plotArea.height) continue;
      const label = formatTickValue(tick);
      widestYLabel = Math.max(widestYLabel, ctx.measureText(label).width);
      ctx.fillText(label, plotArea.x - 6, y);
    }

    if (layout) {
      // Labels are right-aligned at plotArea.x - 6; the shared helper owns the
      // gutter so combo and drawCartesianAxes cannot disagree about the band.
      recordYLabelBandRect(layout, plotArea, widestYLabel);
    }
  }

  // Secondary Y axis labels (right)
  if (yScaleSecondary && opts.secondaryAxis?.showLabels !== false) {
    const ticks = yScaleSecondary.ticks(5);
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `${theme.labelFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    for (const tick of ticks) {
      const y = yScaleSecondary.scale(tick);
      if (y < plotArea.y || y > plotArea.y + plotArea.height) continue;
      ctx.fillText(formatTickValue(tick), plotArea.x + plotArea.width + 6, y);
    }
  }

  // Axis titles
  //
  // The X AXIS TITLE was missing here for as long as this painter has existed,
  // while `computeCartesianLayout` reserved `axisTitleFontSize + 6` of bottom
  // margin for it and `computeCartesianElementRects` produced an `xAxisTitle`
  // RECT at that reservation. So a combo chart with `spec.xAxis.title` set gave
  // up the space, painted nothing in it, and — once element hit-testing landed —
  // let a click on that empty strip SELECT a title the user could not see. It is
  // drawn exactly the way every other cartesian painter draws it: the shared
  // `xAxisTitleBaselineY` decides the drop (so the four copies cannot disagree),
  // and the measured box is written back before `restore`-free measurement can
  // be spoiled by a font change.
  if (spec.xAxis.title) {
    ctx.fillStyle = theme.axisTitleColor;
    ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const baselineY = xAxisTitleBaselineY(
      plotArea,
      xLabelBandHeight(spec, xScale.domain, theme),
      theme,
    );
    ctx.fillText(spec.xAxis.title, plotArea.x + plotArea.width / 2, baselineY);
    if (layout) {
      recordXAxisTitleRect(
        layout,
        plotArea,
        ctx.measureText(spec.xAxis.title).width,
        baselineY,
        theme.axisTitleFontSize,
      );
    }
  }

  if (spec.yAxis.title) {
    ctx.save();
    ctx.fillStyle = theme.axisTitleColor;
    ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
    ctx.translate(Y_AXIS_TITLE_X, plotArea.y + plotArea.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(spec.yAxis.title, 0, 0);
    // Measure BEFORE restore: restore() puts the previous font back and a rect
    // measured under the wrong font is fiction, not truth.
    const titleWidth = ctx.measureText(spec.yAxis.title).width;
    ctx.restore();
    if (layout) {
      // Rotated -90deg with a "top" baseline: local +x runs UP the canvas, so
      // the glyph run is a TALL box one font-size wide and `titleWidth` tall.
      // The shared helper owns that arithmetic.
      recordYAxisTitleRect(layout, plotArea, titleWidth, theme.axisTitleFontSize);
    }
  }
}

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeComboHitGeometry(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): HitGeometry {
  const { plotArea } = layout;
  const frame = comboFrame(data, spec, layout);
  const groups: HitGeometry[] = [];

  // Bar rects — the SAME layout the painter draws (comboBarRects).
  if (frame.barSeries.length > 0) {
    groups.push({ type: "bars", rects: comboBarRects(data, frame, plotArea, theme) });
  }

  // Point markers for line and area series (never stacked).
  const pointSeries = [...frame.lineSeries, ...frame.areaSeries].sort((a, b) => a - b);
  if (pointSeries.length > 0) {
    const markers: PointMarker[] = [];
    for (const si of pointSeries) {
      const series = data.series[si];
      const ys = frame.getYScale(si);
      for (let ci = 0; ci < data.categories.length; ci++) {
        const value = series.values[ci] ?? 0;
        markers.push({
          seriesIndex: si,
          categoryIndex: ci,
          cx: frame.xPointScale.scaleIndex(ci),
          cy: ys.scale(value),
          radius: 4,
          value,
          seriesName: series.name,
          categoryName: data.categories[ci],
        });
      }
    }
    groups.push({ type: "points", markers });
  }

  if (groups.length === 1) return groups[0];
  return { type: "composite", groups };
}
