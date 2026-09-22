//! FILENAME: app/extensions/Charts/rendering/dataTablePainter.ts
// PURPOSE: Renders a data table grid below the chart plot area showing raw values.
// CONTEXT: Called after all chart marks are painted. Draws a grid with category
//          labels and series values, optionally with legend color swatches.
//          The BAND it occupies is owned by chartPainterUtils (see the
//          "data-table band" section there) — this file only paints into it.

import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { seriesPaletteIndex } from "../lib/encodingResolver";
import {
  formatTickValue,
  recordChartElementRect,
  chartShowsDataTable,
  dataTableRect,
  xAxisTitleBaselineBelowDataTable,
  layoutHasXAxis,
  DATA_TABLE_ROW_HEIGHT,
} from "./chartPainterUtils";

// The band arithmetic lives with the layout that reserves it, so the reserved
// height and the painted height cannot drift apart.
export { computeDataTableHeight } from "./chartPainterUtils";

// ============================================================================
// Constants
// ============================================================================

/** Row height in pixels for each data table row. */
const ROW_HEIGHT = DATA_TABLE_ROW_HEIGHT;
/** Font used for data table text. */
const TABLE_FONT_SIZE = 10;
/**
 * Width of the legend-key gutter, painted to the LEFT of the grid.
 *
 * It used to be the table's first COLUMN, which pushed every category column
 * 30px right of the band it was supposed to label — so a column never sat
 * under its own bar. Excel puts the row headers outside the plot span; the
 * swatches now go into the (empty) left margin below the y-axis labels, and
 * the grid itself spans the plot exactly.
 */
const LEGEND_KEY_GUTTER = 30;

// ============================================================================
// Public API
// ============================================================================

/**
 * Paint a data table below the plot area.
 * The layout must already have its plotArea reduced by the table's band —
 * `computeCartesianLayout` / `computeRadialLayout` do that.
 *
 * COLUMN ALIGNMENT: the grid spans the plot area exactly and divides it into
 * `categories.length` equal slices. That is not an approximation — a band
 * scale's step is `W / (n * (1 + padding))` with an outer padding of half an
 * inner one, so band centre `i` lands on `plotArea.x + (i + 0.5) * W / n` for
 * EVERY padding value. Equal slices therefore centre each column on its own
 * bar, which is the whole point of a data table.
 *
 * SELECTABILITY: the grid's box is recorded onto `layout.elements.dataTable`,
 * so it is hit-testable as Excel's `xlDataTable`. It is ONE object — Excel has
 * no addressable data-table cell — which is why this is a single rect and not a
 * collection. Nothing is recorded when there is nothing to draw, so a hit can
 * never land on a table that was skipped for want of series or categories.
 */
