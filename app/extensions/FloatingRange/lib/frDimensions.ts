//! FILENAME: app/extensions/FloatingRange/lib/frDimensions.ts
// PURPOSE: The floating range's OWN row/col size model + frame anatomy math.
// CONTEXT: Frame width/height are DERIVED (counts x sizes + chrome), never
//          stored — the derived-size rule the quantized corner resize depends
//          on. v1 uses uniform defaults (grid defaults 64.29 x 20) with
//          per-col/per-row override maps carried in object state (no UI yet).
//          All coordinates here are LOGICAL pixels (the overlay paint basis).

import type { FloatingRangeEntry } from "./floatingRangeStore";
import {
  FLOATING_RANGE_MAX_ROWS,
  FLOATING_RANGE_MAX_COLS,
} from "@api/floatingRanges";
import { FLOATING_HANDLE_HIT_HALF } from "@api/gridOverlays";
import { firstEndingAfter, lastStartingBefore } from "../../_shared/lib/offsetSearch";

// ============================================================================
// Frame chrome constants
// ============================================================================

/** Title bar height WHEN SHOWN (the Core-move grab zone). */
export const FR_TITLE_H = 20;
/** Local column-header strip height WHEN SHOWN (A, B, C, …). */
export const FR_COL_HDR_H = 16;
/** Local row-header strip width WHEN SHOWN (1, 2, 3, …). */
export const FR_ROW_HDR_W = 28;

/** Default cell sizes — the grid's own defaults (Excel-parity 64.29 x 20). */
export const FR_DEFAULT_COL_W = 64.29;
export const FR_DEFAULT_ROW_H = 20;

// ============================================================================
// Chrome extents — the ONLY readers of the three visibility flags
// ============================================================================
//
// Every piece of frame math below (and in frRenderer / index.ts / frEditor)
// goes through these three, never the raw constants. A hidden strip is ZERO
// pixels wide/tall, so the frame SHRINKS and every derived coordinate — cell
// origins, hit zones, the resize quantization, the editor's DOM rect — moves
// with it. That is what makes hiding chrome one edit instead of thirty.

/** Title-bar height for this entry: 0 when hidden. */
export function frTitleH(entry: FloatingRangeEntry): number {
  return entry.showTitle ? FR_TITLE_H : 0;
}

/** Column-header strip height for this entry: 0 when hidden. */
export function frColHdrH(entry: FloatingRangeEntry): number {
  return entry.showColumnHeaders ? FR_COL_HDR_H : 0;
}

/** Row-header gutter width for this entry: 0 when hidden. */
export function frRowHdrW(entry: FloatingRangeEntry): number {
  return entry.showRowHeaders ? FR_ROW_HDR_W : 0;
}

/** Top of the cell area, relative to the frame origin (title + col header). */
export function frCellsTop(entry: FloatingRangeEntry): number {
  return frTitleH(entry) + frColHdrH(entry);
}

// ============================================================================
// Per-index sizes (override maps with defaults)
// ============================================================================

export function frColWidth(entry: FloatingRangeEntry, col: number): number {
  const w = entry.colWidths[col];
  return typeof w === "number" && isFinite(w) && w > 0 ? w : FR_DEFAULT_COL_W;
}

export function frRowHeight(entry: FloatingRangeEntry, row: number): number {
  const h = entry.rowHeights[row];
  return typeof h === "number" && isFinite(h) && h > 0 ? h : FR_DEFAULT_ROW_H;
}

// ============================================================================
// Derived content + frame sizes
// ============================================================================

/**
 * Total width of the cell area (sum of column widths for the window). Since M7
 * this is the cell VIEWPORT: the content behind it may be wider (see FrView).
 */
export function contentWidth(entry: FloatingRangeEntry): number {
  let w = 0;
  for (let c = 0; c < entry.cols; c++) w += frColWidth(entry, c);
  return w;
}

/** Total height of the cell area (sum of row heights for the window) -- the
 *  cell VIEWPORT's height; the content behind it may be taller. */
