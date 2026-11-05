//! FILENAME: app/extensions/ConditionalFormatting/rendering/dataBarRenderer.ts
// PURPOSE: Grid overlay renderer for conditional formatting data bars, and the
//          pure per-cell bar painter it shares with the floating grid's paint.
// CONTEXT: Draws horizontal fill bars inside cells proportional to their data bar percentage.
//
// ONE PAINTER, TWO CALLERS. `paintDataBar(ctx, box, percent, rule)` draws one bar
// and knows nothing about where the box or the rule came from. The grid overlay
// below looks the rule up in this extension's store (the ACTIVE sheet's rules)
// and clamps the box to the visible cell area; the registered
// `@api/conditionalFormatPaint` painter (conditionalFormatPainter.ts) looks it up
// in the BACKING sheet's rules the object hands over. Both end here, so a bar on
// a floating grid and the same bar on the sheet cannot be drawn two ways.

import type { OverlayRenderContext } from "@api";
import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  getGridRegions,
} from "@api";
import type { CellBox } from "@api/cellPaint";
import { getEvaluationForCell, getRules } from "../lib/cfStore";
import type { DataBarRule, ConditionalFormatDefinition, CellConditionalFormat } from "@api";

/** Excel's default data bar colour (Blue Data Bar). */
export const DEFAULT_DATA_BAR_COLOR = "#638EC6";
/** Excel's default negative bar fill and border colour. */
export const DEFAULT_NEGATIVE_BAR_COLOR = "#FF0000";
/** Excel's default axis colour. */
export const DEFAULT_AXIS_COLOR = "#000000";
/** Inset of the bar inside its cell box, in px. */
const BAR_PADDING = 2;
/**
 * The axis's dash, in px: Excel's is ~3.8px on, ~1.3px off ([LIVE] PDF of a
 * 51pt cell, 2.88pt dashes at a 3.84pt pitch).
 */
const AXIS_DASH = [4, 1];

/**
 * The styling a data bar takes from its rule. Everything but the two original
 * fields is optional, so an object holding only `{ fillColor, gradientFill }`
 * still paints (borderless, LTR, Excel's default negative colours).
 */
export type DataBarStyle = Pick<DataBarRule, "fillColor" | "gradientFill"> &
  Partial<
    Pick<
      DataBarRule,
      "borderColor" | "negativeFillColor" | "negativeBorderColor" | "axisColor" | "axisPosition" | "direction"
    >
  >;

/**
 * One cell's bar as the backend resolved it (`CellConditionalFormat`): the
 * LENGTH (0..1 of the bar area), the AXIS when there is one (0..1 from the start
 * edge), and the sign.
 */
export interface DataBarValue {
  percent: number;
  axis?: number | null;
  negative?: boolean;
}

/** Where a bar and its axis land in a box. Pure geometry; see {@link layoutDataBar}. */
export interface DataBarLayout {
  /** The bar rectangle, or null for a zero-length bar. */
  bar: { x: number; y: number; width: number; height: number } | null;
  /** The x of the axis line, or null when none is drawn (no axis, or at an edge). */
  axisX: number | null;
  /** The bar's BASE end -- the axis side, where a gradient starts. */
  baseX: number;
  negative: boolean;
}

/**
 * Lay one data bar out inside a cell box, as Excel does ([LIVE] 2026-11-04,
 * the measurements are in `data_bar_geometry`, conditional_formatting.rs):
 *   - no axis: the bar runs from the start edge, `percent` of the area long;
 *   - an axis: a positive bar runs from the axis toward the far edge, a
 *     NEGATIVE one from the axis back toward the start edge;
 *   - right-to-left mirrors everything (the start edge is the right one).
 * The bar area is the box inset by 2px on every side.
 */
export function layoutDataBar(
  box: CellBox,
  value: DataBarValue,
  direction: DataBarStyle["direction"] = "context",
): DataBarLayout | null {
  const areaX = box.x + BAR_PADDING;
  const areaY = box.y + BAR_PADDING;
  const areaW = box.width - BAR_PADDING * 2;
  const areaH = box.height - BAR_PADDING * 2;
  if (areaW <= 0 || areaH <= 0) return null;

  const length = Math.max(0, Math.min(1, value.percent));
  const negative = value.negative === true;
  const axis = value.axis == null ? null : Math.max(0, Math.min(1, value.axis));
  // Fractions from the START edge: [from, to], `base` the axis-side end.
  let from: number;
  let to: number;
  let base: number;
  if (axis === null) {
    from = 0;
    to = length;
    base = 0;
  } else if (negative) {
    from = Math.max(0, axis - length);
    to = axis;
    base = axis;
  } else {
    from = axis;
    to = Math.min(1, axis + length);
    base = axis;
  }
  // "context" follows the sheet's direction, and a Calcula sheet is
  // left-to-right.
  const rtl = direction === "rightToLeft";
  const toX = (f: number) => (rtl ? areaX + (1 - f) * areaW : areaX + f * areaW);
  const x1 = toX(from);
  const x2 = toX(to);
  const left = Math.min(x1, x2);
  const width = Math.abs(x2 - x1);
  const axisX = axis !== null && axis > 0 && axis < 1 ? toX(axis) : null;
  return {
    bar: width > 0 ? { x: left, y: areaY, width, height: areaH } : null,
    axisX,
    baseX: toX(base),
    negative,
  };
}

/**
 * The data-bar rule with `ruleId` in `rules`, or null when there is none (or it
 * is not a data bar). The ONE lookup both callers use.
 */
export function findDataBarRule(
  rules: readonly ConditionalFormatDefinition[],
  ruleId: number | null | undefined,
): DataBarStyle | null {
  if (ruleId == null) return null;
  const match = rules.find((r) => r.id === ruleId);
  if (!match || match.rule.type !== "dataBar") return null;
  return match.rule as DataBarRule;
}

