// FILENAME: app/extensions/Collaboration/lib/writebackOutline.ts
// PURPOSE: The discreet writeback REGION OUTLINE: one thin dashed perimeter
//          around each writeback region on the active sheet.
// CONTEXT: Replaces the old per-state full-cell tints (light pastel fills that
//          made dark-skin text unreadable and hid the user's own formatting).
//          It is a grid LAYER at "under-selection", not a cell-anchored grid
//          region: Core removes the gridlines inside a region, and the
//          subscriber's sheet must keep its gridlines and formatting. No fill.
//
//          1px, dashed 3/2, in the theme's INFO tone at 70% alpha. The
//          rectangle comes from @api/gridLayers `rangeToCanvasRect`, which is
//          frozen- and split-pane aware; an edge that continues off-screen is
//          not drawn, so a half-visible region does not look like a smaller
//          one. Layers run on canvas pages too, so the region list it paints is
//          already filtered to the ACTIVE sheet (empty on a canvas).

import type { GridLayerContext, RangeCanvasRect } from "@api/gridLayers";

export const OUTLINE_DASH: readonly number[] = [3, 2];
export const OUTLINE_ALPHA = 0.7;

export interface OutlineRegion {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

export interface WritebackOutlineDeps {
  /** The regions on the ACTIVE sheet (empty on a canvas page). */
  regions: () => readonly OutlineRegion[];
  /** The info tone, read per frame (skin switches). */
  color: () => string;
  /** Freeze-aware geometry (@api/gridLayers rangeToCanvasRect). */
  rectOf: (
    context: GridLayerContext,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => RangeCanvasRect | null;
}

/** Stroke the unclipped edges of one rectangle on the half-pixel grid. */
export function strokeOutline(ctx: CanvasRenderingContext2D, rect: RangeCanvasRect): void {
  const left = Math.round(rect.x) + 0.5;
  const top = Math.round(rect.y) + 0.5;
  const right = Math.round(rect.x + rect.width) - 0.5;
  const bottom = Math.round(rect.y + rect.height) - 0.5;
  if (right <= left || bottom <= top) return;
  ctx.beginPath();
  if (!rect.clippedTop) {
    ctx.moveTo(left, top);
    ctx.lineTo(right, top);
  }
  if (!rect.clippedRight) {
    ctx.moveTo(right, top);
    ctx.lineTo(right, bottom);
  }
  if (!rect.clippedBottom) {
    ctx.moveTo(right, bottom);
    ctx.lineTo(left, bottom);
  }
  if (!rect.clippedLeft) {
    ctx.moveTo(left, bottom);
    ctx.lineTo(left, top);
  }
  ctx.stroke();
}

/** The layer's paint function. */
export function createWritebackOutlinePainter(
  deps: WritebackOutlineDeps,
): (context: GridLayerContext) => void {
  return (context) => {
    const list = deps.regions();
    if (list.length === 0) return;
    const { ctx } = context;
    ctx.strokeStyle = deps.color();
    ctx.globalAlpha = OUTLINE_ALPHA;
    ctx.lineWidth = 1;
    ctx.setLineDash(OUTLINE_DASH as number[]);
    for (const r of list) {
      const rect = deps.rectOf(context, r.rowStart, r.colStart, r.rowEnd, r.colEnd);
      if (rect) strokeOutline(ctx, rect);
    }
  };
}
