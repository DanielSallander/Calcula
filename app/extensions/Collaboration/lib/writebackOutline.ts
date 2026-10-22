// FILENAME: app/extensions/Collaboration/lib/writebackOutline.ts
// PURPOSE: The discreet writeback REGION FRAME: a hairline round each
//          writeback region on the active sheet, ON the region's own boundary
//          gridlines and tinted with the Writeback tab's accent, broken by a
//          small "edit" icon (a pen over an open square) on its top and bottom
//          edges.
// CONTEXT: The owner's design, refined three times:
//            1. (2026-10-21) a dashed outline read as the copy marquee (marching
//               ants), so the frame became SOLID with a tiny "w" at the middle of
//               every outer cell edge;
//            2. (2026-10-21) one mark per edge reads calmer than one per cell, and
//               an edit icon says "you fill this in" better than a letter;
//            3. (2026-10-22) the 1-CSS-px grey line at 45% read "too sharp and
//               noticeable" and the 12px icon "a bit too intrusive on the cell".
//          Before all that it replaced the per-state full-cell tints (pastel
//          fills that made dark-skin text unreadable and hid the user's own
//          formatting). No fill.
//
//          THE LINE IS A GRIDLINE, RE-TINTED. A 1-CSS-px line is 2 device pixels
//          at DPR 2, and it was drawn half a pixel INSIDE the region, so it sat
//          as a second, heavier line beside the gridline. It is now drawn with
//          Core's own gridline geometry (@api/gridLayers `gridlineGeometry`, the
//          function both Core gridline painters use -- the ordinary grid and
//          every frozen or split pane): one DEVICE pixel wide, on the very pixels
//          of the region's boundary gridlines, the right and bottom edges on the
//          NEXT column's and row's gridline. Its colour is the Writeback tab's
//          accent (WRITEBACK_ACCENT_TOKEN, through @api/appearance
//          getCanvasThemeColor) at 35%: a softly coloured gridline that belongs
//          to the tab, in every skin, with no literal. 35% (it was 55%) because
//          at 100% scaling a one-pixel line's weight is its contrast: 55% still
//          measured 3.3:1 on white, the contrast of the line the owner called too
//          sharp; 35% is 2.3:1 in Light and 2.9:1 in Dark, against 1.3 / 1.5 for
//          a plain gridline. The horizontal edges run half a device pixel past
//          each corner and the vertical edges stop short of a corner a drawn
//          horizontal edge covers, so NO device pixel is painted twice:
//          Chromium strokes a one-device-pixel line as a hairline, segment by
//          segment, and an overlap is blended twice into a darker dot.
//
//          THE ICON is 8px at 85% of the same accent, its stroke a WHOLE number
//          of device pixels (one CSS px rounded DOWN, at least one: 1 device px
//          from 100% to 175%, 2 at 200%) and its vertices aligned to device
//          pixels, so it is crisp at every display scaling, fractional ones
//          included: a 1-CSS-px stroke is 1.25-1.75 device px at 125%-175% and no
//          position makes it crisp, and rounding UP to 2 there filled the 8px
//          pen in (measured 2026-10-22). The line is broken 2px either side of it. ONE ICON ON THE TOP EDGE AND ONE
//          ON THE BOTTOM EDGE, at the horizontal centre of the MIDDLE VISIBLE
//          COLUMN -- never on the sides (owner, 2026-10-22: "intrusive on the
//          cell"): a side icon centred on the edge reaches 3px into the edge
//          cell, where Core starts a left-aligned value and ends a right-aligned
//          one (its 3px text inset), so it touched the middle row's value, and a
//          one-row region was boxed in by four icons. Above and below a cell is
//          where no value is: text sits on the cell's bottom, numbers at its
//          sides. Never on a column boundary either, where a cell's corner
//          triangles live (the writeback marker and ErrorChecking's in the
//          top-left, the note's in the top-right). "Middle" is the column holding
//          the middle of the edge's VISIBLE width (a midpoint exactly on a
//          boundary goes to the left one; a hidden column never qualifies). An
//          edge whose middle column is too narrow for the icon keeps a plain
//          line, and so does an edge where the icon would be CUT: a top edge
//          flush with the column header (the headers are painted after every
//          layer, so they covered the icon's upper half) and a bottom edge at the
//          bottom of the canvas. The other edge still carries its icon.
//
//          A grid LAYER at "under-selection", not a cell-anchored grid region:
//          Core removes the gridlines inside a region, and the sheet must keep
//          its gridlines and formatting. Every rectangle comes from @api/gridLayers
//          `rangeToCanvasRect`, which is frozen- and split-pane aware and already
//          clipped to what is on screen; an edge that continues off-screen is not
//          drawn, and neither is its icon. COST: one rectangle for the region,
//          plus one for the middle column when the whole width is on screen and
//          its columns share one width (the usual form); otherwise a binary
//          search of the column holding the midpoint -- O(log n) rectangles for
//          n columns, never one per cell.
//
//          Layers run on canvas pages too, so the region list it paints is
//          already filtered to the ACTIVE sheet (empty on a canvas).