/**
 * Paint one data bar into `box` (the cell's box; the bar is inset by 2px).
 *
 * `value` is the backend's resolved bar (`dataBarPercent`, `dataBarAxis`,
 * `dataBarNegative`); a bare number is a length from the start edge. `rule`
 * supplies every styling option the rule carries (BUG-0511 -- the painter used
 * to read only the fill colour and the gradient switch, so a negative value
 * was a positive-coloured bar from the left edge):
 *   - positive bars in `fillColor`, negative ones in `negativeFillColor`
 *     (Excel's red by default);
 *   - a border only when the rule HAS one (`borderColor`; a negative bar's
 *     is `negativeBorderColor`, else its fill colour), as Excel's solid-fill
 *     presets have none;
 *   - the axis as Excel's dashed line in `axisColor` (black by default);
 *   - `direction` "rightToLeft" mirrors the bar;
 *   - opaque, as Excel paints it ([LIVE]: the PDF's fill alpha is 1). The
 *     painter used to draw every bar at 35% opacity.
 * null paints Excel's default bar: gradient blue with a blue border.
 */
export function paintDataBar(
  ctx: CanvasRenderingContext2D,
  box: CellBox,
  value: number | DataBarValue,
  rule: DataBarStyle | null,
): void {
  const bar: DataBarValue = typeof value === "number" ? { percent: value } : value;
  const layout = layoutDataBar(box, bar, rule?.direction);
  if (!layout) return;

  const gradientFill = rule?.gradientFill ?? true;
  const positiveFill = rule?.fillColor || DEFAULT_DATA_BAR_COLOR;
  const positiveBorder = rule ? rule.borderColor : DEFAULT_DATA_BAR_COLOR;
  const fillColor = layout.negative ? rule?.negativeFillColor || DEFAULT_NEGATIVE_BAR_COLOR : positiveFill;
  // A negative bar has a border exactly when the positive one does.
  const borderColor = positiveBorder
    ? layout.negative
      ? rule?.negativeBorderColor || fillColor
      : positiveBorder
    : undefined;

  ctx.save();

  if (layout.bar) {
    const { x, y, width, height } = layout.bar;
    if (gradientFill) {
      // The colour at the bar's BASE (its axis end, or the start edge), fading
      // toward the end the value reaches.
      const farX = layout.baseX === x ? x + width : x;
      const gradient = ctx.createLinearGradient(layout.baseX, 0, farX, 0);
      gradient.addColorStop(0, fillColor);
      gradient.addColorStop(1, adjustColorBrightness(fillColor, 0.6));
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = fillColor;
    }
    ctx.fillRect(x, y, width, height);

    if (borderColor) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
    }
  }

  if (layout.axisX !== null) {
    ctx.strokeStyle = rule?.axisColor || DEFAULT_AXIS_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash(AXIS_DASH);
    ctx.beginPath();
    const ax = Math.round(layout.axisX) + 0.5;
    ctx.moveTo(ax, box.y);
    ctx.lineTo(ax, box.y + box.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/** The bar a result carries, in the painter's terms. */
export function dataBarValueOf(cf: CellConditionalFormat): DataBarValue {
  return {
    percent: cf.dataBarPercent ?? 0,
    axis: cf.dataBarAxis ?? null,
    negative: cf.dataBarNegative === true,
  };
}

/**
 * Render data bars for all visible cf-data-bar regions.
 */
export function renderDataBars(context: OverlayRenderContext): void {
  const { ctx } = context;
  const regions = getGridRegions().filter((r) => r.type === "cf-data-bar");

  if (regions.length === 0) return;

  const rhw = overlayGetRowHeaderWidth(context);
  const chh = overlayGetColHeaderHeight(context);

  for (const region of regions) {
    const row = region.startRow;
    const col = region.startCol;

    const cellX = overlayGetColumnX(context, col);
    const cellY = overlayGetRowY(context, row);
    const cellW = overlayGetColumnWidth(context, col);
    const cellH = overlayGetRowHeight(context, row);

    // Skip if outside visible area
    if (
      cellX + cellW < rhw ||
      cellX > context.canvasWidth ||
      cellY + cellH < chh ||
      cellY > context.canvasHeight
    ) {
      continue;
    }

    // Get evaluation data
    const cfs = getEvaluationForCell(row, col);
    if (!cfs) continue;

    const barCf = cfs.find((cf) => cf.dataBarPercent != null);
    if (!barCf || barCf.dataBarPercent == null) continue;

    // The matching DataBar rule for styling, from this sheet's rule store.
    const ruleId = region.data?.ruleId as number | undefined;
    const rule = findDataBarRule(getRules(), ruleId);

    // The VISIBLE part of the cell: the bar must not paint under the headers.
    const left = Math.max(cellX, rhw);
    const top = Math.max(cellY, chh);
    const right = Math.min(cellX + cellW, context.canvasWidth);
    const bottom = Math.min(cellY + cellH, context.canvasHeight);

    paintDataBar(
      ctx,
      { x: left, y: top, width: right - left, height: bottom - top },
      dataBarValueOf(barCf),
      rule,
    );
  }
}

/**
 * Adjust color brightness by blending with white.
 * @param hexColor - Hex color string
 * @param factor - Blend factor (0 = original, 1 = white)
 */
function adjustColorBrightness(hexColor: string, factor: number): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  const newR = Math.round(r + (255 - r) * factor);
  const newG = Math.round(g + (255 - g) * factor);
  const newB = Math.round(b + (255 - b) * factor);

  return `#${newR.toString(16).padStart(2, "0")}${newG.toString(16).padStart(2, "0")}${newB.toString(16).padStart(2, "0")}`;
}
