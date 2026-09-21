//! FILENAME: app/extensions/Charts/rendering/chartPainterUtils.ts
// PURPOSE: Shared drawing utilities used by all chart painters.
// CONTEXT: Extracted from barChartPainter to avoid duplication across chart types.
//          Includes title, legend, axis, grid line, and geometry helpers.

import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  ChartElementRect,
  ChartElementRects,
  ChartElementKey,
  AxisSpec,
  TickMarkType,
} from "../types";
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
 * Width the y-axis tick-label band needs. ESTIMATED at ~7px per character —
 * shared by the margin arithmetic and the element rect so the two can never
 * disagree about where the band is.
 */
function estimateYLabelBandWidth(data: ParsedChartData): number {
  const allValues = data.series.flatMap((s) => s.values);
  const maxVal = Math.max(...allValues, 0);
  const minVal = Math.min(...allValues, 0);
  const maxLabel = formatTickValue(maxVal);
  const minLabel = formatTickValue(minVal);
  const longestLabel = maxLabel.length >= minLabel.length ? maxLabel : minLabel;
  // Approximate width: ~7px per character at typical label font size
  return Math.max(longestLabel.length * 7, 20) + 4;
}

/**
 * Height the x-axis tick-label band needs, by label angle. Shared by the margin
 * arithmetic and the element rect (see {@link estimateYLabelBandWidth}).
 */
function estimateXLabelBandHeight(
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): number {
  if (spec.xAxis.labelAngle === 0) return theme.labelFontSize + 8;
  if (spec.xAxis.labelAngle === 45) return 30;
  // 90 degrees
  const maxLen = Math.max(...data.categories.map((c) => c.length), 3);
  return Math.min(maxLen * 5, 60);
}

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
    left += estimateYLabelBandWidth(data);
  }
  if (spec.yAxis.title) {
    left += theme.axisTitleFontSize + 6;
  }

  // X-axis labels
  if (spec.xAxis.showLabels) {
    bottom += estimateXLabelBandHeight(spec, data, theme);
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

  const layout: ChartLayout = { width, height, margin: { top, right, bottom, left }, plotArea };
  layout.elements = computeCartesianElementRects(layout, spec, data, theme);
  return layout;
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

  const layout: ChartLayout = { width, height, margin: { top, right, bottom, left }, plotArea };
  layout.elements = computeRadialElementRects(layout, spec, data, theme);
  return layout;
}

// ============================================================================
// Element Rects (hit-testable boxes for title / axes / legend)
// ============================================================================
//
// See ChartElementRects in ../types for the full two-stage contract. In short:
// the functions BELOW derive estimated rects from the margins; the PAINTERS
// further down overwrite the ones they can measure via recordChartElementRect.
// Any stage that mutates layout.margin / layout.plotArea after layout (the data
// table in chartDispatch, pivot field buttons in chartRenderer, the secondary
// axis in combo/pareto, the horizontal-bar relayout) must call
// reflowChartElements afterwards and BEFORE painting.

/** Rough text width with no canvas context. ~0.55em per character. */
function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.55;
}

/** The bare canvas rect, used whenever `elements` has to be created from nothing. */
function chartAreaRect(layout: ChartLayout): ChartElementRect {
  return { x: 0, y: 0, width: layout.width, height: layout.height };
}

/**
 * Estimated title rect. `drawTitle` paints the title centered on the canvas at
 * y = 10 with a "top" baseline, ANCHORED TO THE CANVAS TOP EDGE — not to
 * `margin.top` — so this rect is the one thing a later margin change cannot
 * invalidate.
 */
function estimateTitleRect(layout: ChartLayout, title: string, theme: ChartRenderTheme): ChartElementRect {
  const w = estimateTextWidth(title, theme.titleFontSize);
  return { x: layout.width / 2 - w / 2, y: TITLE_TOP_Y, width: w, height: theme.titleFontSize };
}

/** The y coordinate `drawTitle` paints at (top baseline). */
const TITLE_TOP_Y = 10;

/**
 * Estimated legend box and per-entry rects, mirroring the arithmetic in
 * {@link drawLegendItems}. `labels` is the series names for a cartesian legend
 * and the category names for a radial one; the entry's `seriesIndex` is that
 * list's PAINTER-space index either way.
 *
 * `spec.legend.hiddenEntries` removes ROWS from the legend without removing the
 * data from the plot, so the surviving rows keep their ORIGINAL indices: the
 * rect for series 2 still says 2 after series 1 is hidden. Renumbering them
 * would make a click on the legend select the wrong series, which is the whole
 * reason the index travels with the rect instead of being the array position.
 */