export function paintDataTable(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const opts = spec.dataTable;
  if (!opts) return;
  const grid = dataTableRect(spec, data, layout.plotArea, theme);
  if (!grid) return;

  const showLegendKeys = opts.showLegendKeys !== false;
  const showHBorder = opts.showHorizontalBorder !== false;
  const showVBorder = opts.showVerticalBorder !== false;
  const showOutline = opts.showOutlineBorder !== false;

  const numCols = data.categories.length;
  const numRows = data.series.length + 1; // +1 for the category header row

  const tableTop = grid.y;
  const tableLeft = grid.x;
  const tableWidth = grid.width;
  const tableHeight = grid.height;
  const colWidth = tableWidth / numCols;

  const font = `${TABLE_FONT_SIZE}px ${theme.fontFamily}`;
  const boldFont = `600 ${TABLE_FONT_SIZE}px ${theme.fontFamily}`;
  const borderColor = theme.gridLineColor ?? "#d0d0d0";

  ctx.save();

  // --- Draw cell contents ---

  // Row 0: Category labels. These ARE the category axis labelling — the axis's
  // own tick labels are suppressed while the table is on (specForMarkPaint), so
  // the two no longer paint the same four strings on top of each other.
  ctx.font = boldFont;
  ctx.fillStyle = theme.axisLabelColor ?? "#666666";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let ci = 0; ci < numCols; ci++) {
    const cellX = tableLeft + ci * colWidth;
    const cellCenterX = cellX + colWidth / 2;
    const cellCenterY = tableTop + ROW_HEIGHT / 2;

    // Clip text to cell width
    ctx.save();
    ctx.beginPath();
    ctx.rect(cellX + 1, tableTop, colWidth - 2, ROW_HEIGHT);
    ctx.clip();
    ctx.fillText(data.categories[ci], cellCenterX, cellCenterY);
    ctx.restore();
  }

  // Rows 1..N: Series values
  for (let si = 0; si < data.series.length; si++) {
    const series = data.series[si];
    const rowY = tableTop + (si + 1) * ROW_HEIGHT;

    // Legend key swatch, in the gutter LEFT of the grid. Clamped to the canvas
    // so a chart with no left margin (no y labels, no y title) still shows it
    // rather than painting off-canvas.
    if (showLegendKeys) {
      const swatchSize = 8;
      const gutterLeft = Math.max(0, tableLeft - LEGEND_KEY_GUTTER);
      const swatchX = gutterLeft + (Math.min(LEGEND_KEY_GUTTER, tableLeft) - swatchSize) / 2;
      const swatchY = rowY + (ROW_HEIGHT - swatchSize) / 2;
      const color = getSeriesColor(spec.palette, seriesPaletteIndex(data, si), series.color);
      ctx.fillStyle = color;
      ctx.fillRect(swatchX, swatchY, swatchSize, swatchSize);
    }

    // Values
    ctx.font = font;
    ctx.fillStyle = theme.axisLabelColor ?? "#666666";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let ci = 0; ci < numCols; ci++) {
      const value = series.values[ci];
      if (value == null || isNaN(value)) continue;

      const cellX = tableLeft + ci * colWidth;
      const cellCenterX = cellX + colWidth / 2;
      const cellCenterY = rowY + ROW_HEIGHT / 2;

      const text = formatTickValue(value);

      ctx.save();
      ctx.beginPath();
      ctx.rect(cellX + 1, rowY, colWidth - 2, ROW_HEIGHT);
      ctx.clip();
      ctx.fillText(text, cellCenterX, cellCenterY);
      ctx.restore();
    }
  }

  // --- Draw borders ---
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);

  // Horizontal borders
  if (showHBorder) {
    for (let ri = 0; ri <= numRows; ri++) {
      const y = Math.floor(tableTop + ri * ROW_HEIGHT) + 0.5;
      ctx.beginPath();
      ctx.moveTo(tableLeft, y);
      ctx.lineTo(tableLeft + tableWidth, y);
      ctx.stroke();
    }
  }

  // Vertical borders — one per category boundary, so they line up with the gaps
  // between the bars.
  if (showVBorder) {
    for (let ci = 0; ci <= numCols; ci++) {
      const x = Math.floor(tableLeft + ci * colWidth) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, tableTop);
      ctx.lineTo(x, tableTop + tableHeight);
      ctx.stroke();
    }
  }

  // Outline border
  if (showOutline) {
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.floor(tableLeft) + 0.5,
      Math.floor(tableTop) + 0.5,
      Math.floor(tableWidth),
      Math.floor(tableHeight),
    );
  }

  ctx.restore();

  recordChartElementRect(layout, "dataTable", grid);
}

/**
 * Paint the x-axis title BELOW the data table, and record the box it actually
 * landed in.
 *
 * The mark painters never see this title while a table is on — `specForMarkPaint`
 * takes it away from them — precisely because they would paint it at their own
 * drop of 30px below the plot, which is inside the table. It is drawn here, in
 * the same file that owns the table's geometry, from the one baseline helper
 * the layout's estimate also uses.
 *
 * No-op when there is no table, no title, or no x axis to hang one on (a pie
 * keeps a `xAxis.title` it inherited from the mark it used to be — see
 * {@link layoutHasXAxis}), so the ordinary path is untouched.
 */
export function paintDataTableAxisTitle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  if (!spec.xAxis.title) return;
  if (!chartShowsDataTable(spec, data)) return;
  if (!layoutHasXAxis(layout)) return;
  const baselineY = xAxisTitleBaselineBelowDataTable(spec, data, layout.plotArea, theme);
  if (baselineY === null) return;

  const plotArea = layout.plotArea;
  ctx.save();
  ctx.fillStyle = theme.axisTitleColor;
  ctx.font = `${theme.axisTitleFontSize}px ${theme.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(spec.xAxis.title, plotArea.x + plotArea.width / 2, baselineY);
  // Measure BEFORE restore: restore() puts the previous font back, and a rect
  // measured under the wrong font is fiction the hit test then trusts.
  const w = ctx.measureText(spec.xAxis.title).width;
  ctx.restore();

  recordChartElementRect(layout, "xAxisTitle", {
    x: plotArea.x + plotArea.width / 2 - w / 2,
    y: baselineY - theme.axisTitleFontSize,
    width: w,
    height: theme.axisTitleFontSize,
  });
}
