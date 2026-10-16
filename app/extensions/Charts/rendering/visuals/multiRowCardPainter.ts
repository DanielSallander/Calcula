//! FILENAME: app/extensions/Charts/rendering/visuals/multiRowCardPainter.ts
// PURPOSE: The Multi-row card visual (Power BI's legacy multi-row card): one
//          row per category; in each row the category as the title, then every
//          value field as a value-over-label pair; an accent bar on the row's
//          left edge.
// CONTEXT: Funnel-template painter, registered from chartDispatch.
//
//          DATA. Categories are the rows, series are the fields. Each value is
//          one datum (series, category) and is written through the shared
//          visual formatter: text as text, numbers with display units Auto.
//
//          ROWS THAT DO NOT FIT are not drawn (Power BI scrolls; a canvas tile
//          cannot), and the last row that fits says how many were left out —
//          a silently shortened list reads as the whole list.
//
//          COLOUR. The accent bar is the first series' colour (its palette
//          colour by default): Power BI's accent is the theme's first data
//          colour, and the series swatch in the Format pane is how a reader
//          changes it. Values are the theme's text colour; a per-point override
//          colours one value.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, MultiRowCardMarkOptions } from "../../types";
import type { ChartRenderTheme } from "../chartTheme";
import { getSeriesColor } from "../chartTheme";
import { resolveDatumStyle } from "../../lib/dataPointOverrides";
import { drawRoundedRect, truncateText } from "../chartPainterUtils";
import { datumValue, formatVisualValue, visualFormatFor } from "./visualValues";
import { computeVisualLayout, drawVisualFrame, fitFontSize } from "./visualLayout";

const ROW_GAP = 6;
const ACCENT_WIDTH = 4;
const PAD = 10;

export function computeMultiRowCardLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  return computeVisualLayout(width, height, spec, data, theme);
}

interface RowGeometry {
  /** Height of one row, px. */
  rowHeight: number;
  /** How many rows fit. */
  visible: number;
  titlePx: number;
  valuePx: number;
  labelPx: number;
}

function rowGeometry(data: ParsedChartData, layout: ChartLayout, theme: ChartRenderTheme, showTitle: boolean): RowGeometry {
  const titlePx = theme.labelFontSize + 3;
  const valuePx = Math.max(16, theme.labelFontSize * 2);
  const labelPx = theme.labelFontSize;
  const rowHeight = PAD * 2 + (showTitle ? titlePx + 6 : 0) + valuePx + 4 + labelPx;
  const fit = Math.max(1, Math.floor((layout.plotArea.height + ROW_GAP) / (rowHeight + ROW_GAP)));
  return { rowHeight, visible: Math.min(data.categories.length, fit), titlePx, valuePx, labelPx };
}

/** The value cell of field `si` in row `ci`. */
function cellBox(
  layout: ChartLayout,
  g: RowGeometry,
  seriesCount: number,
  si: number,
  ci: number,
  showTitle: boolean,
): { x: number; y: number; width: number; height: number } {
  const { plotArea } = layout;
  const rowY = plotArea.y + ci * (g.rowHeight + ROW_GAP);
  const innerX = plotArea.x + ACCENT_WIDTH + PAD;
  const innerW = Math.max(1, plotArea.width - ACCENT_WIDTH - PAD * 2);
  const colW = innerW / Math.max(1, seriesCount);
  const top = rowY + PAD + (showTitle ? g.titlePx + 6 : 0);
  return { x: innerX + si * colW, y: top, width: colW, height: g.valuePx + 4 + g.labelPx };
}

export function paintMultiRowCardChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const opts = (spec.markOptions ?? {}) as MultiRowCardMarkOptions;
  const showTitle = opts.showRowTitle !== false;
  const showAccent = opts.showAccentBar !== false;
  const { plotArea } = layout;

  drawVisualFrame(ctx, spec, layout, theme);
  if (data.series.length === 0) return;

  const g = rowGeometry(data, layout, theme, showTitle);
  const accent = getSeriesColor(spec.palette, 0, data.series[0].color);

  for (let ci = 0; ci < g.visible; ci++) {
    const rowY = plotArea.y + ci * (g.rowHeight + ROW_GAP);

    // Row card and its accent bar.
    ctx.fillStyle = theme.plotBackground;
    drawRoundedRect(ctx, plotArea.x, rowY, plotArea.width, g.rowHeight, 3);
    ctx.fill();
    if (showAccent) {
      ctx.fillStyle = accent;
      ctx.fillRect(plotArea.x, rowY, ACCENT_WIDTH, g.rowHeight);
    }

    if (showTitle) {
      const hidden = data.categories.length - g.visible;
      const title = ci === g.visible - 1 && hidden > 0
        ? `${data.categories[ci]} (+${hidden} more)`
        : data.categories[ci];
      ctx.fillStyle = theme.titleColor;
      ctx.font = `600 ${g.titlePx}px ${theme.fontFamily}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(truncateText(ctx, title, plotArea.width - ACCENT_WIDTH - PAD * 2), plotArea.x + ACCENT_WIDTH + PAD, rowY + PAD);
    }

    for (let si = 0; si < data.series.length; si++) {
      const cell = cellBox(layout, g, data.series.length, si, ci, showTitle);
      // A blank cell is "(Blank)", never the 0 the reader wrote for it.
      const text = formatVisualValue(datumValue(data, si, ci), visualFormatFor(spec, opts, data.series[si]?.name));
      const style = resolveDatumStyle(spec, data, si, ci, { fill: theme.titleColor });

      if (style.opacity != null) {
        ctx.save();
        ctx.globalAlpha = style.opacity;
      }
      ctx.fillStyle = style.fill;
      fitFontSize(ctx, text, cell.width - 6, g.valuePx, 9, "600", theme.fontFamily);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(text, cell.x, cell.y);
      if (style.opacity != null) ctx.restore();

      ctx.fillStyle = theme.axisLabelColor;
      ctx.font = `${g.labelPx}px ${theme.fontFamily}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(truncateText(ctx, data.series[si].name, cell.width - 6), cell.x, cell.y + g.valuePx + 4);
    }
  }
}

export function computeMultiRowCardBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): BarRect[] {
  const opts = (spec.markOptions ?? {}) as MultiRowCardMarkOptions;
  const showTitle = opts.showRowTitle !== false;
  const rects: BarRect[] = [];
  if (data.series.length === 0) return rects;
  const g = rowGeometry(data, layout, theme, showTitle);
  for (let ci = 0; ci < g.visible; ci++) {
    for (let si = 0; si < data.series.length; si++) {
      const cell = cellBox(layout, g, data.series.length, si, ci, showTitle);
      rects.push({
        seriesIndex: si,
        categoryIndex: ci,
        ...cell,
        value: data.series[si].values[ci] ?? 0,
        seriesName: data.series[si].name,
        categoryName: data.categories[ci] ?? "",
      });
    }
  }
  return rects;
}
