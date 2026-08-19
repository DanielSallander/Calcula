//! FILENAME: app/extensions/ConditionalFormatting/rendering/iconSetRenderer.ts
// PURPOSE: Grid overlay renderer for conditional formatting icon sets.
// CONTEXT: Draws small icons inside cells based on the icon index from evaluation results.

import type { OverlayRenderContext, IconSetType } from "@api";
import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  getGridRegions,
} from "@api";
import { getEvaluationForCell } from "../lib/cfStore";
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

    // ONE RESOLVED ANSWER (BUG-0107). The index and the set now arrive together
    // from the rule that actually produced them.
    //
    // This used to be a JOIN OF TWO INDEPENDENT LOOKUPS: the index from the
    // backend, which cascades correctly (skips `enabled: false`, honours
    // `stopIfTrue`, respects priority), and the SET from
    // `findMatchingRuleId(row, col, "iconSet")`, which matched on rule type and
    // range containment ONLY. A disabled five-icon rule listed before an enabled
    // three-icon rule therefore drew a five-arrow glyph indexed 0..2 — a picture
    // assembled from two different rules, one of them switched off. And when no
    // rule id resolved, the renderer silently drew `threeTrafficLights1`, so a
    // cell could show traffic lights no rule had asked for.
    //
    // A cell with an index but no set is now SKIPPED rather than guessed at: a
    // wrong glyph is indistinguishable from a right one on screen, which is what
    // let this survive.
    const iconCf = cfs.find((cf) => cf.iconIndex != null && cf.iconSet != null);
    if (!iconCf || iconCf.iconIndex == null || iconCf.iconSet == null) continue;
    const iconSetType: IconSetType = iconCf.iconSet;

    // Position icon at left side of cell, vertically centered
    const iconX = Math.max(cellX, rhw) + 2;
    const iconY = Math.max(cellY, chh) + (cellH - ICON_SIZE) / 2;

    ctx.save();
    drawIcon(ctx, iconSetType, iconCf.iconIndex, iconX, iconY, ICON_SIZE);
    ctx.restore();
  }
}
