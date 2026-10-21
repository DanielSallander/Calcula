// FILENAME: app/extensions/Collaboration/lib/writebackOutline.ts
// PURPOSE: The discreet writeback REGION FRAME: a soft solid line round each
//          writeback region on the active sheet, broken at the middle of every
//          outer cell edge by a tiny "w".
// CONTEXT: The owner's design (2026-10-21). It replaced a dashed outline that
//          read as the copy marquee (marching ants): the frame is SOLID, low
//          contrast, and the "w"s say what it is. Before that it replaced the
//          per-state full-cell tints (pastel fills that made dark-skin text
//          unreadable and hid the user's own formatting). No fill.
//
//          A grid LAYER at "under-selection", not a cell-anchored grid region:
//          Core removes the gridlines inside a region, and the sheet must keep
//          its gridlines and formatting. The region rectangle and every edge
//          cell's rectangle come from @api/gridLayers `rangeToCanvasRect`, which
//          is frozen- and split-pane aware; an edge that continues off-screen is
//          not drawn, and a "w" is placed only on an edge cell that is wholly on
//          screen along that edge, so scrolling never slides a "w" off-centre.
//          Only the visible rows/columns of a region are walked, so a region of
//          a million rows costs what is on screen.
//
//          Colours are the grid theme's cell text colour at low alpha, read per
//          frame, so the frame follows the skin (light and dark) with no
//          literal. Layers run on canvas pages too, so the region list it
//          paints is already filtered to the ACTIVE sheet (empty on a canvas).

import type { GridLayerContext, RangeCanvasRect } from "@api/gridLayers";

/** The glyph on the frame. */
export const FRAME_GLYPH = "w";
/** CSS pixels; the canvas context is already scaled for the device ratio. */
export const FRAME_GLYPH_FONT_PX = 9;
export const FRAME_GLYPH_FONT = `${FRAME_GLYPH_FONT_PX}px "Segoe UI", Calibri, sans-serif`;
/** The line: quiet, just darker than a gridline. */
export const FRAME_LINE_ALPHA = 0.3;
/** The "w": legible but quieter than cell text. */
export const FRAME_GLYPH_ALPHA = 0.55;
/** Clear space on each side of a "w" where the line is broken. */
export const FRAME_GLYPH_PAD = 2;
/** An edge cell shorter than the glyph plus this keeps a plain line. */
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
  /** The "w" colour (alpha is applied by the painter). */
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

/** A break in a line: [from, to] along the line's axis, with the glyph centre. */
interface Gap {
  from: number;
  to: number;
  centre: number;
}

/**
 * The indices of [start, end] that can be on screen: the frozen ones
 * (< `frozenEnd`) and the scrolling window. Ascending, no duplicates.
 */