export function contentHeight(entry: FloatingRangeEntry): number {
  let h = 0;
  for (let r = 0; r < entry.rows; r++) h += frRowHeight(entry, r);
  return h;
}

/** Derived frame width: local row header (if shown) + cells. */
export function frameWidth(entry: FloatingRangeEntry): number {
  return frRowHdrW(entry) + contentWidth(entry);
}

/** Derived frame height: title bar + local col header (each if shown) + cells. */
export function frameHeight(entry: FloatingRangeEntry): number {
  return frCellsTop(entry) + contentHeight(entry);
}

/** Frame size for arbitrary counts (resize-ghost math), using this entry's
 *  override maps for indexes it has and defaults beyond them. */
export function frameSizeForCounts(
  entry: FloatingRangeEntry,
  rows: number,
  cols: number,
): { width: number; height: number } {
  let w = frRowHdrW(entry);
  for (let c = 0; c < cols; c++) w += frColWidth(entry, c);
  let h = frCellsTop(entry);
  for (let r = 0; r < rows; r++) h += frRowHeight(entry, r);
  return { width: w, height: h };
}

// ============================================================================
// The view: content extent + scroll (M7)
// ============================================================================
//
// The frame is the WINDOW, and its cell area is a VIEWPORT onto the backing
// sheet's content, which can be larger: a window shrink hides cells without
// deleting them, and a formula can spill past the window. A view says how far
// the content reaches (`rows` x `cols`, at least the window) and where the
// viewport sits in it (the scroll origin, in content px). The chrome does not
// scroll: the title bar stays, and the local column letters / row numbers are
// sticky strips that show the SCROLLED labels.
//
// Every geometry function below takes an optional view and defaults to the
// unscrolled window (`windowView`), which is exactly the pre-M7 geometry, so a
// caller that has no scroll to offer keeps its old answers.

export interface FrView {
  /** Scroll origin of the cell area, content px (0 = unscrolled). */
  scrollLeft: number;
  scrollTop: number;
  /** Content extent the cell area scrolls through (>= the window). */
  rows: number;
  cols: number;
}

/** The unscrolled window: the view every pre-M7 caller implicitly had. */
export function windowView(entry: FloatingRangeEntry): FrView {
  return { scrollLeft: 0, scrollTop: 0, rows: entry.rows, cols: entry.cols };
}

/**
 * Column prefix sums: `[c]` = left edge of column c in content px,
 * `[count]` = total width. Summed in index order, so over the window it lands
 * on exactly `contentWidth(entry)` -- the max scroll of an extent that equals
 * the window is then exactly 0, not a floating-point sliver.
 */
export function frColOffsets(entry: FloatingRangeEntry, count: number): Float64Array {
  const n = Math.max(0, Math.trunc(count));
  const out = new Float64Array(n + 1);
  for (let c = 0; c < n; c++) out[c + 1] = out[c] + frColWidth(entry, c);
  return out;
}

/** Row prefix sums (see frColOffsets). */
export function frRowOffsets(entry: FloatingRangeEntry, count: number): Float64Array {
  const n = Math.max(0, Math.trunc(count));
  const out = new Float64Array(n + 1);
  for (let r = 0; r < n; r++) out[r + 1] = out[r] + frRowHeight(entry, r);
  return out;
}

/** How far the cell area can scroll over an extent of `rows` x `cols`. */
export function frMaxScroll(
  entry: FloatingRangeEntry,
  rows: number,
  cols: number,
): { maxLeft: number; maxTop: number } {
  const colOff = frColOffsets(entry, cols);
  const rowOff = frRowOffsets(entry, rows);
  return {
    maxLeft: Math.max(0, Math.ceil(colOff[colOff.length - 1] - contentWidth(entry))),
    maxTop: Math.max(0, Math.ceil(rowOff[rowOff.length - 1] - contentHeight(entry))),
  };
}