function estimateLegendRects(
  layout: ChartLayout,
  spec: ChartSpec,
  labels: string[],
  theme: ChartRenderTheme,
): { legend: ChartElementRect; legendItems: Array<{ seriesIndex: number; rect: ChartElementRect }> } | undefined {
  const fs = theme.legendFontSize;
  const h = legendItemHeight(theme);
  const entries = visibleLegendEntries(spec, labels).map((e) => ({
    seriesIndex: e.seriesIndex,
    width: LEGEND_SWATCH + LEGEND_PADDING + estimateTextWidth(e.label, fs),
  }));
  if (entries.length === 0) return undefined;

  if (spec.legend.position === "bottom" || spec.legend.position === "top") {
    const y = horizontalLegendCenterY(layout, spec, theme);
    return layOutHorizontalLegend(layout, entries, y, h);
  }
  const x = verticalLegendX(layout, spec);
  return layOutVerticalLegend(layout, entries, x, theme, h);
}

/**
 * The legend rows that survive `spec.legend.hiddenEntries`, each still carrying
 * the index it had before anything was hidden. ONE filter, shared by the layout
 * estimate and the painter — two copies of this predicate would drift the first
 * time one of them learned about a new way to hide a row.
 */
function visibleLegendEntries(
  spec: ChartSpec,
  labels: string[],
): Array<{ seriesIndex: number; label: string }> {
  const hidden = spec.legend.hiddenEntries;
  const out: Array<{ seriesIndex: number; label: string }> = [];
  for (let i = 0; i < labels.length; i++) {
    if (hidden && hidden.includes(i)) continue;
    out.push({ seriesIndex: i, label: labels[i] });
  }
  return out;
}

/** Swatch square size, text padding and inter-item gap used by the legend. */
const LEGEND_SWATCH = 10;
const LEGEND_PADDING = 4;
const LEGEND_GAP = 16;

/** Row height of one legend entry — tall enough to contain the swatch. */
function legendItemHeight(theme: ChartRenderTheme): number {
  return Math.max(theme.legendFontSize, LEGEND_SWATCH);
}

/** The text/swatch CENTER y of a horizontal (top/bottom) legend. */
function horizontalLegendCenterY(layout: ChartLayout, spec: ChartSpec, theme: ChartRenderTheme): number {
  return spec.legend.position === "bottom"
    ? layout.height - theme.legendFontSize - 4
    : layout.margin.top - theme.legendFontSize - 12;
}

/** The left edge of a vertical (left/right) legend. */
function verticalLegendX(layout: ChartLayout, spec: ChartSpec): number {
  return spec.legend.position === "right"
    ? layout.plotArea.x + layout.plotArea.width + 16
    : 8;
}

/** One legend row to place: the index it addresses and how wide it draws. */
type LegendEntryWidth = { seriesIndex: number; width: number };

/** Place a horizontal legend's entries from their item widths. */
function layOutHorizontalLegend(
  layout: ChartLayout,
  entries: LegendEntryWidth[],
  centerY: number,
  itemHeight: number,
): { legend: ChartElementRect; legendItems: Array<{ seriesIndex: number; rect: ChartElementRect }> } {
  const totalWidth = entries.reduce((a, e) => a + e.width, 0) + LEGEND_GAP * (entries.length - 1);
  const startX = (layout.width - totalWidth) / 2;
  const items: Array<{ seriesIndex: number; rect: ChartElementRect }> = [];
  let x = startX;
  for (const entry of entries) {
    items.push({
      seriesIndex: entry.seriesIndex,
      rect: { x, y: centerY - itemHeight / 2, width: entry.width, height: itemHeight },
    });
    x += entry.width + LEGEND_GAP;
  }
  return {
    legend: { x: startX, y: centerY - itemHeight / 2, width: totalWidth, height: itemHeight },
    legendItems: items,
  };
}

