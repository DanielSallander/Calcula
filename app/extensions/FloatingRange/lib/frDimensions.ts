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

/** Total width of the cell area (sum of column widths for the window). */
export function contentWidth(entry: FloatingRangeEntry): number {
  let w = 0;
  for (let c = 0; c < entry.cols; c++) w += frColWidth(entry, c);
  return w;
}

/** Total height of the cell area (sum of row heights for the window). */
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
// Local cell geometry
// ============================================================================

/** Top-left of a local cell, relative to the FRAME origin (logical px). */
export function localCellOrigin(
  entry: FloatingRangeEntry,
  row: number,
  col: number,
): { x: number; y: number } {
  let x = frRowHdrW(entry);
  for (let c = 0; c < col; c++) x += frColWidth(entry, c);
  let y = frCellsTop(entry);
  for (let r = 0; r < row; r++) y += frRowHeight(entry, r);
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
 * Map a frame-relative point to a zone + local cell. A linear walk — fine at
 * v1 scale (windows are bounded at 1000 x 256 and typically tiny).
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
): FrHitZone {
  if (dx < 0 || dy < 0 || dx > frameWidth(entry) || dy > frameHeight(entry)) {
    return { zone: "outside" };
  }
  const titleH = frTitleH(entry);
  const cellsTop = frCellsTop(entry);
  if (dy < titleH) return { zone: "title" };

  // Column from x (points in the local row-header gutter clamp to col 0's edge).
  const colX = dx - frRowHdrW(entry);
  let col = 0;
  if (colX >= 0) {
    let acc = 0;
    for (let c = 0; c < entry.cols; c++) {
      acc += frColWidth(entry, c);
      if (colX < acc) {
        col = c;
        break;
      }
      col = c; // clamp to the last column when past the end
    }
  }

  if (dy < cellsTop) {
    // Top-left corner box. With no title bar there is nothing to grab there,
    // so it reads as the row-header gutter it sits above rather than as a
    // move zone that does not exist.
    if (colX < 0) return entry.showTitle ? { zone: "title" } : { zone: "rowHeader", row: 0 };
    return { zone: "colHeader", col };
  }

  // Row from y.
  const rowY = dy - cellsTop;
  let row = 0;
  let acc = 0;
  for (let r = 0; r < entry.rows; r++) {
    acc += frRowHeight(entry, r);
    if (rowY < acc) {
      row = r;
      break;
    }
    row = r; // clamp to the last row when past the end
  }

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
 * Core claims a 10 px SQUARE box around each corner (`HANDLE_HIT_SIZE`,
 * `overlayResizeHandlers.ts`) and is consulted at a HIGHER mousedown priority
 * than this overlay's claim. An edge midpoint sits half the edge's length from
 * both of its corners, so on a short edge the midpoint is inside a corner box
 * and Core takes the drag — the user would grab a yellow ball and get a count
 * resize. Below this span the handle is therefore not offered at all: an
 * affordance that is painted and then loses the click is worse than none.
 *
 * The number is derived, not chosen. The whole HIT circle must clear the
 * corner box, and Core's test is INCLUSIVE (`dy <= 10`), so the requirement is
 * `span / 2 - FR_EDGE_HANDLE_HIT_R > 10`, i.e. `span > 2 * (10 + 7) = 34`.
 * 34 itself still leaves the outermost pixel of the circle to Core; 36 clears
 * it with a pixel to spare. `frEdgeHandles clears Core's corner box` in
 * frDimensions.test.ts asserts the property against Core's 10 directly, so
 * raising this constant carelessly cannot make it pass vacuously.
 */
export const FR_EDGE_HANDLE_MIN_SPAN = 36;

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
 * Every index whose size the object actually tracks: the visible window, plus
 * any override that outlives it.
 *
 * The second half matters. Shrinking the window HIDES columns without deleting
 * them (and their widths are kept), so scaling only the visible ones would
 * leave the hidden columns at their old size — and the object would visibly
 * skew the moment the window grew back.
 */
export function trackedColIndices(entry: FloatingRangeEntry): number[] {
  const seen = new Set<number>();
  for (let c = 0; c < entry.cols; c++) seen.add(c);
  for (const key of Object.keys(entry.colWidths)) seen.add(Number(key));
  return [...seen].sort((a, b) => a - b);
}

export function trackedRowIndices(entry: FloatingRangeEntry): number[] {
  const seen = new Set<number>();
  for (let r = 0; r < entry.rows; r++) seen.add(r);
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
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const c of trackedColIndices(entry)) {
    out[c] = roundSize(frColWidth(entry, c) * scale);
  }
  return out;
}

/** Apply a scale to every tracked row, returning a NEW dense map. */
export function scaledRowHeights(
  entry: FloatingRangeEntry,
  scale: number,
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of trackedRowIndices(entry)) {
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