/** Clamp a scroll origin into [0, max] for an extent (a shrink can lower max). */
export function clampFrScrollTo(
  entry: FloatingRangeEntry,
  rows: number,
  cols: number,
  left: number,
  top: number,
): { left: number; top: number } {
  const { maxLeft, maxTop } = frMaxScroll(entry, rows, cols);
  const clamp = (v: number, max: number) => (Number.isFinite(v) ? Math.min(Math.max(0, v), max) : 0);
  return { left: clamp(left, maxLeft), top: clamp(top, maxTop) };
}

/** A rectangle of local cells, inclusive; empty when end < start. */
export interface FrCellRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

/**
 * The rows/cols of the extent that show through the cell viewport, optionally
 * narrowed to a sub-rectangle of it (`clip`, viewport-local px -- the part of
 * the viewport that is actually on the canvas). A cell is included when any
 * of it is visible. Empty (end < start) when nothing is.
 */
export function frVisibleRange(
  entry: FloatingRangeEntry,
  view: FrView,
  clip?: { x0: number; y0: number; x1: number; y1: number },
): FrCellRange {
  const vpW = contentWidth(entry);
  const vpH = contentHeight(entry);
  const x0 = Math.max(0, clip?.x0 ?? 0);
  const y0 = Math.max(0, clip?.y0 ?? 0);
  const x1 = Math.min(vpW, clip?.x1 ?? vpW);
  const y1 = Math.min(vpH, clip?.y1 ?? vpH);
  if (x1 <= x0 || y1 <= y0) return { startRow: 0, endRow: -1, startCol: 0, endCol: -1 };
  const colOff = frColOffsets(entry, view.cols);
  const rowOff = frRowOffsets(entry, view.rows);
  return {
    startCol: firstEndingAfter(colOff, 0, view.cols, view.scrollLeft + x0),
    endCol: lastStartingBefore(colOff, 0, view.cols, view.scrollLeft + x1),
    startRow: firstEndingAfter(rowOff, 0, view.rows, view.scrollTop + y0),
    endRow: lastStartingBefore(rowOff, 0, view.rows, view.scrollTop + y1),
  };
}

/**
 * The scroll origin that brings local cell (row, col) fully into the cell
 * viewport, moving as little as possible (Excel's rule). A cell bigger than the
 * viewport shows its top-left corner. Clamped to the extent's max.
 */
export function frScrollToReveal(
  entry: FloatingRangeEntry,
  view: FrView,
  row: number,
  col: number,
): { left: number; top: number } {
  const colOff = frColOffsets(entry, view.cols);
  const rowOff = frRowOffsets(entry, view.rows);
  const c = Math.max(0, Math.min(view.cols - 1, Math.trunc(col)));
  const r = Math.max(0, Math.min(view.rows - 1, Math.trunc(row)));
  const vpW = contentWidth(entry);
  const vpH = contentHeight(entry);

  let left = view.scrollLeft;
  if (colOff[c + 1] > left + vpW) left = colOff[c + 1] - vpW;
  if (colOff[c] < left) left = colOff[c];
  let top = view.scrollTop;
  if (rowOff[r + 1] > top + vpH) top = rowOff[r + 1] - vpH;
  if (rowOff[r] < top) top = rowOff[r];

  return clampFrScrollTo(entry, view.rows, view.cols, left, top);
}

// ============================================================================
// Local cell geometry
// ============================================================================

/**
 * Top-left of a local cell, relative to the FRAME origin (logical px), at the
 * view's scroll (default: unscrolled). A scrolled-away cell answers a point
 * outside the cell viewport; callers that paint or position against it clip.
 */
export function localCellOrigin(
  entry: FloatingRangeEntry,
  row: number,
  col: number,
  view?: FrView,
): { x: number; y: number } {
  let x = frRowHdrW(entry);
  for (let c = 0; c < col; c++) x += frColWidth(entry, c);
  let y = frCellsTop(entry);
  for (let r = 0; r < row; r++) y += frRowHeight(entry, r);
  if (view) {
    x -= view.scrollLeft;
    y -= view.scrollTop;
  }
  return { x, y };
}