export function visibleIndices(
  start: number,
  end: number,
  frozenEnd: number | null,
  windowStart: number,
  windowCount: number,
): number[] {
  const out: number[] = [];
  const frozen = frozenEnd !== null && frozenEnd > 0 ? frozenEnd : 0;
  for (let i = start; i <= Math.min(end, frozen - 1); i++) out.push(i);
  const from = Math.max(start, windowStart, frozen);
  // +1: the last row/column of the window is usually partly visible.
  const to = Math.min(end, windowStart + windowCount + 1);
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/** Stroke [a, b] along one axis with the gaps cut out. */
function strokeBroken(
  ctx: CanvasRenderingContext2D,
  a: number,
  b: number,
  gaps: readonly Gap[],
  point: (t: number) => [number, number],
): void {
  let at = a;
  for (const g of gaps) {
    if (g.from > at) {
      ctx.moveTo(...point(at));
      ctx.lineTo(...point(Math.min(g.from, b)));
    }
    at = Math.max(at, g.to);
    if (at >= b) return;
  }
  if (b > at) {
    ctx.moveTo(...point(at));
    ctx.lineTo(...point(b));
  }
}

/** Paint the frame of one region. Exported for tests. */
export function paintRegionFrame(
  context: GridLayerContext,
  region: OutlineRegion,
  rectOf: WritebackOutlineDeps["rectOf"],
  glyphWidth: number,
): void {
  const rect = rectOf(context, region.rowStart, region.colStart, region.rowEnd, region.colEnd);
  if (!rect) return;
  const { ctx } = context;
  const left = Math.round(rect.x) + 0.5;
  const top = Math.round(rect.y) + 0.5;
  const right = Math.round(rect.x + rect.width) - 0.5;
  const bottom = Math.round(rect.y + rect.height) - 0.5;
  if (right <= left || bottom <= top) return;

  const vp = context.viewport;
  const freeze = context.freezeConfig;
  const cols = visibleIndices(
    region.colStart, region.colEnd, freeze?.freezeCol ?? null, vp.startCol, vp.colCount,
  );
  const rows = visibleIndices(
    region.rowStart, region.rowEnd, freeze?.freezeRow ?? null, vp.startRow, vp.rowCount,
  );
  const glyphHeight = FRAME_GLYPH_FONT_PX;
  const halfW = glyphWidth / 2 + FRAME_GLYPH_PAD;
  const halfH = glyphHeight / 2 + FRAME_GLYPH_PAD;

  // One gap per wholly visible edge cell that is long enough for a "w".
  const horizontalGaps = (row: number): Gap[] => {
    const gaps: Gap[] = [];
    for (const c of cols) {
      const cell = rectOf(context, row, c, row, c);
      if (!cell || cell.clippedLeft || cell.clippedRight) continue;
      if (cell.width < glyphWidth + FRAME_MIN_EDGE_SLACK) continue;
      const centre = cell.x + cell.width / 2;
      gaps.push({ from: centre - halfW, to: centre + halfW, centre });
    }
    return gaps;
  };
  const verticalGaps = (col: number): Gap[] => {
    const gaps: Gap[] = [];
    for (const r of rows) {
      const cell = rectOf(context, r, col, r, col);
      if (!cell || cell.clippedTop || cell.clippedBottom) continue;
      if (cell.height < glyphHeight + FRAME_MIN_EDGE_SLACK) continue;
      const centre = cell.y + cell.height / 2;
      gaps.push({ from: centre - halfH, to: centre + halfH, centre });
    }
    return gaps;
  };

  const glyphs: Array<[number, number]> = [];
  ctx.beginPath();
  if (!rect.clippedTop) {
    const gaps = horizontalGaps(region.rowStart);
    strokeBroken(ctx, left, right, gaps, (t) => [t, top]);
    for (const g of gaps) glyphs.push([g.centre, top]);
  }
  if (!rect.clippedBottom) {
    const gaps = horizontalGaps(region.rowEnd);
    strokeBroken(ctx, left, right, gaps, (t) => [t, bottom]);
    for (const g of gaps) glyphs.push([g.centre, bottom]);
  }
  if (!rect.clippedLeft) {
    const gaps = verticalGaps(region.colStart);
    strokeBroken(ctx, top, bottom, gaps, (t) => [left, t]);
    for (const g of gaps) glyphs.push([left, g.centre]);
  }
  if (!rect.clippedRight) {
    const gaps = verticalGaps(region.colEnd);
    strokeBroken(ctx, top, bottom, gaps, (t) => [right, t]);
    for (const g of gaps) glyphs.push([right, g.centre]);
  }
  ctx.globalAlpha = FRAME_LINE_ALPHA;
  ctx.stroke();

  if (glyphs.length === 0) return;
  ctx.globalAlpha = FRAME_GLYPH_ALPHA;
  for (const [x, y] of glyphs) {
    // Nudged up one pixel: a lowercase "w" has no ascender, so its optical
    // centre sits below the em box's middle.
    ctx.fillText(FRAME_GLYPH, x, y - 1);
  }
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
    ctx.strokeStyle = colors.line;
    ctx.fillStyle = colors.glyph;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.font = FRAME_GLYPH_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const measured = ctx.measureText(FRAME_GLYPH).width;
    // A context without text metrics (tests, an exotic canvas) still frames.
    const glyphWidth = Number.isFinite(measured) && measured > 0 ? measured : FRAME_GLYPH_FONT_PX * 0.75;
    for (const r of list) {
      paintRegionFrame(context, r, deps.rectOf, glyphWidth);
    }
  };
}
