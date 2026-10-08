//! FILENAME: app/extensions/Charts/rendering/visuals/cardPainter.ts
// PURPOSE: The Card visual (Power BI's card): one large callout value per value
//          field, written with display units "Auto", with the field's name
//          under it as the category label.
// CONTEXT: Built on the funnel template (computeXLayout / paintX / computeXRects)
//          and registered from chartDispatch like every built-in.
//
//          DATA. Each SERIES is a value field and gets its own card, side by
//          side across the plot — Power BI's "add more values and more cards
//          appear". A field with many rows becomes one value through
//          `markOptions.aggregate` (Power BI's default: one datum as it is, a
//          numeric field summed, a text field's first value). A TEXT value is
//          shown as its text, from `data.displayValues`; the parser's 0 for it
//          is never painted.
//
//          ITS DATUM, for per-point formatting and hit-testing, is (series, 0):
//          "the card of this field". A card summarises its categories, so there
//          is no other single datum it could honestly claim.
//
//          COLOUR. The callout is the theme's text colour, as Power BI's is. A
//          series colour colours it (the Format pane's swatch must do
//          something on a card — the coverage test holds the painter to it),
//          and a per-point override wins over both.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, CardMarkOptions } from "../../types";
import type { ChartRenderTheme } from "../chartTheme";
import { resolveDatumStyle } from "../../lib/dataPointOverrides";
import { truncateText } from "../chartPainterUtils";
import { aggregateSeries, formatVisualValue } from "./visualValues";
import { computeVisualLayout, drawVisualFrame, fitFontSize } from "./visualLayout";

/** Gap between two cards, px. */
const CARD_GAP = 8;

/** Largest callout, px — Power BI's card callout is about this size on a default tile. */
const MAX_CALLOUT_PX = 48;

export function computeCardLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  return computeVisualLayout(width, height, spec, data, theme);
}

/** The box of card `si` of `count` inside the plot area. */
function cardBox(layout: ChartLayout, si: number, count: number): { x: number; y: number; width: number; height: number } {
  const { plotArea } = layout;
  const n = Math.max(1, count);
  const width = Math.max(1, (plotArea.width - CARD_GAP * (n - 1)) / n);
  return { x: plotArea.x + si * (width + CARD_GAP), y: plotArea.y, width, height: plotArea.height };
}

export function paintCardChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const opts = (spec.markOptions ?? {}) as CardMarkOptions;
  const showLabel = opts.showCategoryLabel !== false;

  drawVisualFrame(ctx, spec, layout, theme);

  const count = data.series.length;
  for (let si = 0; si < count; si++) {
    const box = cardBox(layout, si, count);
    const series = data.series[si];
    const shown = aggregateSeries(data, si, opts.aggregate ?? "auto");
    const text = formatVisualValue(shown, opts);

    // The card's datum is (si, 0) in painter space; the resolver translates it.
    const style = resolveDatumStyle(spec, data, si, 0, { fill: series.color ?? theme.titleColor });

    const labelPx = Math.max(theme.labelFontSize + 2, Math.round(theme.labelFontSize * 1.3));
    const labelBand = showLabel ? labelPx + 8 : 0;
    const maxCallout = Math.min(opts.calloutFontSize ?? MAX_CALLOUT_PX, Math.max(12, (box.height - labelBand) * 0.6));
    const calloutPx = fitFontSize(ctx, text, box.width - 8, maxCallout, 10, "600", theme.fontFamily);

    // Callout and label are centred as ONE block in the card.
    const blockHeight = calloutPx + labelBand;
    const top = box.y + Math.max(0, (box.height - blockHeight) / 2);
    const cx = box.x + box.width / 2;

    if (style.opacity != null) {
      ctx.save();
      ctx.globalAlpha = style.opacity;
    }
    ctx.fillStyle = style.fill;
    ctx.font = `600 ${calloutPx}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, top + calloutPx / 2);
    if (style.opacity != null) ctx.restore();

    if (showLabel) {
      ctx.fillStyle = theme.axisLabelColor;
      ctx.font = `${labelPx}px ${theme.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(truncateText(ctx, series.name, box.width - 8), cx, top + calloutPx + 8);
    }
  }
}

export function computeCardBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): BarRect[] {
  const opts = (spec.markOptions ?? {}) as CardMarkOptions;
  const count = data.series.length;
  const rects: BarRect[] = [];
  for (let si = 0; si < count; si++) {
    const box = cardBox(layout, si, count);
    const shown = aggregateSeries(data, si, opts.aggregate ?? "auto");
    rects.push({
      seriesIndex: si,
      categoryIndex: 0,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      value: shown.value ?? 0,
      seriesName: data.series[si].name,
      categoryName: data.categories[shown.categoryIndex >= 0 ? shown.categoryIndex : 0] ?? data.series[si].name,
    });
  }
  return rects;
}