/** Which zone of the frame a point (relative to the frame origin) is in. */
export type FrHitZone =
  | { zone: "outside" }
  | { zone: "title" }
  | { zone: "colHeader"; col: number }
  | { zone: "rowHeader"; row: number }
  | { zone: "cells"; row: number; col: number };

/**
 * Map a frame-relative point to a zone + local cell, at the view's scroll
 * (default: the unscrolled window). The cell viewport is the window's size
 * whatever the view, so a point inside the frame is always over a VISIBLE
 * cell; the view decides which one. The sticky headers answer the scrolled
 * index too: the letter strip's column is the column under it.
 *
 * A hidden strip must yield NO zone of its own, and it does so structurally:
 * with `frTitleH` at 0 the `dy < titleH` test can never pass, with `frColHdrH`
 * at 0 the col-header band is empty, and with `frRowHdrW` at 0 `colX` is never
 * negative. Nothing here needs an `if (showX)` — the extents already say it.
 */
export function localCellFromPoint(
  entry: FloatingRangeEntry,
  dx: number,
  dy: number,
  view: FrView = windowView(entry),
): FrHitZone {
  if (dx < 0 || dy < 0 || dx > frameWidth(entry) || dy > frameHeight(entry)) {
    return { zone: "outside" };
  }
  const titleH = frTitleH(entry);
  const cellsTop = frCellsTop(entry);
  if (dy < titleH) return { zone: "title" };

  const colOff = frColOffsets(entry, view.cols);
  const rowOff = frRowOffsets(entry, view.rows);
  // The index under a content coordinate, clamped to the last one when the
  // point is past the end (the viewport's far edge is inclusive).
  const colAt = (x: number) => Math.min(view.cols - 1, firstEndingAfter(colOff, 0, view.cols, x));
  const rowAt = (y: number) => Math.min(view.rows - 1, firstEndingAfter(rowOff, 0, view.rows, y));

  // Column from x (points in the local row-header gutter have no column).
  const colX = dx - frRowHdrW(entry);
  const col = colX >= 0 ? colAt(colX + view.scrollLeft) : 0;

  if (dy < cellsTop) {
    // Top-left corner box. With no title bar there is nothing to grab there,
    // so it reads as the row-header gutter it sits above -- the top VISIBLE
    // row's gutter -- rather than as a move zone that does not exist.
    if (colX < 0) {
      return entry.showTitle ? { zone: "title" } : { zone: "rowHeader", row: rowAt(view.scrollTop) };
    }
    return { zone: "colHeader", col };
  }

  // Row from y.
  const row = rowAt(dy - cellsTop + view.scrollTop);

  if (colX < 0) return { zone: "rowHeader", row };
  return { zone: "cells", row, col };
}

// ============================================================================
// Edge handles — resize the CELLS, not the counts
// ============================================================================
//
// The four CORNER handles are Core's and change how many rows and columns the
// object shows. These four EDGE-MIDPOINT handles change how big those cells
// are, leaving the counts alone. Two different resizes, two different
// affordances, so neither has to be a modifier key on the other.

export type FrEdge = "left" | "right" | "top" | "bottom";

/** Painted radius of an edge handle. */
export const FR_EDGE_HANDLE_R = 4.5;
/** Click radius — deliberately larger than the paint, so the ball is easy to
 *  grab without being visually heavy. */
export const FR_EDGE_HANDLE_HIT_R = 7;

