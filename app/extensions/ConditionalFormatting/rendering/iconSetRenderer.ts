//! FILENAME: app/extensions/ConditionalFormatting/rendering/iconSetRenderer.ts
// PURPOSE: Grid overlay renderer for conditional formatting icon sets.
// CONTEXT: Draws small icons inside cells based on the icon index from evaluation results.
//
// ONE PAINTER, TWO CALLERS. `paintIconSetIcon(ctx, box, iconSet, index)` draws
// one glyph in a cell box. The grid overlay below and the registered
// `@api/conditionalFormatPaint` painter (conditionalFormatPainter.ts) both end
// there, so a floating grid's icon and the sheet's cannot be drawn two ways.

import type { OverlayRenderContext, IconSetType } from "@api";
import type { CellBox } from "@api/cellPaint";
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
/** Inset of the icon from the cell's left edge, in px. */
const ICON_INSET_X = 2;

/**
 * Paint one icon-set glyph into `box`: at the left edge, vertically centred.
 * `iconSet` and `index` are the backend's resolved pair (BUG-0107: both come
 * from the ONE rule that produced them, never re-derived here).
 */
export function paintIconSetIcon(
  ctx: CanvasRenderingContext2D,
  box: CellBox,
  iconSet: IconSetType,
  index: number,
): void {
  const iconX = box.x + ICON_INSET_X;
  const iconY = box.y + (box.height - ICON_SIZE) / 2;
  ctx.save();
  drawIcon(ctx, iconSet, index, iconX, iconY, ICON_SIZE);
  ctx.restore();
}

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

    // The box starts at the VISIBLE cell's top-left (never under a header) and
    // keeps the cell's full height, which reproduces this overlay's geometry
    // from before the painter was factored out, unchanged.
    const left = Math.max(cellX, rhw);
    const top = Math.max(cellY, chh);
    paintIconSetIcon(
      ctx,
      { x: left, y: top, width: Math.max(0, cellX + cellW - left), height: cellH },
      iconSetType,
      iconCf.iconIndex,
    );
  }
}
