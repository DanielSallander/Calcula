//! FILENAME: app/extensions/ConditionalFormatting/rendering/iconSetRenderer.ts
// PURPOSE: Grid overlay renderer for conditional formatting icon sets.
// CONTEXT: Draws small icons inside cells based on the icon index from evaluation results.

import type { OverlayRenderContext, IconSetType } from "../../../src/api";
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
import { drawIcon } from "./iconShapes";

const ICON_SIZE = 14;

/**
 * Render icon sets for all visible cf-icon-set regions.
 */
export function renderIconSets(context: OverlayRenderContext): void {
  const { ctx } = context;
  const regions = getGridRegions().filter((r) => r.type === "cf-icon-set");

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

    const iconCf = cfs.find((cf) => cf.iconIndex != null);
    if (!iconCf || iconCf.iconIndex == null) continue;

    // Find the matching IconSet rule for the icon set type
    const ruleId = region.data?.ruleId as number | undefined;
    let iconSetType: IconSetType = "threeTrafficLights1";

    if (ruleId != null) {
      const rules = getRules();
      const matchingRule = rules.find((r) => r.id === ruleId);
      if (matchingRule && matchingRule.rule.type === "iconSet") {
        const isRule = matchingRule.rule as { type: "iconSet"; iconSet: IconSetType };
        iconSetType = isRule.iconSet;
      }
    }

    // Position icon at left side of cell, vertically centered
    const iconX = Math.max(cellX, rhw) + 2;
    const iconY = Math.max(cellY, chh) + (cellH - ICON_SIZE) / 2;

    ctx.save();
    drawIcon(ctx, iconSetType, iconCf.iconIndex, iconX, iconY, ICON_SIZE);
    ctx.restore();
  }
}
