//! FILENAME: app/extensions/Charts/rendering/dataTablePainter.ts
// PURPOSE: Renders a data table grid below the chart plot area showing raw values.
// CONTEXT: Called after all chart marks are painted. Draws a grid with category
//          labels and series values, optionally with legend color swatches.

import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  DataTableOptions,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { formatTickValue } from "./chartPainterUtils";

// ============================================================================
// Constants
// ============================================================================

/** Row height in pixels for each data table row. */
const ROW_HEIGHT = 18;
/** Padding inside cells. */
const CELL_PADDING_X = 6;
/** Font used for data table text. */
const TABLE_FONT_SIZE = 10;

// ============================================================================
// Layout Adjustment
// ============================================================================

/**
 * Compute how much vertical space the data table needs.
 * Returns the height in pixels to reserve below the plot area.
 * Call this during layout computation to reduce plotArea.height.
 */
export function computeDataTableHeight(
  spec: ChartSpec,
  data: ParsedChartData,
): number {
  if (!spec.dataTable?.enabled) return 0;
  // One header row (categories) + one row per series
  const rowCount = data.series.length + 1;
  return rowCount * ROW_HEIGHT + 4; // +4 for top margin
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Paint a data table below the plot area.
 * The layout must already have its plotArea reduced by computeDataTableHeight().
 */
export function paintDataTable(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const opts = spec.dataTable;
  if (!opts || !opts.enabled) return;
  if (data.series.length === 0 || data.categories.length === 0) return;

  const showLegendKeys = opts.showLegendKeys !== false;
  const showHBorder = opts.showHorizontalBorder !== false;
  const showVBorder = opts.showVerticalBorder !== false;
  const showOutline = opts.showOutlineBorder !== false;

  const { plotArea } = layout;
  const numCols = data.categories.length;
  const numRows = data.series.length + 1; // +1 for the category header row

  // Table starts just below the plot area
  const tableTop = plotArea.y + plotArea.height + 4;
  const tableLeft = plotArea.x;
  const tableWidth = plotArea.width;
  const tableHeight = numRows * ROW_HEIGHT;

  // Column widths: legend key column (optional) + one column per category
  const legendColWidth = showLegendKeys ? 30 : 0;
  const availableWidth = tableWidth - legendColWidth;
  const colWidth = availableWidth / numCols;

  const font = `${TABLE_FONT_SIZE}px ${theme.fontFamily}`;
  const boldFont = `600 ${TABLE_FONT_SIZE}px ${theme.fontFamily}`;
  const borderColor = theme.gridLineColor ?? "#d0d0d0";

  ctx.save();

  // --- Draw cell contents ---

  // Row 0: Category labels
  ctx.font = boldFont;
  ctx.fillStyle = theme.axisLabelColor ?? "#666666";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let ci = 0; ci < numCols; ci++) {
    const cellX = tableLeft + legendColWidth + ci * colWidth;
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

    // Legend key swatch
    if (showLegendKeys) {
      const swatchSize = 8;
      const swatchX = tableLeft + (legendColWidth - swatchSize) / 2;
      const swatchY = rowY + (ROW_HEIGHT - swatchSize) / 2;
      const color = getSeriesColor(spec.palette, si, series.color);
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

      const cellX = tableLeft + legendColWidth + ci * colWidth;
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

  // Vertical borders
  if (showVBorder) {
    // Legend column border
    if (showLegendKeys) {
      const x = Math.floor(tableLeft + legendColWidth) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, tableTop);
      ctx.lineTo(x, tableTop + tableHeight);
      ctx.stroke();
    }

    // Category column borders
    for (let ci = 0; ci <= numCols; ci++) {
      const x = Math.floor(tableLeft + legendColWidth + ci * colWidth) + 0.5;
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
}