/** Place a vertical legend's entries from their item widths. */
function layOutVerticalLegend(
  layout: ChartLayout,
  entries: LegendEntryWidth[],
  x: number,
  theme: ChartRenderTheme,
  itemHeight: number,
): { legend: ChartElementRect; legendItems: Array<{ seriesIndex: number; rect: ChartElementRect }> } {
  const step = theme.legendFontSize + 6;
  const firstCenterY = layout.plotArea.y + 4;
  const items: Array<{ seriesIndex: number; rect: ChartElementRect }> = [];
  let widest = 0;
  for (let row = 0; row < entries.length; row++) {
    const entry = entries[row];
    if (entry.width > widest) widest = entry.width;
    items.push({
      seriesIndex: entry.seriesIndex,
      // The ROW the entry occupies, not its series index: hiding series 1 must
      // close the gap it left rather than leave a hole in the legend.
      rect: { x, y: firstCenterY + row * step - itemHeight / 2, width: entry.width, height: itemHeight },
    });
  }
  return {
    legend: {
      x,
      y: firstCenterY - itemHeight / 2,
      width: widest,
      height: (entries.length - 1) * step + itemHeight,
    },
    legendItems: items,
  };
}

/**
 * Derive the element rects for a CARTESIAN layout from its margins and plot
 * area. Pure — call it again after any margin change (see
 * {@link reflowChartElements}).
 */