import type { GridLayerContext, GridlineGeometry, RangeCanvasRect } from "@api/gridLayers";
import type { ThemeTokenName } from "@api/appearance";
import { WRITEBACK_ACCENT_TOKEN } from "./writebackIds";

/** The token the frame is tinted with: the Writeback ribbon tab's accent (the tab's own token). */
export const FRAME_ACCENT_TOKEN: ThemeTokenName = WRITEBACK_ACCENT_TOKEN;
/** The line's opacity: a tinted gridline, not a border. */
export const FRAME_LINE_ALPHA = 0.35;
/** The icon's box, CSS pixels (the canvas transform carries DPR and zoom). */
export const FRAME_ICON_SIZE = 8;
/** The icon's stroke, CSS pixels -- rounded down to whole device pixels when drawn. */
export const FRAME_ICON_STROKE = 1;
/** The icon's opacity: legible, still quieter than cell text. */
export const FRAME_ICON_ALPHA = 0.85;
/** Clear space on each side of the icon where the line is broken. */
export const FRAME_ICON_PAD = 2;
/** Line left visible on each side of the break, inside the icon's column. */
export const FRAME_ICON_MIN_LINE = 2;
/** The middle column must be at least this wide to carry the icon. */
export const FRAME_ICON_MIN_CELL = FRAME_ICON_SIZE + 2 * (FRAME_ICON_PAD + FRAME_ICON_MIN_LINE);