/**
 * Shortest edge that may carry a handle.
 *
 * Core claims a SQUARE hit box around each corner handle of a selected range
 * (`FLOATING_HANDLE_HIT_HALF` px either side of the corner, inclusive --
 * core/lib/floatingHandles.ts, re-exported through @api/gridOverlays) and
 * scans it BEFORE this overlay's own zone answer. An edge midpoint sits half
 * the edge's length from both of its corners, so on a short edge the midpoint
 * is inside a corner box and Core takes the drag — the user would grab a
 * yellow ball and get a count resize. Below this span the handle is therefore
 * not offered at all: an affordance that is painted and then loses the click
 * is worse than none. (The range publishes `handles: "corners"`, so Core
 * offers no midpoint handle of its own that could pre-empt a ball.)
 *
 * The number is DERIVED from Core's constant, never typed. The whole HIT
 * circle must clear the corner box, and Core's test is INCLUSIVE, so the
 * requirement is `span / 2 - FR_EDGE_HANDLE_HIT_R > HALF`, i.e.
 * `span > 2 * (HALF + FR_EDGE_HANDLE_HIT_R)`; two more pixels clear it with one
 * to spare (28 at today's HALF of 6; it was 36 against the old 10px box).
 * `keeps every offered handle's WHOLE hit circle clear of Core's corner box`
 * in frDimensions.test.ts asserts the property against the same imported
 * constant, so the two cannot drift apart.
 */
export const FR_EDGE_HANDLE_MIN_SPAN = 2 * (FLOATING_HANDLE_HIT_HALF + FR_EDGE_HANDLE_HIT_R) + 2;

export interface FrEdgeHandle {
  edge: FrEdge;
  /** Centre, relative to the FRAME origin (logical px). */
  x: number;
  y: number;
}

/** The edge handles this object can currently offer (frame-relative). */
export function frEdgeHandles(entry: FloatingRangeEntry): FrEdgeHandle[] {
  const w = frameWidth(entry);
  const h = frameHeight(entry);
  const handles: FrEdgeHandle[] = [];
  if (h >= FR_EDGE_HANDLE_MIN_SPAN) {
    handles.push({ edge: "left", x: 0, y: h / 2 });
    handles.push({ edge: "right", x: w, y: h / 2 });
  }
  if (w >= FR_EDGE_HANDLE_MIN_SPAN) {
    handles.push({ edge: "top", x: w / 2, y: 0 });
    handles.push({ edge: "bottom", x: w / 2, y: h });
  }
  return handles;
}

/** Which edge handle a frame-relative point grabs, or null. */
export function frEdgeHandleAt(
  entry: FloatingRangeEntry,
  dx: number,
  dy: number,
): FrEdge | null {
  for (const handle of frEdgeHandles(entry)) {
    const ex = dx - handle.x;
    const ey = dy - handle.y;
    if (ex * ex + ey * ey <= FR_EDGE_HANDLE_HIT_R * FR_EDGE_HANDLE_HIT_R) {
      return handle.edge;
    }
  }
  return null;
}

// ============================================================================
// Border grab band — the move handle of a range with no title bar
// ============================================================================

/**
 * Width of the band just INSIDE the frame edge that moves a range whose title
 * bar is hidden (owner decision 2026-09-27; Excel's text box moves by its
 * border the same way). It costs this many pixels of the edge cells as a
 * click target, which is why it is thin.
 */
export const FR_BORDER_GRAB = 4;

/**
 * Whether a frame-relative point is in the border grab band: inside the frame
 * and within `FR_BORDER_GRAB` of any of its four edges. Outside the frame is
 * never the band (a near-miss must not start a move from outside the object).
 */
export function frBorderGrabAt(entry: FloatingRangeEntry, dx: number, dy: number): boolean {
  const w = frameWidth(entry);
  const h = frameHeight(entry);
  if (dx < 0 || dy < 0 || dx > w || dy > h) return false;
  return (
    dx < FR_BORDER_GRAB ||
    dy < FR_BORDER_GRAB ||
    dx > w - FR_BORDER_GRAB ||
    dy > h - FR_BORDER_GRAB
  );
}

/** Vertical edges stretch columns; horizontal edges stretch rows. */
export function edgeAxis(edge: FrEdge): "cols" | "rows" {
  return edge === "left" || edge === "right" ? "cols" : "rows";
}

/** Dragging these moves the frame's own origin — the OPPOSITE edge stays put. */
export function edgeMovesOrigin(edge: FrEdge): boolean {
  return edge === "left" || edge === "top";
}

