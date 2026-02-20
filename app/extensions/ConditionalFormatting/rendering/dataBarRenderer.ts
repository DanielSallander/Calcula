//! FILENAME: app/extensions/ConditionalFormatting/rendering/dataBarRenderer.ts
// PURPOSE: Grid overlay renderer for conditional formatting data bars.
// CONTEXT: Draws horizontal fill bars inside cells proportional to their data bar percentage.

import type { OverlayRenderContext } from "../../../src/api";
import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  getGridRegions,
} from "../../../src/api";
import { getEvaluationForCell, getRules } from "../lib/cfStore";
import type { DataBarRule } from "../../../src/api";

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

    // Find the matching DataBar rule for styling
    const ruleId = region.data?.ruleId as number | undefined;
    let fillColor = "#638EC6";
    let gradientFill = true;

    if (ruleId != null) {
      const rules = getRules();
      const matchingRule = rules.find((r) => r.id === ruleId);
      if (matchingRule && matchingRule.rule.type === "dataBar") {
        const dbRule = matchingRule.rule as { type: "dataBar" } & DataBarRule;
        fillColor = dbRule.fillColor || fillColor;
        gradientFill = dbRule.gradientFill ?? true;
      }
    }

    const percent = barCf.dataBarPercent;

    // Calculate bar dimensions
    const padding = 2;
    const barX = Math.max(cellX, rhw) + padding;
    const barY = Math.max(cellY, chh) + padding;
    const maxBarW = Math.min(cellX + cellW, context.canvasWidth) - barX - padding;
    const barH = Math.min(cellY + cellH, context.canvasHeight) - barY - padding;

    if (maxBarW <= 0 || barH <= 0) continue;

    const barW = maxBarW * percent;

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