export function computeCartesianElementRects(
  layout: ChartLayout,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartElementRects {
  const pa = layout.plotArea;
  const els: ChartElementRects = {
    family: "cartesian",
    chartArea: chartAreaRect(layout),
    measured: [],
  };

  if (spec.title) els.title = estimateTitleRect(layout, spec.title, theme);

  if (spec.xAxis.showLabels) {
    els.xAxisBand = {
      x: pa.x,
      y: pa.y + pa.height,
      width: pa.width,
      height: estimateXLabelBandHeight(spec, data, theme),
    };
  }
  if (spec.yAxis.showLabels) {
    const w = estimateYLabelBandWidth(data);
    els.yAxisBand = { x: pa.x - w, y: pa.y, width: w, height: pa.height };
  }

  if (spec.xAxis.title) {
    // drawCartesianAxes paints it centered under the plot with a "bottom"
    // baseline, so the box ends at that y.
    const baselineY = pa.y + pa.height + (spec.xAxis.showLabels ? 30 : 16);
    const w = estimateTextWidth(spec.xAxis.title, theme.axisTitleFontSize);
    els.xAxisTitle = {
      x: pa.x + pa.width / 2 - w / 2,
      y: baselineY - theme.axisTitleFontSize,
      width: w,
      height: theme.axisTitleFontSize,
    };
  }
  if (spec.yAxis.title) {
    // Rotated -90deg about (14, plot vertical centre) with a "top" baseline:
    // the glyph run becomes a TALL box one font-size wide.
    const w = estimateTextWidth(spec.yAxis.title, theme.axisTitleFontSize);
    els.yAxisTitle = {
      x: Y_AXIS_TITLE_X,
      y: pa.y + pa.height / 2 - w / 2,
      width: theme.axisTitleFontSize,
      height: w,
    };
  }

  if (spec.yAxis.displayUnit && spec.yAxis.displayUnit !== "none" && spec.yAxis.showDisplayUnitLabel) {
    const fs = theme.labelFontSize - 1;
    const w = estimateTextWidth(getDisplayUnitLabel(spec.yAxis.displayUnit), fs);
    els.displayUnitLabel = { x: pa.x + 2, y: pa.y - 2 - fs, width: w, height: fs };
  }

  if (spec.legend.visible) {
    const legend = estimateLegendRects(layout, spec, data.series.map((s) => s.name), theme);
    if (legend) {
      els.legend = legend.legend;
      els.legendItems = legend.legendItems;
    }
  }

  return els;
}

/** The x coordinate the rotated y-axis title is translated to. */
const Y_AXIS_TITLE_X = 14;

/**
 * Derive the element rects for a RADIAL layout. No axes — title and a
 * category-keyed legend only.
 */
export function computeRadialElementRects(
  layout: ChartLayout,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartElementRects {
  const els: ChartElementRects = {
    family: "radial",
    chartArea: chartAreaRect(layout),
    measured: [],
  };
  if (spec.title) els.title = estimateTitleRect(layout, spec.title, theme);
  if (spec.legend.visible) {
    const legend = estimateLegendRects(layout, spec, data.categories, theme);
    if (legend) {
      els.legend = legend.legend;
      els.legendItems = legend.legendItems;
    }
  }
  return els;
}

/**
 * RECOMPUTE every element rect from the layout's CURRENT margins and plot area,
 * discarding any measured write-backs.
 *
 * Call this from any stage that mutates `layout.margin` or `layout.plotArea`
 * after the layout was computed — the data table folded into `margin.bottom`
 * (chartDispatch), pivot field buttons (chartRenderer), the secondary axis
 * (combo/pareto), the horizontal-bar relayout. Call it BEFORE painting: a
 * reflow after paint throws away the exact rects the painters measured.
 *
 * A layout with no `elements` yet (hand-built in a test) gets a fresh set; the
 * family is taken from the existing rects, defaulting to cartesian.
 */
export function reflowChartElements(
  layout: ChartLayout,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): void {
  layout.elements = layout.elements?.family === "radial"
    ? computeRadialElementRects(layout, spec, data, theme)
    : computeCartesianElementRects(layout, spec, data, theme);
}

/**
 * Ensure `layout.elements` exists so a painter can write a measured rect back
 * onto it. Preserves the family when the rects are already there.
 */
function ensureChartElements(layout: ChartLayout): ChartElementRects {
  if (!layout.elements) {
    layout.elements = { family: "cartesian", chartArea: chartAreaRect(layout), measured: [] };
  }
  return layout.elements;
}

/**
 * Write a MEASURED element rect back onto the layout, replacing the layout's
 * estimate and marking the key as truth. Painters call this as they paint —
 * `drawTitle` knows its own box exactly and `drawLegendItems` measures every
 * entry, so throwing those measurements away and keeping a ~6px/char guess
 * would be a hit-test that misses the thing the user clicked.
 */
export function recordChartElementRect(
  layout: ChartLayout,
  key: ChartElementKey,
  rect: ChartElementRect,
): void {
  const els = ensureChartElements(layout);
  switch (key) {
    case "chartArea": els.chartArea = rect; break;
    case "title": els.title = rect; break;
    case "xAxisTitle": els.xAxisTitle = rect; break;
    case "yAxisTitle": els.yAxisTitle = rect; break;
    case "xAxisBand": els.xAxisBand = rect; break;
    case "yAxisBand": els.yAxisBand = rect; break;
    case "legend": els.legend = rect; break;
    case "displayUnitLabel": els.displayUnitLabel = rect; break;
    case "dataTable": els.dataTable = rect; break;
  }
  if (!els.measured.includes(key)) els.measured.push(key);
}

/** Write the measured legend box AND its per-entry rects back onto the layout. */
export function recordLegendElementRects(
  layout: ChartLayout,
  legend: ChartElementRect,
  items: Array<{ seriesIndex: number; rect: ChartElementRect }>,
): void {
  const els = ensureChartElements(layout);
  els.legendItems = items;
  recordChartElementRect(layout, "legend", legend);
}

// ---------------------------------------------------------------------------
// Collection recorders (the furniture that is MANY rects under one name)
// ---------------------------------------------------------------------------
//
// REPLACE, NEVER APPEND. Each painter builds its complete list in one pass and
// hands it over once. Appending would double every entry on the second paint of
// the same layout (a cached chart repainted on hover does exactly that), and a
// half-written list is worse than none: a hit test that answers a rect nothing
// drew sends the format pane at an element the user cannot see.

/** Write back the polylines of every trendline painted on this layout. */
export function recordTrendlineGeometry(
  layout: ChartLayout,
  trendlines: Array<{ seriesIndex: number; trendlineIndex: number; points: Array<{ x: number; y: number }> }>,
): void {
  ensureChartElements(layout).trendlines = trendlines;
}

/** Write back one rect per drawn error bar. Identity is the SERIES, not the point. */
export function recordErrorBarRects(
  layout: ChartLayout,
  bars: Array<{ seriesIndex: number; rect: ChartElementRect }>,
): void {
  ensureChartElements(layout).errorBars = bars;
}

/** Write back one rect per painted data label. */
export function recordDataLabelRects(
  layout: ChartLayout,
  labels: Array<{ seriesIndex: number; pointIndex: number; rect: ChartElementRect }>,
): void {
  ensureChartElements(layout).dataLabels = labels;
}

/** Whether a chart-local point falls inside a rect (edges inclusive). */
export function rectContains(rect: ChartElementRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
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
  ctx.fillText(title, layout.width / 2, TITLE_TOP_Y);

  // Write-back: this is the exact box, not the layout's ~0.55em/char estimate.
  const w = ctx.measureText(title).width;
  recordChartElementRect(layout, "title", {
    x: layout.width / 2 - w / 2,
    y: TITLE_TOP_Y,
    width: w,
    height: theme.titleFontSize,
  });
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

  // A deleted legend ENTRY removes the row and nothing else — the series stays
  // plotted, which is the whole point of the element being separately
  // addressable. The surviving rows keep their original indices.
  const visible = visibleLegendEntries(spec, items.map((it) => it.name));
  if (visible.length === 0) {
    // Every row hidden: there is no legend box to record, and leaving a stale
    // one behind would keep a click selecting a legend that is not painted.
    const els = ensureChartElements(layout);
    els.legend = undefined;
    els.legendItems = [];
    return;
  }

  // MEASURED widths — the layout only had ~6px/char to work with. The placement
  // itself is the shared helper the layout estimate uses, so the drawn boxes and
  // the recorded boxes cannot drift apart.
  const entries = visible.map((e) => ({
    seriesIndex: e.seriesIndex,
    width: LEGEND_SWATCH + LEGEND_PADDING + ctx.measureText(e.label).width,
  }));
  const itemHeight = legendItemHeight(theme);
  const placed = spec.legend.position === "bottom" || spec.legend.position === "top"
    ? layOutHorizontalLegend(layout, entries, horizontalLegendCenterY(layout, spec, theme), itemHeight)
    : layOutVerticalLegend(layout, entries, verticalLegendX(layout, spec), theme, itemHeight);

  for (let row = 0; row < placed.legendItems.length; row++) {
    const { seriesIndex, rect } = placed.legendItems[row];
    const centerY = rect.y + rect.height / 2;
    ctx.fillStyle = items[seriesIndex].color;
    ctx.fillRect(rect.x, centerY - LEGEND_SWATCH / 2, LEGEND_SWATCH, LEGEND_SWATCH);
    ctx.fillStyle = theme.legendTextColor;
    ctx.fillText(items[seriesIndex].name, rect.x + LEGEND_SWATCH + LEGEND_PADDING, centerY);
  }

  recordLegendElementRects(layout, placed.legend, placed.legendItems);
}

// ============================================================================
// Axis tick values — Excel's majorUnit / minorUnit / crossesAt
// ============================================================================
//
// These five AxisSpec fields (majorUnit, minorUnit, minorTickMark, crossesAt,
// crossesAtValue) round-tripped into saved workbooks for a long time with a
// full editor behind them in ChartFormatPane and NO painter reading any of
// them: setting "Major unit: 250" changed the file and never changed a pixel.
// The readers are below. They are the ONLY readers, and `axisTickValues` feeds
// both the tick marks and the tick labels from one call so the two cannot
// disagree about where a tick is.
//
// SCOPE, stated rather than implied: this is the vertical-value-axis family
// (`drawCartesianAxes`). `drawHorizontalAxes` — the horizontal-bar variant,
// whose VALUE axis is X — honours `majorUnit` on that axis and nothing else,
// because it draws no tick marks at all and has no tick-mark code to extend.

/** Hard cap on generated ticks: a majorUnit of 1e-9 must not hang the painter. */
const MAX_AXIS_TICKS = 1000;

/** Values at `step` intervals across a domain, from the first multiple inside it. */
function stepValues(domain: [number, number], step: number): number[] {
  const lo = Math.min(domain[0], domain[1]);
  const hi = Math.max(domain[0], domain[1]);
  const out: number[] = [];
  const start = Math.ceil(lo / step) * step;
  for (let i = 0; i < MAX_AXIS_TICKS; i++) {
    // Indexed, not accumulated: `v += step` a hundred times drifts far enough
    // to drop the last tick of a 0.1-step axis.
    const v = start + i * step;
    if (v > hi + step * 1e-9) break;
    out.push(Math.round(v * 1e10) / 1e10);
  }
  return out;
}

/**
 * The MAJOR tick values for a value axis: `majorUnit` when the user pinned one,
 * otherwise the scale's own nice ticks at `tickCount`.
 */
export function axisTickValues(scale: LinearScale, axis: AxisSpec): number[] {
  const unit = axis.majorUnit;
  if (unit == null || !Number.isFinite(unit) || unit <= 0) {
    return scale.ticks(axis.tickCount ?? 5);
  }
  return stepValues(scale.domain, unit);
}

/**
 * The MINOR tick values for a value axis — empty unless `minorTickMark` asks
 * for marks, because Excel draws no minor ticks by default and a minorUnit
 * alone is not a request to show them.
 *
 * `minorUnit` defaults to HALF the major step (Excel's own default is a fifth,
 * but our default major step comes from a nice-ticks algorithm rather than a
 * round unit, so a fifth of it is not a round number either; a half always
 * lands between two majors). Values that coincide with a major tick are
 * dropped: drawing both would paint a double-width tick on every major.
 */
export function axisMinorTickValues(scale: LinearScale, axis: AxisSpec, major: number[]): number[] {
  if ((axis.minorTickMark ?? "none") === "none") return [];

  const majorStep = axis.majorUnit != null && Number.isFinite(axis.majorUnit) && axis.majorUnit > 0
    ? axis.majorUnit
    : major.length >= 2
      ? Math.abs(major[1] - major[0])
      : 0;

  const unit = axis.minorUnit != null && Number.isFinite(axis.minorUnit) && axis.minorUnit > 0
    ? axis.minorUnit
    : majorStep / 2;
  if (!Number.isFinite(unit) || unit <= 0) return [];

  const majorSet = new Set(major);
  return stepValues(scale.domain, unit).filter((v) => !majorSet.has(v));
}

/**
 * The pixel row the HORIZONTAL axis sits on — Excel's "Vertical axis crosses".
 * Clamped into the plot, so `crossesAt: "value"` with a value off the scale
 * parks the axis on the nearest edge instead of drawing outside the plot.
 */
export function axisCrossingY(
  yScale: LinearScale,
  axis: AxisSpec,
  plotArea: { x: number; y: number; width: number; height: number },
): number {
  const bottom = plotArea.y + plotArea.height;
  let value: number;
  switch (axis.crossesAt ?? "auto") {
    case "min": value = Math.min(yScale.domain[0], yScale.domain[1]); break;
    case "max": value = Math.max(yScale.domain[0], yScale.domain[1]); break;
    case "value": value = axis.crossesAtValue ?? 0; break;
    default: return bottom; // "auto" — the plot's bottom edge
  }
  const y = yScale.scale(value);
  if (!Number.isFinite(y)) return bottom;
  return Math.max(plotArea.y, Math.min(bottom, y));
}

// ============================================================================
// Drawing: Axes (for cartesian charts)
// ============================================================================

/**
 * `layout` is OPTIONAL and exists only for the element-rect write-back: when a
 * painter passes it, the axis titles, the display-unit label and the y-label
 * band replace the layout's character-count estimates with their measured
 * boxes. Omitting it paints exactly as before and leaves the estimates in place.
 */
export function drawCartesianAxes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  xScale: BandScale,
  yScale: LinearScale,
  plotArea: { x: number; y: number; width: number; height: number },
  spec: ChartSpec,
  theme: ChartRenderTheme,
  layout?: ChartLayout,
): void {
  // Where the horizontal axis sits. "auto" is the plot's bottom edge; a
  // `crossesAt` moves the LINE, its tick marks and its tick labels together,
  // because in Excel they are one object.
  const xAxisY = axisCrossingY(yScale, spec.yAxis, plotArea);
  const plotBottom = plotArea.y + plotArea.height;

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

  // Y axis line — always the FULL height of the plot. It used to stop at
  // `xAxisY`, which was the same pixel while the X axis was pinned to the
  // bottom; once the X axis can cross in the middle, stopping there would cut
  // the value axis in half.
  if (spec.yAxis.showLine !== false) {
    ctx.strokeStyle = spec.yAxis.lineColor ?? theme.axisColor;
    ctx.lineWidth = spec.yAxis.lineWidth ?? 1;
    ctx.setLineDash(spec.yAxis.lineDash ?? []);
    ctx.beginPath();
    ctx.moveTo(plotArea.x - 0.5, plotArea.y);
    ctx.lineTo(plotArea.x - 0.5, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // -- Tick Marks --
  const yTicks = axisTickValues(yScale, spec.yAxis);
  drawTickMarks(
    ctx, spec.yAxis,
    yTicks.map((t) => yScale.scale(t)),
    axisMinorTickValues(yScale, spec.yAxis, yTicks).map((t) => yScale.scale(t)),
    "y", theme, plotArea.x,
  );
  drawTickMarks(
    ctx, spec.xAxis,
    xScale.domain.map((_, ci) => xScale.scaleIndex(ci) + xScale.bandwidth / 2),
    // A category axis has no minor unit — minor ticks subdivide a VALUE.
    [],
    "x", theme, xAxisY,
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

    // The layout estimated this band at the plot's bottom edge. When the axis
    // CROSSED somewhere else the labels went with it, so that estimate now
    // points at empty pixels — record where they actually landed. Left alone in
    // the ordinary case so every existing chart keeps the estimate it had.
    if (layout && xAxisY !== plotBottom) {
      const bandHeight = angle === 0
        ? theme.labelFontSize + 8
        : widestLabelWidth(ctx, xScale.domain) * Math.abs(Math.sin(angleRad)) + 8;
      recordChartElementRect(layout, "xAxisBand", {
        x: plotArea.x,
        y: xAxisY,
        width: plotArea.width,
        height: bandHeight,
      });
    }
  }

  // X axis title
  if (spec.xAxis.title) {
    ctx.fillStyle = theme.axisTitleColor;
    ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const baselineY = plotArea.y + plotArea.height + (spec.xAxis.showLabels ? 30 : 16);
    ctx.fillText(spec.xAxis.title, plotArea.x + plotArea.width / 2, baselineY);
    if (layout) {
      recordXAxisTitleRect(ctx, layout, spec.xAxis.title, plotArea, baselineY, theme);
    }
  }

  // -- Y Axis Labels --
  let widestYLabel = 0;
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
      const w = ctx.measureText(label).width;
      if (w > widestYLabel) widestYLabel = w;
      ctx.fillText(label, plotArea.x - 6, y);
    }
    if (layout) {
      // Labels are right-aligned at plotArea.x - 6, so the band runs from the
      // widest label's left edge to the axis line.
      const bandWidth = widestYLabel + 6;
      recordChartElementRect(layout, "yAxisBand", {
        x: plotArea.x - bandWidth,
        y: plotArea.y,
        width: bandWidth,
        height: plotArea.height,
      });
    }
  }

  // Y axis display unit label
  if (spec.yAxis.displayUnit && spec.yAxis.displayUnit !== "none" && spec.yAxis.showDisplayUnitLabel) {
    const fs = theme.labelFontSize - 1;
    ctx.fillStyle = theme.axisLabelColor;
    ctx.font = `italic ${fs}px ${theme.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const label = getDisplayUnitLabel(spec.yAxis.displayUnit);
    ctx.fillText(label, plotArea.x + 2, plotArea.y - 2);
    if (layout) {
      recordChartElementRect(layout, "displayUnitLabel", {
        x: plotArea.x + 2,
        y: plotArea.y - 2 - fs,
        width: ctx.measureText(label).width,
        height: fs,
      });
    }
  }

  // Y axis title
  if (spec.yAxis.title) {
    ctx.save();
    ctx.fillStyle = theme.axisTitleColor;
    ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
    ctx.translate(Y_AXIS_TITLE_X, plotArea.y + plotArea.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(spec.yAxis.title, 0, 0);
    // Measure BEFORE restore: restore() puts the previous font back, and
    // measuring under the wrong font is how a "measured" rect becomes fiction.
    const titleWidth = ctx.measureText(spec.yAxis.title).width;
    ctx.restore();
    if (layout) {
      recordYAxisTitleRect(layout, plotArea, titleWidth, theme);
    }
  }
}

/**
 * Write back the X axis title's measured box. It is painted centered on the
 * plot with a "bottom" baseline, so the box ENDS at `baselineY`.
 */
function recordXAxisTitleRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layout: ChartLayout,
  title: string,
  plotArea: { x: number; y: number; width: number; height: number },
  baselineY: number,
  theme: ChartRenderTheme,
): void {
  const w = ctx.measureText(title).width;
  recordChartElementRect(layout, "xAxisTitle", {
    x: plotArea.x + plotArea.width / 2 - w / 2,
    y: baselineY - theme.axisTitleFontSize,
    width: w,
    height: theme.axisTitleFontSize,
  });
}

/**
 * Write back the Y axis title's measured box. It is painted rotated -90deg
 * about (Y_AXIS_TITLE_X, plot vertical centre) with a "top" baseline: local +x
 * runs UP the canvas and local +y runs RIGHT, so the glyph run becomes a TALL
 * box one font-size wide and `w` (the measured text width) tall.
 */
function recordYAxisTitleRect(
  layout: ChartLayout,
  plotArea: { x: number; y: number; width: number; height: number },
  w: number,
  theme: ChartRenderTheme,
): void {
  recordChartElementRect(layout, "yAxisTitle", {
    x: Y_AXIS_TITLE_X,
    y: plotArea.y + plotArea.height / 2 - w / 2,
    width: theme.axisTitleFontSize,
    height: w,
  });
}

// ============================================================================
// Tick Mark Drawing
// ============================================================================

/**
 * Draw an axis's tick marks.
 *
 * `anchor` is the pixel the axis LINE sits on — the y of the horizontal axis
 * (which `crossesAt` can move) or the x of the vertical one. It is passed in
 * rather than derived from the plot area, because deriving it here is exactly
 * how the ticks would stay at the bottom after the line moved.
 *
 * Minor ticks are drawn at 60% of the major length, Excel's proportion, and
 * with the same inside/outside/cross rule read from `minorTickMark`.
 */
function drawTickMarks(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  axisSpec: AxisSpec,
  positions: number[],
  minorPositions: number[],
  axis: "x" | "y",
  theme: ChartRenderTheme,
  anchor: number,
): void {
  const majorType = axisSpec.majorTickMark ?? "outside";
  const minorType = axisSpec.minorTickMark ?? "none";
  if (majorType === "none" && minorType === "none") return;

  ctx.strokeStyle = axisSpec.lineColor ?? theme.axisColor;
  ctx.lineWidth = 1;
  const majorLen = 5;
  const minorLen = 3;

  const stroke = (pos: number, type: TickMarkType, len: number) => {
    if (axis === "x") {
      if (type === "outside" || type === "cross") {
        ctx.moveTo(pos, anchor);
        ctx.lineTo(pos, anchor + len);
      }
      if (type === "inside" || type === "cross") {
        ctx.moveTo(pos, anchor);
        ctx.lineTo(pos, anchor - len);
      }
    } else {
      if (type === "outside" || type === "cross") {
        ctx.moveTo(anchor, pos);
        ctx.lineTo(anchor - len, pos);
      }
      if (type === "inside" || type === "cross") {
        ctx.moveTo(anchor, pos);
        ctx.lineTo(anchor + len, pos);
      }
    }
  };

  ctx.beginPath();
  if (majorType !== "none") {
    for (const pos of positions) stroke(pos, majorType, majorLen);
  }
  if (minorType !== "none") {
    for (const pos of minorPositions) stroke(pos, minorType, minorLen);
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
 *
 * `layout` is OPTIONAL and exists only for the element-rect write-back (see
 * {@link drawCartesianAxes}). Omitting it paints exactly as before.
 */
export function drawHorizontalAxes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  xScale: LinearScale,
  yScale: BandScale,
  plotArea: { x: number; y: number; width: number; height: number },
  spec: ChartSpec,
  theme: ChartRenderTheme,
  layout?: ChartLayout,
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

  // X axis labels (values, at bottom). This painter's VALUE axis is X, so
  // `xAxis.majorUnit` is the one that pins its ticks. It draws no tick marks
  // and no crossing, so minorTickMark / crossesAt have nothing to act on here.
  if (spec.xAxis.showLabels) {
    const ticks = axisTickValues(xScale, spec.xAxis);
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
    const baselineY = plotArea.y + plotArea.height + (spec.xAxis.showLabels ? 26 : 16);
    ctx.fillText(spec.xAxis.title, plotArea.x + plotArea.width / 2, baselineY);
    if (layout) {
      recordXAxisTitleRect(ctx, layout, spec.xAxis.title, plotArea, baselineY, theme);
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
    const titleWidth = ctx.measureText(spec.yAxis.title).width;
    ctx.restore();
    if (layout) {
      recordYAxisTitleRect(layout, plotArea, titleWidth, theme);
    }
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
  drawCartesianAxes(ctx, xScale, yScale, plotArea, spec, theme, layout);
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
  // A categorical scale ("band"/"point", what an ordinal/nominal x channel lowers
  // to) is a positive instruction — "these labels are categories, in this order" —
  // so it must SUPPRESS the proportional axis rather than opt into it. Without
  // this, declaring the field ordinal would do the opposite of what it says: on
  // line/area the opt-in test IS "xAxis.scale is set", and on scatter/bubble
  // proportional is already the default, so a category column that happens to
  // parse as numbers would get re-spaced by value.
  const declared = spec.xAxis.scale?.type;
  const categorical = declared === "band" || declared === "point";
  const optedIn = !categorical && (!options?.requireScale || spec.xAxis.scale != null);

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