export interface OutlineRegion {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

export interface WritebackFrameColors {
  /** The line's and the icon's colour (each alpha is applied by the painter). */
  accent: string;
}

/** Freeze-aware range geometry (@api/gridLayers rangeToCanvasRect). */
export type RangeRectOf = (
  context: GridLayerContext,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
) => RangeCanvasRect | null;

export interface WritebackOutlineDeps {
  /** The regions on the ACTIVE sheet (empty on a canvas page). */
  regions: () => readonly OutlineRegion[];
  /** Read per frame (skin switches). */
  colors: () => WritebackFrameColors;
  rectOf: RangeRectOf;
  /** Where Core strokes gridlines on this context (@api/gridLayers gridlineGeometry). */
  gridline: (ctx: CanvasRenderingContext2D) => GridlineGeometry;
  /** The cell area's top-left corner, below and right of the headers (@api/gridLayers cellAreaOrigin). */
  cellArea: (context: GridLayerContext) => { x: number; y: number };
}

/** The frame's colours, read through a theme-token accessor (@api/appearance getCanvasThemeColor). */
export function writebackFrameColors(read: (token: ThemeTokenName) => string): WritebackFrameColors {
  return { accent: read(FRAME_ACCENT_TOKEN) };
}

/** The canvas's device scale (DPR x zoom): the transform's x scale, 1 without one. */
export function deviceScaleOf(ctx: CanvasRenderingContext2D): number {
  return ctx.getTransform?.().a || 1;
}

/**
 * The icon's stroke in CSS px: FRAME_ICON_STROKE rounded DOWN to a whole number
 * of device pixels, at least one. Down, not to the nearest: at 150% and 175% a
 * 2-device-pixel stroke filled the 8px glyph's pen in; one device pixel keeps
 * it a crisp, light outline (100%-175%: 1 device px; 200%: 2).
 */
export function iconStrokeWidth(deviceScale: number): number {
  return Math.max(1, Math.floor(FRAME_ICON_STROKE * deviceScale + 1e-6)) / deviceScale;
}

/**
 * A coordinate aligner for strokes of the context's current lineWidth: when the
 * stroke covers a whole number of device pixels, a value moves to where such a
 * stroke is crisp -- a device pixel's centre for an odd width, its edge for an
 * even one; otherwise (a fractional width) it is left alone, because no position
 * makes that stroke crisp. The icon is always drawn with a whole-pixel stroke
 * ({@link iconStrokeWidth}), so for it the aligner always engages.
 */
export function deviceStrokeAligner(ctx: CanvasRenderingContext2D): (v: number) => number {
  const scale = deviceScaleOf(ctx);
  const deviceStroke = ctx.lineWidth * scale;
  const whole = Math.round(deviceStroke);
  if (whole < 1 || Math.abs(deviceStroke - whole) > 0.01) return (v) => v;
  const half = whole % 2 === 1 ? 0.5 : 0;
  return (v) => (Math.round(v * scale - half) + half) / scale;
}

/**
 * The "edit" icon centred on (cx, cy): an open square whose top-right corner
 * gives way to a pen. Drawn on a 24-unit grid (the icon set's), scaled to
 * `size`, in the context's current stroke. At 8px the grid's units are thirds
 * of a pixel, so unaligned the strokes smear into a soft blob; the centre and
 * every vertex are therefore aligned to the device pixels
 * ({@link deviceStrokeAligner}) -- the same glyph, drawn crisp, and identical
 * wherever it lands. Plain path commands, no Path2D, so a recording context can
 * check it.
 */
export function drawEditIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number = FRAME_ICON_SIZE,
): void {
  const k = size / 24;
  const fit = deviceStrokeAligner(ctx);
  const ox = fit(cx);
  const oy = fit(cy);
  const X = (u: number) => fit(ox + (u - 12) * k);
  const Y = (u: number) => fit(oy + (u - 12) * k);
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

/** One row or column's VISIBLE extent along its axis, canvas pixels. */
export interface VisibleLine {
  index: number;
  /** Top (row) or left (column) edge of the visible part. */
  lo: number;
  /** Bottom (row) or right (column) edge of the visible part. */
  hi: number;
}

/**
 * The row (`axis` "row") or column ("col") of the region that holds the middle
 * of the region's visible extent on that axis, with its own visible extent;
 * null when nothing qualifies. A midpoint exactly on a boundary belongs to the
 * upper / left line. Hidden lines (zero size) never hold it. Exported for tests.
 */
export function middleVisibleLine(
  axis: "row" | "col",
  context: GridLayerContext,
  region: OutlineRegion,
  rect: RangeCanvasRect,
  rectOf: RangeRectOf,
): VisibleLine | null {
  const rows = axis === "row";
  const r0 = Math.min(region.rowStart, region.rowEnd);
  const r1 = Math.max(region.rowStart, region.rowEnd);
  const c0 = Math.min(region.colStart, region.colEnd);
  const c1 = Math.max(region.colStart, region.colEnd);
  const first = rows ? r0 : c0;
  const last = rows ? r1 : c1;
  // Lines a..b of this axis across the WHOLE other axis, so the rectangle is on
  // screen whenever those lines are.
  const linesRect = (a: number, b: number): RangeCanvasRect | null =>
    rows ? rectOf(context, a, c0, b, c1) : rectOf(context, r0, a, r1, b);
  const extent = (r: RangeCanvasRect): [number, number] =>
    rows ? [r.y, r.y + r.height] : [r.x, r.x + r.width];
  const [lo, hi] = extent(rect);
  const mid = (lo + hi) / 2;
  const holdsMid = (r: RangeCanvasRect | null): r is RangeCanvasRect => {
    if (!r) return false;
    const [a, b] = extent(r);
    return a < mid && mid <= b;
  };

  // 1. The usual form -- the whole extent on screen, lines of one size: the
  //    middle line by count holds the midpoint. One rectangle.
  const clipped = rows ? rect.clippedTop || rect.clippedBottom : rect.clippedLeft || rect.clippedRight;
  if (!clipped) {
    const guess = first + Math.floor((last - first) / 2);
    const r = linesRect(guess, guess);
    if (holdsMid(r)) {
      const [a, b] = extent(r);
      return { index: guess, lo: a, hi: b };
    }
  }

  // 2. Otherwise the first line whose PREFIX (first..k) reaches the midpoint.
  //    A prefix's far edge never decreases as k grows -- hidden lines add
  //    nothing, a prefix scrolled away is null, one under frozen panes is held
  //    at the pinned edge -- so a binary search finds it.
  let a = first;
  let b = last;
  while (a < b) {
    const k = a + Math.floor((b - a) / 2);
    const prefix = linesRect(first, k);
    if (prefix && extent(prefix)[1] >= mid) b = k;
    else a = k + 1;
  }
  const r = linesRect(a, a);
  if (!r) return null;
  const [s, e] = extent(r);
  return { index: a, lo: s, hi: e };
}

/** The icon's centre along an edge: the middle of its column, or null when the column is too narrow. */
function iconCentreIn(line: VisibleLine | null): number | null {
  if (!line || line.hi - line.lo < FRAME_ICON_MIN_CELL) return null;
  return (line.lo + line.hi) / 2;
}

/** How far the icon reaches above or below the line it sits on, CSS px (half its box plus half a stroke). */
const ICON_REACH = FRAME_ICON_SIZE / 2 + FRAME_ICON_STROKE;

/** Add [a, b] along one axis to the current path, broken around `centre` when there is one. */
function addEdge(
  ctx: CanvasRenderingContext2D,
  a: number,
  b: number,
  centre: number | null,
  point: (t: number) => [number, number],
): void {
  if (!(b > a)) return;
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

/** Paint the frame of one region. Exported for tests. */
export function paintRegionFrame(
  context: GridLayerContext,
  region: OutlineRegion,
  deps: Pick<WritebackOutlineDeps, "rectOf" | "gridline" | "cellArea">,
  colors: WritebackFrameColors,
): void {
  const { rectOf } = deps;
  const rect = rectOf(context, region.rowStart, region.colStart, region.rowEnd, region.colEnd);
  if (!rect) return;
  const { ctx } = context;
  const { deviceScale: scale, lineWidth, snap } = deps.gridline(ctx);
  // ON the boundary gridlines: the left/top boundary's own, and the right/bottom
  // boundary's, which is the next column's / row's.
  const left = snap(rect.x);
  const right = snap(rect.x + rect.width);
  const top = snap(rect.y);
  const bottom = snap(rect.y + rect.height);
  if (right <= left || bottom <= top) return;
  // Half a device pixel: a horizontal edge covers its corner pixels whole; a
  // vertical edge stops short of a corner pixel a drawn horizontal edge covers.
  const half = 0.5 / scale;

  // The top and bottom edges' icon: the middle visible column, when either
  // horizontal edge is on screen at all.
  const across =
    !rect.clippedTop || !rect.clippedBottom
      ? iconCentreIn(middleVisibleLine("col", context, region, rect, rectOf))
      : null;
  // An icon is CUT where something is painted over it after this layer: the
  // column header above the cell area, and the canvas's own bottom edge.
  const topIcon = across !== null && top - ICON_REACH >= deps.cellArea(context).y;
  const bottomIcon = across !== null && bottom + ICON_REACH <= context.canvasHeight;
  const icons: Array<[number, number]> = [];

  ctx.beginPath();
  if (!rect.clippedTop) {
    addEdge(ctx, left - half, right + half, topIcon ? across : null, (t) => [t, top]);
    if (topIcon) icons.push([across, top]);
  }
  if (!rect.clippedBottom) {
    addEdge(ctx, left - half, right + half, bottomIcon ? across : null, (t) => [t, bottom]);
    if (bottomIcon) icons.push([across, bottom]);
  }
  const downFrom = rect.clippedTop ? top - half : top + half;
  const downTo = rect.clippedBottom ? bottom + half : bottom - half;
  if (!rect.clippedLeft) addEdge(ctx, downFrom, downTo, null, (t) => [left, t]);
  if (!rect.clippedRight) addEdge(ctx, downFrom, downTo, null, (t) => [right, t]);
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "butt";
  ctx.strokeStyle = colors.accent;
  ctx.globalAlpha = FRAME_LINE_ALPHA;
  ctx.stroke();

  if (icons.length === 0) return;
  ctx.lineWidth = iconStrokeWidth(scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
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
    const colors = deps.colors();
    context.ctx.setLineDash([]);
    for (const r of list) {
      paintRegionFrame(context, r, deps, colors);
    }
  };
}