// ---------------------------------------------------------------------------
// Proportional scaling
// ---------------------------------------------------------------------------

/**
 * Every index whose size a scale acts on: the visible window, every column the
 * CONTENT reaches (`extentCols`, the scrollable extent -- M7), plus any
 * override that outlives both.
 *
 * The override half matters. Shrinking the window HIDES columns without
 * deleting them (and their widths are kept), so scaling only the visible ones
 * would leave the hidden columns at their old size -- and the object would
 * visibly skew the moment the window grew back.
 *
 * The extent half is E10 (open-items 2.af, M7 follow-ups). Scaling the window
 * alone left every default-width column the content reaches past it at its old
 * width: scrolled into view after a x1.5 stretch it was narrower than its
 * neighbours, a skew the user did see. The extent is bounded by the backing
 * sheet's USED range (not the window maxima), so this writes a width for the
 * columns there is content in -- the ones a scroll can show -- and no more. A
 * column content reaches only LATER starts at the default width, as a new
 * worksheet column does.
 */
export function trackedColIndices(entry: FloatingRangeEntry, extentCols = 0): number[] {
  const seen = new Set<number>();
  const span = Math.max(entry.cols, extentCols);
  for (let c = 0; c < span; c++) seen.add(c);
  for (const key of Object.keys(entry.colWidths)) seen.add(Number(key));
  return [...seen].sort((a, b) => a - b);
}

/** The row twin of {@link trackedColIndices} (`extentRows`: the rows the content reaches). */
export function trackedRowIndices(entry: FloatingRangeEntry, extentRows = 0): number[] {
  const seen = new Set<number>();
  const span = Math.max(entry.rows, extentRows);
  for (let r = 0; r < span; r++) seen.add(r);
  for (const key of Object.keys(entry.rowHeights)) seen.add(Number(key));
  return [...seen].sort((a, b) => a - b);
}

/**
 * Clamp a scale factor so that EVERY resulting size lands inside [min, max].
 *
 * The clamp is on the SCALE, never on the individual results: clamping results
 * one by one would let the smallest column hit the floor while the others kept
 * shrinking, quietly changing the RELATIVE widths — the one property a
 * proportional stretch exists to preserve. When the bounds cannot both be
 * satisfied (a set already spanning the whole legal range), the object simply
 * does not scale.
 */
export function clampScaleFactor(
  sizes: number[],
  desired: number,
  min: number,
  max: number,
): number {
  if (sizes.length === 0 || !isFinite(desired)) return 1;
  let smallest = Infinity;
  let largest = 0;
  for (const s of sizes) {
    if (s < smallest) smallest = s;
    if (s > largest) largest = s;
  }
  if (!isFinite(smallest) || largest <= 0) return 1;
  const lo = min / smallest;
  const hi = max / largest;
  if (lo > hi) return 1;
  return Math.min(Math.max(desired, lo), hi);
}

/**
 * The largest scale an edge drag may apply without the frame crossing
 * `maxFrameExtent` along the dragged axis (the page border on a canvas, or the
 * sheet origin for a left/top edge, whose opposite edge must stay put).
 *
 * `baseFrameExtent` is the frame's extent on that axis at the drag's start and
 * `baseContentExtent` its cell area's (the part the scale multiplies). A frame
 * ALREADY past the limit (a page made smaller, a script's placement) is not
 * pulled back: it may shrink, never grow (cap 1) -- the rule Core's
 * `clampResizeToPage` applies to a fixed edge already off the page.
 *
 * `trackedCount` is how many of the rounded sizes MAKE THE FRAME -- the
 * window's columns (rows), `entry.cols` / `entry.rows` -- (`scaledColWidths` /
 * `scaledRowHeights` round each to 1/100 px, up to half a hundredth each), so
 * the cap leaves room for that rounding and the frame never lands a fraction
 * of a pixel past the page. NOT every size the scale writes: since E10 (d)
 * that is the whole content extent, and counting it left the frame pixels
 * short of the page.
 */
