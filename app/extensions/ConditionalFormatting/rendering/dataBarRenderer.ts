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
import type { DataBarRule, ConditionalFormatDefinition } from "@api";

/** Excel's default data bar colour (Blue Data Bar). */
export const DEFAULT_DATA_BAR_COLOR = "#638EC6";
/** Inset of the bar inside its cell box, in px. */
const BAR_PADDING = 2;

/** The styling a data bar takes from its rule. */
export type DataBarStyle = Pick<DataBarRule, "fillColor" | "gradientFill">;

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
 * `percent` is the backend's 0..1 fill fraction. `rule` supplies the colour and
 * the gradient switch; null paints Excel's default gradient blue.
 */
export function paintDataBar(
  ctx: CanvasRenderingContext2D,
  box: CellBox,
  percent: number,
  rule: DataBarStyle | null,
): void {
  const fillColor = rule?.fillColor || DEFAULT_DATA_BAR_COLOR;
  const gradientFill = rule?.gradientFill ?? true;

  const barX = box.x + BAR_PADDING;
  const barY = box.y + BAR_PADDING;
  const maxBarW = box.width - BAR_PADDING * 2;
  const barH = box.height - BAR_PADDING * 2;
  if (maxBarW <= 0 || barH <= 0) return;

  const clamped = Math.max(0, Math.min(1, percent));
  const barW = maxBarW * clamped;

  ctx.save();

  if (gradientFill) {
    // Gradient: solid color at left, fading to lighter at right
    const gradient = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    gradient.addColorStop(0, fillColor);
    gradient.addColorStop(1, adjustColorBrightness(fillColor, 0.6));
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = fillColor;
  }

  ctx.globalAlpha = 0.35;
  ctx.fillRect(barX, barY, barW, barH);

  // Draw border on the bar
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = fillColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);

  ctx.restore();
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
      barCf.dataBarPercent,
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
