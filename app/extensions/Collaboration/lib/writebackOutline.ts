// FILENAME: app/extensions/Collaboration/lib/writebackOutline.ts
// PURPOSE: The discreet writeback REGION FRAME: a soft solid line round each
//          writeback region on the active sheet, broken ONCE per edge by a
//          small "edit" icon (a pen over an open square).
// CONTEXT: The owner's design, refined twice on 2026-10-21:
//            1. a dashed outline read as the copy marquee (marching ants), so
//               the frame became SOLID with a tiny "w" at the middle of every
//               outer cell edge;
//            2. one mark per edge reads calmer than one per cell, and an edit
//               icon says "you fill this in" better than a letter; the line got
//               a little stronger.
//          Before all that it replaced the per-state full-cell tints (pastel
//          fills that made dark-skin text unreadable and hid the user's own
//          formatting). No fill.
//
//          A grid LAYER at "under-selection", not a cell-anchored grid region:
//          Core removes the gridlines inside a region, and the sheet must keep
//          its gridlines and formatting. The rectangle comes from @api/gridLayers
//          `rangeToCanvasRect`, which is frozen- and split-pane aware and already
//          clipped to what is on screen; an edge that continues off-screen is not
//          drawn, and each drawn edge carries its icon at the middle of its
//          VISIBLE length, so a tall region scrolled half off still shows one.
//          One rectangle per region per frame: the cost does not grow with the
//          region's size.
//
//          Colours are the grid theme's cell text colour at low alpha, read per
//          frame, so the frame follows the skin (light and dark) with no
//          literal. Layers run on canvas pages too, so the region list it
//          paints is already filtered to the ACTIVE sheet (empty on a canvas).

import type { GridLayerContext, RangeCanvasRect } from "@api/gridLayers";

/** The icon's box, CSS pixels (the canvas context is already DPR-scaled). */
export const FRAME_ICON_SIZE = 12;
/** The line: a quiet grey, clearly darker than a gridline. */
export const FRAME_LINE_ALPHA = 0.45;
/** The icon: legible, still quieter than cell text. */
export const FRAME_ICON_ALPHA = 0.7;
/** Clear space on each side of the icon where the line is broken. */
export const FRAME_ICON_PAD = 2;
/** An edge shorter than the icon plus this keeps a plain line. */
export const FRAME_MIN_EDGE_SLACK = 6;

export interface OutlineRegion {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

export interface WritebackFrameColors {
  /** The line colour (alpha is applied by the painter). */
  line: string;
  /** The icon colour (alpha is applied by the painter). */
  glyph: string;
}

export interface WritebackOutlineDeps {
  /** The regions on the ACTIVE sheet (empty on a canvas page). */
  regions: () => readonly OutlineRegion[];
  /** Read per frame (skin switches). */
  colors: () => WritebackFrameColors;
  /** Freeze-aware geometry (@api/gridLayers rangeToCanvasRect). */
  rectOf: (
    context: GridLayerContext,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => RangeCanvasRect | null;
}

/**
 * The "edit" icon centred on (cx, cy): an open square whose top-right corner
 * gives way to a pen. Drawn on a 24-unit grid (the icon set's), scaled to
 * {@link FRAME_ICON_SIZE}, with a 2-unit stroke (1px at 12px). Plain path
 * commands, no Path2D, so a recording context can check it.
 */
export function drawEditIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const k = FRAME_ICON_SIZE / 24;
  const X = (u: number) => cx + (u - 12) * k;
  const Y = (u: number) => cy + (u - 12) * k;
  ctx.beginPath();
  // The square, open at its top-right where the pen sits.
  ctx.moveTo(X(11), Y(4));
  ctx.lineTo(X(4), Y(4));
  ctx.lineTo(X(4), Y(20));
  ctx.lineTo(X(20), Y(20));
  ctx.lineTo(X(20), Y(13));
  // The pen: a slanted body from the top-right, ending in a point.
  ctx.moveTo(X(17.5), Y(3.5));
  ctx.lineTo(X(20.5), Y(6.5));
  ctx.lineTo(X(12), Y(15));
  ctx.lineTo(X(8.5), Y(15.5));
  ctx.lineTo(X(9), Y(12));
  ctx.lineTo(X(17.5), Y(3.5));
  ctx.stroke();
}

/** Stroke [a, b] along one axis, broken around `centre` when there is one. */
function strokeEdge(
  ctx: CanvasRenderingContext2D,
  a: number,
  b: number,
  centre: number | null,
  point: (t: number) => [number, number],
): void {
  if (centre === null) {
    ctx.moveTo(...point(a));
    ctx.lineTo(...point(b));
    return;
  }
  const half = FRAME_ICON_SIZE / 2 + FRAME_ICON_PAD;
  ctx.moveTo(...point(a));
  ctx.lineTo(...point(centre - half));
  ctx.moveTo(...point(centre + half));
  ctx.lineTo(...point(b));
}

/** The middle of [a, b] when the edge is long enough to hold the icon, else null. */
function iconCentre(a: number, b: number): number | null {
  if (b - a < FRAME_ICON_SIZE + 2 * FRAME_ICON_PAD + FRAME_MIN_EDGE_SLACK) return null;
  return Math.round((a + b) / 2) + 0.5;
}

/** Paint the frame of one region. Exported for tests. */
export function paintRegionFrame(
  context: GridLayerContext,
  region: OutlineRegion,
  rectOf: WritebackOutlineDeps["rectOf"],
  colors: WritebackFrameColors,
): void {
  const rect = rectOf(context, region.rowStart, region.colStart, region.rowEnd, region.colEnd);
  if (!rect) return;
  const { ctx } = context;
  const left = Math.round(rect.x) + 0.5;
  const top = Math.round(rect.y) + 0.5;
  const right = Math.round(rect.x + rect.width) - 0.5;
  const bottom = Math.round(rect.y + rect.height) - 0.5;
  if (right <= left || bottom <= top) return;

  const hCentre = iconCentre(left, right);
  const vCentre = iconCentre(top, bottom);
  const icons: Array<[number, number]> = [];

  ctx.beginPath();
  if (!rect.clippedTop) {
    strokeEdge(ctx, left, right, hCentre, (t) => [t, top]);
    if (hCentre !== null) icons.push([hCentre, top]);
  }
  if (!rect.clippedBottom) {
    strokeEdge(ctx, left, right, hCentre, (t) => [t, bottom]);
    if (hCentre !== null) icons.push([hCentre, bottom]);
  }
  if (!rect.clippedLeft) {
    strokeEdge(ctx, top, bottom, vCentre, (t) => [left, t]);
    if (vCentre !== null) icons.push([left, vCentre]);
  }
  if (!rect.clippedRight) {
    strokeEdge(ctx, top, bottom, vCentre, (t) => [right, t]);
    if (vCentre !== null) icons.push([right, vCentre]);
  }
  ctx.strokeStyle = colors.line;
  ctx.globalAlpha = FRAME_LINE_ALPHA;
  ctx.stroke();

  if (icons.length === 0) return;
  ctx.strokeStyle = colors.glyph;
  ctx.globalAlpha = FRAME_ICON_ALPHA;
  for (const [x, y] of icons) drawEditIcon(ctx, x, y);
}

/** The layer's paint function. */
export function createWritebackOutlinePainter(
  deps: WritebackOutlineDeps,
): (context: GridLayerContext) => void {
  return (context) => {
    const list = deps.regions();
    if (list.length === 0) return;
    const { ctx } = context;
    const colors = deps.colors();
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([]);
    for (const r of list) {
      paintRegionFrame(context, r, deps.rectOf, colors);
    }
  };
}