export function maxScaleWithin(
  baseFrameExtent: number,
  baseContentExtent: number,
  maxFrameExtent: number,
  trackedCount: number,
): number {
  if (!(baseContentExtent > 0) || !Number.isFinite(maxFrameExtent)) return Infinity;
  const chrome = baseFrameExtent - baseContentExtent;
  const roomForContent = maxFrameExtent - chrome - 0.005 * Math.max(0, trackedCount);
  if (roomForContent < baseContentExtent) return 1;
  return roomForContent / baseContentExtent;
}

/**
 * Sizes are stored to 1/100 of a pixel. A drag produces irrational-looking
 * floats (64.29 * 1.0374…), and those go into the document verbatim — 17
 * significant digits per column, every gesture, in a file meant to stay
 * diffable. A hundredth of a pixel is two orders of magnitude below anything
 * that can be seen or clicked, so the rounding costs nothing real.
 */
function roundSize(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Apply a scale to every tracked column, returning a NEW dense map. */
export function scaledColWidths(
  entry: FloatingRangeEntry,
  scale: number,
  extentCols = 0,
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const c of trackedColIndices(entry, extentCols)) {
    out[c] = roundSize(frColWidth(entry, c) * scale);
  }
  return out;
}

/** Apply a scale to every tracked row, returning a NEW dense map. */
export function scaledRowHeights(
  entry: FloatingRangeEntry,
  scale: number,
  extentRows = 0,
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of trackedRowIndices(entry, extentRows)) {
    out[r] = roundSize(frRowHeight(entry, r) * scale);
  }
  return out;
}

// ============================================================================
// Quantized resize: rect size -> best whole counts
// ============================================================================

/**
 * Convert a dragged frame width/height into the best-matching whole row/col
 * counts: walk sizes and pick the count whose cumulative extent is nearest the
 * target (at least 1; clamped to the backend bounds). Raw w/h is NEVER
 * persisted — this is the ONLY interpretation of a corner drag.
 */
export function bestCountsForSize(
  entry: FloatingRangeEntry,
  width: number,
  height: number,
): { rows: number; cols: number } {
  const targetW = width - frRowHdrW(entry);
  const targetH = height - frCellsTop(entry);

  let cols = 1;
  {
    let acc = frColWidth(entry, 0);
    let best = Math.abs(acc - targetW);
    for (let c = 2; c <= FLOATING_RANGE_MAX_COLS; c++) {
      acc += frColWidth(entry, c - 1);
      const d = Math.abs(acc - targetW);
      if (d < best) {
        best = d;
        cols = c;
      }
      if (acc > targetW) break; // sums only grow; no better fit past the target
    }
  }

  let rows = 1;
  {
    let acc = frRowHeight(entry, 0);
    let best = Math.abs(acc - targetH);
    for (let r = 2; r <= FLOATING_RANGE_MAX_ROWS; r++) {
      acc += frRowHeight(entry, r - 1);
      const d = Math.abs(acc - targetH);
      if (d < best) {
        best = d;
        rows = r;
      }
      if (acc > targetH) break;
    }
  }

  return { rows, cols };
}

/**
 * Step whole counts DOWN until the frame they derive fits `maxWidth` x
 * `maxHeight` (never below 1). `bestCountsForSize` rounds to the NEAREST
 * count, so it can overshoot the dragged rect by up to half a track; where the
 * rect was clamped -- to a canvas page, or at the sheet origin for a left/top
 * drag whose opposite edge must stay put -- that half track would push the
 * frame past the clamp. An unbounded axis passes `Infinity` and is untouched.
 */
export function fitCountsWithin(
  entry: FloatingRangeEntry,
  counts: { rows: number; cols: number },
  maxWidth: number,
  maxHeight: number,
): { rows: number; cols: number } {
  let { rows, cols } = counts;
  while (cols > 1 && frameSizeForCounts(entry, rows, cols).width > maxWidth) cols--;
  while (rows > 1 && frameSizeForCounts(entry, rows, cols).height > maxHeight) rows--;
  return { rows, cols };
}
