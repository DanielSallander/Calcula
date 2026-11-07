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
import { getEvaluationForCell, getIconAlignForCell } from "../lib/cfStore";
import { drawIcon } from "./iconShapes";

export const ICON_SIZE = 14;
/** Inset of the icon from the cell's edge it sits against, in px. */
export const ICON_INSET_X = 2;

/** Where a glyph sits across its cell. */
export type IconPlacement = "left" | "center" | "right";

/**
 * Where Excel puts an icon-set glyph in its cell (BUG-0728) [LIVE, Excel 16,
 * 2026-11-06, lane uiforms probe2/probe3 PDFs]: at the LEFT while the value
 * shows, whatever the alignment; with Show Icon Only, by the cell's horizontal
 * alignment -- CENTRED under Center, at the RIGHT under Right, at the left
 * under everything else (General, Left, Fill, Justify, Center Across
 * Selection, Distributed), the indent ignored. (The ledger's "Excel centres the
 * icon when the value is hidden" held only for a centred cell: a General cell's
 * icon stays at the left.)
 */
export function iconPlacementFor(hideValue: boolean, textAlign: string | null | undefined): IconPlacement {
  if (!hideValue) return "left";
  if (textAlign === "center") return "center";
  if (textAlign === "right") return "right";
  return "left";
}

/** The glyph's left edge in `box` for a placement. */
export function iconXIn(box: CellBox, placement: IconPlacement): number {
  if (placement === "center") return box.x + (box.width - ICON_SIZE) / 2;
  if (placement === "right") return box.x + box.width - ICON_INSET_X - ICON_SIZE;
  return box.x + ICON_INSET_X;
}

/**
 * Paint one icon-set glyph into `box`, vertically centred, across the cell as
 * `placement` says (left by default). `iconSet` and `index` are the backend's
 * resolved pair (BUG-0107: both come from the ONE rule that produced them,
 * never re-derived here).
 */
export function paintIconSetIcon(
  ctx: CanvasRenderingContext2D,
  box: CellBox,
  iconSet: IconSetType,
  index: number,
  placement: IconPlacement = "left",
): void {
  const iconX = iconXIn(box, placement);
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

    // Show Icon Only places the glyph by the cell's alignment (Excel), which
    // the store reads for such cells (getIconAlignForCell).
    const placement = iconPlacementFor(iconCf.hideValue === true, getIconAlignForCell(row, col));
    const top = Math.max(cellY, chh);
    if (placement !== "left") {
      // Centred / right-aligned across the WHOLE cell, as Excel lays it out; a
      // glyph that would land under the row header is not drawn over it.
      const box = { x: cellX, y: top, width: cellW, height: cellH };
      if (iconXIn(box, placement) < rhw) continue;
      paintIconSetIcon(ctx, box, iconSetType, iconCf.iconIndex, placement);
      continue;
    }

    // The box starts at the VISIBLE cell's top-left (never under a header) and
    // keeps the cell's full height, which reproduces this overlay's geometry
    // from before the painter was factored out, unchanged.
    const left = Math.max(cellX, rhw);
    paintIconSetIcon(
      ctx,
      { x: left, y: top, width: Math.max(0, cellX + cellW - left), height: cellH },
      iconSetType,
      iconCf.iconIndex,
    );
  }
}
